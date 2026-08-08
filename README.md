# Club Gas

Fuel prices for four Houston-area Sam's Club locations, sorted cheapest first,
with the price difference per gallon against the cheapest one.

It is a static page on GitHub Pages. A scheduled GitHub Action collects the
prices. There is no server, no API key, no build step, and no dependencies.

**Unofficial.** This project is not affiliated with, endorsed by, or operated by
Sam's Club or Walmart. Prices are read once a day from each club's own public
page, so they can be out of date. The pump is the authority on what you pay.

## Why the prices are collected in CI

The simpler design would be a static page that fetches the prices itself. That
does not work. Sam's sends no `Access-Control-Allow-Origin` header, and it
returns `403` to any request that carries an `Origin`:

```
$ curl -I -H "Origin: https://example.github.io" https://www.samsclub.com/club/4769
HTTP/1.1 403 Forbidden
```

A browser therefore cannot do the fetching, so something outside the browser
has to. Here that is GitHub Actions:

```
GitHub Action (cron)  ->  reads 4 club pages  ->  commits docs/prices.json
                                                          |
GitHub Pages  ->  docs/index.html  ->  reads prices.json (same origin)
```

Visitors only read a committed JSON file from this site's own origin. For a
public page that has a useful side effect: no matter how much traffic arrives,
none of it reaches Sam's. A page that fetched live would send every visitor's
page load to their servers, and that is the most likely way to get the whole
approach blocked.

Committing the data has a second benefit. The git history of
`docs/prices.json` doubles as a record of past prices, and the file is
pretty-printed so those diffs stay readable.

### Where the prices come from

Sam's has an internal club-finder API that returns clean JSON, but it is not
usable. It sits behind PerimeterX bot protection and answers `412` with a
CAPTCHA redirect to anything that is not a real browser running their sensor.
This project does not try to get around that.

The public club page needs none of it. `https://www.samsclub.com/club/<id>`
renders the prices into the HTML on the server, and it answers a plain `GET`
with no cookies, no custom headers, and no user-agent spoofing. Sam's also
expects that page to be crawled: `robots.txt` disallows `/cart`, `/checkout`,
`/account`, and `/search`, but not `/club`.

The cost is that [`src/fuel.js`](src/fuel.js) reads about 700KB of HTML to get
roughly 200 bytes of JSON, and the page structure could change at any time. It
guards against that in three ways. It checks the club id embedded in the
payload before it trusts a price, it rejects any number outside a believable
range, and a failed parse keeps the previous reading instead of blanking the
card.

## Schedule

Sam's publishes prices in one batch each day at about 08:18 UTC, which held
true on consecutive days for every club checked. The workflow runs shortly
after:

```yaml
- cron: '40 8 * * *'   # just after the daily batch
- cron: '40 14 * * *'  # second pass for a club that published late
```

GitHub's scheduler is best effort and can run several minutes late. That does
not matter for a number that changes once a day.

Two rules keep the history clean. A run that only changed the `fetchedAt`
timestamp is not committed, because otherwise real price changes would be
buried under daily no-op commits. A run where every club failed exits with an
error instead of committing an empty snapshot.

The header on the page says "Prices from", not "last updated", because it shows
when Sam's published the numbers. When the job last checked is a separate
question, and it appears in the footer. Any price older than 30 hours, which is
about six hours past the normal overnight gap, still appears but is marked
stale.

## Setup

1. Create a public repository and push this directory to it.
2. Go to **Settings > Pages**, set the source to **Deploy from a branch**, and
   choose branch `main` with folder **`/docs`**.
3. Go to **Settings > Actions > General** and make sure **Workflow
   permissions** is set to **Read and write permissions**, so the job can
   commit.
4. Go to **Actions > Update prices > Run workflow** to confirm it works. After
   that the schedule takes over.

`docs/prices.json` is already committed with real data, so the page works as
soon as Pages goes live. Step 4 confirms the job runs; it is not required for
the page to render.

### Changing which clubs appear

Edit [`src/stations.js`](src/stations.js). A club number is the last part of
its URL, and every club is listed at
`https://www.samsclub.com/sitemap_locators.xml` in the form
`/club/<number>-<city>-<state>`.

Labels are written into `prices.json` by the job, so the page has no separate
club list that could fall out of step.

## Local development

```bash
npm run serve     # http://localhost:4173
npm run fetch     # rewrite docs/prices.json from the live club pages
npm test          # 23 unit tests, no network access
```

There are no dependencies, so `npm install` is not needed. Node 18 or newer.

Opening `docs/index.html` straight from disk will not work. The page is an ES
module and it fetches `prices.json`, and browsers block both over `file://`.
Use `npm run serve` instead.

## Tests

There are 23 tests on [`src/fuel.js`](src/fuel.js). They use no network and no
DOM. They cover brace matching the price payload out of a large HTML file while
respecting quoted strings and escapes, rejecting prices that belong to a
different club, rejecting implausible numbers, the staleness cutoff, and
keeping the last good price when a fetch fails.

The club mismatch test is the important one. Showing one club's price under
another club's name would send someone to the wrong pump expecting the wrong
number, so that case fails loudly rather than quietly.
