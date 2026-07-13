// File-type dispatch for telemetry imports. Every parser resolves to the same
// shape the review UI consumes:
//   { kind, date, time, durationS, laps: [{timeMs, estimated}],
//     gps: [{t, lat, lon, v?}] | null, needsLine }
// gps + needsLine feed the start/finish line picker for sources without lap
// markers (GoPro, VBO without [laptiming], FIT without lap messages).

import { parsePdrFile } from "../../pdr.js";
import { parseGpmfFile } from "./gpmf.js";
import { parseVboFile } from "./vbo.js";
import { parseFitFile } from "./fit.js";

export const SUPPORTED_EXT = /\.(mp4|vbo|fit)$/i;

export const KIND_LABELS = { pdr: "PDR", gopro: "GoPro", vbo: "VBO", fit: "Garmin" };

export async function parseTelemetryFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".vbo")) return parseVboFile(file);
  if (name.endsWith(".fit")) return parseFitFile(file);

  // .mp4: Corvette PDR first (the original import path — unchanged), then
  // GoPro GPMF. Both parsers throw a "No ... telemetry track" error when the
  // file simply isn't theirs.
  let pdrErr;
  try {
    const pdr = await parsePdrFile(file);
    return { kind: "pdr", ...pdr, gps: null, needsLine: false };
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
