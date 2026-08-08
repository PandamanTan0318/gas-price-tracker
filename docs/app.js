// Reads the prices.json that the scheduled workflow commits, and renders it
// cheapest first.
//
// There is no fetching of Sam's here and there cannot be: they send no CORS
// header and 403 anything carrying an Origin. This file only ever reads a
// same-origin JSON file, which is also why the page has no refresh button —
// pressing one could not produce a newer number than the last committed run.

const el = (id) => document.getElementById(id);

const ui = {
  grades: el('grades'),
  cards: el('cards'),
  empty: el('empty'),
  error: el('error'),
  updated: el('updated'),
  checked: el('checked'),
  cardTpl: el('card-tpl'),
};

const GRADE_KEY = 'grade';

// Kept in step with STALE_AFTER_HOURS in src/stations.js. Duplicated rather
// than imported because the page is plain static files with no build step, and
// one number is a cheaper duplication than a bundler.
const STALE_AFTER_HOURS = 30;

const state = {
  stations: [],
  grade: localStorage.getItem(GRADE_KEY) || null,
  fetchedAt: null,
};

// ---------------------------------------------------------------- formatting

// Sam's quotes fuel with the traditional nine-tenths of a cent and prints it as
// a small raised digit, on their site and on the pump sign. Matching that means
// the number here reads the same as the number you pull up to, rather than a
// "3.379" you have to mentally re-parse.
function splitPrice(price) {
  if (price == null || !Number.isFinite(price)) return null;
  const mills = Math.round(price * 1000);
  return {
    dollars: (Math.floor(mills / 10) / 100).toFixed(2),
    ninth: String(mills % 10),
  };
}

const MINUS = '−'; // U+2212, not a hyphen

/** Difference from the cheapest club, in cents per gallon. */
function fmtDelta(price, best) {
  if (price == null || best == null) return '';
  const cents = Math.round((price - best) * 1000) / 10;
  if (cents === 0) return '';
  const n = Number.isInteger(cents) ? String(Math.abs(cents)) : Math.abs(cents).toFixed(1);
  return `${cents > 0 ? '+' : MINUS}${n}¢`;
}

const clock = (d) =>
  d
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
    // Recent ICU emits U+202F before the meridiem, older builds a plain space.
    // Normalise either to a non-breaking space so "2:15 PM" cannot wrap.
    .replace(/[\s  ]+(?=[ap]\.?m\.?$)/i, ' ');

/**
 * When a price was published. Prices land in one daily batch, so the useful
 * question is which day's batch this is — "yesterday" is the signal that
 * something was missed, and a bare clock time would hide it.
 */
function fmtWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  if (then >= midnight) return clock(then);
  const yesterday = new Date(midnight.getTime() - 86_400_000);
  if (then >= yesterday) return `Yesterday ${clock(then)}`;
  return then.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function isStale(updatedAt) {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > STALE_AFTER_HOURS * 3_600_000;
}

// ---------------------------------------------------------------- rendering

const priceOf = (station, grade) =>
  station.prices?.find((p) => p.grade === grade)?.price ?? null;

/** Every grade any club publishes, in the order clubs list them. */
function gradesAvailable() {
  const seen = [];
  for (const s of state.stations) {
    for (const p of s.prices ?? []) if (!seen.includes(p.grade)) seen.push(p.grade);
  }
  return seen;
}

function renderGrades() {
  const grades = gradesAvailable();
  ui.grades.replaceChildren();
  if (grades.length < 2) return; // nothing to choose between

  if (!grades.includes(state.grade)) state.grade = grades[0];

  for (const grade of grades) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.className = 'tab';
    b.textContent = grade;
    b.setAttribute('aria-selected', String(grade === state.grade));
    b.addEventListener('click', () => {
      state.grade = grade;
      localStorage.setItem(GRADE_KEY, grade);
      renderGrades();
      renderCards();
    });
    ui.grades.append(b);
  }
}

function renderCards() {
  const grade = state.grade;

  // Cheapest first. A club with no price for this grade sinks to the bottom
  // rather than sorting as free.
  const rows = [...state.stations].sort((a, b) => {
    const pa = priceOf(a, grade);
    const pb = priceOf(b, grade);
    if (pa == null) return pb == null ? 0 : 1;
    if (pb == null) return -1;
    return pa - pb;
  });

  const prices = rows.map((s) => priceOf(s, grade)).filter((p) => p != null);
  const best = prices.length ? Math.min(...prices) : null;

  ui.cards.replaceChildren();

  for (const station of rows) {
    const node = ui.cardTpl.content.cloneNode(true);
    const card = node.querySelector('.card');
    const price = priceOf(station, grade);
    const parts = splitPrice(price);

    node.querySelector('[data-label]').textContent = station.label;
    node.querySelector('[data-dollars]').textContent = parts ? parts.dollars : '—';
    node.querySelector('[data-ninth]').textContent = parts ? parts.ninth : '';

    const isBest = price != null && price === best;
    if (isBest) card.classList.add('is-best');

    const delta = node.querySelector('[data-delta]');
    delta.textContent = isBest && rows.length > 1 ? 'Cheapest' : fmtDelta(price, best);

    // A stale or errored price is still shown — an old number you can judge
    // beats a blank card — but it is never allowed to look current.
    const note = node.querySelector('[data-note]');
    const stale = isStale(station.updatedAt);
    if (!station.prices?.length) {
      card.classList.add('is-dim');
      note.hidden = false;
      note.textContent = 'Unavailable';
      note.title = station.error || 'No price published for this club.';
    } else if (stale) {
      card.classList.add('is-stale');
      note.hidden = false;
      note.textContent = 'Stale';
      note.title = `Published ${fmtWhen(station.updatedAt)} and not refreshed since.`;
    }

    // Built from the same split as the headline price rather than toFixed(2),
    // which rounds: 3.999 would print as "4.00" and 4.299 as "4.30", quoting a
    // cent more than the pump charges.
    node.querySelector('[data-others]').textContent = (station.prices ?? [])
      .filter((p) => p.grade !== grade)
      .map((p) => {
        const s = splitPrice(p.price);
        return s ? `${p.grade} ${s.dollars}${s.ninth}` : p.grade;
      })
      .join('  ·  ');

    ui.cards.append(node);
  }

  ui.empty.hidden = rows.length > 0;
}

/**
 * One timestamp for the board. Every club publishes in the same nightly batch,
 * so the newest of them is the age of the whole set.
 *
 * "Prices from", not "last updated": this is when Sam's published, which moves
 * once a day. When the job last looked is a different question, and sits in the
 * footer rather than the headline.
 */
function renderUpdated() {
  const times = state.stations.map((s) => s.updatedAt).filter(Boolean).sort();
  const newest = times[times.length - 1] ?? null;

  ui.updated.textContent = newest ? fmtWhen(newest) : '—';
  ui.updated.classList.toggle('is-stale', state.stations.some((s) => isStale(s.updatedAt)));
  ui.checked.textContent = state.fetchedAt ? `checked ${fmtWhen(state.fetchedAt)}` : '';
}

// ---------------------------------------------------------------- loading

async function load() {
  try {
    // Cache-busted because GitHub Pages caches aggressively and a stale
    // prices.json is the one thing this page must not serve.
    const res = await fetch(`./prices.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load prices (${res.status}).`);

    const data = await res.json();

    // Labels ride along in the file, so this page holds no club list of its
    // own that could drift out of step with src/stations.js.
    state.stations = Array.isArray(data?.stations) ? data.stations : [];
    state.fetchedAt = data?.fetchedAt ?? null;

    ui.error.hidden = true;
  } catch (err) {
    ui.error.hidden = false;
    ui.error.textContent = err.message || 'Could not load prices.';
    state.stations = [];
  }

  renderGrades();
  renderCards();
  renderUpdated();
}

load();
