import fs from "node:fs/promises";
import path from "node:path";

const defaults = {
  dataDir: "data",
  managerMap: "data/manager-identity-map.csv",
  output: "reports/manager-head-to-head-matrix.html",
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
  const candidates = [
    season.pages?.home?.url,
    season.pages?.teams?.url,
    ...((Array.isArray(season.captured) ? season.captured : []).slice(0, 1).map((page) => page.url)),
    fileName,
  ];
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function scorePair(page) {
  const row = page.tables?.[0]?.rows?.find((candidate) => candidate.cells?.[1] === "Points");
  if (!row) return null;
  const left = Number(row.cells[0]);
  const right = Number(row.cells[2]);
  return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : null;
}

function pageQuality(page) {
  return (page.tables?.length ?? 0) * 1_000 + (page.links?.length ?? 0);
}

function regularSeasonEnd(year) {
  return year >= 2021 ? 14 : 13;
}

function recordText(record) {
  return record.ties > 0 ? `${record.wins}–${record.losses}–${record.ties}` : `${record.wins}–${record.losses}`;
}

function playoffRecordText(record) {
  return record.playoffTies > 0
    ? `${record.playoffWins}–${record.playoffLosses}–${record.playoffTies}`
    : `${record.playoffWins}–${record.playoffLosses}`;
}

function cellTone(record) {
  if (!record.games || record.wins === record.losses) return { className: "neutral", strength: 0 };
  const rate = record.wins / record.games;
  const strength = Math.round(12 + Math.abs(rate - 0.5) * 76);
  return { className: rate > 0.5 ? "win" : "loss", strength };
}

function renderHtml({ managerOrder, matrix, summary }) {
  const headerCells = managerOrder.map((manager) => `<th scope="col">${manager}</th>`).join("");
  const rows = managerOrder.map((rowManager) => {
    const cells = managerOrder.map((columnManager) => {
      if (rowManager === columnManager) return '<td class="diagonal" aria-label="Same manager"></td>';
      const record = matrix.get(rowManager).get(columnManager);
      if (!record.games) return '<td class="neutral" aria-label="No games"></td>';
      const tone = cellTone(record);
      const label = `${rowManager} versus ${columnManager}: ${recordText(record)}, ${record.games} games total; playoffs ${playoffRecordText(record)}, ${record.playoffGames} games`;
      return `<td class="${tone.className}" style="--strength:${tone.strength}%" aria-label="${label}"><span>${recordText(record)}</span><small>P: ${playoffRecordText(record)}</small><small class="counts">${record.games}g total · ${record.playoffGames}g playoff</small></td>`;
    }).join("");
    return `<tr><th scope="row">${rowManager}</th>${cells}</tr>`;
  }).join("");

  return `<div id="manager-h2h-matrix">
  <style>
    #manager-h2h-matrix { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #manager-h2h-matrix h2 { margin: 0 0 0.25rem; }
    #manager-h2h-matrix .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #manager-h2h-matrix .table-responsive { overflow-x: auto; }
    #manager-h2h-matrix table { width: 100%; min-width: 760px; border-collapse: separate; border-spacing: 2px; }
    #manager-h2h-matrix th { font-weight: 500; text-align: center; }
    #manager-h2h-matrix thead th { height: 4.2rem; vertical-align: bottom; white-space: normal; }
    #manager-h2h-matrix .corner { text-align: right; white-space: nowrap; }
    #manager-h2h-matrix .corner span, #manager-h2h-matrix .corner small { display: block; }
    #manager-h2h-matrix .corner small { color: var(--muted-foreground); margin-top: 0.15rem; }
    #manager-h2h-matrix tbody th { text-align: right; white-space: nowrap; padding-right: 0.4rem; }
    #manager-h2h-matrix td { min-width: 58px; height: 64px; text-align: center; vertical-align: middle; background: color-mix(in srgb, var(--muted) 45%, transparent); }
    #manager-h2h-matrix td span, #manager-h2h-matrix td small { display: block; }
    #manager-h2h-matrix td small { color: var(--muted-foreground); margin-top: 0.15rem; }
    #manager-h2h-matrix td .counts { opacity: 0.72; }
    #manager-h2h-matrix td.win { background: color-mix(in srgb, var(--green) var(--strength), transparent); }
    #manager-h2h-matrix td.loss { background: color-mix(in srgb, var(--red) var(--strength), transparent); }
    #manager-h2h-matrix td.diagonal { background: transparent; }
    #manager-h2h-matrix .legend { display: flex; gap: 1rem; margin-top: 0.75rem; color: var(--muted-foreground); }
    #manager-h2h-matrix .legend span::before { content: ""; display: inline-block; width: 0.8rem; height: 0.8rem; margin-right: 0.35rem; vertical-align: -0.1rem; }
    #manager-h2h-matrix .legend .better::before { background: var(--green); }
    #manager-h2h-matrix .legend .worse::before { background: var(--red); }
  </style>
  <h2>Manager head-to-head matrix</h2>
  <p class="scope">${summary.activeManagers} active ${summary.activeSeason} managers. Each record reads row-manager wins – opponent wins. The first line is the total record; P is the championship-playoff record. Consolation games${summary.excludeManager ? ` and ${escapeHtml(summary.excludeManager)}` : ""} are excluded.</p>
  <div class="table-responsive"><table aria-label="Manager head-to-head records; row-manager wins appear first and opponent wins appear second"><thead><tr><th scope="col" class="corner"><span>Opponent →</span><small>Row manager ↓</small></th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>
  <div class="legend" aria-label="Color legend"><span class="worse">Lower win rate</span><span class="better">Higher win rate</span></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, "utf8"));
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith("-history.json"));
const teamLabels = new Map();
const playoffTeams = new Map();
const detailsByUrl = new Map();

for (const fileName of historyFiles) {
  const exportFile = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), "utf8"));
  for (const season of exportFile.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (!year) continue;
    const playoffTeamIds = playoffTeams.get(year) ?? new Set();
    playoffTeams.set(year, playoffTeamIds);

    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const [teamName, observedManagerName] = row.cells ?? [];
        const teamId = teamIdFromLinks(row.links, year);
        if (teamId && teamName && observedManagerName) teamLabels.set(`${year}|${teamId}`, String(observedManagerName).trim());
      }
    }

    for (const table of season.pages?.standings?.tables ?? []) {
      if (!table.headers?.includes("Rank") || !table.headers?.includes("Team")) continue;
      for (const row of table.rows ?? []) {
        if (!String(row.cells?.[0] ?? "").startsWith("*")) continue;
        const teamId = teamIdFromLinks(row.links, year);
        if (teamId) playoffTeamIds.add(teamId);
      }
    }

    for (const page of matchupDetails(season)) {
      const match = String(page.url ?? "").match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
      if (!match) continue;
      const pageYear = Number(match[1]);
      const mid1 = Number(match[3]);
      const mid2 = Number(match[4]);
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
  const managerId = managerMap.get(observedManagerName);
  if (managerId && managerId !== options.excludeManager) activeManagers.add(managerId);
}
if (activeManagers.size === 0) throw new Error(`No active managers were found for ${options.activeSeason}.`);

const managerOrder = [...activeManagers].sort((left, right) => left.localeCompare(right));
const matrix = new Map(managerOrder.map((manager) => [
  manager,
  new Map(managerOrder.map((opponent) => [opponent, {
    wins: 0,
    losses: 0,
    ties: 0,
    games: 0,
    playoffWins: 0,
    playoffLosses: 0,
    playoffTies: 0,
    playoffGames: 0,
  }])),
]));
const summary = {
  activeManagers: managerOrder.length,
  activeSeason: options.activeSeason,
  excludeManager: options.excludeManager,
  regularSeasonGames: 0,
  championshipPlayoffGames: 0,
  consolationGames: 0,
  excludedFormerManagerGames: 0,
  missingManagerDetails: 0,
  availableDetails: detailsByUrl.size,
};

for (const page of detailsByUrl.values()) {
  const match = String(page.url).match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
  if (!match) continue;
  const [, yearText, weekText, mid1Text, mid2Text] = match;
  const year = Number(yearText);
  const week = Number(weekText);
  const mid1 = Number(mid1Text);
  const mid2 = Number(mid2Text);
  const score = scorePair(page);
  const observedManager1 = teamLabels.get(`${year}|${mid1}`);
  const observedManager2 = teamLabels.get(`${year}|${mid2}`);
  const manager1 = managerMap.get(observedManager1);
  const manager2 = managerMap.get(observedManager2);
  if (!score || !manager1 || !manager2) {
    summary.missingManagerDetails += 1;
    continue;
  }
  if (!activeManagers.has(manager1) || !activeManagers.has(manager2)) {
    summary.excludedFormerManagerGames += 1;
    continue;
  }
  const isRegularSeason = week <= regularSeasonEnd(year);
  const isChampionshipPlayoff = !isRegularSeason
    && playoffTeams.get(year)?.has(mid1)
    && playoffTeams.get(year)?.has(mid2);
  if (!isRegularSeason && !isChampionshipPlayoff) {
    summary.consolationGames += 1;
    continue;
  }
  const [score1, score2] = score;
  const row1 = matrix.get(manager1).get(manager2);
  const row2 = matrix.get(manager2).get(manager1);
  row1.games += 1;
  row2.games += 1;
  if (score1 > score2) {
    row1.wins += 1;
    row2.losses += 1;
  } else if (score2 > score1) {
    row1.losses += 1;
    row2.wins += 1;
  } else {
    row1.ties += 1;
    row2.ties += 1;
  }
  if (isRegularSeason) {
    summary.regularSeasonGames += 1;
  } else {
    summary.championshipPlayoffGames += 1;
    row1.playoffGames += 1;
    row2.playoffGames += 1;
    if (score1 > score2) {
      row1.playoffWins += 1;
      row2.playoffLosses += 1;
    } else if (score2 > score1) {
      row1.playoffLosses += 1;
      row2.playoffWins += 1;
    } else {
      row1.playoffTies += 1;
      row2.playoffTies += 1;
    }
  }
}

const output = renderHtml({ managerOrder, matrix, summary });
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, output);

console.log(JSON.stringify({
  ...summary,
  managers: managerOrder,
  includedGames: summary.regularSeasonGames + summary.championshipPlayoffGames,
}, null, 2));
