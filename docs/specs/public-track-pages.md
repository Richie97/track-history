# Public track pages (#457)

One public, indexable page per catalog track, so a search for
"<track> lap times" finds something. Web and Worker only; the phone apps are
unchanged.

## The consent rule

**A public page names no driver.** The leaderboard opt-in promises a name and
a best device-timed lap to other signed-in drivers; it does not promise the
open web. So the public pages take only what cannot say whose it is:

- the number of opted-in drivers with a device-timed lap at the track, and
- the best lap of each of the fastest ten, as a time alone.

No name, date, car, lap id, telemetry or anything a driver typed. A driver who
has not opted in is not counted, and opting out removes their time on the next
request. No new consent flag and no change to the opt-in copy on any client;
the privacy policy and the data-model page say what the pages show.

Adding names later needs a separate, default-off consent (the
`leaderboard_share_laps` pattern), not a widening of this one.

## Routes

All on the app host, outside `/api`, in `run_worker_first`, with no session read.

| Route | Answers |
| --- | --- |
| `GET /tracks` | Every catalog track with its lap length, linked. |
| `GET /tracks/<slug>` | The track: length, fastest lap, driver count, up to ten unnamed best laps, how to time your own, the venue's other layouts. An unknown slug is a `noindex` 404. |
| `GET /tracks/sitemap.xml` | `/tracks` and every track page; named by a second `Sitemap:` line in `public/robots.txt`. |

The slug is `trackSlug(name)` — derived, not stored. Catalog names change only
by migration, and a test fails if two rows share a slug. **Renaming a catalog
row changes its URL**; a migration that does so owes a redirect from the old slug.

Each page is server-rendered HTML in the docs site's style (`/site/site.css`),
needs no JavaScript, and carries a canonical link, Open Graph tags and JSON-LD
(`WebPage` + `SportsActivityLocation` with the catalog's coordinates +
`BreadcrumbList`; the index is a `CollectionPage`). `Cache-Control: public,
max-age=300`. The service worker skips `/tracks*`.

## Acceptance

- [x] The rule is written here, in the privacy policy (effective date bumped)
      and on the data-model page. The opt-in copy is unchanged because what it
      promises is unchanged.
- [x] No driver is named, and none appears without the opt-in — asserted by
      `test/api/track-pages.test.ts`, including a driver who opts out.
- [x] Nothing user-entered and no telemetry reaches a page.
- [x] Pages are in a sitemap, carry a canonical link and structured data, and
      render without JavaScript.
- [x] `README.md` and `AGENTS.md` describe the route and the rule.

## Not done

- Names on public pages (needs its own consent).
- Per-track Open Graph images.
- A link to the public page from inside the apps.
