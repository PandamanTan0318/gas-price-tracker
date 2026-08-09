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

// Prices change during the day, not once overnight. Club 8246 was read at
// 3.199 in the evening of 8 Aug 2026 after reading 3.299 that morning. So the
// workflow polls every six hours rather than catching a single morning batch.
//
// A reading is therefore normally at most six hours old. Fourteen hours means
// two scheduled runs in a row failed to confirm it, which is a real fault
// rather than an ordinary gap. A stale price is still shown, because an old
// number you can judge beats a blank one, but never as if it were current.
export const STALE_AFTER_HOURS = 14;
