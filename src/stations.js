// ---------------------------------------------------------------------------
// THE CLUBS THIS SITE TRACKS. This is the only file you need to edit.
//
// `club`   Sam's Club number, the last path segment of the club URL:
//          https://www.samsclub.com/club/4769  ->  club: 4769
// `label`  full name, shown on the card
//
// Every club is listed at https://www.samsclub.com/sitemap_locators.xml as
// /club/<number>-<city>-<state>.
//
// Unlike the private commute app this was extracted from, nothing here is
// sensitive: these are public storefronts, and the file is committed to a
// public repository on purpose.
// ---------------------------------------------------------------------------

export const STATIONS = [
  { club: 4769, label: 'Galleria · S Rice Ave' },
  { club: 8274, label: 'West Rd' },
  { club: 8246, label: 'Stafford · SW Fwy' },
  { club: 6338, label: 'College Station' },
];

// Sam's publishes prices in a single daily batch at roughly 08:18 UTC, observed
// on consecutive days across every club checked. The workflow runs just after
// that rather than polling through the day.
//
// A price is therefore normally at most ~24h old, and this leaves about six
// hours of grace before one is called stale. It flags a batch that never landed
// rather than the ordinary overnight gap. A stale price is still shown, because
// an old number you can judge beats a blank one, but never as if it were current.
export const STALE_AFTER_HOURS = 30;
