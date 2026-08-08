#!/usr/bin/env node
// Fetches every club in src/stations.js and writes docs/prices.json.
//
// Runs in GitHub Actions, not in the browser: Sam's sends no CORS header and
// answers 403 to a request carrying an Origin, so the page it feeds can only
// ever read the committed result from its own origin.
//
// Writing a file that gets committed means the git history doubles as a price
// log for free, which is why the JSON is pretty-printed. A one-line file would
// make every diff useless.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseClubPage, mergeSnapshot } from '../src/fuel.js';
import { STATIONS } from '../src/stations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'docs', 'prices.json');

const CLUB_PAGE = 'https://www.samsclub.com/club';

/**
 * One club's current prices.
 *
 * Retries once on a miss because the failure actually seen in practice is a
 * truncated response rather than a rejection. The page comes back 200 with
 * the fuel block cut off. A club-id mismatch is deterministic, so that one
 * breaks out immediately rather than spending a second request on the same
 * wrong answer.
 */
async function readClub(club) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${CLUB_PAGE}/${club}`, {
        headers: { accept: 'text/html' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`Sam's Club returned ${res.status}`);

      const parsed = parseClubPage(await res.text(), club);
      if (parsed) return { ...parsed, error: null };

      lastError = 'No fuel prices found on the club page.';
    } catch (err) {
      lastError = err?.message || 'Fetch failed';
      if (/returned prices for club/.test(lastError)) break;
    }
  }

  return { club, prices: [], updatedAt: null, error: lastError };
}

// prices.json carries the labels as well as the prices, so the page needs no
// config of its own. GitHub Pages serves only docs/, and a second copy of the
// club list in there would be one that could silently drift out of step with
// this one.
//
// The file is a flat station list rather than the keyed map mergeSnapshot works
// in, because that is what the page renders and what reads clearly in a diff.
// The two shapes are converted at the edges here.

const toClubs = (file) => ({
  clubs: Object.fromEntries((file?.stations ?? []).map((s) => [String(s.club), s])),
});

const toStations = (snapshot) =>
  STATIONS.map(({ club, label }) => {
    const r = snapshot.clubs[String(club)] ?? {};
    return {
      club,
      label,
      prices: r.prices ?? [],
      updatedAt: r.updatedAt ?? null,
      checkedAt: r.checkedAt ?? null,
      error: r.error ?? null,
    };
  });

async function readPrevious() {
  try {
    return toClubs(JSON.parse(await readFile(OUT, 'utf8')));
  } catch {
    // First run, or a file someone hand-edited into invalid JSON. Either way a
    // missing previous snapshot just means nothing to merge over.
    return null;
  }
}

const previous = await readPrevious();
const readings = await Promise.all(STATIONS.map((s) => readClub(s.club)));
const snapshot = mergeSnapshot(previous, readings, new Date().toISOString());

const file = { fetchedAt: snapshot.fetchedAt, stations: toStations(snapshot) };

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

for (const s of file.stations) {
  const prices = s.prices.length
    ? s.prices.map((p) => `${p.grade} ${p.price.toFixed(3)}`).join('  ')
    : '—';
  console.log(`${String(s.club).padEnd(6)} ${prices.padEnd(40)} ${s.error ?? ''}`);
}

// A round where every club failed is systemic, such as a blocked runner or a
// restructured page, and should fail the job loudly rather than quietly
// committing a snapshot of nothing. Individual failures are fine: those clubs
// keep their previous price and the page marks them.
if (!file.stations.some((s) => s.prices.length)) {
  console.error('\nNo prices for any club. Refusing to treat this as a successful run.');
  process.exit(1);
}
