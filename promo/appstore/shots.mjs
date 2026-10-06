// The app preview's shot list: one slot per scene, each played from a clip of
// the native iOS app recorded in the Simulator (out/ios/<id>.mov — see
// README.md) or, until that clip exists, from a draft stand-in built from the
// web app's phone-width captures. Shared by preview.js (the cut),
// render-preview.mjs (frame extraction) and ios-capture.sh's instructions
// (printed by `node appstore/shots.mjs`).
//
// Scenes start on the score's two-second bars; 14 and 26 land on its hits.
// Tiers follow docs/specs/native/NS-32-subscriptions.md, as the promo's do.

export const DURATION = 29.9; // App Store Connect takes 15–30 s
export const FPS = 30;
// Footage starts this long before its scene, under the crossfade.
export const LEAD = 0.3;

export const SLOTS = [
  {
    id: "record", t0: 0, t1: 4, tag: "PRO",
    caption: "Your phone is *the lap timer*",
    howTo: "Dashboard → Record laps → Start, with the simulated drive running (ios-capture.sh starts it). Record once the predictive delta shows — after the second lap.",
  },
  {
    id: "event", t0: 4, t1: 8, tag: "FREE",
    caption: "Every session, *every lap*",
    howTo: "Dashboard → Circuit of the Americas → the Sep 12, 2026 event. Hold a beat at the top, then scroll slowly to the sessions.",
  },
  {
    id: "analysis", t0: 8, t1: 14, tag: "PRO",
    caption: "See where *the time went*",
    howTo: "On that event, Day 2 — Session 3 (the ★ 2:17.827) → open the lap panel, light Lap 2 beside the best, Time tab (delta + sectors); after ~3 s switch to Grip (friction circle).",
  },
  {
    id: "progress", t0: 14, t1: 18, tag: "FREE",
    caption: "Watch your times *fall*",
    howTo: "Circuit of the Americas track page, with the best-lap-per-event chart in view.",
  },
  {
    id: "garage", t0: 18, t1: 22, tag: "PRO",
    caption: "Know when the pads *are due*",
    howTo: "Garage tab → 2023 Corvette Z06. Hold on the maintenance line, then scroll to the front pads' wear bar.",
  },
  {
    id: "leaderboard", t0: 22, t1: 26, tag: "FREE",
    caption: "See where *you rank*",
    howTo: "Circuit of the Americas track page → Leaderboard (Jordan Reyes is P4).",
  },
];

// The closing card, drawn: no footage.
export const END = { t0: 26, t1: DURATION };

// `node appstore/shots.mjs` prints the shot list; `--tsv` is for ios-capture.sh.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--tsv")) {
    for (const s of SLOTS) console.log([s.id, s.t1 - s.t0, s.caption.replace(/\*/g, ""), s.howTo].join("\t"));
    process.exit(0);
  }
  for (const s of SLOTS) {
    console.log(`${s.id.padEnd(12)} ${String(s.t1 - s.t0).padStart(2)} s  ${s.caption.replace(/\*/g, "")}`);
    console.log(`${"".padEnd(12)}       ${s.howTo}`);
  }
}
