import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  dataDir: "data",
  managerMap: "data/manager-identity-map.csv",
  output: "reports/all-time-favorite-players.html",
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

function playerStat(stats, manager, player) {
  if (!stats.has(manager)) stats.set(manager, new Map());
  const players = stats.get(manager);
  if (!players.has(player)) players.set(player, { starts: 0, points: 0, bench: 0 });
  return players.get(player);
}

function isBench(slot) {
  return ["BN", "BENCH"].includes(slot);
}

function isStarter(slot) {
  return !["BN", "BENCH", "IR", "IR+", "NA", "IL"].includes(slot);
}

function addPlayer(stats, manager, entry) {
  if (!entry.player || ["(Empty)", "Player", "Total"].includes(entry.player)) return false;
  const stat = playerStat(stats, manager, entry.player);
  if (isBench(entry.slot)) {
    stat.bench += 1;
    return true;
  }
  if (!isStarter(entry.slot) || entry.points === null) return false;
  stat.starts += 1;
  stat.points += entry.points;
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

function metricCell(result, detail, secondary = null, nonDefense = null) {
  if (!result) return '<td class="empty">No qualifying player</td>';
  const note = secondary ? `<small class="non-kicker">Top non-kicker: ${escapeHtml(secondary[0])} · ${formatNumber(secondary[1].starts)} starts</small>` : "";
  const extra = nonDefense ? `<small class="non-kicker">Top non-kicker/non-defense: ${escapeHtml(nonDefense[0])} · ${formatNumber(nonDefense[1].starts)} starts</small>` : "";
  return `<td><strong>${escapeHtml(result[0])}</strong><small>${escapeHtml(detail(result[1]))}</small>${note}${extra}</td>`;
}

function draftCell(players) {
  const maximum = Math.max(0, ...[...players.values()].map((years) => years.size));
  if (!maximum) return '<td class="empty">No draft data</td>';
  const leaders = [...players].filter(([, years]) => years.size === maximum)
    .sort(([left], [right]) => left.localeCompare(right));
  const entries = leaders.map(([player, years]) =>
    `<strong>${escapeHtml(player)}</strong><small>${maximum} drafts · ${[...years].sort().join(", ")}</small>`
  ).join("");
  if (leaders.length > 1) return `<td><details><summary>${leaders.length} players tied · ${maximum} drafts</summary>${entries}</details></td>`;
  return '<td>' + entries + '</td>';
}

function renderHtml({ managerOrder, stats, summary, drafts }) {
  const rows = managerOrder.map((manager) => {
    const players = stats.get(manager) ?? new Map();
    const nonKickers = new Map([...players].filter(([player]) => !kickers.has(player)));
    const byStarts = (left, right) => right[1].starts - left[1].starts || right[1].points - left[1].points || left[0].localeCompare(right[0]);
    const mostStarted = topPlayer(players, byStarts);
    const secondary = mostStarted && kickers.has(mostStarted[0]) ? topPlayer(nonKickers, byStarts) : null;
    const nonDefense = manager === "Ryan Harrigan"
      ? topPlayer(new Map([...nonKickers].filter(([player]) => !defenses.has(player))), byStarts)
      : null;
    const mostPoints = topPlayer(players, (left, right) => right[1].points - left[1].points || right[1].starts - left[1].starts || left[0].localeCompare(right[0]));
    const bestPpg = topPlayer(players, (left, right) => right[1].points / right[1].starts - left[1].points / left[1].starts || right[1].starts - left[1].starts || left[0].localeCompare(right[0]), (stat) => stat.starts >= 10);
    const mostBench = topPlayer(players, (left, right) => right[1].bench - left[1].bench || left[0].localeCompare(right[0]), (stat) => stat.bench > 0);
    return `<tr><th scope="row">${escapeHtml(manager)}</th>${metricCell(mostStarted, (stat) => `${formatNumber(stat.starts)} starts`, secondary, nonDefense)}${metricCell(mostPoints, (stat) => `${formatNumber(stat.points, 1)} fantasy points`)}${metricCell(bestPpg, (stat) => `${formatNumber(stat.points / stat.starts, 2)} points/start · ${formatNumber(stat.starts)} starts`)}${metricCell(mostBench, (stat) => `${formatNumber(stat.bench)} bench appearances`)}${draftCell(drafts.get(manager))}</tr>`;
  }).join("");

  return `<div id="all-time-favorite-players">
  <style>
    #all-time-favorite-players { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #all-time-favorite-players h2 { margin: 0 0 0.25rem; }
    #all-time-favorite-players .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #all-time-favorite-players .table-responsive { overflow-x: auto; }
    #all-time-favorite-players table { width: 100%; min-width: 940px; border-collapse: collapse; }
    #all-time-favorite-players th, #all-time-favorite-players td { padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    #all-time-favorite-players thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #all-time-favorite-players tbody th { white-space: nowrap; font-weight: 600; }
    #all-time-favorite-players td strong, #all-time-favorite-players td small { display: block; }
    #all-time-favorite-players td small { margin-top: 0.18rem; color: var(--muted-foreground); }
    #all-time-favorite-players .empty { color: var(--muted-foreground); }
    #all-time-favorite-players td .non-kicker { margin-top: 0.6rem; }
  </style>
  <h2>All-time favorite players</h2>
  <p class="scope">${summary.activeManagers} active ${summary.activeSeason} managers · all ${summary.years} matchup pages (regular season and postseason)${summary.excludeManager ? ` · ${escapeHtml(summary.excludeManager)} excluded` : ""}. “Bench” means a recorded BN roster slot; points per start requires at least 10 starts.</p>
  <p class="scope">Draft coverage: ${summary.draftYears[0]}–${summary.draftYears.at(-1)} · tied draft leaders shown.</p>
  <div class="table-responsive"><table aria-label="All-time favorite players by manager"><thead><tr><th scope="col">Manager</th><th scope="col">Most started</th><th scope="col">Most fantasy points</th><th scope="col">Best points per start</th><th scope="col">Most bench appearances</th><th scope="col">Most drafted</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, "utf8"));
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith("-history.json"));
const teamLabels = new Map();
const detailsByUrl = new Map();
const years = new Set();
const draftSelections = new Map();
const teamNames = new Map();

for (const fileName of historyFiles) {
  const exportFile = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), "utf8"));
  for (const season of exportFile.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (year) years.add(year);
    for (const table of season.pages?.draftresults?.tables ?? []) {
      if (!/^Round \d+$/.test(table.headers?.[0] ?? "")) continue;
      for (const row of table.rows ?? []) {
        const [pick, player, team] = row.cells ?? [];
        if (!/^\d+\.$/.test(String(pick)) || !player || !team) continue;
        const key = `${year}|${table.headers[0]}|${pick}`;
        const selection = { year, player: playerName(player), team: String(team).trim() };
        const previous = draftSelections.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(selection)) throw new Error(`Conflicting draft selection: ${key}`);
        draftSelections.set(key, selection);
      }
    }
    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const [teamName, observedManagerName] = row.cells ?? [];
        if (teamName && observedManagerName) teamNames.set(`${year}|${String(teamName).trim()}`, String(observedManagerName).trim());
        const teamId = teamIdFromLinks(row.links, year);
        if (teamId && teamName && observedManagerName) teamLabels.set(`${year}|${teamId}`, String(observedManagerName).trim());
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
const summary = {
  activeManagers: managerOrder.length,
  activeSeason: options.activeSeason,
  excludeManager: options.excludeManager,
  years: `${Math.min(...years)}–${Math.max(...years)}`,
  matchupPages: detailsByUrl.size,
  processedPages: 0,
  excludedFormerManagerPages: 0,
  missingManagerPages: 0,
  rosterRows: 0,
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
    summary.rosterRows += Number(addPlayer(stats, manager1, left));
    summary.rosterRows += Number(addPlayer(stats, manager2, right));
  }
}

const drafts = new Map(managerOrder.map((manager) => [manager, new Map()]));
for (const selection of draftSelections.values()) {
  const manager = managerMap.get(teamNames.get(`${selection.year}|${selection.team}`));
  if (!manager) throw new Error(`Unmapped draft team in ${selection.year}: ${selection.team}`);
  if (!drafts.has(manager)) continue;
  const players = drafts.get(manager);
  if (!players.has(selection.player)) players.set(selection.player, new Set());
  players.get(selection.player).add(selection.year);
}
summary.draftYears = [...new Set([...draftSelections.values()].map((selection) => selection.year))].sort();
summary.draftSelections = draftSelections.size;
const defenses = new Set([...detailsByUrl.values()].flatMap((page) => rosterEntries(page).flat())
  .filter((entry) => ["DEF", "DST", "D/ST"].includes(entry.slot)).map((entry) => entry.player));
const kickers = new Set([...detailsByUrl.values()].flatMap((page) => rosterEntries(page).flat())
  .filter((entry) => entry.slot === "K").map((entry) => entry.player));
const output = renderHtml({ managerOrder, stats, summary, drafts });
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, output);

console.log(JSON.stringify({ ...summary, managers: managerOrder }, null, 2));
