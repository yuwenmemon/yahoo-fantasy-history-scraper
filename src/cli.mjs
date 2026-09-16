import {mkdir, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import path from 'node:path';

const defaultDelayMs = 25000;

const usage = `Usage:
  npm start -- --league-slug NAME --first-season YYYY --last-season YYYY [options]

Options:
  --all-weeks                 Capture every available matchup week.
  --include-season-pages      Capture standings, teams, transactions, settings, draft results, and brackets.
  --max-matchup-pages NUMBER  Stop after this many matchup detail pages per season. Default: 4.
  --request-delay-ms NUMBER   Wait at least this long between Yahoo page loads. Default: 25000.
  --output DIRECTORY          Write snapshots to this directory. Default: data.
  --help                      Show this message.`;

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function getOptions(argv) {
  if (argv.includes('--help')) {
    console.log(usage);
    process.exit(0);
  }

  const options = {
    leagueSlug: null,
    firstSeason: null,
    lastSeason: null,
    allWeeks: false,
    includeSeasonPages: false,
    maxMatchupPages: 4,
    requestDelayMs: defaultDelayMs,
    outputDirectory: path.resolve('data'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--league-slug' && /^[a-z0-9-]+$/i.test(value ?? '')) {
      options.leagueSlug = value;
      index += 1;
    } else if (argument === '--first-season' && /^\d{4}$/.test(value ?? '')) {
      options.firstSeason = Number(value);
      index += 1;
    } else if (argument === '--last-season' && /^\d{4}$/.test(value ?? '')) {
      options.lastSeason = Number(value);
      index += 1;
    } else if (argument === '--all-weeks') {
      options.allWeeks = true;
    } else if (argument === '--include-season-pages') {
      options.includeSeasonPages = true;
    } else if (argument === '--max-matchup-pages' && Number.isInteger(Number(value)) && Number(value) > 0) {
      options.maxMatchupPages = Number(value);
      index += 1;
    } else if (argument === '--request-delay-ms' && Number.isInteger(Number(value)) && Number(value) >= 1000) {
      options.requestDelayMs = Number(value);
      index += 1;
    } else if (argument === '--output' && value) {
      options.outputDirectory = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown or invalid option: ${argument}.\n\n${usage}`);
    }
  }

  if (!options.leagueSlug || !options.firstSeason || !options.lastSeason || options.lastSeason < options.firstSeason) {
    throw new Error(`Use --league-slug NAME --first-season YYYY --last-season YYYY.\n\n${usage}`);
  }
  return options;
}

async function waitForUser(message) {
  const terminal = createInterface({input, output});
  await terminal.question(`${message}\n`);
  terminal.close();
}

async function extractPage(page) {
  return page.evaluate(() => {
    const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const absoluteUrl = (href) => {
      try {
        return new URL(href, location.href).href;
      } catch {
        return href;
      }
    };
    const links = [...document.querySelectorAll('a[href]')].map((link) => ({
      label: text(link),
      url: absoluteUrl(link.getAttribute('href')),
    }));
    const tables = [...document.querySelectorAll('table')].map((table, index) => ({
      index,
      caption: text(table.querySelector('caption')),
      headers: [...table.querySelectorAll('thead th')].map(text),
      rows: [...table.querySelectorAll('tr')]
        .map((row) => ({
          cells: [...row.querySelectorAll(':scope > th, :scope > td')].map(text).filter(Boolean),
          links: [...row.querySelectorAll('a[href]')].map((link) => ({label: text(link), url: absoluteUrl(link.getAttribute('href'))})),
        }))
        .filter((row) => row.cells.length > 0),
    }));
    return {
      title: document.title,
      url: location.href,
      headings: [...document.querySelectorAll('h1, h2, h3, h4')].map(text).filter(Boolean),
      links,
      tables,
      capturedAt: new Date().toISOString(),
    };
  });
}

function matchupLinks(snapshot, week) {
  return [...new Set(snapshot.links
    .map(({url}) => url)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.pathname.endsWith('/matchup')
          && parsed.searchParams.get('week') === String(week)
          && parsed.searchParams.has('mid1')
          && parsed.searchParams.has('mid2');
      } catch {
        return false;
      }
    }))];
}

async function main() {
  const options = getOptions(process.argv.slice(2));
  log('Load Playwright.');
  const {chromium} = await import('playwright');
  log('Playwright is ready.');

  const firstUrl = `https://football.fantasysports.yahoo.com/league/${options.leagueSlug}/${options.firstSeason}`;
  const profileDirectory = path.resolve('playwright-profile');
  log('Start Chrome with the saved Yahoo browser profile.');
  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: 'chrome',
    headless: false,
    viewport: {width: 1440, height: 1000},
    timeout: 30000,
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultNavigationTimeout(30000);
  log(`Open Yahoo. ${firstUrl}`);
  await page.goto(firstUrl, {waitUntil: 'domcontentloaded'});
  await waitForUser('Sign in to Yahoo, then press Enter here.');

  let lastRequestAt = 0;
  const visit = async (url, label) => {
    const waitMs = Math.max(0, options.requestDelayMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) {
      log(`${label}: wait ${Math.ceil(waitMs / 1000)} seconds before the next Yahoo page.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    log(`${label}. ${url}`);
    const response = await page.goto(url, {waitUntil: 'domcontentloaded'});
    lastRequestAt = Date.now();
    if (response?.status() === 999) throw new Error('Yahoo returned HTTP 999. Stop and retry later.');
    await page.locator('table').first().waitFor({state: 'attached', timeout: 5000}).catch(() => undefined);
    return extractPage(page);
  };

  const seasons = [];
  await mkdir(options.outputDirectory, {recursive: true});
  for (let year = options.firstSeason; year <= options.lastSeason; year += 1) {
    const archiveUrl = `https://football.fantasysports.yahoo.com/league/${options.leagueSlug}/${year}`;
    try {
      const home = await visit(archiveUrl, `Season ${year}: load league overview`);
      const canonicalUrl = home.url.replace(/[?#].*$/, '').replace(/\/$/, '');
      const season = {pages: {home}, weeklyScoreboards: {}, matchups: {}, captured: [], rateLimited: false};
      const weekNumbers = options.allWeeks
        ? [...new Set((await page.locator('option').allTextContents())
          .map((label) => label.match(/^\s*Week\s+(\d+)/i)?.[1])
          .filter(Boolean)
          .map(Number))].sort((left, right) => left - right)
        : [1];
      if (weekNumbers.length === 0) throw new Error('Yahoo did not show weekly matchup options.');
      log(`Season ${year}: found ${weekNumbers.length} weekly selector options.`);
      if (options.includeSeasonPages) {
        const pageUrls = {
          standings: `${canonicalUrl}?module=standings&lhst=stand#lhststand`,
          teams: `${canonicalUrl}/teams`,
          transactions: `${canonicalUrl}?transactionsfilter=all&mid=1`,
          settings: `${canonicalUrl}/settings`,
          draftresults: `${canonicalUrl}/draftresults`,
          championshipBracket: `${canonicalUrl}?module=standings&lhst=playoff&ptype=champ`,
          consolationBracket: `${canonicalUrl}?module=standings&lhst=playoff&ptype=consolation`,
        };
        for (const [name, url] of Object.entries(pageUrls)) {
          season.pages[name] = await visit(url, `Season ${year}: load ${name}`);
        }
      }

      let captured = 0;
      for (const week of weekNumbers) {
        const scoreboardUrl = `${canonicalUrl}?matchup_week=${week}&module=matchups&lhst=matchups`;
        const scoreboard = await visit(scoreboardUrl, `Season ${year}: week ${week}: load matchups`);
        season.weeklyScoreboards[week] = scoreboard;
        const details = matchupLinks(scoreboard, week);
        log(`Season ${year}: week ${week}: found ${details.length} matchup detail links.`);
        season.matchups[week] = [];
        for (const [index, detailUrl] of details.entries()) {
          if (captured >= options.maxMatchupPages) break;
          const detail = await visit(detailUrl, `Season ${year}: week ${week}: detail ${index + 1}/${details.length}`);
          season.matchups[week].push(detail);
          captured += 1;
          log(`Season ${year}: week ${week}: detail ${index + 1}/${details.length} loaded. ${detail.tables.length} tables; ${detail.links.length} links.`);
        }
      }
      season.captured = Object.values(season.matchups).flat();
      seasons.push(season);
      log(`Season ${year}: complete.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      seasons.push({pages: {home: {url: archiveUrl, error: message}}, weeklyScoreboards: {}, matchups: {}, captured: [], rateLimited: message.includes('HTTP 999')});
      log(`Season ${year}: stopped. ${message}`);
      break;
    }
  }

  const fileName = `${options.leagueSlug}-${options.firstSeason}-${options.lastSeason}-${options.allWeeks ? 'all-weeks' : 'week-1'}-matchups-1-${options.maxMatchupPages}-history.json`;
  const historyFile = path.join(options.outputDirectory, fileName);
  await writeFile(historyFile, `${JSON.stringify({sourceLeagueUrl: firstUrl, exportedAt: new Date().toISOString(), seasonCount: seasons.length, seasons}, null, 2)}\n`, {mode: 0o600});
  console.log(`Saved ${seasons.length} season snapshot(s) to ${historyFile}`);
  await context.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
