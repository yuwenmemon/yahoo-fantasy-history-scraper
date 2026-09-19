import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  dataDir: "data",
  managerMap: "data/manager-identity-map.csv",
  output: "reports/lineup-regret.html",
  activeSeason: null,
  excludeManager: null,
};

const fixedSlots = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const benchSlots = new Set(["BN", "BENCH"]);
const inactiveSlots = new Set(["BN", "BENCH", "IR", "IR+", "NA", "IL"]);
const playerAliases = new Map([["Robbie Chosen", "Robbie Anderson"]]);

function parseArgs(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir") options.dataDir = argv[++index];
    if (argument === "--manager-map") options.managerMap = argv[++index];
    if (argument === "--output") options.output = argv[++index];
    if (argument === "--active-season") options.activeSeason = Number(argv[++index]);
    if (argument === "--exclude-manager") options.excludeManager = argv[++index];
  }
  return options;
}

function parseManagerMap(csvText) {
  const [header, ...rows] = csvText.trim().split(/\r?\n/);
  if (header !== "observed_manager_name,manager_id") {
    throw new Error("The manager map must contain observed_manager_name,manager_id headers.");
  }
  const map = new Map();
  for (const row of rows) {
    const separator = row.indexOf(",");
    const observedManagerName = row.slice(0, separator).trim();
    const managerId = row.slice(separator + 1).trim();
    if (!observedManagerName || !managerId) throw new Error(`Invalid manager map row: ${row}`);
    map.set(observedManagerName, managerId);
  }
  return map;
}

function seasonYear(season, fileName) {
  const candidates = [season.pages?.home?.url, season.pages?.teams?.url, fileName];
  for (const candidate of candidates) {
    const match = String(candidate ?? "").match(/20\d{2}/);
    if (match) return Number(match[0]);
  }
  return null;
}

function teamIdFromLinks(links, year) {
  for (const link of links ?? []) {
    const match = String(link.url ?? "").match(new RegExp(`/${year}/f1/\\d+/(\\d+)(?:[?#]|$)`));
    if (match) return Number(match[1]);
  }
  return null;
}

function matchupDetails(season) {
  const details = Array.isArray(season.captured) ? [...season.captured] : [];
  for (const pages of Object.values(season.matchups ?? {})) {
    if (Array.isArray(pages)) details.push(...pages);
  }
  return details;
}

function profileLabels(page) {
  const profileTable = (page.tables ?? []).find(
    (table) => table.headers?.length === 3 && table.headers[1] === "Category" && / View Profile$/.test(table.headers[0] ?? ""),
  );
  if (!profileTable) return null;
  return [profileTable.headers[0], profileTable.headers[2]].map((label) => label.replace(/ View Profile$/, "").trim());
}

function pageQuality(page) {
  return (page.tables?.length ?? 0) * 1_000 + (page.links?.length ?? 0);
}

function rosterTable(table) {
  const headers = table.headers ?? [];
  return headers.filter((header) => header === "Player").length >= 2
    && headers.filter((header) => header === "Fan Pts").length >= 2
    && headers.filter((header) => header === "Pos").length >= 3;
}

function slotRun(cells) {
  for (let index = 0; index <= cells.length - 3; index += 1) {
    const slot = String(cells[index] ?? "").trim();
    if (!slot || slot === "Pos") continue;
    if (slot === String(cells[index + 1] ?? "").trim() && slot === String(cells[index + 2] ?? "").trim()) {
      return { slot, index };
    }
  }
  return null;
}

function playerName(value) {
  const name = String(value ?? "")
    .replace(/Video(?:\s|Forecast|$).*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return playerAliases.get(name) ?? name;
}

function points(value) {
  const number = Number(String(value ?? "").replace(/,/gu, ""));
  return Number.isFinite(number) ? number : null;
}

function rosterEntries(page) {
  const entries = [];
  for (const table of page.tables ?? []) {
    if (!rosterTable(table)) continue;
    for (const row of table.rows ?? []) {
      const cells = row.cells ?? [];
      const run = slotRun(cells);
      if (!run) continue;
      entries.push([
        { player: playerName(cells[run.index - 3]), points: points(cells[run.index - 1]), slot: run.slot },
        { player: playerName(cells[run.index + 5]), points: points(cells[run.index + 3]), slot: run.slot },
      ]);
    }
  }
  return entries;
}

function matchupScores(page) {
  for (const table of page.tables ?? []) {
    for (const row of table.rows ?? []) {
      const [left, label, right] = row.cells ?? [];
      if (String(label ?? "").trim() === "Points") return [points(left), points(right)];
    }
  }
  return [null, null];
}

function isPlayer(entry) {
  return entry.player && !["(Empty)", "Player", "Total"].includes(entry.player);
}

function isStarter(entry) {
  return isPlayer(entry) && !inactiveSlots.has(entry.slot) && entry.points !== null;
}

function eligibleSlots(role) {
  if (["RB", "WR", "TE"].includes(role)) return new Set([role, "W/R/T"]);
  return new Set([role]);
}

function addRole(playerRoles, entry) {
  if (!isStarter(entry) || !fixedSlots.has(entry.slot)) return;
  if (!playerRoles.has(entry.player)) playerRoles.set(entry.player, new Map());
  const roles = playerRoles.get(entry.player);
  roles.set(entry.slot, (roles.get(entry.slot) ?? 0) + 1);
}

function rolesFor(playerRoles, player) {
  return new Set(playerRoles.get(player)?.keys() ?? []);
}

function regretStat(stats, manager, player) {
  const players = stats.get(manager);
  if (!players.has(player)) players.set(player, { points: 0, decisions: 0, peak: 0, matchupFlips: 0 });
  return players.get(player);
}

function addRegret(stats, manager, entries, playerRoles, ownScore, opponentScore, summary) {
  const starters = entries.filter(isStarter);
  let flippedMatchup = false;
  for (const entry of entries) {
    if (!isPlayer(entry) || !benchSlots.has(entry.slot) || entry.points === null) continue;
    const roles = rolesFor(playerRoles, entry.player);
    if (roles.size === 0) {
      summary.unknownPositionBenchEntries += 1;
      continue;
    }
    const eligible = starters.filter((starter) => [...roles].some((role) => eligibleSlots(role).has(starter.slot)));
    if (eligible.length === 0) {
      summary.noEligibleStarterEntries += 1;
      continue;
    }
    const baseline = Math.min(...eligible.map((starter) => starter.points));
    const missedPoints = entry.points - baseline;
    if (missedPoints <= 0) continue;
    const stat = regretStat(stats, manager, entry.player);
    stat.points += missedPoints;
    stat.decisions += 1;
    stat.peak = Math.max(stat.peak, missedPoints);
    if (ownScore !== null && opponentScore !== null && ownScore <= opponentScore && ownScore + missedPoints > opponentScore) {
      stat.matchupFlips += 1;
      summary.matchupFlips += 1;
      flippedMatchup = true;
    }
    summary.regretDecisions += 1;
  }
  return flippedMatchup;
}

function topPlayer(players) {
  return [...players.entries()].sort((left, right) => right[1].points - left[1].points
    || right[1].decisions - left[1].decisions
    || left[0].localeCompare(right[0]))[0] ?? null;
}

function topFlippers(players) {
  const candidates = [...players.entries()].filter(([, stat]) => stat.matchupFlips > 0)
    .sort((left, right) => right[1].matchupFlips - left[1].matchupFlips
      || right[1].points - left[1].points
      || left[0].localeCompare(right[0]));
  if (candidates.length === 0) return [];
  return candidates.filter(([, stat]) => stat.matchupFlips === candidates[0][1].matchupFlips);
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function renderHtml({ managerOrder, stats, managerOpportunities, summary }) {
  const rows = managerOrder.map((manager) => {
    const result = topPlayer(stats.get(manager) ?? new Map());
    const flippers = topFlippers(stats.get(manager) ?? new Map());
    const regretCell = result
      ? `<td><strong>${escapeHtml(result[0])}</strong><small>${formatNumber(result[1].points, 1)} cumulative missed points · ${formatNumber(result[1].decisions)} lineup decisions · largest single miss: ${formatNumber(result[1].peak, 1)}</small></td>`
      : '<td class="empty">No qualifying bench regret</td>';
    const flipCell = flippers.length > 0
      ? `<td><strong>${flippers.map(([player]) => escapeHtml(player)).join(" · ")}</strong><small>${formatNumber(flippers[0][1].matchupFlips)} matchup wins left on the bench${flippers.length > 1 ? " apiece" : ""}</small></td>`
      : '<td class="empty">No matchup flipped by one swap</td>';
    return `<tr><th scope="row">${escapeHtml(manager)}</th>${regretCell}${flipCell}<td>${formatNumber(managerOpportunities.get(manager) ?? 0)}</td></tr>`;
  }).join("");

  return `<div id="lineup-regret">
  <style>
    #lineup-regret { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #lineup-regret h2 { margin: 0 0 0.25rem; }
    #lineup-regret .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #lineup-regret .table-responsive { overflow-x: auto; }
    #lineup-regret table { width: 100%; min-width: 1080px; border-collapse: collapse; }
    #lineup-regret th, #lineup-regret td { padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    #lineup-regret thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #lineup-regret tbody th { white-space: nowrap; font-weight: 600; }
    #lineup-regret td strong, #lineup-regret td small { display: block; }
    #lineup-regret td small, #lineup-regret .empty { margin-top: 0.18rem; color: var(--muted-foreground); }
  </style>
  <h2>All-time own-team nemeses</h2>
  <p class="scope">${summary.activeManagers} active ${summary.activeSeason} managers · all ${summary.years} matchup pages (regular season and postseason)${summary.excludeManager ? ` · ${escapeHtml(summary.excludeManager)} excluded` : ""}. For each bench player, missed points equal that player’s score minus the lowest score among starters they could replace. A matchup flip is a loss or tie that would become a win after that one swap. A missed-out win opportunity counts each matchup once, even if several bench players could flip it. RB, WR, and TE players can replace a W/R/T flex starter. Player positions come from their observed non-flex starts in the saved history.</p>
  <div class="table-responsive"><table aria-label="All-time lineup regret by manager"><thead><tr><th scope="col">Manager</th><th scope="col">Largest cumulative lineup regret</th><th scope="col">Most matchup flips</th><th scope="col">Missed-out win opportunities</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, "utf8"));
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith("-history.json"));
const teamLabels = new Map();
const detailsByUrl = new Map();
const years = new Set();

for (const fileName of historyFiles) {
  const exportFile = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), "utf8"));
  for (const season of exportFile.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (year) years.add(year);
    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const [, observedManagerName] = row.cells ?? [];
        const teamId = teamIdFromLinks(row.links, year);
        if (teamId && observedManagerName) teamLabels.set(`${year}|${teamId}`, String(observedManagerName).trim());
      }
    }
    for (const page of matchupDetails(season)) {
      const match = String(page.url ?? "").match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=\d+&mid1=(\d+)&mid2=(\d+)/);
      if (!match) continue;
      const [, pageYear, mid1, mid2] = match;
      const labels = profileLabels(page);
      if (labels) {
        teamLabels.set(`${pageYear}|${mid1}`, labels[0]);
        teamLabels.set(`${pageYear}|${mid2}`, labels[1]);
      }
      const existing = detailsByUrl.get(page.url);
      if (!existing || pageQuality(page) > pageQuality(existing)) detailsByUrl.set(page.url, page);
    }
  }
}

options.activeSeason ??= Math.max(...[...teamLabels.keys()].map((key) => Number(key.split("|")[0])));
const activeManagers = new Set();
for (const [key, observedManagerName] of teamLabels) {
  const [year] = key.split("|").map(Number);
  if (year !== options.activeSeason) continue;
  const manager = managerMap.get(observedManagerName);
  if (manager && manager !== options.excludeManager) activeManagers.add(manager);
}
if (activeManagers.size === 0) throw new Error(`No active managers were found for ${options.activeSeason}.`);

const managerOrder = [...activeManagers].sort((left, right) => left.localeCompare(right));
const playerRoles = new Map();
for (const page of detailsByUrl.values()) {
  for (const [left, right] of rosterEntries(page)) {
    addRole(playerRoles, left);
    addRole(playerRoles, right);
  }
}

const stats = new Map(managerOrder.map((manager) => [manager, new Map()]));
const managerOpportunities = new Map(managerOrder.map((manager) => [manager, 0]));
const summary = {
  activeManagers: managerOrder.length,
  activeSeason: options.activeSeason,
  excludeManager: options.excludeManager,
  years: `${Math.min(...years)}–${Math.max(...years)}`,
  matchupPages: detailsByUrl.size,
  processedPages: 0,
  excludedFormerManagerPages: 0,
  missingManagerPages: 0,
  scoredPages: 0,
  missingScorePages: 0,
  regretDecisions: 0,
  matchupFlips: 0,
  missedOutWinOpportunities: 0,
  unknownPositionBenchEntries: 0,
  noEligibleStarterEntries: 0,
};

for (const [url, page] of detailsByUrl) {
  const match = url.match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=\d+&mid1=(\d+)&mid2=(\d+)/);
  if (!match) continue;
  const [, year, mid1, mid2] = match;
  const manager1 = managerMap.get(teamLabels.get(`${year}|${mid1}`));
  const manager2 = managerMap.get(teamLabels.get(`${year}|${mid2}`));
  if (!manager1 || !manager2) {
    summary.missingManagerPages += 1;
    continue;
  }
  if (!activeManagers.has(manager1) || !activeManagers.has(manager2)) {
    summary.excludedFormerManagerPages += 1;
    continue;
  }
  const rows = rosterEntries(page);
  const [score1, score2] = matchupScores(page);
  summary.processedPages += 1;
  if (score1 === null || score2 === null) summary.missingScorePages += 1;
  else summary.scoredPages += 1;
  const manager1Flipped = addRegret(stats, manager1, rows.map(([left]) => left), playerRoles, score1, score2, summary);
  const manager2Flipped = addRegret(stats, manager2, rows.map(([, right]) => right), playerRoles, score2, score1, summary);
  if (manager1Flipped) {
    managerOpportunities.set(manager1, managerOpportunities.get(manager1) + 1);
    summary.missedOutWinOpportunities += 1;
  }
  if (manager2Flipped) {
    managerOpportunities.set(manager2, managerOpportunities.get(manager2) + 1);
    summary.missedOutWinOpportunities += 1;
  }
}

const results = managerOrder.map((manager) => {
  const result = topPlayer(stats.get(manager));
  const flippers = topFlippers(stats.get(manager));
  return {
    manager,
    player: result?.[0] ?? null,
    missedPoints: result && Number(result[1].points.toFixed(1)),
    decisions: result?.[1].decisions ?? 0,
    largestSingleMiss: result && Number(result[1].peak.toFixed(1)),
    matchupFlipPlayers: flippers.map(([player]) => player),
    matchupFlips: flippers[0]?.[1].matchupFlips ?? 0,
    missedOutWinOpportunities: managerOpportunities.get(manager),
  };
});
const output = renderHtml({ managerOrder, stats, managerOpportunities, summary });
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, output);

console.log(JSON.stringify({ ...summary, results }, null, 2));
