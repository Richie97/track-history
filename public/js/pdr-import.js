// PDR video import UI: file picker + drag & drop -> parse telemetry in the
// browser -> review panel -> POST the accepted files as sessions.
// Expects the event-detail markup: #pdr-files, #pdr-dropzone, #pdr-import, #pdr-review.

import { api } from "./api.js";
import { esc, fmtMs } from "./format.js";
import { parsePdrFile } from "../pdr.js";

export function bindPdrImport(view, event, onDone) {
  const fileInput = view.querySelector("#pdr-files");
  const dropzone = view.querySelector("#pdr-dropzone");
  view.querySelector("#pdr-import").onclick = () => fileInput.click();

  async function importPdrFiles(fileList) {
    const files = [...fileList].filter((f) => /\.mp4$/i.test(f.name) || f.type === "video/mp4");
    if (!files.length) return;
    const box = view.querySelector("#pdr-review");
    box.innerHTML = `<div class="panel">Reading telemetry from ${files.length} file${files.length === 1 ? "" : "s"}…</div>`;
    const results = [];
    for (const f of files) {
      try {
        results.push({ file: f.name, parsed: await parsePdrFile(f) });
      } catch (err) {
        results.push({ file: f.name, error: err.message });
      }
    }
    results.sort((a, b) => ((a.parsed?.time ?? "") < (b.parsed?.time ?? "") ? -1 : 1));
    renderPdrReview(box, event, results, onDone);
  }

  fileInput.onchange = () => importPdrFiles(fileInput.files);

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
    if (ev.dataTransfer.files.length) importPdrFiles(ev.dataTransfer.files);
  });
}

function renderPdrReview(box, event, results, onDone) {
  const blocks = results
    .map((r, i) => {
      if (r.error) {
        return `<div style="margin-bottom:12px"><strong>${esc(r.file)}</strong><div class="error-banner">${esc(r.error)}</div></div>`;
      }
      const p = r.parsed;
      const dateWarn =
        p.date && p.date !== event.start_date &&
        Math.abs(new Date(p.date) - new Date(event.start_date)) > (event.days || 1) * 86400000
          ? `<div class="error-banner">Video is dated ${esc(p.date)} but this event is ${esc(event.start_date)}</div>`
          : "";
      const lapChips = p.laps
        .map((l) => `<span class="lap">${l.estimated ? "~" : ""}${fmtMs(l.timeMs)}</span>`)
        .join("");
      const estCount = p.laps.filter((l) => l.estimated).length;
      return `<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border-hairline)">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" data-pdr-include="${i}" ${p.laps.length ? "checked" : "disabled"}>
          <strong>${esc(r.file)}</strong>
          <span style="color:var(--text-muted);font-size:13px">${esc(p.date ?? "")} ${esc(p.time ?? "")} · ${(p.durationS / 60).toFixed(0)} min · ${p.laps.length} lap${p.laps.length === 1 ? "" : "s"}</span>
        </label>
        ${dateWarn}
        <div class="laps" style="margin-top:8px">${lapChips || `<span class="hint" style="color:var(--text-muted);font-size:13px">No complete laps found (no start/finish crossings in telemetry)</span>`}</div>
        ${estCount ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">~ = recovered from distance telemetry (±0.1–0.3s); unmarked laps are beacon-exact</div>` : ""}
        <div class="field" style="margin:8px 0 0"><input data-pdr-label="${i}" value="${esc(`PDR ${p.time ?? r.file.replace(/\.mp4$/i, "")}`)}" placeholder="Session label"></div>
      </div>`;
    })
    .join("");
  box.innerHTML = `<div class="panel">
    <strong>PDR import preview</strong>
    <div style="margin-top:10px">${blocks}</div>
    <div class="btn-row">
      <button class="btn primary" id="pdr-confirm">Add as sessions</button>
      <button class="btn" id="pdr-cancel">Cancel</button>
    </div>
  </div>`;
  box.querySelector("#pdr-cancel").onclick = () => (box.innerHTML = "");
  box.querySelector("#pdr-confirm").onclick = async () => {
    let added = 0;
    for (let i = 0; i < results.length; i++) {
      const inc = box.querySelector(`[data-pdr-include="${i}"]`);
      if (!inc || !inc.checked) continue;
      const r = results[i];
      const estCount = r.parsed.laps.filter((l) => l.estimated).length;
      const notes =
        `Imported from ${r.file}` +
        (estCount ? ` — ${estCount} of ${r.parsed.laps.length} laps distance-estimated (~), rest beacon-exact` : "");
      await api(`/events/${event.id}/sessions`, {
        method: "POST",
        body: {
          label: box.querySelector(`[data-pdr-label="${i}"]`).value.trim() || r.file,
          notes,
          laps: r.parsed.laps.map((l) => l.timeMs),
        },
      });
      added++;
    }
    if (added) onDone();
    else box.innerHTML = "";
  };
}
