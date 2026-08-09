// Parsing Sam's Club fuel prices out of a club page. Pure, so it can be
// unit-tested against saved HTML without touching the network.
// See scripts/test-fuel.mjs.
//
// WHY THE PUBLIC PAGE, NOT THE API
//
// Sam's has an internal club-finder endpoint that returns the same data as
// clean JSON, but it sits behind PerimeterX bot protection: it answers 412 with
// a CAPTCHA redirect to anything that isn't a real browser running their
// sensor. Getting past that would mean defeating a bot-detection system, which
// is not something this project does.
//
// The club page at /club/<id> needs none of that. It is a public, indexable
// page. robots.txt disallows /cart, /checkout and /account, but not /club,
// and it answers a plain GET with no cookies, no custom headers and no
// user-agent spoofing. It also server-renders the prices into the HTML, so
// there is no JavaScript to run.
//
// WHY THIS RUNS IN CI AND NOT IN THE BROWSER
//
// Sam's sends no Access-Control-Allow-Origin header, and answers 403 outright
// to a request carrying an Origin. So a static page cannot fetch this itself at
// any point, because the browser blocks it. The scheduled job in
// .github/workflows/update-prices.yml does the fetching and commits the result,
// and the page only ever reads that committed file from its own origin.
//
// The cost of parsing a ~700KB HTML page for ~200 bytes of JSON is that the
// shape could change without warning. That is handled below: the club id
// embedded in the payload is verified, prices are sanity-checked, and a parse
// that comes back empty leaves the last good reading in place rather than
// blanking the card.

/** Sam's embeds the fuel block in a larger JSON island inside the HTML. */
const MARKER = '"storeFuelPrices"';

// A parsed price outside this range means we matched something that isn't a
// fuel price, such as a version number or a restructured payload. Better to
// report nothing than to send someone to a pump with a fabricated number.
const MIN_PRICE = 0.5;
const MAX_PRICE = 25;

/**
 * Returns the JSON object literal beginning at `start`, or null if it is
 * unbalanced. Counts braces while respecting quoted strings and escapes, since
 * the payload contains addresses and names that may hold braces of their own.
 */
export function sliceJsonObject(text, start) {
  if (text[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * The club whose prices a payload actually describes.
 *
 * The id looks like "CPF_FUELPRICE_PROD_4769". Checking it is what makes a
 * redirect, whether to a nearby club or to a generic page, fail loudly
 * instead of quietly attributing one club's prices to another. That is the
 * failure mode worth engineering against here: a wrong price is worse than
 * no price.
 */
export function clubIdFrom(id) {
  const m = typeof id === 'string' ? id.match(/(\d+)\s*$/) : null;
  return m ? Number(m[1]) : null;
}

/** Keeps the upstream ordering, which runs cheapest grade first. */
function normalisePrices(raw) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const entry of raw) {
    const price = Number(entry?.price);
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;
    if (entry?.type && entry.type !== 'fuel') continue;

    const name =
      (typeof entry?.displayName === 'string' && entry.displayName.trim()) ||
      (typeof entry?.name === 'string' && entry.name.trim()) ||
      'Fuel';

    out.push({
      grade: name,
      gradeId: Number.isFinite(entry?.gradeId) ? entry.gradeId : null,
      price: Math.round(price * 1000) / 1000,
    });
  }
  return out;
}

/**
 * Pulls the fuel block out of a club page.
 *
 * Returns null rather than throwing when the page simply has no fuel block.
 * Not every club sells fuel, and that is an ordinary answer, not an error.
 * Throws only when the page contradicts itself, i.e. it carries prices for a
 * club we did not ask about.
 */
export function parseClubPage(html, expectedClub) {
  if (typeof html !== 'string' || !html) return null;

  const at = html.indexOf(MARKER);
  if (at < 0) return null;

  // Step past the marker and its colon to the value itself.
  let i = at + MARKER.length;
  while (i < html.length && /[\s:]/.test(html[i])) i++;
  if (html.startsWith('null', i)) return null;

  const slice = sliceJsonObject(html, i);
  if (!slice) return null;

  let payload;
  try {
    payload = JSON.parse(slice);
  } catch {
    return null;
  }

  const found = clubIdFrom(payload?.id);
  if (expectedClub != null && found != null && found !== Number(expectedClub)) {
    throw new Error(`Club page for ${expectedClub} returned prices for club ${found}.`);
  }

  const prices = normalisePrices(payload?.prices);
  if (!prices.length) return null;

  const updatedAt =
    typeof payload?.metadata?.dateCreated === 'string' ? payload.metadata.dateCreated : null;

  return { club: Number(expectedClub ?? found), prices, updatedAt };
}

/**
 * True once a reading is old enough that it should be shown as stale.
 *
 * Measured from when we last confirmed the price against the club page, not
 * from the payload's own dateCreated. See the note on mergeSnapshot: that field
 * does not move when a price moves, so it cannot answer "is this still true".
 */
export function isStale(checkedAt, staleAfterHours, now = Date.now()) {
  if (!checkedAt) return true;
  const t = Date.parse(checkedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > staleAfterHours * 3_600_000;
}

/**
 * Merges a fresh round of readings over the previous snapshot.
 *
 * A club that failed this round keeps its last good reading, flagged with the
 * error, so the page can say "couldn't refresh" while still showing the older
 * price. Blanking a card because one fetch was truncated would be a worse
 * answer than a slightly old one, and truncated fetches do happen.
 *
 * WHY checkedAt IS THE FRESHNESS FIELD, AND updatedAt IS NOT
 *
 * updatedAt is the payload's metadata.dateCreated, and it is not the time the
 * price was set. Observed on 8 Aug 2026: club 8246 read 3.299 in the morning
 * and 3.199 that evening, while dateCreated stayed at 08:20:45.234Z through
 * both. It marks when the day's fuel record was created, and it sits still
 * while the numbers inside it move.
 *
 * So freshness has to come from our own side: checkedAt is when this club's
 * price was last confirmed against the club page. It moves only on a
 * successful read. A club whose fetches keep failing therefore ages out and is
 * marked stale, instead of looking freshly checked because the job ran.
 */
export function mergeSnapshot(previous, readings, fetchedAt) {
  const before = previous?.clubs ?? {};
  const clubs = {};

  for (const reading of readings) {
    const key = String(reading.club);
    const last = before[key];

    if (reading.prices?.length) {
      clubs[key] = {
        club: reading.club,
        prices: reading.prices,
        updatedAt: reading.updatedAt,
        checkedAt: fetchedAt,
        error: null,
      };
      continue;
    }

    clubs[key] = last
      ? { ...last, error: reading.error ?? last.error ?? null }
      : {
          club: reading.club,
          prices: [],
          updatedAt: null,
          checkedAt: null,
          error: reading.error ?? 'No fuel prices published for this club.',
        };
  }

  return { fetchedAt, clubs };
}

/**
 * True when two price lists differ in grade, ordering or value. Used to tell a
 * run that found a new price from one that merely looked again.
 */
export function pricesChanged(before = [], after = []) {
  if (before.length !== after.length) return true;
  return before.some((p, i) => p.grade !== after[i].grade || p.price !== after[i].price);
}
