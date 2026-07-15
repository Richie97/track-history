// Telemetry import UI: file picker + drag & drop -> parse in the browser ->
// review panel -> POST the accepted files as sessions. Sources with lap
// markers (PDR beacons, VBO [laptiming], Garmin laps) show their laps
// directly; GPS-only sources (GoPro, PDR without beacons, plain VBO/FIT) get
// a track map where the user clicks the start/finish line and laps are
// derived from crossings. Beacon-less PDR recordings whose GPS doesn't decode
// have no trace to click — their laps come from lat+odometer recovery
// (pdr-laps.js), phase-anchored across the batch.
// Expects the event-detail markup: #pdr-files, #pdr-dropzone, #pdr-import, #pdr-review.

import { api } from "../api.js";
import { esc, fmtMs } from "../format.js";
import { KIND_LABELS, SUPPORTED_EXT, parseTelemetryFile } from "./parse.js";
import { bestLapTrace, buildGate, deriveLaps, projectTrace } from "./geo.js";
import { anchorPdrBatch } from "./pdr-laps.js";
import { attachLapChannels } from "./channels.js";

export function bindTelemetryImport(view, event, onDone) {
  const fileInput = view.querySelector("#pdr-files");
  const dropzone = view.querySelector("#pdr-dropzone");
  view.querySelector("#pdr-import").onclick = () => fileInput.click();

  async function importFiles(fileList) {
    const files = [...fileList].filter((f) => SUPPORTED_EXT.test(f.name) || f.type === "video/mp4");
    if (!files.length) return;
    const box = view.querySelector("#pdr-review");
    box.innerHTML = `<div class="panel">Reading telemetry from ${files.length} file${files.length === 1 ? "" : "s"}…</div>`;
    const results = [];
    for (const f of files) {
      try {
        results.push({ file: f.name, parsed: await parseTelemetryFile(f) });
      } catch (err) {
        results.push({ file: f.name, error: err.message });
      }
    }
    results.sort((a, b) => ((a.parsed?.time ?? "") < (b.parsed?.time ?? "") ? -1 : 1));

    // Beacon-less PDR laps start as rolling laps; a beacon-timed PDR session
    // of the same track in this batch re-anchors them to the start/finish.
    // Anchoring re-cuts lap boundaries, so per-lap channels follow.
    anchorPdrBatch(results);
    for (const r of results) {
      if (r.parsed?.kind === "pdr" && r.parsed.lapRecovery) attachLapChannels(r.parsed);
    }

    // Shared coordinate frame for all line-picking files (same track), so one
    // picked line applies to every trace in the batch.
    const first = results.find((r) => r.parsed?.needsLine && r.parsed.gps?.length);
    const state = {
      results,
      origin: first ? first.parsed.gps[0] : null,
      gate: null,
    };
    renderReview(box, event, state, onDone);
  }

  fileInput.onchange = () => importFiles(fileInput.files);

  // Drag & drop onto the dropzone. dragenter/leave can fire on child
  // elements, so count depth to avoid flicker.
  let dragDepth = 0;
  dropzone.addEventListener("dragenter", (ev) => {
    ev.preventDefault();
    if (dragDepth++ === 0) dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  });
  dropzone.addEventListener("dragleave", (ev) => {
    ev.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropzone.classList.remove("dragover");
    }
  });
  dropzone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove("dragover");
    if (ev.dataTransfer.files.length) importFiles(ev.dataTransfer.files);
  });
}

// --- line picker ---------------------------------------------------------------

const MAP_W = 380;
const MAP_H = 260;

// Fit the pick trace into the map viewport; returns the transform used for
// click mapping.
function mapTransform(trace) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of trace) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const scale = 0.9 * Math.min(MAP_W / Math.max(1, x1 - x0), MAP_H / Math.max(1, y1 - y0));
  const ox = (MAP_W - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = (MAP_H + (y1 - y0) * scale) / 2 + y0 * scale;
  return {
    sx: (p) => ox + p.x * scale,
    sy: (p) => oy - p.y * scale, // north up
    toWorld: (px, py) => ({ x: (px - ox) / scale, y: (oy - py) / scale }),
  };
}

function lineMapHtml(trace, gate) {
  const tr = mapTransform(trace);
  const pts = trace.map((p) => `${tr.sx(p).toFixed(1)},${tr.sy(p).toFixed(1)}`).join(" ");
  const gateLine = gate
    ? `<line x1="${tr.sx({ x: gate.x1 }).toFixed(1)}" y1="${tr.sy({ y: gate.y1 }).toFixed(1)}"
             x2="${tr.sx({ x: gate.x2 }).toFixed(1)}" y2="${tr.sy({ y: gate.y2 }).toFixed(1)}"
             stroke="var(--danger)" stroke-width="3" stroke-linecap="round"/>`
    : "";
  return `<svg id="line-map" viewBox="0 0 ${MAP_W} ${MAP_H}" style="max-width:${MAP_W}px;width:100%;cursor:crosshair;display:block">
    <polyline points="${pts}" fill="none" stroke="var(--chart-line)" stroke-width="2" stroke-linejoin="round" opacity="0.9"/>
    ${gateLine}
  </svg>`;
}

// --- review panel ---------------------------------------------------------------

function traceDistanceTo(trace, gate) {
  let best = Infinity;
  for (const p of trace) {
    const d = (p.x - gate.x) ** 2 + (p.y - gate.y) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function applyGate(state) {
  for (const r of state.results) {
    const p = r.parsed;
    if (!p?.needsLine || !p.gps) continue;
    if (!state.gate) {
      p.laps = [];
      p.bestLapTrace = null;
      p.lapChannels = null;
      continue;
    }
    let trace = projectTrace(p.gps, state.origin);
    let gate = state.gate;
    if (traceDistanceTo(trace, gate) > 1000) {
      // This file's longitude sign convention differs from the displayed
      // trace (Racelogic VBO is west-positive, GPS sources east-positive).
      // Mirror the longitude; handedness flips with it, so drop the gate's
      // direction filter.
      trace = projectTrace(p.gps.map((q) => ({ ...q, lon: -q.lon })), state.origin);
      if (traceDistanceTo(trace, gate) > 1000) {
        p.laps = [];
        p.bestLapTrace = null;
        p.lapChannels = null;
        continue;
      }
      gate = { ...state.gate, hx: null, hy: null };
    }
    p.laps = deriveLaps(trace, gate);
    p.bestLapTrace = p.laps.length ? bestLapTrace(trace, gate) : null;
    attachLapChannels(p);
  }
}

function defaultLabel(r) {
  const p = r.parsed;
  const prefix = KIND_LABELS[p.kind] ?? "Import";
  return `${prefix} ${p.time ?? r.file.replace(SUPPORTED_EXT, "")}`;
}

// "top speed 121 mph · max 6,703 rpm · 1.43 G lateral" from a PDR file's car
// channels; "" when the source has none. Exported for unit tests.
export function metricsSummary(p) {
  const m = p.metrics;
  if (!m) return "";
  const parts = [];
  if (m.topSpeedKph != null) parts.push(`top speed ${Math.round(m.topSpeedKph / 1.609344)} mph`);
  if (m.maxRpm != null) parts.push(`max ${Math.round(m.maxRpm).toLocaleString()} rpm`);
  if (m.maxLatG != null) parts.push(`${m.maxLatG.toFixed(2)} G lateral`);
  return parts.join(" · ");
}

function estimatedNote(p, estCount) {
  if (!estCount) return "";
  if (p.kind === "pdr" && p.lapRecovery) {
    // No beacons in this recording: laps recovered from latitude + odometer.
    return p.lapRecovery.anchored
      ? `laps recovered from latitude + odometer, aligned to the beacon session's start/finish (~±0.2s)`
      : `laps recovered from latitude + odometer (~±0.2s); boundaries are a fixed track point, not the official start/finish`;
  }
  if (p.kind === "pdr" && !p.needsLine) {
    return `${estCount} of ${p.laps.length} laps distance-estimated (~), rest beacon-exact`;
  }
  return `lap times derived from GPS start/finish crossings (~±0.1–0.3s)`;
}

function renderReview(box, event, state, onDone) {
  const { results } = state;

  // Preserve label edits and checkbox choices across re-renders (line picks).
  const prevLabels = new Map();
  const prevChecks = new Map();
  box.querySelectorAll("[data-import-label]").forEach((el) => prevLabels.set(el.dataset.importLabel, el.value));
  // Only remember deliberate checkbox choices — a disabled box (no laps yet)
  // should default to checked once a line pick produces laps for it.
  box.querySelectorAll("[data-import-include]").forEach((el) => {
    if (!el.disabled) prevChecks.set(el.dataset.importInclude, el.checked);
  });

  const needLine = results.filter((r) => r.parsed?.needsLine && r.parsed.gps?.length);

  const blocks = results
    .map((r, i) => {
      if (r.error) {
        return `<div style="margin-bottom:12px"><strong>${esc(r.file)}</strong><div class="error-banner">${esc(r.error)}</div></div>`;
      }
      const p = r.parsed;
      const dateWarn =
        p.date && p.date !== event.start_date &&
        Math.abs(new Date(p.date) - new Date(event.start_date)) > (event.days || 1) * 86400000
          ? `<div class="error-banner">File is dated ${esc(p.date)} but this event is ${esc(event.start_date)}</div>`
          : "";
      const lapChips = p.laps
        .map((l) => `<span class="lap">${l.estimated ? "~" : ""}${fmtMs(l.timeMs)}</span>`)
        .join("");
      const estCount = p.laps.filter((l) => l.estimated).length;
      const noLapsHint = p.needsLine
        ? state.gate
          ? `<span class="hint" style="color:var(--text-muted);font-size:13px">No laps cross the picked line — try clicking a different spot</span>`
          : `<span class="hint" style="color:var(--text-muted);font-size:13px">${p.gps.length} GPS points — set the start/finish line below to time laps</span>`
        : p.kind === "pdr" && !p.beaconCount
          ? `<span class="hint" style="color:var(--text-muted);font-size:13px">No laps found — no beacons, and the telemetry shows no repeating lap pattern (pit/paddock footage?)</span>`
          : `<span class="hint" style="color:var(--text-muted);font-size:13px">No complete laps found (no start/finish crossings in telemetry)</span>`;
      const checked = prevChecks.has(String(i)) ? prevChecks.get(String(i)) : !!p.laps.length;
      const label = prevLabels.get(String(i)) ?? defaultLabel(r);
      const note = estimatedNote(p, estCount);
      const metrics = metricsSummary(p);
      return `<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border-hairline)">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" data-import-include="${i}" ${p.laps.length ? (checked ? "checked" : "") : "disabled"}>
          <strong>${esc(r.file)}</strong>
          <span style="color:var(--text-muted);font-size:13px">${esc(p.date ?? "")} ${esc(p.time ?? "")} · ${(p.durationS / 60).toFixed(0)} min · ${p.laps.length} lap${p.laps.length === 1 ? "" : "s"}</span>
        </label>
        ${dateWarn}
        <div class="laps" style="margin-top:8px">${lapChips || noLapsHint}</div>
        ${metrics ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(metrics)}</div>` : ""}
        ${note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">~ = ${esc(note)}</div>` : ""}
        <div class="field" style="margin:8px 0 0"><input data-import-label="${i}" value="${esc(label)}" placeholder="Session label"></div>
      </div>`;
    })
    .join("");

  let pickerHtml = "";
  if (needLine.length) {
    const pickTrace = projectTrace(
      needLine.reduce((best, r) => (r.parsed.gps.length > best.parsed.gps.length ? r : best), needLine[0]).parsed.gps,
      state.origin
    );
    state.pickTrace = pickTrace;
    pickerHtml = `<div style="margin:4px 0 14px">
      <strong>Start/finish line</strong>
      <div class="hint" style="margin:4px 0 8px">${
        state.gate
          ? "Line set — click the map again to adjust it."
          : `${needLine.length} file${needLine.length === 1 ? " has" : "s have"} GPS data but no lap markers. Click the map where the start/finish line is; laps are timed each pass across it.`
      }</div>
      ${lineMapHtml(pickTrace, state.gate)}
    </div>`;
  }

  box.innerHTML = `<div class="panel">
    <strong>Import preview</strong>
    <div style="margin-top:10px">${pickerHtml}${blocks}</div>
    <div class="btn-row">
      <button class="btn primary" id="import-confirm">Add as sessions</button>
      <button class="btn" id="import-cancel">Cancel</button>
    </div>
  </div>`;

  const map = box.querySelector("#line-map");
  if (map) {
    map.addEventListener("click", (ev) => {
      const rect = map.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * MAP_W;
      const py = ((ev.clientY - rect.top) / rect.height) * MAP_H;
      const w = mapTransform(state.pickTrace).toWorld(px, py);
      let best = 0;
      let bestD = Infinity;
      state.pickTrace.forEach((p, i) => {
        const d = (p.x - w.x) ** 2 + (p.y - w.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const gate = buildGate(state.pickTrace, best);
      if (!gate) return;
      state.gate = gate;
      applyGate(state);
      renderReview(box, event, state, onDone);
    });
  }

  box.querySelector("#import-cancel").onclick = () => (box.innerHTML = "");
  box.querySelector("#import-confirm").onclick = async () => {
    let added = 0;
    for (let i = 0; i < results.length; i++) {
      const inc = box.querySelector(`[data-import-include="${i}"]`);
      if (!inc || !inc.checked) continue;
      const r = results[i];
      const estCount = r.parsed.laps.filter((l) => l.estimated).length;
      const note = estimatedNote(r.parsed, estCount);
      const metrics = metricsSummary(r.parsed);
      await api(`/events/${event.id}/sessions`, {
        method: "POST",
        body: {
          label: box.querySelector(`[data-import-label="${i}"]`).value.trim() || r.file,
          notes: `Imported from ${r.file}` + (metrics ? ` — ${metrics}` : "") + (note ? ` — ${note}` : ""),
          laps: r.parsed.laps.map((l) => l.timeMs),
          trace: r.parsed.bestLapTrace ?? null,
          channels: r.parsed.lapChannels ?? null,
        },
      });
      added++;
    }
    if (added) onDone();
    else box.innerHTML = "";
  };
}
