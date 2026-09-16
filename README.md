# Yahoo Fantasy History Scraper

A local, browser-assisted exporter for Yahoo Fantasy Football league history.

The scraper opens Chrome, where you sign in to your own Yahoo account. It then
captures the league pages that your account can access and writes local JSON
snapshots. Nothing is sent to another service by this project.

## What it captures

- League overview, weekly scoreboards, and each available matchup detail page.
- Optional season pages: standings, teams, transactions, settings, draft
  results, championship bracket, and consolation bracket.
- Player lineups, player scores, and projections when Yahoo presents them in a
  matchup table.

The included analysis commands build a head-to-head matrix, favorite-player
tables, draft return-on-investment rankings, and player-discovery rankings from
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

Run `npm start -- --help` for the full option list.

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
```

Each command writes an HTML report in `reports/`. The reports are local outputs
and are intentionally ignored by Git.

The scripts infer the current season from the newest snapshot. Use
`--active-season YEAR` to choose a different active-manager set. Use
`--exclude-manager "Name"` when a historical manager should not appear in an
analysis.

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
