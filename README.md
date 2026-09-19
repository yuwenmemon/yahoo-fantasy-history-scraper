# Yahoo Fantasy History Scraper

A local, browser-assisted exporter for Yahoo Fantasy Football league history.

The scraper opens Chrome, where you sign in to your own Yahoo account. It then
captures the league pages that your account can access and writes local JSON
snapshots. Nothing is sent to another service by this project.

## What it captures

- League overview, weekly scoreboards, and each available matchup detail page.
- Optional season pages: standings, teams, transactions, settings, draft
  results, championship bracket, and consolation bracket.
- A transaction index plus paginated add, drop, trade, and waiver feeds when
  `--include-season-pages` or `--transactions-only` is set. The index is not
  paginated because its records overlap the category feeds.
- Player lineups, player scores, and projections when Yahoo presents them in a
  matchup table.

The included analysis commands build a head-to-head matrix, player and nemesis
tables, draft return-on-investment rankings, player-discovery rankings,
lineup-regret tables, transaction-value tables, and trade counterfactuals from
the saved snapshots.

## Requirements

- Node.js 20 or later.
- Google Chrome installed locally.
- A Yahoo account with access to the league and its historical seasons.

## Install

```sh
npm install
```

## Collect a league

Start with one season and a small page limit. The script opens Chrome and waits
for you to sign in before it starts the collection.

```sh
npm start -- \
  --league-slug your-league-slug \
  --first-season 2020 \
  --last-season 2020 \
  --all-weeks \
  --include-season-pages \
  --max-matchup-pages 200 \
  --request-delay-ms 30000
```

`--request-delay-ms` sets the minimum time between Yahoo page loads. Start at
30 seconds and reduce it only if Yahoo accepts the traffic. Stop when Yahoo
shows a rate-limit response. Do not use proxies or other methods to bypass
Yahoo limits.

The script writes JSON snapshots to `data/` by default. Use `--output` to
choose a different local directory.

If a network change interrupts a run, use `--resume-from` with the saved
snapshot. The scraper keeps completed seasons and starts the interrupted season
again.

Run `npm start -- --help` for the full option list.

## Collect transactions only

Use the same conservative delay for a transaction-only backfill. This mode
captures the add, drop, trade, and waiver feeds without loading weekly matchup
pages.

```sh
npm start -- \
  --league-slug your-league-slug \
  --first-season 2020 \
  --last-season 2020 \
  --transactions-only \
  --request-delay-ms 30000
```

## Analyze snapshots

The analysis scripts require a local manager identity map at
`data/manager-identity-map.csv`:

```csv
observed_manager_name,manager_id
Example Display Name,example-manager
```

Map every historical Yahoo manager label to one stable identifier. Keep this
file private because Yahoo pages can expose personal information.

```sh
npm run analyze:h2h
npm run analyze:players
npm run analyze:draft-roi
npm run analyze:discoveries
npm run analyze:nemeses
npm run analyze:lineup-regret
npm run analyze:transaction-value
npm run analyze:trade-counterfactuals
```

Each command writes an HTML report in `reports/`. The reports are local outputs
and are intentionally ignored by Git.

The transaction-value and trade-counterfactual commands also need a
transaction-only history snapshot. Pass it explicitly, so the scripts can use
any local league export:

```sh
npm run analyze:transaction-value -- \
  --transaction-history data/your-league-transactions-history.json

npm run analyze:trade-counterfactuals -- \
  --transaction-history data/your-league-transactions-history.json
```

The scripts infer the current season from the newest snapshot. Use
`--active-season YEAR` to choose a different active-manager set. Use
`--exclude-manager "Name"` when a historical manager should not appear in an
analysis.

## Export transactions

Create one deduplicated JSON file from the category feeds. The export leaves
out the overlapping transaction-index rows.

```sh
npm run export:transactions -- \
  --input data/your-league-2025-2025-transactions-only-matchups-1-4-history.json \
  --output data/your-league-2025-transactions.json
```

## Privacy and publishing

Yahoo snapshots can contain league member names, email addresses, player data,
and Yahoo URLs. This repository ignores `data/`, `reports/`, and
`playwright-profile/` to prevent accidental publication. Review `git status`
before every commit, and never add those folders to a public repository.

This project is for exports from leagues that you can access. Use it at a pace
that respects Yahoo's terms and rate limits.

## Limitations

- Yahoo can change its historical HTML at any time.
- The scraper does not resume a partial season automatically.
- Manager identity normalization is a manual local step.
- The project does not include example league data, so the repository stays
  free of private league records.
