import fs from 'node:fs/promises';
import path from 'node:path';

const defaults = {
  dataDir: 'data',
  transactionHistory: null,
  managerMap: 'data/manager-identity-map.csv',
  output: 'reports/transaction-value.html',
  activeSeason: null,
  excludeManager: null,
};

function parseArgs(argv) {
  const options = {...defaults};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--data-dir') options.dataDir = argv[++index];
    if (argument === '--transaction-history') options.transactionHistory = argv[++index];
    if (argument === '--manager-map') options.managerMap = argv[++index];
    if (argument === '--output') options.output = argv[++index];
    if (argument === '--active-season') options.activeSeason = Number(argv[++index]);
    if (argument === '--exclude-manager') options.excludeManager = argv[++index];
  }
  return options;
}

function parseManagerMap(csvText) {
  const [header, ...rows] = csvText.trim().split(/\r?\n/);
  if (header !== 'observed_manager_name,manager_id') throw new Error('The manager map must contain observed_manager_name,manager_id headers.');
  return new Map(rows.map((row) => {
    const separator = row.indexOf(',');
    return [row.slice(0, separator).trim(), row.slice(separator + 1).trim()];
  }));
}

function seasonYear(season, fileName) {
  for (const candidate of [season.pages?.home?.url, season.pages?.teams?.url, fileName]) {
    const match = String(candidate ?? '').match(/20\d{2}/);
    if (match) return Number(match[0]);
  }
  return null;
}

function teamIdFromUrl(url, year) {
  return String(url ?? '').match(new RegExp(`/${year}/f1/\\d+/(\\d+)(?:[?#]|$)`))?.[1] ?? null;
}

function matchupDetails(season) {
  const details = Array.isArray(season.captured) ? [...season.captured] : [];
  for (const pages of Object.values(season.matchups ?? {})) if (Array.isArray(pages)) details.push(...pages);
  return details;
}

function profileLabels(page) {
  const table = (page.tables ?? []).find((candidate) => candidate.headers?.length === 3 && candidate.headers[1] === 'Category' && / View Profile$/.test(candidate.headers[0] ?? ''));
  return table ? [table.headers[0], table.headers[2]].map((label) => label.replace(/ View Profile$/, '').trim()) : null;
}

function pageQuality(page) {
  return (page.tables?.length ?? 0) * 1_000 + (page.links?.length ?? 0);
}

function playerName(value) {
  return String(value ?? '').replace(/Video(?:\s|Forecast|$).*/u, '').replace(/\s+(?:Final|Bye|Postponed|Live|Scheduled)(?:\s|$).*/iu, '').replace(/\s+/gu, ' ').trim();
}

function playerKey(value) {
  return playerName(value).replace(/\s+-\s+DEF$/iu, ' DST').replace(/\s+D\/ST$/iu, ' DST').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function points(value) {
  const number = Number(String(value ?? '').replace(/,/gu, ''));
  return Number.isFinite(number) ? number : null;
}

function rosterTable(table) {
  const headers = table.headers ?? [];
  return headers.filter((header) => header === 'Player').length >= 2 && headers.filter((header) => header === 'Fan Pts').length >= 2 && headers.filter((header) => header === 'Pos').length >= 3;
}

function slotRun(cells) {
  for (let index = 0; index <= cells.length - 3; index += 1) {
    const slot = String(cells[index] ?? '').trim();
    if (slot && slot !== 'Pos' && slot === String(cells[index + 1] ?? '').trim() && slot === String(cells[index + 2] ?? '').trim()) return {slot, index};
  }
  return null;
}

function isStarter(slot) {
  return ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'W/R', 'W/T', 'R/T', 'W/R/T'].includes(slot);
}

function rosterEntries(page) {
  const entries = [];
  for (const table of page.tables ?? []) {
    if (!rosterTable(table)) continue;
    for (const row of table.rows ?? []) {
      const run = slotRun(row.cells ?? []);
      if (!run) continue;
      const cells = row.cells;
      for (const entry of [
        {side: 0, player: playerName(cells[run.index - 3]), points: points(cells[run.index - 1]), slot: run.slot},
        {side: 1, player: playerName(cells[run.index + 5]), points: points(cells[run.index + 3]), slot: run.slot},
      ]) {
        if (entry.player && !['(Empty)', 'Player', 'Total'].includes(entry.player) && entry.points !== null) entries.push(entry);
      }
    }
  }
  return entries;
}

function transactionPlayers(row) {
  return (row.links ?? []).filter((link) => /sports\.yahoo\.com\/nfl\/(?:players|teams)\//.test(link.url ?? '')).map((link) => ({name: playerName(link.label), key: playerKey(link.label)})).filter((player) => player.name);
}

function managerFromTransactionRow(row, year, teamManagers, managerMap) {
  for (const link of row.links ?? []) {
    const teamId = teamIdFromUrl(link.url, year);
    if (!teamId) continue;
    const manager = managerMap.get(teamManagers.get(`${year}|${teamId}`));
    if (manager) return manager;
  }
  return null;
}

function transactionDate(year, text) {
  const match = String(text ?? '').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*([ap]m)\b/i);
  if (!match) return null;
  const months = {Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11};
  const month = months[match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()];
  let hour = Number(match[3]);
  if (match[5].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (match[5].toLowerCase() === 'am' && hour === 12) hour = 0;
  const calendarYear = month <= 3 ? year + 1 : year;
  return Date.UTC(calendarYear, month, Number(match[2]), hour, Number(match[4]));
}

function firstWeekStart(year) {
  const septemberFirst = new Date(Date.UTC(year, 8, 1));
  const daysToMonday = (8 - septemberFirst.getUTCDay()) % 7;
  const laborDay = new Date(Date.UTC(year, 8, 1 + daysToMonday));
  return Date.UTC(year, 8, laborDay.getUTCDate() + 2);
}

function transactionWeek(year, timestamp) {
  return Math.max(1, Math.floor((timestamp - firstWeekStart(year)) / (7 * 24 * 60 * 60 * 1_000)) + 1);
}

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(value);
}

function escapeHtml(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

function tableRows(rows, cells) {
  return rows.map((row) => `<tr>${cells(row).map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('');
}

function tradePlayerList(players, direction) {
  if (players.length === 0) return '<span class="empty">No recorded player value</span>';
  const relation = direction === 'acquired' ? 'from' : 'to';
  return players.map((player) => {
    const counterparties = [...player.counterparties.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([manager]) => manager);
    return `<strong>${escapeHtml(player.player)} (${player.year})</strong><small><span class="counterparty">${relation} ${escapeHtml(counterparties.join(' and '))}</span><span class="points">${formatNumber(player.ppg, 2)} PPG · ${formatNumber(player.points)} points / ${player.games} games</span></small>`;
  }).join('');
}

function renderHtml({tradeRows, tradePlayerRows, activityRows, addRows, dropRows, summary}) {
  const managerCell = (manager) => `<strong>${escapeHtml(manager)}</strong>`;
  const numberCell = (value) => formatNumber(value);
  return `<div id="transaction-value">
  <style>
    #transaction-value { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #transaction-value h2, #transaction-value h3 { margin: 0 0 0.35rem; }
    #transaction-value h3 { margin-top: 1.5rem; }
    #transaction-value .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #transaction-value .table-responsive { overflow-x: auto; }
    #transaction-value table { width: 100%; min-width: 900px; border-collapse: collapse; }
    #transaction-value th, #transaction-value td { padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--border); text-align: right; vertical-align: top; }
    #transaction-value th:first-child, #transaction-value td:first-child { text-align: left; }
    #transaction-value thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #transaction-value .positive { color: var(--green); }
    #transaction-value .negative { color: var(--red); }
    #transaction-value .trade-player-list strong, #transaction-value .trade-player-list small { display: block; }
    #transaction-value .trade-player-list small { margin: 0.1rem 0 0.55rem; color: var(--muted-foreground); }
    #transaction-value .trade-player-list .counterparty, #transaction-value .trade-player-list .points { display: block; }
    #transaction-value .trade-player-list.gained .points { color: color-mix(in srgb, var(--green) 72%, var(--muted-foreground)); }
    #transaction-value .trade-player-list.lost .points { color: color-mix(in srgb, var(--red) 72%, var(--muted-foreground)); }
    #transaction-value .trade-player-list.bottom.gained .points { color: color-mix(in srgb, var(--red) 72%, var(--muted-foreground)); }
    #transaction-value .trade-player-list.bottom.lost .points { color: color-mix(in srgb, var(--green) 72%, var(--muted-foreground)); }
    #transaction-value .empty { color: var(--muted-foreground); }
  </style>
  <h2>Transaction value</h2>
  <p class="scope">${summary.years} · ${summary.activeManagers} active managers · ${summary.tradeGroups} two-team trades evaluated. Trade value uses the player’s points in every later matchup week, regardless of their manager. Points per game (PPG) is the primary comparison.</p>
  <h3>Transaction activity</h3>
  <p class="scope">Add and waiver-add counts are player actions. Yahoo labels each add as either a free-agent or waiver addition.</p>
  <div class="table-responsive"><table><thead><tr><th>Manager</th><th>Two-team trades</th><th>Add actions</th><th>Waiver additions</th></tr></thead><tbody>${tableRows(activityRows, (row) => [managerCell(row.manager), row.trades, row.adds, row.waivers])}</tbody></table></div>
  <h3>Trade value</h3>
  <p class="scope">Each asset counts player scoring from the first matchup week after its trade. PPG is total remaining player points divided by those games.</p>
  <div class="table-responsive"><table><thead><tr><th>Manager</th><th>Trades</th><th>PPG edge</th><th>Acquired PPG</th><th>Traded-away PPG</th><th>Acquired games</th><th>Traded-away games</th></tr></thead><tbody>${tableRows(tradeRows, (row) => [managerCell(row.manager), row.trades, `<span class="${row.ppgNet >= 0 ? 'positive' : 'negative'}">${numberCell(row.ppgNet, 2)}</span>`, numberCell(row.inPpg, 2), numberCell(row.outPpg, 2), row.inGames, row.outGames])}</tbody></table></div>
  <h3>Trade player leaders</h3>
  <p class="scope">Highest and lowest five player-seasons by remaining PPG. A player can appear in more than one column if they changed hands more than once.</p>
  <div class="table-responsive"><table><thead><tr><th rowspan="2">Manager</th><th colspan="2">Top five remaining PPG</th><th colspan="2">Bottom five remaining PPG</th></tr><tr><th>Acquired</th><th>Traded away</th><th>Acquired</th><th>Traded away</th></tr></thead><tbody>${tableRows(tradePlayerRows, (row) => [managerCell(row.manager), `<div class="trade-player-list gained">${tradePlayerList(row.acquired, 'acquired')}</div>`, `<div class="trade-player-list lost">${tradePlayerList(row.sent, 'traded')}</div>`, `<div class="trade-player-list bottom gained">${tradePlayerList(row.bottomAcquired, 'acquired')}</div>`, `<div class="trade-player-list bottom lost">${tradePlayerList(row.bottomSent, 'traded')}</div>`])}</tbody></table></div>
  <h3>Add value</h3>
  <p class="scope">Adds exclude players drafted by that manager in the same season. The score ends when the manager drops or trades away the player.</p>
  <div class="table-responsive"><table><thead><tr><th>Manager</th><th>Qualifying adds</th><th>All roster points</th><th>All roster games</th><th>All points/game</th><th>Starter points</th><th>Starter games</th><th>Starter points/game</th></tr></thead><tbody>${tableRows(addRows, (row) => [managerCell(row.manager), row.adds, numberCell(row.allPoints), row.allGames, numberCell(row.allPpg, 2), numberCell(row.starterPoints), row.starterGames, numberCell(row.starterPpg, 2)])}</tbody></table></div>
  <h3>Drop cost</h3>
  <p class="scope">Foregone starter points are later points scored for another manager after a drop. A drop qualifies only if the original manager never adds that player again that season.</p>
  <div class="table-responsive"><table><thead><tr><th>Manager</th><th>Qualifying drops</th><th>Players with later starts</th><th>Later starter games</th><th>Foregone starter points</th><th>Foregone points/game</th></tr></thead><tbody>${tableRows(dropRows, (row) => [managerCell(row.manager), row.drops, row.players, row.games, numberCell(row.points), numberCell(row.ppg, 2)])}</tbody></table></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
if (!options.transactionHistory) {
  throw new Error('Use --transaction-history TRANSACTIONS_HISTORY.json.');
}
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, 'utf8'));
const teamManagers = new Map();
const teamNames = new Map();
const detailsByUrl = new Map();
const draftSelections = new Set();
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith('-history.json'));

for (const fileName of historyFiles) {
  const history = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), 'utf8'));
  for (const season of history.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (!year) continue;
    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const [teamName, observedManager] = row.cells ?? [];
        if (teamName && observedManager) teamNames.set(`${year}|${String(teamName).trim()}`, String(observedManager).trim());
        for (const link of row.links ?? []) {
          const teamId = teamIdFromUrl(link.url, year);
          if (teamId && observedManager) teamManagers.set(`${year}|${teamId}`, String(observedManager).trim());
        }
      }
    }
    for (const table of season.pages?.draftresults?.tables ?? []) {
      if (!/^Round \d+$/.test(table.headers?.[0] ?? '')) continue;
      for (const row of table.rows ?? []) {
        const [pick, player, teamName] = row.cells ?? [];
        if (!/^\d+\.$/.test(String(pick)) || !player || !teamName) continue;
        const manager = managerMap.get(teamNames.get(`${year}|${String(teamName).trim()}`));
        if (manager) draftSelections.add(`${year}|${manager}|${playerKey(player)}`);
      }
    }
    for (const page of matchupDetails(season)) {
      const match = String(page.url ?? '').match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
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

options.activeSeason ??= Math.max(...[...teamManagers.keys()].map((key) => Number(key.split('|')[0])));
const activeManagers = new Set();
for (const [key, observedManager] of teamManagers) {
  if (Number(key.split('|')[0]) !== options.activeSeason) continue;
  const manager = managerMap.get(observedManager);
  if (manager && manager !== options.excludeManager) activeManagers.add(manager);
}
if (activeManagers.size === 0) throw new Error(`No active managers were found for ${options.activeSeason}.`);

const weeklyByPlayer = new Map();
const knownYears = new Set();
for (const [url, page] of detailsByUrl) {
  const match = url.match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
  if (!match) continue;
  const [, yearText, weekText, mid1, mid2] = match;
  const year = Number(yearText);
  const managers = [managerMap.get(teamManagers.get(`${year}|${mid1}`)), managerMap.get(teamManagers.get(`${year}|${mid2}`))];
  knownYears.add(year);
  for (const entry of rosterEntries(page)) {
    const manager = managers[entry.side];
    if (!manager) continue;
    const event = {year, week: Number(weekText), manager, player: entry.player, key: playerKey(entry.player), points: entry.points, starter: isStarter(entry.slot)};
    const key = `${year}|${event.key}`;
    if (!weeklyByPlayer.has(key)) weeklyByPlayer.set(key, []);
    weeklyByPlayer.get(key).push(event);
  }
}
for (const events of weeklyByPlayer.values()) events.sort((left, right) => left.week - right.week || left.manager.localeCompare(right.manager));

const transactionHistory = JSON.parse(await fs.readFile(options.transactionHistory, 'utf8'));
const additions = [];
const drops = [];
const tradeGroups = new Map();
for (const season of transactionHistory.seasons ?? []) {
  const year = seasonYear(season, options.transactionHistory);
  if (!year) continue;
  for (const [feed, pages] of Object.entries(season.transactionFeeds ?? {})) {
    for (const page of pages ?? []) {
      for (const table of page.tables ?? []) {
        for (const row of table.rows ?? []) {
          const timestamp = transactionDate(year, row.cells?.at(-1));
          const manager = managerFromTransactionRow(row, year, teamManagers, managerMap);
          const players = transactionPlayers(row);
          if (!timestamp || !manager || players.length === 0) continue;
          const record = {year, timestamp, week: transactionWeek(year, timestamp), manager, players, waiverAdd: feed === 'add' && (row.cells ?? []).some((cell) => /\bwaiver\b/i.test(cell))};
          if (feed === 'add') additions.push(record);
          if (feed === 'drop') drops.push(record);
          if (feed === 'trade') {
            const key = `${year}|${timestamp}`;
            if (!tradeGroups.has(key)) tradeGroups.set(key, {year, timestamp, week: record.week, moves: []});
            tradeGroups.get(key).moves.push(record);
          }
        }
      }
    }
  }
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.year}|${record.timestamp}|${record.manager}|${record.players.map((player) => player.key).join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const uniqueAdditions = uniqueRecords(additions);
const uniqueDrops = uniqueRecords(drops);
const removals = new Map();
function addRemoval(record) {
  for (const player of record.players) {
    const key = `${record.year}|${record.manager}|${player.key}`;
    if (!removals.has(key)) removals.set(key, []);
    removals.get(key).push(record);
  }
}
for (const drop of uniqueDrops) addRemoval(drop);

const evaluatedTrades = [];
for (const group of tradeGroups.values()) {
  const byManager = new Map();
  for (const move of group.moves) {
    if (!byManager.has(move.manager)) byManager.set(move.manager, []);
    byManager.get(move.manager).push(...move.players);
  }
  if (byManager.size !== 2) continue;
  const managers = [...byManager.keys()];
  for (const manager of managers) {
    const outgoing = byManager.get(managers.find((candidate) => candidate !== manager));
    addRemoval({year: group.year, timestamp: group.timestamp, week: group.week, manager, players: outgoing});
  }
  evaluatedTrades.push({...group, byManager});
}
for (const records of removals.values()) records.sort((left, right) => left.timestamp - right.timestamp);

function pointsDuringTenure(year, manager, player, timestamp) {
  const events = weeklyByPlayer.get(`${year}|${player.key}`) ?? [];
  const startWeek = transactionWeek(year, timestamp);
  const nextRemoval = (removals.get(`${year}|${manager}|${player.key}`) ?? []).find((record) => record.timestamp > timestamp);
  const endWeek = nextRemoval?.week ?? Infinity;
  const eligible = events.filter((event) => event.manager === manager && event.week >= startWeek && event.week < endWeek);
  return {
    allPoints: eligible.reduce((sum, event) => sum + event.points, 0),
    allGames: eligible.length,
    starterPoints: eligible.filter((event) => event.starter).reduce((sum, event) => sum + event.points, 0),
    starterGames: eligible.filter((event) => event.starter).length,
  };
}

function playerValueAfterTrade(year, player, timestamp) {
  const events = weeklyByPlayer.get(`${year}|${player.key}`) ?? [];
  const eligible = events.filter((event) => event.week > transactionWeek(year, timestamp));
  const points = eligible.reduce((sum, event) => sum + event.points, 0);
  return {points, games: eligible.length, ppg: eligible.length ? points / eligible.length : 0};
}

const tradeStats = new Map([...activeManagers].map((manager) => [manager, {manager, trades: 0, inPoints: 0, inGames: 0, outPoints: 0, outGames: 0}]));
const activityStats = new Map([...activeManagers].map((manager) => [manager, {manager, trades: 0, adds: 0, waivers: 0}]));
const acquiredPlayers = new Map([...activeManagers].map((manager) => [manager, new Map()]));
const tradedAwayPlayers = new Map([...activeManagers].map((manager) => [manager, new Map()]));

function addTradePlayerValue(values, year, player, counterparty, value) {
  const key = `${year}|${player.key}`;
  if (!values.has(key)) values.set(key, {player: player.name, year, points: 0, games: 0, counterparties: new Map()});
  const result = values.get(key);
  result.points += value.points;
  result.games += value.games;
  result.ppg = result.games ? result.points / result.games : 0;
  result.counterparties.set(counterparty, (result.counterparties.get(counterparty) ?? 0) + value.points);
}

for (const trade of evaluatedTrades) {
  for (const [manager, incoming] of trade.byManager) {
    if (!tradeStats.has(manager)) continue;
    activityStats.get(manager).trades += 1;
    const otherManager = [...trade.byManager.keys()].find((candidate) => candidate !== manager);
    const outgoing = trade.byManager.get(otherManager);
    const stat = tradeStats.get(manager);
    stat.trades += 1;
    for (const player of incoming) {
      const value = playerValueAfterTrade(trade.year, player, trade.timestamp);
      stat.inPoints += value.points;
      stat.inGames += value.games;
      addTradePlayerValue(acquiredPlayers.get(manager), trade.year, player, otherManager, value);
    }
    for (const player of outgoing) {
      const value = playerValueAfterTrade(trade.year, player, trade.timestamp);
      stat.outPoints += value.points;
      stat.outGames += value.games;
      addTradePlayerValue(tradedAwayPlayers.get(manager), trade.year, player, otherManager, value);
    }
  }
}
const tradeRows = [...tradeStats.values()].map((row) => {
  const inPpg = row.inGames ? row.inPoints / row.inGames : 0;
  const outPpg = row.outGames ? row.outPoints / row.outGames : 0;
  return {...row, inPpg, outPpg, ppgNet: inPpg - outPpg};
}).sort((left, right) => right.ppgNet - left.ppgNet || left.manager.localeCompare(right.manager));
const tradePlayerRows = [...activeManagers].sort((left, right) => left.localeCompare(right)).map((manager) => {
  const leaders = (values, direction) => [...values.values()].sort((left, right) => direction * (right.ppg - left.ppg) || direction * (right.points - left.points) || left.player.localeCompare(right.player)).slice(0, 5);
  return {
    manager,
    acquired: leaders(acquiredPlayers.get(manager), 1),
    sent: leaders(tradedAwayPlayers.get(manager), 1),
    bottomAcquired: leaders(acquiredPlayers.get(manager), -1),
    bottomSent: leaders(tradedAwayPlayers.get(manager), -1),
  };
});

for (const addition of uniqueAdditions) {
  if (!activityStats.has(addition.manager)) continue;
  activityStats.get(addition.manager).adds += addition.players.length;
  if (addition.waiverAdd) activityStats.get(addition.manager).waivers += addition.players.length;
}
const activityRows = [...activityStats.values()].sort((left, right) => right.trades - left.trades || right.adds - left.adds || left.manager.localeCompare(right.manager));

const addStats = new Map([...activeManagers].map((manager) => [manager, {manager, adds: 0, allPoints: 0, allGames: 0, starterPoints: 0, starterGames: 0}]));
for (const addition of uniqueAdditions) {
  if (!addStats.has(addition.manager)) continue;
  for (const player of addition.players) {
    if (draftSelections.has(`${addition.year}|${addition.manager}|${player.key}`)) continue;
    const value = pointsDuringTenure(addition.year, addition.manager, player, addition.timestamp);
    const stat = addStats.get(addition.manager);
    stat.adds += 1;
    stat.allPoints += value.allPoints;
    stat.allGames += value.allGames;
    stat.starterPoints += value.starterPoints;
    stat.starterGames += value.starterGames;
  }
}
const addRows = [...addStats.values()].map((row) => ({...row, allPpg: row.allGames ? row.allPoints / row.allGames : 0, starterPpg: row.starterGames ? row.starterPoints / row.starterGames : 0})).sort((left, right) => right.allPoints - left.allPoints || left.manager.localeCompare(right.manager));

const dropStats = new Map([...activeManagers].map((manager) => [manager, {manager, drops: 0, players: 0, games: 0, points: 0}]));
for (const drop of uniqueDrops) {
  if (!dropStats.has(drop.manager)) continue;
  for (const player of drop.players) {
    const readded = uniqueAdditions.some((addition) => addition.year === drop.year && addition.manager === drop.manager && addition.timestamp > drop.timestamp && addition.players.some((candidate) => candidate.key === player.key));
    if (readded) continue;
    const laterStarts = (weeklyByPlayer.get(`${drop.year}|${player.key}`) ?? []).filter((event) => event.manager !== drop.manager && event.week >= drop.week && event.starter);
    const value = laterStarts.reduce((sum, event) => sum + event.points, 0);
    const stat = dropStats.get(drop.manager);
    stat.drops += 1;
    if (laterStarts.length > 0) stat.players += 1;
    stat.games += laterStarts.length;
    stat.points += value;
  }
}
const dropRows = [...dropStats.values()].map((row) => ({...row, ppg: row.games ? row.points / row.games : 0})).sort((left, right) => right.points - left.points || left.manager.localeCompare(right.manager));

const years = [...knownYears].sort((left, right) => left - right);
const summary = {years: `${years[0]}–${years.at(-1)}`, activeManagers: activeManagers.size, tradeGroups: evaluatedTrades.length, excludedTradeGroups: tradeGroups.size - evaluatedTrades.length};
const output = renderHtml({tradeRows, tradePlayerRows, activityRows, addRows, dropRows, summary});
await fs.mkdir(path.dirname(options.output), {recursive: true});
await fs.writeFile(options.output, output);

console.log(JSON.stringify({summary, activity: activityRows, tradeLeaders: tradeRows.slice(0, 3).map(({manager, ppgNet, inPpg, outPpg}) => ({manager, ppgNet: Number(ppgNet.toFixed(2)), inPpg: Number(inPpg.toFixed(2)), outPpg: Number(outPpg.toFixed(2))})), tradePlayerLeaders: tradePlayerRows.map(({manager, acquired, sent}) => ({manager, acquired: acquired[0]?.player ?? null, sent: sent[0]?.player ?? null})), addLeaders: addRows.slice(0, 3).map(({manager, allPoints, allPpg}) => ({manager, allPoints: Number(allPoints.toFixed(1)), allPpg: Number(allPpg.toFixed(2))})), dropLeaders: dropRows.slice(0, 3).map(({manager, points}) => ({manager, points: Number(points.toFixed(1))}))}, null, 2));
