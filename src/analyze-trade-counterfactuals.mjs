import fs from 'node:fs/promises';
import path from 'node:path';

const defaults = {
  dataDir: 'data',
  transactionHistory: null,
  managerMap: 'data/manager-identity-map.csv',
  output: 'reports/trade-counterfactuals.html',
  excludeManager: null,
};

const fixedSlots = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const starterSlots = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'W/R', 'W/T', 'R/T', 'W/R/T']);
const emptyPlayers = new Set(['', '(Empty)', 'Player', 'Total']);

function parseArgs(argv) {
  const options = {...defaults};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--data-dir') options.dataDir = argv[++index];
    if (argument === '--transaction-history') options.transactionHistory = argv[++index];
    if (argument === '--manager-map') options.managerMap = argv[++index];
    if (argument === '--output') options.output = argv[++index];
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
        if (!emptyPlayers.has(entry.player) && entry.points !== null) entries.push(entry);
      }
    }
  }
  return entries;
}

function transactionPlayers(row) {
  const text = (row.cells ?? []).join(' ');
  return (row.links ?? []).filter((link) => /sports\.yahoo\.com\/nfl\/(?:players|teams)\//.test(link.url ?? '')).map((link) => {
    const name = playerName(link.label);
    const tail = text.slice(Math.max(0, text.indexOf(link.label) + String(link.label).length));
    const role = tail.match(/^[^-]*-\s*(QB|RB|WR|TE|K|DEF|D\/ST)\b/i)?.[1]?.replace('D/ST', 'DEF') ?? null;
    return {name, key: playerKey(name), role};
  }).filter((player) => player.name);
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
  return Date.UTC(month <= 3 ? year + 1 : year, month, Number(match[2]), hour, Number(match[4]));
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

function eligibleForSlot(roles, slot) {
  if (roles.has(slot)) return true;
  if (slot === 'W/R') return roles.has('WR') || roles.has('RB');
  if (slot === 'W/T') return roles.has('WR') || roles.has('TE');
  if (slot === 'R/T') return roles.has('RB') || roles.has('TE');
  return slot === 'W/R/T' && (roles.has('WR') || roles.has('RB') || roles.has('TE'));
}

function optimalLineup(players, slots) {
  const candidates = [...players.values()].filter((player) => player.roles.size > 0);
  let states = new Map([[0, 0]]);
  for (const slot of slots) {
    const next = new Map(states);
    for (const [mask, total] of states) {
      for (let index = 0; index < candidates.length; index += 1) {
        if (mask & (1 << index) || !eligibleForSlot(candidates[index].roles, slot)) continue;
        const nextMask = mask | (1 << index);
        const nextTotal = total + candidates[index].points;
        if (nextTotal > (next.get(nextMask) ?? Number.NEGATIVE_INFINITY)) next.set(nextMask, nextTotal);
      }
    }
    states = next;
  }
  return Math.max(...states.values(), 0);
}

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(value);
}

function escapeHtml(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

function playersLabel(players) {
  return players.map((player) => player.name).join(', ') || 'No players recorded';
}

function impactClass(value) {
  return value > 0 ? 'positive' : value < 0 ? 'negative' : '';
}

function managerSummary(result) {
  return `<strong>${escapeHtml(result.manager)}</strong><small class="${impactClass(result.impact)}">${result.impact >= 0 ? '+' : ''}${formatNumber(result.impact)} ideal-lineup points</small><small>received: ${escapeHtml(playersLabel(result.received))}</small><small>sent: ${escapeHtml(playersLabel(result.sent))}</small>`;
}

function renderHtml({lopsided, symbiotic, summary}) {
  const rows = (trades, kind) => trades.map((trade, index) => `<tr><td>${index + 1}</td><td>${trade.year} · Week ${trade.week}</td><td>${managerSummary(trade.left)}</td><td>${managerSummary(trade.right)}</td><td><span class="${kind === 'lopsided' ? 'negative' : 'positive'}">${kind === 'lopsided' ? formatNumber(trade.spread) : `+${formatNumber(trade.sharedGain)}`}</span></td></tr>`).join('');
  return `<div id="trade-counterfactuals">
  <style>
    #trade-counterfactuals { color: var(--foreground); font-variant-numeric: tabular-nums; }
    #trade-counterfactuals h2, #trade-counterfactuals h3 { margin: 0 0 0.35rem; }
    #trade-counterfactuals h3 { margin-top: 1.5rem; }
    #trade-counterfactuals .scope { margin: 0 0 0.9rem; color: var(--muted-foreground); }
    #trade-counterfactuals .table-responsive { overflow-x: auto; }
    #trade-counterfactuals table { width: 100%; min-width: 1080px; border-collapse: collapse; }
    #trade-counterfactuals th, #trade-counterfactuals td { padding: 0.7rem 0.8rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    #trade-counterfactuals thead th { color: var(--muted-foreground); font-weight: 500; white-space: nowrap; }
    #trade-counterfactuals td:nth-child(1), #trade-counterfactuals td:nth-child(5) { text-align: right; white-space: nowrap; }
    #trade-counterfactuals td strong, #trade-counterfactuals td small { display: block; }
    #trade-counterfactuals td small { margin-top: 0.14rem; color: var(--muted-foreground); }
    #trade-counterfactuals .positive { color: var(--green); }
    #trade-counterfactuals .negative { color: var(--red); }
  </style>
  <h2>Trade counterfactuals</h2>
  <p class="scope">${summary.years} · ${summary.trades} two-team trades evaluated${summary.excludeManager ? ` · ${escapeHtml(summary.excludeManager)} excluded` : ''}. Each manager’s actual weekly roster is re-optimized, then compared with a counterfactual roster that removes players received in this trade and restores players sent away. The comparison starts with the first full matchup week after the trade and keeps later transactions unchanged. Player positions come from observed fixed-position starts and trade descriptions.</p>
  <h3>Most lopsided trades</h3>
  <p class="scope">A lopsided trade has one manager with a positive optimal-lineup impact and the other with a negative impact. The rightmost figure is the gap between those impacts.</p>
  <div class="table-responsive"><table><thead><tr><th>Rank</th><th>Trade</th><th>Manager A</th><th>Manager B</th><th>Impact gap</th></tr></thead><tbody>${rows(lopsided, 'lopsided')}</tbody></table></div>
  <h3>Most symbiotic trades</h3>
  <p class="scope">Both managers must gain ideal-lineup points. Rankings use the smaller gain, which favors trades that helped both sides instead of one-sided deals.</p>
  <div class="table-responsive"><table><thead><tr><th>Rank</th><th>Trade</th><th>Manager A</th><th>Manager B</th><th>Shared gain</th></tr></thead><tbody>${rows(symbiotic, 'symbiotic')}</tbody></table></div>
</div>`;
}

const options = parseArgs(process.argv.slice(2));
if (!options.transactionHistory) {
  throw new Error('Use --transaction-history TRANSACTIONS_HISTORY.json.');
}
const managerMap = parseManagerMap(await fs.readFile(options.managerMap, 'utf8'));
const teamManagers = new Map();
const detailsByUrl = new Map();
const years = new Set();
const historyFiles = (await fs.readdir(options.dataDir)).filter((file) => file.endsWith('-history.json'));

for (const fileName of historyFiles) {
  const history = JSON.parse(await fs.readFile(path.join(options.dataDir, fileName), 'utf8'));
  for (const season of history.seasons ?? []) {
    const year = seasonYear(season, fileName);
    if (year) years.add(year);
    for (const table of season.pages?.teams?.tables ?? []) {
      for (const row of table.rows ?? []) {
        const observedManager = row.cells?.[1];
        for (const link of row.links ?? []) {
          const teamId = teamIdFromUrl(link.url, year);
          if (teamId && observedManager) teamManagers.set(`${year}|${teamId}`, String(observedManager).trim());
        }
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

const playerRoles = new Map();
const playerScores = new Map();
const rosters = new Map();
const actualScores = new Map();
for (const [url, page] of detailsByUrl) {
  const match = url.match(/\/(20\d{2})\/f1\/\d+\/matchup\?week=(\d+)&mid1=(\d+)&mid2=(\d+)/);
  if (!match) continue;
  const [, yearText, weekText, mid1, mid2] = match;
  const year = Number(yearText);
  const week = Number(weekText);
  const managers = [managerMap.get(teamManagers.get(`${year}|${mid1}`)), managerMap.get(teamManagers.get(`${year}|${mid2}`))];
  for (const manager of managers) {
    if (!manager || manager === options.excludeManager) continue;
    const rosterKey = `${year}|${week}|${manager}`;
    if (!rosters.has(rosterKey)) rosters.set(rosterKey, {year, week, manager, slots: [], players: new Map()});
  }
  for (const entry of rosterEntries(page)) {
    const manager = managers[entry.side];
    if (!manager || manager === options.excludeManager) continue;
    const key = playerKey(entry.player);
    if (fixedSlots.has(entry.slot)) {
      if (!playerRoles.has(`${year}|${key}`)) playerRoles.set(`${year}|${key}`, new Set());
      playerRoles.get(`${year}|${key}`).add(entry.slot);
    }
    const scoreKey = `${year}|${week}|${key}`;
    if (!playerScores.has(scoreKey)) playerScores.set(scoreKey, {name: entry.player, points: entry.points});
    const roster = rosters.get(`${year}|${week}|${manager}`);
    roster.players.set(key, {key, name: entry.player, points: entry.points, roles: new Set()});
    if (starterSlots.has(entry.slot)) roster.slots.push(entry.slot);
  }
}

for (const roster of rosters.values()) {
  for (const player of roster.players.values()) player.roles = new Set(playerRoles.get(`${roster.year}|${player.key}`) ?? []);
}

for (const [key, roster] of rosters) actualScores.set(key, optimalLineup(roster.players, roster.slots));

const transactionHistory = JSON.parse(await fs.readFile(options.transactionHistory, 'utf8'));
const tradeGroups = new Map();
for (const season of transactionHistory.seasons ?? []) {
  const year = seasonYear(season, options.transactionHistory);
  if (!year) continue;
  for (const page of season.transactionFeeds?.trade ?? []) {
    for (const table of page.tables ?? []) {
      for (const row of table.rows ?? []) {
        const timestamp = transactionDate(year, row.cells?.at(-1));
        const manager = managerFromTransactionRow(row, year, teamManagers, managerMap);
        const players = transactionPlayers(row);
        if (!timestamp || !manager || manager === options.excludeManager || players.length === 0) continue;
        const key = `${year}|${timestamp}`;
        if (!tradeGroups.has(key)) tradeGroups.set(key, {year, timestamp, week: transactionWeek(year, timestamp), moves: []});
        tradeGroups.get(key).moves.push({manager, players});
      }
    }
  }
}

function counterfactualImpact(trade, manager, received, sent) {
  let actual = 0;
  let counterfactual = 0;
  const receivedKeys = new Set(received.map((player) => player.key));
  for (const roster of rosters.values()) {
    if (roster.year !== trade.year || roster.week <= trade.week || roster.manager !== manager) continue;
    actual += actualScores.get(`${roster.year}|${roster.week}|${roster.manager}`) ?? 0;
    const players = new Map([...roster.players].filter(([key]) => !receivedKeys.has(key)).map(([key, player]) => [key, {...player, roles: new Set(player.roles)}]));
    for (const player of sent) {
      const score = playerScores.get(`${trade.year}|${roster.week}|${player.key}`);
      if (!score) continue;
      const roles = new Set(playerRoles.get(`${trade.year}|${player.key}`) ?? []);
      if (player.role) roles.add(player.role);
      players.set(player.key, {key: player.key, name: score.name, points: score.points, roles});
    }
    counterfactual += optimalLineup(players, roster.slots);
  }
  return {manager, received, sent, actual, counterfactual, impact: actual - counterfactual};
}

const trades = [];
for (const group of tradeGroups.values()) {
  const byManager = new Map();
  for (const move of group.moves) {
    if (!byManager.has(move.manager)) byManager.set(move.manager, []);
    byManager.get(move.manager).push(...move.players);
  }
  if (byManager.size !== 2) continue;
  const [firstManager, secondManager] = [...byManager.keys()].sort((left, right) => left.localeCompare(right));
  const left = counterfactualImpact(group, firstManager, byManager.get(firstManager), byManager.get(secondManager));
  const right = counterfactualImpact(group, secondManager, byManager.get(secondManager), byManager.get(firstManager));
  trades.push({...group, left, right, spread: Math.abs(left.impact - right.impact), sharedGain: Math.min(left.impact, right.impact)});
}

const lopsided = trades.filter((trade) => Math.min(trade.left.impact, trade.right.impact) < 0 && Math.max(trade.left.impact, trade.right.impact) > 0).sort((left, right) => right.spread - left.spread || left.year - right.year).slice(0, 10);
const symbiotic = trades.filter((trade) => trade.left.impact > 0 && trade.right.impact > 0).sort((left, right) => right.sharedGain - left.sharedGain || (right.left.impact + right.right.impact) - (left.left.impact + left.right.impact) || left.year - right.year).slice(0, 10);
const summary = {years: `${Math.min(...years)}–${Math.max(...years)}`, trades: trades.length, excludeManager: options.excludeManager, lopsided: lopsided.length, symbiotic: symbiotic.length};
const output = renderHtml({lopsided, symbiotic, summary});
await fs.mkdir(path.dirname(options.output), {recursive: true});
await fs.writeFile(options.output, output);

function resultSummary(trade) {
  return {year: trade.year, week: trade.week, left: {manager: trade.left.manager, impact: Number(trade.left.impact.toFixed(1))}, right: {manager: trade.right.manager, impact: Number(trade.right.impact.toFixed(1))}, spread: Number(trade.spread.toFixed(1)), sharedGain: Number(trade.sharedGain.toFixed(1))};
}

console.log(JSON.stringify({summary, lopsided: lopsided.map(resultSummary), symbiotic: symbiotic.map(resultSummary)}, null, 2));
