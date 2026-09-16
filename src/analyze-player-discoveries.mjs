import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  dataDir: "data",
  managerMap: "data/manager-identity-map.csv",
  output: "reports/player-discoveries.html",
  activeSeason: null,
  excludeManager: null,
  minimumDiscovererStarts: 4,
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
    if (argument === "--minimum-discoverer-starts") options.minimumDiscovererStarts = Number(argv[++index]);
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

function playerKey(value) {
  return playerName(value)
    .replace(/\s+-\s+DEF$/iu, " DST")
    .replace(/\s+D\/ST$/iu, " DST")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
}

function points(value) {
  const number = Number(String(value ?? "").replace(/,/gu, ""));
  return Number.isFinite(number) ? number : null;
}

function isStarter(slot) {
  return ["QB", "RB", "WR", "TE", "K", "DEF", "W/R", "W/T", "R/T", "W/R/T"].includes(slot);
}

function starterEntries(page) {
  const entries = [];
  for (const table of page.tables ?? []) {
    if (!rosterTable(table)) continue;
    for (const row of table.rows ?? []) {
      const cells = row.cells ?? [];
      const run = slotRun(cells);
      if (!run || !isStarter(run.slot)) continue;
      const leftName = playerName(cells[run.index - 3]);
      const rightName = playerName(cells[run.index + 5]);
      const leftPoints = points(cells[run.index - 1]);
      const rightPoints = points(cells[run.index + 3]);
      if (leftName && !["(Empty)", "Player", "Total"].includes(leftName) && leftPoints !== null) entries.push({ side: 0, name: leftName, points: leftPoints, slot: run.slot });
      if (rightName && !["(Empty)", "Player", "Total"].includes(rightName) && rightPoints !== null) entries.push({ side: 1, name: rightName, points: rightPoints, slot: run.slot });
    }
  }
  return entries;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function primarySlot(slotCounts) {
  const slot = [...slotCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  if (!slot) return "Not started";
  return slot.includes("/") ? "Flex" : slot;
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function signedPoints(value) {
  return `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value), 1)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function renderHtml({ rows, summary }) {
  const body = rows.slice(0, 50).map((row, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(row.player)}</strong><small>${row.position} · ${row.leagueStarts} league starts</small></td><td>${escapeHtml(row.discoverer)}</td><td>${row.firstYear}, W${row.firstWeek}</td><td>${row.discovererStarts}</td><td>${formatNumber(row.leagueStarterPoints, 1)}</td><td class="${row.leagueLineupValue >= 0 ? "positive" : "negative"}">${signedPoints(row.leagueLineupValue)}</td></tr>`).join("");
  return `<div id="player-discoveries">
  <style>
    #player-discoveries { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #player-discoveries h2 { margin: 0 0 0.25rem; }
    #player-discoveries .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #player-discoveries .table-responsive { overflow-x: auto; }
    #player-discoveries table { width: 100%; min-width: 860px; border-collapse: collapse; }
    #player-discoveries th, #player-discoveries td { padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--border); text-align: right; vertical-align: top; }
    #player-discoveries th:nth-child(2), #player-discoveries th:nth-child(3), #player-discoveries td:nth-child(2), #player-discoveries td:nth-child(3) { text-align: left; }
    #player-discoveries thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #player-discoveries td small { display: block; margin-top: 0.15rem; color: var(--muted-foreground); }
    #player-discoveries .positive { color: var(--green); }
    #player-discoveries .negative { color: var(--red); }
  </style>
  <h2>Player discoveries</h2>
  <p class="scope">${summary.years} · the first league manager to start a player qualifies after at least ${summary.minimumDiscovererStarts} starts. Team defenses and 2010 Week 1 are excluded. League lineup value compares every later start with the season median for that roster slot.${summary.excludeManager ? ` ${escapeHtml(summary.excludeManager)} is excluded.` : ""}</p>
  <div class="table-responsive"><table aria-label="Player discoveries ranked by league lineup value"><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Discoverer</th><th scope="col">First start</th><th scope="col">Discoverer starts</th><th scope="col">League starter points</th><th scope="col">League lineup value</th></tr></thead><tbody>${body}</tbody></table></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, "utf8"));
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith("-history.json"));
const teamManagers = new Map();
const detailsByUrl = new Map();

for (const fileName of historyFiles) {
  const exportFile = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), "utf8"));
  for (const season of exportFile.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (!year) continue;
    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const [, observedManagerName] = row.cells ?? [];
        const teamId = teamIdFromLinks(row.links, year);
        if (teamId && observedManagerName) teamManagers.set(`${year}|${teamId}`, String(observedManagerName).trim());
      }
    }
    for (const page of matchupDetails(season)) {
      const match = String(page.url ?? "").match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
      if (!match) continue;
      const [, pageYear, , mid1, mid2] = match;
      const labels = profileLabels(page);
      if (labels) {
        teamManagers.set(`${pageYear}|${mid1}`, labels[0]);
        teamManagers.set(`${pageYear}|${mid2}`, labels[1]);
      }
      const existing = detailsByUrl.get(page.url);
      if (!existing || pageQuality(page) > pageQuality(existing)) detailsByUrl.set(page.url, page);
    }
  }
}

options.activeSeason ??= Math.max(...[...teamManagers.keys()].map((key) => Number(key.split("|")[0])));
const activeManagers = new Set();
for (const [key, observedManager] of teamManagers) {
  const [year] = key.split("|").map(Number);
  if (year !== options.activeSeason) continue;
  const manager = managerMap.get(observedManager);
  if (manager && manager !== options.excludeManager) activeManagers.add(manager);
}
if (activeManagers.size === 0) throw new Error(`No active managers were found for ${options.activeSeason}.`);

const events = [];
for (const [url, page] of detailsByUrl) {
  const match = url.match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
  if (!match) continue;
  const [, yearText, weekText, mid1, mid2] = match;
  const year = Number(yearText);
  const week = Number(weekText);
  if (year === 2010 && week === 1) continue;
  const managers = [managerMap.get(teamManagers.get(`${year}|${mid1}`)), managerMap.get(teamManagers.get(`${year}|${mid2}`))];
  for (const entry of starterEntries(page)) {
    const manager = managers[entry.side];
    if (!activeManagers.has(manager) || entry.slot === "DEF") continue;
    events.push({ year, week, manager, player: entry.name, playerKey: playerKey(entry.name), points: entry.points, slot: entry.slot });
  }
}

const slotPoints = new Map();
for (const event of events) {
  const key = `${event.year}|${event.slot}`;
  if (!slotPoints.has(key)) slotPoints.set(key, []);
  slotPoints.get(key).push(event.points);
}
const slotMedians = new Map([...slotPoints].map(([key, values]) => [key, median(values)]));
for (const event of events) event.lineupValue = event.points - slotMedians.get(`${event.year}|${event.slot}`);

const playerEvents = new Map();
for (const event of events) {
  if (!playerEvents.has(event.playerKey)) playerEvents.set(event.playerKey, []);
  playerEvents.get(event.playerKey).push(event);
}

const discoveries = [];
for (const [key, starts] of playerEvents) {
  starts.sort((left, right) => left.year - right.year || left.week - right.week || left.manager.localeCompare(right.manager));
  const first = starts[0];
  const discovererStarts = starts.filter((start) => start.manager === first.manager);
  if (discovererStarts.length < options.minimumDiscovererStarts) continue;
  const slotCounts = new Map();
  for (const start of starts) slotCounts.set(start.slot, (slotCounts.get(start.slot) ?? 0) + 1);
  discoveries.push({
    playerKey: key,
    player: first.player,
    discoverer: first.manager,
    firstYear: first.year,
    firstWeek: first.week,
    discovererStarts: discovererStarts.length,
    leagueStarts: starts.length,
    leagueStarterPoints: starts.reduce((sum, start) => sum + start.points, 0),
    leagueLineupValue: starts.reduce((sum, start) => sum + start.lineupValue, 0),
    position: primarySlot(slotCounts),
  });
}

discoveries.sort((left, right) => right.leagueLineupValue - left.leagueLineupValue || right.leagueStarterPoints - left.leagueStarterPoints || left.player.localeCompare(right.player));
const years = [...new Set(events.map((event) => event.year))].sort((left, right) => left - right);
const summary = {
  activeManagers: activeManagers.size,
  years: `${years[0]}–${years.at(-1)}`,
  minimumDiscovererStarts: options.minimumDiscovererStarts,
  excludeManager: options.excludeManager,
  events: events.length,
  discoveries: discoveries.length,
};
const output = renderHtml({ rows: discoveries, summary });
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, output);

console.log(JSON.stringify({ ...summary, topDiscoveries: discoveries.slice(0, 10).map((row) => ({ player: row.player, discoverer: row.discoverer, firstStart: `${row.firstYear} W${row.firstWeek}`, discovererStarts: row.discovererStarts, leagueLineupValue: Number(row.leagueLineupValue.toFixed(1)) })) }, null, 2));
