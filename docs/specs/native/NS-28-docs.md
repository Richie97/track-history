# NS-28 — Documentation update

**Phase:** 3 · **Platform:** Shared · **Depends on:** NS-27 · **Estimate:** 3–4 days

## Goal

Bring `README.md`, `AGENTS.md`, and the docs site in line with a three-client
world.

`AGENTS.md` requires docs to ship **in the same change** as the code they
describe. This spec is the sweep for what that rule could not cover — the
cross-cutting rewrites that only make sense once the native apps exist and
`mobile/` is gone. Per-spec doc updates still happen in their own PRs.

## Requirements

### `README.md`

1. Replace the Capacitor mobile section with the native projects: `apps/ios` and
   `apps/android` build instructions, prerequisites (Xcode, Android Studio, JDK),
   and how to point a debug build at `wrangler dev` (including the `10.0.2.2`
   emulator alias and the `DEV_MODE` host allowlist).
2. Rewrite the CarPlay section — the entitlement request steps stay (they are
   still accurate), but every reference to `CarPlayBridgePlugin.swift`, the JS
   bridge, and the scene-lifecycle workarounds goes.
3. Document the golden-contract workflow: `npm run contracts:generate`, when to
   regenerate, and what a failing native decode test means.
4. Add Android Auto if it shipped.
5. Keep the telemetry-import and PDR-derivation sections **unchanged** — that
   feature is unaffected and still lives on the web.

### `AGENTS.md`

1. Rewrite the "Mobile apps" architecture paragraph entirely. It currently
   describes `mobile/`, the `sync-www.mjs` transform, the `native:strip` markers,
   the scene-lifecycle gotchas, and the CarPlay bridge — all gone.
2. Add the **three-client product split** as an explicit convention: native owns
   the on-track path, web owns the desk-bound tail and stays the feature frontier.
   A future agent needs to know that "add this to all three clients" is *not* the
   default.
3. Add the golden-contract convention and where `contracts/golden/` fits.
4. Update the `public/js/platform.js` description — the seam still exists for the
   web build, but it no longer has native shells filling it in. **Check whether
   `platform.js`'s null hooks (`bgLocation`, `recorderRemote`, `onRecorderState`,
   `login`, `shareLink`…) are now permanently null on the only remaining
   consumer.** If so, say so; if the recorder UI is now dead code on the web,
   flag it as a follow-up rather than deleting it here.
5. Update the commands section with the native build/test commands.

### Docs site (`site/`)

Remember the standing rules: written for **users, not developers**; never mentions
Cloudflare, self-hosting, or deployment; all links relative; a new page must be
added to the sidebar of *every* docs page with the prev/next pager wired.

1. **`site/docs/lap-recording.html`** — the substantive one. Recorder behavior
   genuinely changed: reliability with the screen off, the visible Android
   recording notification, Android Auto if shipped, and CarPlay if the entitlement
   landed. Keep the on-device data handling promise prominent — the raw trace
   still never leaves the phone.
2. **`site/index.html`** — update the features grid if Android Auto or CarPlay
   shipped. Do not advertise anything not in the shipped build.
3. **`site/docs/index.html`** — getting started: installing the native apps
   vs the PWA, and where telemetry import lives (web only). Be straightforward
   that file import is a desktop-browser flow; users should not hunt for it in the
   app.
4. **`site/docs/telemetry-import.html`** — add a clear note that import is done in
   the browser. Otherwise unchanged.
5. **`site/docs/privacy.html`** — review against what the native apps actually
   collect and store on device (recorder checkpoints, offline queue, token
   storage). **Bump the effective date on any substantive edit.** Operator remains
   Speedshift LLC.
6. Leave `site/docs/data-model.html` and `site/docs/garage.html` alone unless
   behavior changed — garage is web-only and unaffected.
7. If `public/style.css` design tokens changed during the port, re-mirror them into
   `site/site.css`. They should not have, but check.

## Acceptance criteria

- [ ] No reference to Capacitor, `mobile/`, `sync-www.mjs`, the bridge plugin, or the scene workarounds survives in `README.md` or `AGENTS.md`.
- [ ] `AGENTS.md` states the three-client product split and the golden-contract convention.
- [ ] The `platform.js` question in (4) is answered explicitly, not left ambiguous.
- [ ] `site/` mentions no framework, build tooling, or implementation detail.
- [ ] The site advertises only features present in the shipped builds.
- [ ] Every internal link on the site is relative and resolves both at docs.trackevolution.app and under the `/track-history/` GitHub Pages subpath.
- [ ] Privacy policy reviewed; effective date bumped if edited.
- [ ] `og-image.png` still identical between `site/` and `public/`.

## Verification

```sh
npm test && npm run typecheck
grep -ril "capacitor\|sync-www\|CarPlayBridge" README.md AGENTS.md site/   # expect no hits
```

Serve `site/` locally and click every sidebar and pager link in both path layouts.
Check the GitHub Pages deploy after merge — `.github/workflows/pages.yml` fires on
pushes to `main` touching `site/**`.

## Notes

- The docs site is the one place where being behind the code is *correct*: it must
  never describe an unshipped feature. If CarPlay or Android Auto has not cleared
  review, leave them out and add them when they land.
