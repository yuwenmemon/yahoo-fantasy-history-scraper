import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  dataDir: "data",
  managerMap: "data/manager-identity-map.csv",
  output: "reports/nemesis-players.html",
  activeSeason: null,
  excludeManager: null,
};

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
  return String(value ?? "")
    .replace(/Video(?:\s|Forecast|$).*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
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
      const left = {
        player: playerName(cells[run.index - 3]),
        points: points(cells[run.index - 1]),
        slot: run.slot,
      };
      const right = {
        player: playerName(cells[run.index + 5]),
        points: points(cells[run.index + 3]),
        slot: run.slot,
      };
      entries.push([left, right]);
    }
  }
  return entries;
}

function isStarter(slot) {
  return !["BN", "BENCH", "IR", "IR+", "NA", "IL"].includes(slot);
}

function isTeamDefense(slot) {
  return ["DEF", "DST", "D/ST"].includes(slot);
}

function isPositionPlayer(slot) {
  return !["QB", "K", "DEF", "DST", "D/ST"].includes(slot);
}

function opponentStat(stats, manager, player) {
  const players = stats.get(manager);
  if (!players.has(player)) players.set(player, { starts: 0, points: 0 });
  return players.get(player);
}

function addOpponent(stats, positionStats, manager, entry) {
  if (!entry.player || ["(Empty)", "Player", "Total"].includes(entry.player)) return false;
  if (isTeamDefense(entry.slot) || !isStarter(entry.slot) || entry.points === null) return false;
  const stat = opponentStat(stats, manager, entry.player);
  stat.starts += 1;
  stat.points += entry.points;
  if (isPositionPlayer(entry.slot)) {
    const positionStat = opponentStat(positionStats, manager, entry.player);
    positionStat.starts += 1;
    positionStat.points += entry.points;
  }
  return true;
}

function topPlayer(players, comparator, predicate = () => true) {
  return [...players.entries()]
    .filter(([, stat]) => predicate(stat))
    .sort((left, right) => comparator(left, right))[0] ?? null;
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

function metricCell(result, detail, positionResult) {
  if (!result) return '<td class="empty">No qualifying player</td>';
  const positionNote = positionResult
    ? `<small class="position-player">Top non-QB/K/DEF: ${escapeHtml(positionResult[0])} · ${escapeHtml(detail(positionResult[1]))}</small>`
    : "";
  return `<td><strong>${escapeHtml(result[0])}</strong><small>${escapeHtml(detail(result[1]))}</small>${positionNote}</td>`;
}

function renderHtml({ managerOrder, stats, positionStats, summary }) {
  const rows = managerOrder.map((manager) => {
    const players = stats.get(manager) ?? new Map();
    const positionPlayers = positionStats.get(manager) ?? new Map();
    const mostPoints = topPlayer(players, (left, right) => right[1].points - left[1].points || right[1].starts - left[1].starts || left[0].localeCompare(right[0]));
    const mostFaced = topPlayer(players, (left, right) => right[1].starts - left[1].starts || right[1].points - left[1].points || left[0].localeCompare(right[0]));
    const bestPpg = topPlayer(players, (left, right) => right[1].points / right[1].starts - left[1].points / left[1].starts || right[1].starts - left[1].starts || left[0].localeCompare(right[0]), (stat) => stat.starts >= 10);
    const positionMostPoints = topPlayer(positionPlayers, (left, right) => right[1].points - left[1].points || right[1].starts - left[1].starts || left[0].localeCompare(right[0]));
    const positionMostFaced = topPlayer(positionPlayers, (left, right) => right[1].starts - left[1].starts || right[1].points - left[1].points || left[0].localeCompare(right[0]));
    const positionBestPpg = topPlayer(positionPlayers, (left, right) => right[1].points / right[1].starts - left[1].points / left[1].starts || right[1].starts - left[1].starts || left[0].localeCompare(right[0]), (stat) => stat.starts >= 10);
    return `<tr><th scope="row">${escapeHtml(manager)}</th>${metricCell(mostPoints, (stat) => `${formatNumber(stat.points, 1)} fantasy points · ${formatNumber(stat.starts)} starts`, positionMostPoints)}${metricCell(mostFaced, (stat) => `${formatNumber(stat.starts)} starts · ${formatNumber(stat.points, 1)} fantasy points`, positionMostFaced)}${metricCell(bestPpg, (stat) => `${formatNumber(stat.points / stat.starts, 2)} points/start · ${formatNumber(stat.starts)} starts`, positionBestPpg)}</tr>`;
  }).join("");

  return `<div id="nemesis-players">
  <style>
    #nemesis-players { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #nemesis-players h2 { margin: 0 0 0.25rem; }
    #nemesis-players .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #nemesis-players .table-responsive { overflow-x: auto; }
    #nemesis-players table { width: 100%; min-width: 840px; border-collapse: collapse; }
    #nemesis-players th, #nemesis-players td { padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    #nemesis-players thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #nemesis-players tbody th { white-space: nowrap; font-weight: 600; }
    #nemesis-players td strong, #nemesis-players td small { display: block; }
    #nemesis-players td small { margin-top: 0.18rem; color: var(--muted-foreground); }
    #nemesis-players td .position-player { margin-top: 0.6rem; }
    #nemesis-players .empty { color: var(--muted-foreground); }
  </style>
  <h2>All-time nemesis players</h2>
  <p class="scope">${summary.activeManagers} active ${summary.activeSeason} managers · all ${summary.years} matchup pages (regular season and postseason)${summary.excludeManager ? ` · ${escapeHtml(summary.excludeManager)} excluded` : ""}. Each stat includes opposing starters only. Team defenses are excluded. The secondary line in each cell is the top non-QB/K/DEF player. Points per start requires at least 10 starts against the manager.</p>
  <div class="table-responsive"><table aria-label="All-time nemesis players by manager"><thead><tr><th scope="col">Manager</th><th scope="col">Most points scored against them</th><th scope="col">Most faced</th><th scope="col">Highest points per start</th></tr></thead><tbody>${rows}</tbody></table></div>
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
const stats = new Map(managerOrder.map((manager) => [manager, new Map()]));
const positionStats = new Map(managerOrder.map((manager) => [manager, new Map()]));
const summary = {
  activeManagers: managerOrder.length,
  activeSeason: options.activeSeason,
  excludeManager: options.excludeManager,
  years: `${Math.min(...years)}–${Math.max(...years)}`,
  matchupPages: detailsByUrl.size,
  processedPages: 0,
  excludedFormerManagerPages: 0,
  missingManagerPages: 0,
  opposingStarterRows: 0,
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
  summary.processedPages += 1;
  for (const [left, right] of rosterEntries(page)) {
    summary.opposingStarterRows += Number(addOpponent(stats, positionStats, manager1, right));
    summary.opposingStarterRows += Number(addOpponent(stats, positionStats, manager2, left));
  }
}

const nemeses = managerOrder.map((manager) => {
  const players = stats.get(manager);
  const positionPlayers = positionStats.get(manager);
  const mostPoints = topPlayer(players, (left, right) => right[1].points - left[1].points || right[1].starts - left[1].starts || left[0].localeCompare(right[0]));
  const mostFaced = topPlayer(players, (left, right) => right[1].starts - left[1].starts || right[1].points - left[1].points || left[0].localeCompare(right[0]));
  const bestPpg = topPlayer(players, (left, right) => right[1].points / right[1].starts - left[1].points / left[1].starts || right[1].starts - left[1].starts || left[0].localeCompare(right[0]), (stat) => stat.starts >= 10);
  const positionMostPoints = topPlayer(positionPlayers, (left, right) => right[1].points - left[1].points || right[1].starts - left[1].starts || left[0].localeCompare(right[0]));
  const positionMostFaced = topPlayer(positionPlayers, (left, right) => right[1].starts - left[1].starts || right[1].points - left[1].points || left[0].localeCompare(right[0]));
  const positionBestPpg = topPlayer(positionPlayers, (left, right) => right[1].points / right[1].starts - left[1].points / left[1].starts || right[1].starts - left[1].starts || left[0].localeCompare(right[0]), (stat) => stat.starts >= 10);
  return {
    manager,
    mostPoints: mostPoints && { player: mostPoints[0], points: Number(mostPoints[1].points.toFixed(1)), starts: mostPoints[1].starts },
    mostFaced: mostFaced && { player: mostFaced[0], points: Number(mostFaced[1].points.toFixed(1)), starts: mostFaced[1].starts },
    bestPpg: bestPpg && { player: bestPpg[0], pointsPerStart: Number((bestPpg[1].points / bestPpg[1].starts).toFixed(2)), starts: bestPpg[1].starts },
    positionMostPoints: positionMostPoints && { player: positionMostPoints[0], points: Number(positionMostPoints[1].points.toFixed(1)), starts: positionMostPoints[1].starts },
    positionMostFaced: positionMostFaced && { player: positionMostFaced[0], points: Number(positionMostFaced[1].points.toFixed(1)), starts: positionMostFaced[1].starts },
    positionBestPpg: positionBestPpg && { player: positionBestPpg[0], pointsPerStart: Number((positionBestPpg[1].points / positionBestPpg[1].starts).toFixed(2)), starts: positionBestPpg[1].starts },
  };
});
const output = renderHtml({ managerOrder, stats, positionStats, summary });
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, output);

console.log(JSON.stringify({ ...summary, nemeses }, null, 2));
