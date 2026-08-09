#!/usr/bin/env node
// Unit tests for Sam's Club fuel price parsing. Run with `npm test`.

import { strict as assert } from 'node:assert';
import {
  sliceJsonObject,
  clubIdFrom,
  parseClubPage,
  isStale,
  mergeSnapshot,
  pricesChanged,
} from '../src/fuel.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// A trimmed copy of the real payload, in the real setting: buried in a large
// JSON island inside HTML, with other objects on either side.
const fuelBlock = (club, prices, dateCreated = '2026-08-02T08:19:06.602Z') =>
  `"storeFuelPrices":{"countryCode":"US","id":"CPF_FUELPRICE_PROD_${club}",` +
  `"metadata":{"dateCreated":"${dateCreated}","createdBy":"CPF_STORAGE"},` +
  `"prices":${JSON.stringify(prices)}}`;

const page = (inner) =>
  `<!doctype html><html><body><script>window.__DATA={"a":{"b":1},${inner},"after":{"c":2}}</script></body></html>`;

const UNLEAD = { price: 3.379, gradeId: 11, displayName: 'Unleaded', name: 'UNLEAD', type: 'fuel' };
const PREMIUM = { price: 4.299, gradeId: 16, displayName: 'Premium', name: 'PREMIUM', type: 'fuel' };

// ---- brace matching -------------------------------------------------------

test('slices a balanced object out of surrounding text', () => {
  const text = 'xx{"a":{"b":1}}yy';
  assert.equal(sliceJsonObject(text, 2), '{"a":{"b":1}}');
});

// The payload carries addresses and club names; a brace inside a string must
// not be counted as structure.
test('ignores braces inside strings', () => {
  const text = '{"a":"}{","b":1}';
  assert.equal(sliceJsonObject(text, 0), text);
});

test('ignores an escaped quote inside a string', () => {
  const text = '{"a":"say \\"}\\" now","b":1}';
  assert.equal(sliceJsonObject(text, 0), text);
});

test('returns null on an unbalanced object rather than a truncated one', () => {
  assert.equal(sliceJsonObject('{"a":1', 0), null);
  assert.equal(sliceJsonObject('not an object', 0), null);
});

// ---- club id --------------------------------------------------------------

test('reads the club number off the payload id', () => {
  assert.equal(clubIdFrom('CPF_FUELPRICE_PROD_4769'), 4769);
  assert.equal(clubIdFrom('CPF_FUELPRICE_PROD_6338'), 6338);
});

test('a shapeless id yields null rather than a wrong number', () => {
  assert.equal(clubIdFrom(undefined), null);
  assert.equal(clubIdFrom(''), null);
  assert.equal(clubIdFrom('CPF_FUELPRICE_PROD'), null);
});

// ---- parsing --------------------------------------------------------------

test('pulls both grades out of a club page', () => {
  const out = parseClubPage(page(fuelBlock(4769, [UNLEAD, PREMIUM])), 4769);
  assert.deepEqual(out.prices, [
    { grade: 'Unleaded', gradeId: 11, price: 3.379 },
    { grade: 'Premium', gradeId: 16, price: 4.299 },
  ]);
  assert.equal(out.updatedAt, '2026-08-02T08:19:06.602Z');
  assert.equal(out.club, 4769);
});

// Some clubs sell diesel too, so the grade list is whatever upstream sends.
test('handles a club with more than two grades', () => {
  const diesel = { price: 3.899, gradeId: 20, displayName: 'Diesel', name: 'DIESEL', type: 'fuel' };
  const out = parseClubPage(page(fuelBlock(4873, [UNLEAD, PREMIUM, diesel])), 4873);
  assert.equal(out.prices.length, 3);
  assert.equal(out.prices[2].grade, 'Diesel');
});

// The failure that actually matters: showing one club's price under another
// club's name would send someone to the wrong pump believing a wrong number.
test('throws when the page describes a different club', () => {
  assert.throws(
    () => parseClubPage(page(fuelBlock(8274, [UNLEAD])), 4769),
    /returned prices for club 8274/
  );
});

test('a club with no fuel block is an ordinary null, not an error', () => {
  assert.equal(parseClubPage(page('"other":{"x":1}'), 4769), null);
  assert.equal(parseClubPage('"storeFuelPrices":null', 4769), null);
});

test('survives absent and malformed input', () => {
  assert.equal(parseClubPage(undefined, 4769), null);
  assert.equal(parseClubPage('', 4769), null);
  assert.equal(parseClubPage('"storeFuelPrices":{"prices":', 4769), null);
  assert.equal(parseClubPage('"storeFuelPrices":{not json}', 4769), null);
});

test('an empty price list reads as no data rather than an empty card', () => {
  assert.equal(parseClubPage(page(fuelBlock(4769, [])), 4769), null);
});

// A restructured payload is likelier to yield a version number than a price,
// and a fabricated pump price is worse than an admitted blank.
test('rejects prices outside a believable range', () => {
  const junk = { price: 20260801, gradeId: 1, displayName: 'Build', type: 'fuel' };
  assert.equal(parseClubPage(page(fuelBlock(4769, [junk])), 4769), null);
  assert.equal(parseClubPage(page(fuelBlock(4769, [{ price: 0, displayName: 'Free' }])), 4769), null);
});

test('drops non-fuel entries but keeps the fuel beside them', () => {
  const merch = { price: 9.99, gradeId: 99, displayName: 'Hot dog', type: 'food' };
  const out = parseClubPage(page(fuelBlock(4769, [merch, UNLEAD])), 4769);
  assert.equal(out.prices.length, 1);
  assert.equal(out.prices[0].grade, 'Unleaded');
});

test('falls back to the internal name when displayName is missing', () => {
  const out = parseClubPage(page(fuelBlock(4769, [{ price: 3.1, name: 'UNLEAD', type: 'fuel' }])), 4769);
  assert.equal(out.prices[0].grade, 'UNLEAD');
});

// ---- staleness ------------------------------------------------------------

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-03T12:00:00Z');

test('a reading from the last scheduled run is fresh', () => {
  assert.equal(isStale('2026-08-03T08:40:00Z', 14, NOW), false);
});

test('a reading from two days ago is stale', () => {
  assert.equal(isStale('2026-08-01T08:40:00Z', 14, NOW), true);
});

test('an absent or unparseable timestamp counts as stale', () => {
  assert.equal(isStale(null, 14, NOW), true);
  assert.equal(isStale('not a date', 14, NOW), true);
});

test('the boundary is the configured window, not a hardcoded day', () => {
  assert.equal(isStale(new Date(NOW - 13 * HOUR).toISOString(), 14, NOW), false);
  assert.equal(isStale(new Date(NOW - 15 * HOUR).toISOString(), 14, NOW), true);
});

// ---- change detection -----------------------------------------------------

const list = (...prices) => prices.map((price, i) => ({ grade: `G${i}`, price }));

test('a moved price reads as a change', () => {
  assert.equal(pricesChanged(list(3.299), list(3.199)), true);
});

test('an identical list reads as no change', () => {
  assert.equal(pricesChanged(list(3.299, 4.249), list(3.299, 4.249)), false);
});

// A grade appearing or disappearing is as much a change as a price moving.
test('a different number of grades reads as a change', () => {
  assert.equal(pricesChanged(list(3.299), list(3.299, 3.899)), true);
  assert.equal(pricesChanged([], list(3.299)), true);
});

test('the same price under a different grade reads as a change', () => {
  assert.equal(pricesChanged([{ grade: 'Unleaded', price: 3.299 }], [{ grade: 'Premium', price: 3.299 }]), true);
});

// ---- snapshot merging -----------------------------------------------------

const reading = (club, price) => ({
  club,
  prices: [{ grade: 'Unleaded', gradeId: 11, price }],
  updatedAt: '2026-08-03T08:18:00Z',
  error: null,
});

test('a successful round replaces the previous prices', () => {
  const before = mergeSnapshot(null, [reading(4769, 3.379)], 't1');
  const after = mergeSnapshot(before, [reading(4769, 3.299)], 't2');
  assert.equal(after.clubs['4769'].prices[0].price, 3.299);
  assert.equal(after.fetchedAt, 't2');
});

// The observed real-world failure is a truncated page, not an outage. Blanking
// the card for that would replace a slightly old price with no price at all.
test('a failed club keeps its last good price and records the error', () => {
  const before = mergeSnapshot(null, [reading(4769, 3.379)], 't1');
  const after = mergeSnapshot(
    before,
    [{ club: 4769, prices: [], updatedAt: null, error: 'truncated' }],
    't2'
  );
  assert.equal(after.clubs['4769'].prices[0].price, 3.379, 'the earlier price survives');
  assert.equal(after.clubs['4769'].updatedAt, '2026-08-03T08:18:00Z', 'and keeps its own timestamp');
  assert.equal(after.clubs['4769'].error, 'truncated');
});

// checkedAt drives the stale badge, so it has to mean "last confirmed", not
// "last attempted". If a failed round advanced it, a club that stopped
// answering would keep looking freshly checked for as long as the job ran.
test('a failed club does not advance its checkedAt', () => {
  const before = mergeSnapshot(null, [reading(4769, 3.379)], 't1');
  const after = mergeSnapshot(
    before,
    [{ club: 4769, prices: [], updatedAt: null, error: 'truncated' }],
    't2'
  );
  assert.equal(after.clubs['4769'].checkedAt, 't1');
  assert.equal(after.fetchedAt, 't2', 'the run itself is still recorded');
});

test('a successful club advances its checkedAt', () => {
  const before = mergeSnapshot(null, [reading(4769, 3.379)], 't1');
  const after = mergeSnapshot(before, [reading(4769, 3.379)], 't2');
  assert.equal(after.clubs['4769'].checkedAt, 't2', 'confirmed again, even unchanged');
});

test('a club that has never succeeded reports the error with no prices', () => {
  const out = mergeSnapshot(null, [{ club: 8274, prices: [], updatedAt: null, error: 'boom' }], 't1');
  assert.deepEqual(out.clubs['8274'].prices, []);
  assert.equal(out.clubs['8274'].error, 'boom');
  assert.equal(out.clubs['8274'].checkedAt, null, 'never confirmed, so never fresh');
});

test('a club dropped from the config falls out of the snapshot', () => {
  const before = mergeSnapshot(null, [reading(4769, 3.379), reading(8274, 3.289)], 't1');
  const after = mergeSnapshot(before, [reading(4769, 3.359)], 't2');
  assert.deepEqual(Object.keys(after.clubs), ['4769']);
});

console.log(`\n${passed} passed`);
