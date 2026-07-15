// Racelogic .vbo parser. Plain ASCII: an optional "File created on ..." line,
// [section] blocks — [column names] for the data layout, [laptiming] for the
// start/finish line, [data] for the samples. Written by VBOX hardware and by
// RaceChrono / TrackAddict / Harry's LapTimer exports.
//
// Coordinates are in minutes (degrees * 60); Racelogic longitude is
// west-positive but exporters vary — irrelevant here because lap derivation
// is relative geometry within the file (see geo.js).

import { bestLapTrace, deriveLaps, gateFromSegment, projectTrace } from "./geo.js";

// "095512.30" (UTC time-of-day) -> seconds
function timeOfDayS(s) {
  const m = /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parseVboText(text) {
  const lines = text.split(/\r?\n/);

  let date = null;
  let time = null;
  const created = /created on (\d{2})\/(\d{2})\/(\d{4})(?: at| @)? (\d{2}):(\d{2})(?::(\d{2}))?/i.exec(
    lines[0] ?? ""
  );
  if (created) {
    date = `${created[3]}-${created[2]}-${created[1]}`;
    time = `${created[4]}:${created[5]}:${created[6] ?? "00"}`;
  }

  // Collect sections.
  const sections = {};
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }

  const colNames = (sections["column names"]?.[0] ?? "").split(/\s+/).filter(Boolean);
  if (!colNames.length) throw new Error("Not a valid VBO file (no [column names] section)");
  const col = (name) => colNames.indexOf(name);
  const iTime = col("time");
  const iLat = col("lat");
  const iLon = col("long");
  const iVel = col("velocity");
  if (iTime < 0 || iLat < 0 || iLon < 0) {
    throw new Error("VBO file is missing time/lat/long columns");
  }
  // gps.v is m/s across all parsers (channels.js depends on it). The [header]
  // section names the velocity unit — "velocity kmh" in VBOX files and the
  // common exporters; handle mph/knots variants, default km/h.
  const velLine = (sections["header"] ?? []).find((l) => /^velocity\b/i.test(l)) ?? "";
  const velToMs = /mph/i.test(velLine) ? 0.44704 : /kts|knots/i.test(velLine) ? 0.514444 : 1 / 3.6;

  // Data rows -> GPS points. VBO coordinates are minutes -> /60 to degrees.
  // The time column is UTC time-of-day; make t relative to the first sample
  // (handling a midnight wrap).
  const points = [];
  let t0 = null;
  for (const row of sections["data"] ?? []) {
    const f = row.split(/\s+/);
    if (f.length < colNames.length) continue;
    const tod = timeOfDayS(f[iTime]);
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (tod == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue; // no GPS fix
    if (t0 == null) t0 = tod;
    let t = tod - t0;
    if (t < 0) t += 86400;
    points.push({ t, lat: lat / 60, lon: lon / 60, v: iVel >= 0 ? Number(f[iVel]) * velToMs : undefined });
  }
  if (points.length < 10) throw new Error("VBO file contains no usable GPS data");

  if (!time && t0 != null) {
    const h = Math.floor(t0 / 3600);
    const mi = Math.floor((t0 % 3600) / 60);
    const se = Math.floor(t0 % 60);
    time = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(se).padStart(2, "0")}`;
  }

  // [laptiming]: "Start <lat1> <lon1> <lat2> <lon2>" (minutes, two endpoints
  // of the start/finish line). If present, laps come for free.
  let laps = [];
  let lapTracePts = null;
  const startLine = (sections["laptiming"] ?? []).find((l) => /^start\s/i.test(l));
  if (startLine) {
    const n = startLine.split(/\s+/).slice(1).map(Number);
    if (n.length >= 4 && n.every(Number.isFinite)) {
      const origin = points[0];
      const [end1, end2] = projectTrace(
        [
          { t: 0, lat: n[0] / 60, lon: n[1] / 60 },
          { t: 0, lat: n[2] / 60, lon: n[3] / 60 },
        ],
        origin
      );
      const trace = projectTrace(points, origin);
      const gate = gateFromSegment(end1, end2);
      laps = deriveLaps(trace, gate);
      if (laps.length) lapTracePts = bestLapTrace(trace, gate);
    }
  }

  return {
    kind: "vbo",
    date,
    time,
    durationS: points[points.length - 1].t,
    laps,
    bestLapTrace: lapTracePts,
    gps: points,
    // A [laptiming] line that yields no laps (wrong circuit, odd layout)
    // falls back to manual line picking.
    needsLine: laps.length === 0,
  };
}

export async function parseVboFile(fileBlob) {
  return parseVboText(await fileBlob.text());
}
