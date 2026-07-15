// File-type dispatch for telemetry imports. Every parser resolves to the same
// shape the review UI consumes:
//   { kind, date, time, durationS, laps: [{timeMs, estimated}],
//     gps: [{t, lat, lon, v?}] | null, needsLine }
// gps + needsLine feed the start/finish line picker for sources without lap
// markers (GoPro, beacon-less PDR, VBO without [laptiming], FIT without lap
// messages). PDR results also carry `metrics` (top speed / max rpm / max
// lateral G), `channels` (raw latitude/odometer series) and `lapRecovery` —
// when a PDR file's GPS can't be decoded, beacon-less recordings get their
// laps recovered from lat-vs-distance periodicity instead of the line picker
// (pdr-laps.js).

import { parsePdrFile } from "../../pdr.js";
import { parseGpmfFile } from "./gpmf.js";
import { parseVboFile } from "./vbo.js";
import { parseFitFile } from "./fit.js";
import { lapTrace, projectTrace } from "./geo.js";
import { recoverPdrLaps } from "./pdr-laps.js";

export const SUPPORTED_EXT = /\.(mp4|vbo|fit)$/i;

export const KIND_LABELS = { pdr: "PDR", gopro: "GoPro", vbo: "VBO", fit: "Garmin" };

export async function parseTelemetryFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".vbo")) return parseVboFile(file);
  if (name.endsWith(".fit")) return parseFitFile(file);

  // .mp4: Corvette PDR first, then GoPro GPMF. Both parsers throw a
  // "No ... telemetry track" error when the file simply isn't theirs.
  let pdrErr;
  try {
    const pdr = await parsePdrFile(file);
    // Beacon-timed laps share the telemetry clock with the GPS trace, so the
    // fastest lap's window cuts straight out of it (like FIT). Without laps,
    // the trace goes to the start/finish line picker instead.
    let bestLapTrace = null;
    if (pdr.gps && pdr.laps.length) {
      const best = pdr.laps.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
      bestLapTrace = lapTrace(projectTrace(pdr.gps), best.startT, best.endT);
    }
    // No beacons and no decodable GPS trace: recover laps from latitude +
    // odometer. Boundaries start as rolling laps; anchorPdrBatch (ui.js)
    // aligns them to the start/finish when the batch has a beacon-timed
    // session of the same track.
    let lapRecovery = null;
    if (!pdr.laps.length && !pdr.gps) {
      lapRecovery = recoverPdrLaps(pdr.channels);
      if (lapRecovery) pdr.laps = lapRecovery.laps;
    }
    return { kind: "pdr", ...pdr, bestLapTrace, lapRecovery, needsLine: !pdr.laps.length && !!pdr.gps };
  } catch (err) {
    pdrErr = err;
  }
  try {
    return await parseGpmfFile(file);
  } catch (gpErr) {
    const noTrack = (e) => /No .* telemetry track/.test(e.message);
    if (noTrack(pdrErr) && noTrack(gpErr)) {
      throw new Error("No PDR or GoPro telemetry in this video");
    }
    throw noTrack(pdrErr) ? gpErr : pdrErr;
  }
}
