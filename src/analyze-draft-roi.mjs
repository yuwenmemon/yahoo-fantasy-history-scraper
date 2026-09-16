import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  dataDir: "data",
  managerMap: "data/manager-identity-map.csv",
  output: "reports/draft-roi.html",
  activeSeason: null,
  excludeManager: null,
  season: null,
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
    if (argument === "--season") options.season = Number(argv[++index]);
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
  const candidates = [season.pages?.home?.url, season.pages?.teams?.url, season.pages?.draftresults?.url, fileName];
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

function draftPageQuality(page) {
  return (page.tables ?? []).filter((table) => /^Round \d+$/u.test(table.headers?.[0] ?? "")).length * 1_000 + (page.links?.length ?? 0);
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

function roundSelections(page) {
  const selections = [];
  for (const table of page.tables ?? []) {
    const roundMatch = String(table.headers?.[0] ?? "").match(/^Round (\d+)$/u);
    if (!roundMatch) continue;
    const round = Number(roundMatch[1]);
    for (const row of table.rows ?? []) {
      const [pickText, player, team] = row.cells ?? [];
      const pickInRound = Number(String(pickText ?? "").replace(/\D/gu, ""));
      if (!pickInRound || !player || !team) continue;
      selections.push({ round, pickInRound, player: playerName(player), team: String(team).trim() });
    }
  }
  return selections
    .sort((left, right) => left.round - right.round || left.pickInRound - right.pickInRound)
    .map((selection, index) => ({ ...selection, overallPick: index + 1 }));
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function signedPoints(value) {
  return `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value), 1)}`;
}

function renderHtml({ rows, summary }) {
  const body = rows.slice(0, summary.displayLimit).map((row, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(row.player)} (${row.year})</strong><small>${row.position} · ${row.starts} starts</small></td><td>${escapeHtml(row.manager)}</td><td>${row.overallPick}</td><td>${row.round}</td><td>${formatNumber(row.starterPoints, 1)}</td><td>${signedPoints(row.lineupValue)}</td><td>${formatNumber(row.roundMedianValue, 1)}</td><td class="${row.draftValue >= 0 ? "positive" : "negative"}">${signedPoints(row.draftValue)}</td></tr>`).join("");
  return `<div id="draft-roi">
  <style>
    #draft-roi { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #draft-roi h2 { margin: 0 0 0.25rem; }
    #draft-roi .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #draft-roi .table-responsive { overflow-x: auto; }
    #draft-roi table { width: 100%; min-width: 760px; border-collapse: collapse; }
    #draft-roi th, #draft-roi td { padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--border); text-align: right; }
    #draft-roi th:nth-child(2), #draft-roi th:nth-child(3), #draft-roi td:nth-child(2), #draft-roi td:nth-child(3) { text-align: left; }
    #draft-roi thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #draft-roi td small { display: block; margin-top: 0.15rem; color: var(--muted-foreground); }
    #draft-roi .positive { color: var(--green); }
    #draft-roi .negative { color: var(--red); }
  </style>
  <h2>Draft return on investment</h2>
  <p class="scope">${summary.years} · ${summary.displayLimit === summary.selections ? "all draft selections" : `top ${summary.displayLimit} draft values`} · lineup value compares each start with the season median for that roster slot. Draft ROI is lineup value above the other picks in that season and round.</p>
  <div class="table-responsive"><table aria-label="Top position-adjusted draft values"><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Drafted by</th><th scope="col">Pick</th><th scope="col">Round</th><th scope="col">Starter points</th><th scope="col">Lineup value</th><th scope="col">Round median</th><th scope="col">Draft ROI</th></tr></thead><tbody>${body}</tbody></table></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, "utf8"));
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith("-history.json"));
const teamNames = new Map();
const teamManagers = new Map();
const detailsByUrl = new Map();
const draftPages = new Map();

for (const fileName of historyFiles) {
  const exportFile = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), "utf8"));
  for (const season of exportFile.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (!year) continue;
    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const [teamName, observedManagerName] = row.cells ?? [];
        const teamId = teamIdFromLinks(row.links, year);
        if (teamId && teamName && observedManagerName) {
          teamNames.set(`${year}|${String(teamName).trim()}`, String(observedManagerName).trim());
          teamManagers.set(`${year}|${teamId}`, String(observedManagerName).trim());
        }
      }
    }
    const draftPage = season.pages?.draftresults;
    if (draftPage) {
      const existingDraft = draftPages.get(year);
      if (!existingDraft || draftPageQuality(draftPage) > draftPageQuality(existingDraft)) draftPages.set(year, draftPage);
    }
    for (const page of matchupDetails(season)) {
      const match = String(page.url ?? "").match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=\d+&mid1=(\d+)&mid2=(\d+)/);
      if (!match) continue;
      const [, pageYear, mid1, mid2] = match;
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

const starterEvents = [];
for (const [url, page] of detailsByUrl) {
  const match = url.match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=\d+&mid1=(\d+)&mid2=(\d+)/);
  if (!match) continue;
  const [, year, mid1, mid2] = match;
  const managers = [managerMap.get(teamManagers.get(`${year}|${mid1}`)), managerMap.get(teamManagers.get(`${year}|${mid2}`))];
  for (const entry of starterEntries(page)) {
    const manager = managers[entry.side];
    if (!manager) continue;
    starterEvents.push({ year, manager, player: entry.name, playerKey: playerKey(entry.name), points: entry.points, slot: entry.slot });
  }
}

const slotPoints = new Map();
for (const event of starterEvents) {
  const key = `${event.year}|${event.slot}`;
  if (!slotPoints.has(key)) slotPoints.set(key, []);
  slotPoints.get(key).push(event.points);
}
const slotMedians = new Map([...slotPoints].map(([key, values]) => [key, median(values)]));
const playerStats = new Map();
for (const event of starterEvents) {
  const key = `${event.year}|${event.manager}|${event.playerKey}`;
  if (!playerStats.has(key)) playerStats.set(key, { starterPoints: 0, lineupValue: 0, starts: 0, slotCounts: new Map() });
  const stat = playerStats.get(key);
  stat.starterPoints += event.points;
  stat.lineupValue += event.points - slotMedians.get(`${event.year}|${event.slot}`);
  stat.starts += 1;
  stat.slotCounts.set(event.slot, (stat.slotCounts.get(event.slot) ?? 0) + 1);
}

const draftedRows = [];
const baselineRows = [];
const summary = { activeManagers: activeManagers.size, validDraftSeasons: 0, unrecognizedTeams: 0, excludedFormerManagerPicks: 0 };
for (const [year, draftPage] of draftPages) {
  if (options.season && year !== options.season) continue;
  const selections = roundSelections(draftPage);
  if (!selections.length) continue;
  summary.validDraftSeasons += 1;
  for (const selection of selections) {
    const manager = managerMap.get(teamNames.get(`${year}|${selection.team}`));
    if (!manager) {
      summary.unrecognizedTeams += 1;
      continue;
    }
    const stat = playerStats.get(`${year}|${manager}|${playerKey(selection.player)}`);
    const row = {
      year,
      manager,
      player: selection.player,
      overallPick: selection.overallPick,
      round: selection.round,
      starterPoints: stat?.starterPoints ?? 0,
      lineupValue: stat?.lineupValue ?? 0,
      starts: stat?.starts ?? 0,
      position: primarySlot(stat?.slotCounts ?? new Map()),
    };
    baselineRows.push(row);
    if (!activeManagers.has(manager)) {
      summary.excludedFormerManagerPicks += 1;
      continue;
    }
    draftedRows.push(row);
  }
}

if (!draftedRows.length) throw new Error("No usable draft selections were found for the requested season.");
const roundValues = new Map();
for (const row of baselineRows) {
  const key = `${row.year}|${row.round}`;
  if (!roundValues.has(key)) roundValues.set(key, []);
  roundValues.get(key).push(row);
}
for (const row of draftedRows) {
  const peers = roundValues.get(`${row.year}|${row.round}`).filter((candidate) => candidate !== row);
  row.roundMedianValue = median(peers.map((peer) => peer.lineupValue));
  row.draftValue = row.lineupValue - row.roundMedianValue;
}
draftedRows.sort((left, right) => right.draftValue - left.draftValue || right.lineupValue - left.lineupValue || left.year - right.year || left.overallPick - right.overallPick);

summary.years = [...new Set(draftedRows.map((row) => row.year))].sort((left, right) => left - right).join(", ");
summary.selections = draftedRows.length;
summary.displayLimit = options.season ? draftedRows.length : 50;
const output = renderHtml({ rows: draftedRows, summary });
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, output);

console.log(JSON.stringify({ ...summary, topValues: draftedRows.slice(0, 10).map((row) => ({ player: `${row.player} (${row.year})`, manager: row.manager, pick: row.overallPick, round: row.round, position: row.position, starterPoints: Number(row.starterPoints.toFixed(1)), lineupValue: Number(row.lineupValue.toFixed(1)), roundMedian: Number(row.roundMedianValue.toFixed(1)), draftRoi: Number(row.draftValue.toFixed(1)) })) }, null, 2));
