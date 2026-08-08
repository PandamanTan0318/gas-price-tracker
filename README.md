# Club Gas

Current fuel prices at four Houston-area Sam's Club locations, cheapest first,
with the per-gallon difference against the cheapest.

A static page on GitHub Pages, fed by a scheduled GitHub Action. No server, no
API key, no build step, no dependencies.

**Unofficial.** Not affiliated with, endorsed by, or operated by Sam's Club or
Walmart. Prices are read once a day from each club's own public page and may be
out of date. The pump is authoritative.

## Why it works this way

The obvious design — a static page that fetches the prices itself — is
impossible. Sam's sends no `Access-Control-Allow-Origin` header, and answers
`403` outright to a request carrying an `Origin`:

```
$ curl -I -H "Origin: https://example.github.io" https://www.samsclub.com/club/4769
HTTP/1.1 403 Forbidden
```

So the browser can never do the fetching. Something server-side has to, and
that something is CI:

```
GitHub Action (cron)  ->  scrapes 4 club pages  ->  commits docs/prices.json
                                                          |
GitHub Pages  ->  docs/index.html  ->  reads prices.json (same origin)
```

Visitors only ever read a committed JSON file from the site's own origin. That
has a pleasant consequence for a public tool: **however much traffic the page
gets, Sam's sees none of it.** A live-fetching design would put every visitor's
page load onto their servers, which is the one thing likely to get the whole
approach blocked.

A second consequence is free of charge: because the data is committed, the git
history of `docs/prices.json` **is** a price history. It is pretty-printed so
those diffs are readable.

### Where the prices come from

Sam's has an internal club-finder API returning clean JSON, and it is a dead
end: it sits behind PerimeterX bot protection and answers `412` with a CAPTCHA
redirect to anything that is not a real browser running their sensor. Defeating
that is not something this project does.

The public club page needs none of it. `https://www.samsclub.com/club/<id>`
server-renders the prices into the HTML and answers a plain `GET` with no
cookies, no custom headers and no user-agent spoofing. It is also a page Sam's
expects to be crawled: `robots.txt` disallows `/cart`, `/checkout`, `/account`
and `/search`, but not `/club`.

The trade is that [`src/fuel.js`](src/fuel.js) parses ~700KB of HTML for ~200
bytes of JSON, and the shape could change without notice. So it verifies the
club id embedded in the payload before trusting a price, rejects anything
outside a believable range, and a failed parse leaves the previous reading in
place rather than blanking the card.

## Schedule

Sam's publishes in one daily batch at roughly 08:18 UTC, observed on
consecutive days across every club checked. So:

```yaml
- cron: '40 8 * * *'   # just after the batch
- cron: '40 14 * * *'  # a club that published late
```

GitHub's scheduler is best effort and can run several minutes behind, which does
not matter for a number that moves once a day.

A run that only moved the `fetchedAt` timestamp is **not** committed — otherwise
every real price change would be buried in daily no-op commits. A run where
every club failed exits non-zero rather than committing a snapshot of nothing.

The header reads **"Prices from"**, not "last updated", because it shows when
Sam's published. When the job last looked is a different question and sits in
the footer. A price older than 30 hours — about six hours past the ordinary
overnight gap — is still shown but marked stale.

## Setup

1. Create a new **public** repository and push this directory to it.
2. **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder
   **`/docs`**.
3. **Settings → Actions → General → Workflow permissions**: ensure
   *Read and write permissions* is enabled, so the job can commit.
4. **Actions → Update prices → Run workflow** to seed the first file. After
   that the cron takes over.

`docs/prices.json` is committed with real data already, so the page works from
the first deploy.

### Changing which clubs

Edit [`src/stations.js`](src/stations.js). Club numbers are the last path
segment of the club URL, and every club is listed at
`https://www.samsclub.com/sitemap_locators.xml` as `/club/<number>-<city>-<state>`.

The labels ride along in `prices.json`, so the page has no club list of its own
to keep in step.

## Local development

```bash
npm run serve     # http://localhost:4173
npm run fetch     # refresh docs/prices.json from the live club pages
npm test          # 23 unit tests, no network
```

`npm install` is not needed — there are no dependencies. Node 18 or newer.

Opening `docs/index.html` directly with `file://` will not work: the page is an
ES module and fetches `prices.json`, both of which browsers block over
`file://`. Hence `npm run serve`.

## Tests

23 tests on [`src/fuel.js`](src/fuel.js), with no network and no DOM: brace
matching the price payload out of a large HTML page while respecting quoted
strings, refusing prices belonging to a different club, rejecting implausible
numbers, staleness boundaries, and keeping the last good price when a fetch
fails.

The club-mismatch test earns its place: showing one club's price under another
club's name would send someone to the wrong pump believing a wrong number,
which is the failure worth engineering against.
