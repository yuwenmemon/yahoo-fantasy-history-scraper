import fs from 'node:fs/promises';
import path from 'node:path';

const feedNames = ['add', 'drop', 'trade', 'waiver'];

function getOptions(argv) {
  const options = {input: null, output: null};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.input = argv[++index];
    if (argument === '--output') options.output = argv[++index];
  }
  if (!options.input || !options.output) {
    throw new Error('Use --input HISTORY.json --output TRANSACTIONS.json.');
  }
  return options;
}

function seasonYear(season) {
  const match = String(season.pages?.home?.url ?? '').match(/\/(20\d{2})(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

function entityType(url) {
  if (/sports\.yahoo\.com\/nfl\/(?:players|teams)\//.test(url)) return 'player';
  if (/fantasysports\.yahoo\.com\/20\d{2}\/f1\/\d+\/\d+/.test(url)) return 'team';
  if (/profiles\.sports\.yahoo\.com\//.test(url)) return 'manager-profile';
  return 'other';
}

function cleanLinks(links) {
  const unique = new Map();
  for (const link of links ?? []) {
    if (!link.label || !link.url) continue;
    const key = `${link.label}|${link.url}`;
    if (!unique.has(key)) unique.set(key, {label: link.label, url: link.url, type: entityType(link.url)});
  }
  return [...unique.values()];
}

function recordForRow(year, feed, row) {
  const cells = row.cells ?? [];
  return {
    year,
    feed,
    details: cells.slice(1, -1).join(' '),
    recordedAt: cells.at(-1) ?? '',
    cells,
    entities: cleanLinks(row.links),
  };
}

function recordKey(record) {
  return JSON.stringify([record.year, record.feed, record.cells, record.entities]);
}

const options = getOptions(process.argv.slice(2));
const history = JSON.parse(await fs.readFile(options.input, 'utf8'));
const seasons = [];
const totals = Object.fromEntries(feedNames.map((feed) => [feed, 0]));

for (const season of history.seasons ?? []) {
  const year = seasonYear(season);
  if (!year) continue;
  const records = {};
  for (const feed of feedNames) {
    const seen = new Set();
    records[feed] = [];
    for (const page of season.transactionFeeds?.[feed] ?? []) {
      for (const table of page.tables ?? []) {
        for (const row of table.rows ?? []) {
          const record = recordForRow(year, feed, row);
          if (!record.details || !record.recordedAt) continue;
          const key = recordKey(record);
          if (seen.has(key)) continue;
          seen.add(key);
          records[feed].push(record);
        }
      }
    }
    totals[feed] += records[feed].length;
  }
  seasons.push({year, records, totals: Object.fromEntries(feedNames.map((feed) => [feed, records[feed].length]))});
}

const output = {
  sourceHistoryFile: path.resolve(options.input),
  exportedAt: new Date().toISOString(),
  feedNames,
  seasonCount: seasons.length,
  totals: {...totals, all: Object.values(totals).reduce((sum, count) => sum + count, 0)},
  seasons,
};
await fs.mkdir(path.dirname(options.output), {recursive: true});
await fs.writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, {mode: 0o600});
console.log(JSON.stringify({output: path.resolve(options.output), seasons: seasons.map(({year, totals: seasonTotals}) => ({year, ...seasonTotals})), totals: output.totals}, null, 2));
