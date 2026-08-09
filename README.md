# Club Gas

Fuel prices for four Houston-area Sam's Club locations, sorted cheapest first,
with the price difference per gallon against the cheapest one.

It is a static page on GitHub Pages. A scheduled GitHub Action collects the
prices. There is no server, no API key, no build step, and no dependencies.

**Unofficial.** This project is not affiliated with, endorsed by, or operated by
Sam's Club or Walmart. Prices are read every six hours from each club's own
public page, so they can be out of date. The pump is the authority on what you
pay.

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

The workflow runs every six hours:

```yaml
- cron: '40 2,8,14,20 * * *'
```

Prices move during the day, not once overnight. On 8 August 2026 club 8246 read
3.29⁹ in the morning and 3.19⁹ that evening. A single morning run would have
shown the earlier number for the rest of the day.

Cron in GitHub Actions is UTC and does not follow daylight saving, so the local
times shift by an hour in winter. The scheduler is also best effort and can run
several minutes late, which the six-hour spacing absorbs.

A run where every club failed exits with an error instead of committing an
empty snapshot.

### Why the page says "checked" and not "prices from"

The payload carries a `metadata.dateCreated` field, and it is tempting to treat
it as the time the price was set. It is not. On the day above it stayed at
`08:20:45.234Z` across both readings while the price itself moved ten cents. It
marks when the day's fuel record was created, and it holds still while the
numbers inside it change.

So the site does not claim to know when a price was set. It reports `checkedAt`,
which is when the job last confirmed that club's price against the club page.
That field advances only on a successful read, so a club that stops answering
ages out and gets marked stale rather than looking freshly checked because the
job happened to run. Anything past 14 hours, meaning two scheduled runs in a
row failed to confirm it, is still shown but marked.

The footer reports the job's last run. Normally it matches the header. A gap
between them means the schedule is firing but some club is not coming back.

### Commit history

Every run commits, including runs where no price moved, because the page reads
`checkedAt` out of the committed file and a run that skipped committing would
leave a working job looking broken.

The commit subject carries the difference instead, so the price history is one
grep away:

```bash
git log --grep='^Price change'
```

A run that found new prices is committed as `Price changes at 3 clubs (...)`
with the before and after for each club in the body. A run that found none is
committed as `No change at (...)`.

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
npm test          # 29 unit tests, no network access
```

There are no dependencies, so `npm install` is not needed. Node 18 or newer.

Opening `docs/index.html` straight from disk will not work. The page is an ES
module and it fetches `prices.json`, and browsers block both over `file://`.
Use `npm run serve` instead.

## Tests

There are 29 tests on [`src/fuel.js`](src/fuel.js). They use no network and no
DOM. They cover brace matching the price payload out of a large HTML file while
respecting quoted strings and escapes, rejecting prices that belong to a
different club, rejecting implausible numbers, the staleness cutoff, detecting
which prices moved between two runs, and keeping the last good price when a
fetch fails.

Two of them matter more than the rest. The club mismatch test: showing one
club's price under another club's name would send someone to the wrong pump
expecting the wrong number, so that case fails loudly rather than quietly. And
the test that a failed round does not advance `checkedAt`: if it did, a club
that stopped answering would keep looking freshly checked forever, which is the
same class of mistake as trusting `dateCreated`.
