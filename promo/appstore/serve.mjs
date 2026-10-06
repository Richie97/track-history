// Serve the demo logbook to the iOS Simulator, for recording the app
// preview's footage (see appstore/README.md):
//
//   node capture.mjs          once, to build the demo logbook in .state/
//   node appstore/serve.mjs   then leave this running while ios-capture.sh records
//
// Starts the real Worker on the promo's scratch database at a fixed port,
// signs in as the demo driver through the DEV_MODE bypass (which answers only
// on localhost — the Simulator shares the Mac's), and writes what the capture
// script needs into out/ios/:
//
//   session.env      TE_SERVER and TE_TOKEN — the app takes them as the
//                    DEBUG-only -server.url / -authToken launch arguments —
//                    and TE_LAP_M, the lap's length
//   cota-lap.txt     one lap of the COTA racing line as "lat,lon" waypoints,
//                    which ios-capture.sh drives with `xcrun simctl location`

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as LB from "../demo/logbook.mjs";
import { loadCota, toLatLon } from "../demo/track.mjs";
import { PERSIST, PROMO, signIn, startWorker } from "../lib/worker.mjs";

const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : 8790;
if (!existsSync(PERSIST)) {
  console.error("no demo logbook in .state/ — run `node capture.mjs` first");
  process.exit(1);
}
const IOS = path.join(PROMO, "out", "ios");
mkdirSync(IOS, { recursive: true });

const { worker, base } = await startWorker({ email: LB.DRIVER.email, name: LB.DRIVER.name, port });
const token = await signIn(base);
// The waypoints: every 25 m of the line, from the start/finish. The capture
// script drives it a lap at a time at a slightly different speed each lap, so
// the recorder's predictive delta has something to say.
const track = await loadCota(path.join(PROMO, ".cache"));
const lap = track.pts.filter((_, k) => k % 25 === 0).map((p) => toLatLon(p.x, p.y));
const lapM = Math.round(track.pts.length); // resampled at 1 m
writeFileSync(path.join(IOS, "cota-lap.txt"), lap.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join("\n") + "\n");
writeFileSync(path.join(IOS, "session.env"), `TE_SERVER=${base}\nTE_TOKEN=${token}\nTE_LAP_M=${lapM}\n`);

console.log(`demo logbook (${LB.DRIVER.name}) at ${base}`);
console.log(`wrote out/ios/session.env and out/ios/cota-lap.txt (${lap.length} waypoints, ${lapM} m)`);
console.log("leave this running and record with appstore/ios-capture.sh; Ctrl-C to stop");
const stop = async () => {
  await worker.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
