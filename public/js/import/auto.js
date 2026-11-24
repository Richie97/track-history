// The event-less import review (NS-57): files dropped with no event picked are
// located (locate.js), grouped into events by track and date, and shown as one
// card per event to confirm. Nothing is saved before that — a confident match
// is pre-filled, never pre-saved.
//
// It is the New Event form's flow with the track and dates filled in by the
// match: each new group posts `POST /events` (which find-or-creates the track
// by name) and then its sessions, through `api()`, so the offline queue and
// temp ids apply as they do there. Web-only DOM; the rules are locate.js's.

import { api } from "../api.js";
import { esc, fmtMs } from "../format.js";
import { projectTrace, buildGate } from "./geo.js";
import {
  MAP_H,
  MAP_W,
  applyGate,
  clipHandles,
  clipRowHtml,
  defaultLabel,
  estimatedNote,
  importSessionBody,
  lineMapHtml,
  mapTransform,
  metricsSummary,
} from "./ui.js";
import { clipOffer, offersEveryLap } from "./clip.js";
import { VENUE_RADIUS_M, distanceM, eventBodyFor, groupDatesText, groupImports, locateTrack, recordingPlace } from "./locate.js";

const OTHER = "__other__";

// ctx: { tracks, catalog, events, defaultCar, today, fmtDate, onDone(eventIds) }.
// options.clips is bindTelemetryImport's.
export function reviewAuto(box, results, ctx, options = {}) {
  // Sources waiting for a start/finish line are picked per venue: one line
  // applies to every such file at the same place, as on the event page.
  const pickers = [];
  results.forEach((r) => {
    if (!r.parsed?.needsLine || !r.parsed.gps?.length) return;
    const place = recordingPlace({ gps: r.parsed.gps });
    let p = place ? pickers.find((q) => q.place && distanceM(q.place, place) <= VENUE_RADIUS_M) : null;
    if (!p) pickers.push((p = { place, results: [], origin: r.parsed.gps[0], gate: null }));
    p.results.push(r);
  });
  const state = { results, pickers, choices: {}, editing: new Set(), errors: {}, saved: [], busy: false };
  render(box, state, ctx, options);
}

function located(r, ctx) {
  const place = recordingPlace(r.parsed);
  return { place, located: locateTrack(place, ctx.tracks, ctx.catalog) };
}

function buildGroups(state, ctx) {
  const items = [];
  state.results.forEach((r, i) => {
    if (r.error || r.savedTo != null || !r.parsed.laps.length) return;
    items.push({ id: i, date: r.parsed.date, time: r.parsed.time, ...located(r, ctx) });
  });
  return groupImports(items, ctx.events, { choices: state.choices, ownTracks: ctx.tracks, today: ctx.today });
}

function trackPickerHtml(group, ctx) {
  const seen = new Set();
  const opts = [];
  for (const c of group.candidates) {
    seen.add(c.name.toLowerCase());
    opts.push(`<option value="${esc(c.name)}">${esc(c.name)}</option>`);
  }
  const mine = ctx.tracks.filter((t) => !seen.has(t.name.toLowerCase()));
  const names = [...ctx.tracks.map((t) => t.name), ...ctx.catalog.map((c) => c.name)];
  const typing = !group.candidates.length;
  return `<div class="field" style="margin:8px 0 0">
    ${
      typing
        ? ""
        : `<select data-group-track="${esc(group.key)}" aria-label="Track">
        <option value="">Pick the track…</option>
        ${opts.join("")}
        ${mine.length ? `<optgroup label="Your tracks">${mine.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("")}</optgroup>` : ""}
        <option value="${OTHER}">Another track…</option>
      </select>`
    }
    <div data-group-typing="${esc(group.key)}" ${typing ? "" : "hidden"} style="display:flex;gap:8px;margin-top:${typing ? 0 : 8}px">
      <input data-group-name="${esc(group.key)}" list="auto-track-names" placeholder="Name this track" aria-label="Track name" style="flex:1">
      <button class="btn small" type="button" data-group-name-ok="${esc(group.key)}">Use</button>
    </div>
    <datalist id="auto-track-names">${[...new Set(names)].map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
  </div>`;
}

function fileBlockHtml(r, i, prev) {
  const p = r.parsed;
  const estCount = p.laps.filter((l) => l.estimated).length;
  const note = estimatedNote(p, estCount);
  const metrics = metricsSummary(p);
  const checked = prev.checks.has(String(i)) ? prev.checks.get(String(i)) : true;
  const label = prev.labels.get(String(i)) ?? defaultLabel(r);
  const chips = p.laps.map((l) => `<span class="lap">${l.estimated ? "~" : ""}${fmtMs(l.timeMs)}</span>`).join("");
  return `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-hairline)">
    <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
      <input type="checkbox" data-import-include="${i}" ${checked ? "checked" : ""}>
      <strong>${esc(r.file)}</strong>
      <span style="color:var(--text-muted);font-size:13px">${esc(p.date ?? "")} ${esc(p.time ?? "")} · ${p.laps.length} lap${p.laps.length === 1 ? "" : "s"}</span>
    </label>
    <div class="laps" style="margin-top:8px">${chips}</div>
    ${metrics ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(metrics)}</div>` : ""}
    ${note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">~ = ${esc(note)}</div>` : ""}
    <div class="field" style="margin:8px 0 0"><input data-import-label="${i}" value="${esc(label)}" placeholder="Session label" aria-label="Session label"></div>
  </div>`;
}

function groupHtml(group, state, ctx, prev) {
  const results = state.results;
  const laps = group.itemIds.reduce((n, i) => n + results[i].parsed.laps.length, 0);
  const best = Math.min(...group.itemIds.flatMap((i) => results[i].parsed.laps.map((l) => l.timeMs)));
  const dates = groupDatesText(group, ctx.fmtDate);
  const known = group.track != null;
  const editing = !known || state.editing.has(group.key);
  const heading = known
    ? `<strong>${esc(group.track.name)}</strong> · ${esc(dates)}`
    : `<strong>Which track is this?</strong> · ${esc(dates)}`;
  const where = group.eventId != null
    ? `Adds to your event on ${esc(ctx.fmtDate(group.start))}`
    : known
      ? `New event${group.track.source === "new" || group.track.source === "catalog" ? " at a new track" : ""}`
      : group.candidates.length
        ? "More than one track could be here — pick the one you drove."
        : "No track we know is here. Name it once and it is recognised next time.";
  const err = state.errors[group.key];
  return `<div class="panel" style="margin-top:12px" data-group="${esc(group.key)}">
    <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
      <span style="flex:1">${heading}</span>
      ${known && !editing ? `<button class="btn small" type="button" data-group-change="${esc(group.key)}">Change</button>` : ""}
    </div>
    <div class="hint" style="margin-top:4px">${where} · ${group.itemIds.length} session${group.itemIds.length === 1 ? "" : "s"} · ${laps} lap${laps === 1 ? "" : "s"} · best ${fmtMs(best)}</div>
    ${editing ? trackPickerHtml(group, ctx) : ""}
    ${err ? `<div class="error-banner" style="margin-top:8px">${esc(err)}</div>` : ""}
    ${group.itemIds.map((i) => fileBlockHtml(results[i], i, prev)).join("")}
  </div>`;
}

function pickerHtml(picker, n) {
  const pending = picker.results.filter((r) => !r.parsed.laps.length && r.savedTo == null);
  if (!pending.length && picker.gate) {
    // Every file here has laps; keep the map so the line can still be moved.
  }
  const longest = picker.results.reduce((b, r) => (r.parsed.gps.length > b.parsed.gps.length ? r : b), picker.results[0]);
  picker.pickTrace = projectTrace(longest.parsed.gps, picker.origin);
  return `<div class="panel" style="margin-top:12px">
    <strong>Start/finish line</strong>
    <div class="hint" style="margin:4px 0 8px">${
      picker.gate
        ? pending.length
          ? "No laps cross the picked line in every file — click a different spot to adjust it."
          : "Line set — click the map again to adjust it."
        : `${picker.results.length} file${picker.results.length === 1 ? " has" : "s have"} GPS data but no lap markers. Click the map where the start/finish line is; laps are timed each pass across it.`
    }</div>
    ${lineMapHtml(picker.pickTrace, picker.gate, `line-map-${n}`)}
    ${pending.map((r) => `<div class="hint" style="margin-top:6px">${esc(r.file)} · ${r.parsed.gps.length} GPS points, no laps yet</div>`).join("")}
  </div>`;
}

function render(box, state, ctx, options) {
  const prev = { labels: new Map(), checks: new Map() };
  box.querySelectorAll("[data-import-label]").forEach((el) => prev.labels.set(el.dataset.importLabel, el.value));
  box.querySelectorAll("[data-import-include]").forEach((el) => prev.checks.set(el.dataset.importInclude, el.checked));
  const clipBox = box.querySelector("#import-clip");
  const prevClip = clipBox && !clipBox.disabled ? clipBox.checked : undefined;
  const prevScope = box.querySelector('input[name="import-clip-scope"]:checked')?.value ?? "best";

  const groups = buildGroups(state, ctx);
  const included = (i) => (prev.checks.has(String(i)) ? prev.checks.get(String(i)) : true);
  const saveable = groups.filter((g) => g.track && g.itemIds.some(included));
  const failed = state.results.filter((r) => r.error);
  const empty = state.results.filter((r) => !r.error && !r.parsed.laps.length && !(r.parsed.needsLine && r.parsed.gps?.length));

  const grouped = new Set(groups.flatMap((g) => g.itemIds));
  const clipItems = state.results.map((r, i) => ({ parsed: r.parsed, include: grouped.has(i) && included(i), fileBytes: r.source?.size }));
  const offer = options.clips ? clipOffer(clipItems, options.clips.entitlement, options.clips.storage) : "none";
  const everyOffer =
    options.clips && offer === "on" && offersEveryLap(clipItems)
      ? clipOffer(clipItems, options.clips.entitlement, options.clips.storage, "every")
      : null;
  const scope = everyOffer === "on" && prevScope === "every" ? "every" : "best";

  const files = state.results.length;
  box.innerHTML = `<div>
    <div class="panel">
      <strong>${files} file${files === 1 ? "" : "s"} · ${groups.length} event${groups.length === 1 ? "" : "s"} found</strong>
      <div class="hint" style="margin-top:4px">Each file is placed by where it was driven. Check the track and the dates, then save.</div>
      ${state.saved.map((s) => `<div style="margin-top:8px">Saved: <a href="#/event/${esc(String(s.eventId))}">${esc(s.name)} · ${esc(s.dates)}</a></div>`).join("")}
      ${failed.map((r) => `<div style="margin-top:10px"><strong>${esc(r.file)}</strong><div class="error-banner">${esc(r.error)}</div></div>`).join("")}
      ${empty.map((r) => `<div class="hint" style="margin-top:10px"><strong>${esc(r.file)}</strong> · no complete laps found</div>`).join("")}
    </div>
    ${state.pickers.map((p, n) => pickerHtml(p, n)).join("")}
    ${groups.map((g) => groupHtml(g, state, ctx, prev)).join("")}
    ${options.clips ? clipRowHtml(offer, everyOffer, scope, clipItems, options.clips, prevClip) : ""}
    <div class="btn-row">
      <button class="btn primary" id="import-confirm" type="button" ${saveable.length && !state.busy ? "" : "disabled"}>Save ${saveable.length} event${saveable.length === 1 ? "" : "s"}</button>
      <button class="btn" id="import-cancel" type="button">Cancel</button>
    </div>
  </div>`;

  const again = () => render(box, state, ctx, options);

  state.pickers.forEach((picker, n) => {
    const map = box.querySelector(`#line-map-${n}`);
    if (!map) return;
    map.addEventListener("click", (ev) => {
      const rect = map.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * MAP_W;
      const py = ((ev.clientY - rect.top) / rect.height) * MAP_H;
      const w = mapTransform(picker.pickTrace).toWorld(px, py);
      let best = 0;
      let bestD = Infinity;
      picker.pickTrace.forEach((p, i) => {
        const d = (p.x - w.x) ** 2 + (p.y - w.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const gate = buildGate(picker.pickTrace, best);
      if (!gate) return;
      picker.gate = gate;
      applyGate(picker);
      again();
    });
  });

  const byKey = new Map(groups.map((g) => [g.key, g]));
  const choose = (key, name) => {
    const g = byKey.get(key);
    if (!g || !name.trim()) return;
    // An unanswered place is answered once: every other date at the same
    // place takes the name too (a group's key is "<track or place>@<date>").
    const place = key.slice(0, key.lastIndexOf("@"));
    const same = g.track ? [g] : groups.filter((o) => !o.track && o.key.slice(0, o.key.lastIndexOf("@")) === place);
    for (const o of same) for (const i of o.itemIds) state.choices[i] = { name: name.trim() };
    state.editing.delete(key);
    delete state.errors[key];
    again();
  };
  box.querySelectorAll("[data-group-change]").forEach((el) => {
    el.onclick = () => {
      state.editing.add(el.dataset.groupChange);
      again();
    };
  });
  box.querySelectorAll("[data-group-track]").forEach((el) => {
    el.onchange = () => {
      const key = el.dataset.groupTrack;
      if (el.value === OTHER) {
        const typing = [...box.querySelectorAll("[data-group-typing]")].find((t) => t.dataset.groupTyping === key);
        typing.hidden = false;
        typing.querySelector("input").focus();
      } else if (el.value) choose(key, el.value);
    };
  });
  box.querySelectorAll("[data-group-name-ok]").forEach((el) => {
    const key = el.dataset.groupNameOk;
    const input = [...box.querySelectorAll("[data-group-name]")].find((t) => t.dataset.groupName === key);
    el.onclick = () => choose(key, input.value);
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        choose(key, input.value);
      }
    };
  });
  box.querySelectorAll("[data-import-include], input[name='import-clip-scope']").forEach((el) => {
    el.onchange = again;
  });

  box.querySelector("#import-cancel").onclick = () => {
    box.innerHTML = "";
    if (state.saved.length) ctx.onDone(state.saved.map((s) => s.eventId));
  };
  box.querySelector("#import-confirm").onclick = async () => {
    const saveClips = offer === "on" && !!box.querySelector("#import-clip")?.checked;
    const labels = new Map();
    box.querySelectorAll("[data-import-label]").forEach((el) => labels.set(Number(el.dataset.importLabel), el.value));
    const checks = new Set();
    box.querySelectorAll("[data-import-include]").forEach((el) => el.checked && checks.add(Number(el.dataset.importInclude)));
    state.busy = true;
    box.querySelector("#import-confirm").disabled = true;
    for (const g of saveable) {
      const idxs = g.itemIds.filter((i) => checks.has(i));
      if (!idxs.length) continue;
      try {
        // A group whose event was created on an earlier, failed attempt posts
        // its remaining sessions onto that event rather than a second one.
        let eventId = g.eventId ?? idxs.map((i) => state.results[i].eventId).find((id) => id != null);
        if (eventId == null) {
          eventId = (await api("/events", { method: "POST", body: eventBodyFor(g, ctx.defaultCar) })).id;
          for (const i of g.itemIds) state.results[i].eventId = eventId;
        }
        for (const i of idxs) {
          const r = state.results[i];
          const body = importSessionBody(r, labels.get(i));
          const saved = await api(`/events/${eventId}/sessions`, { method: "POST", body });
          r.savedTo = eventId;
          if (saveClips && saved?.id != null) {
            for (const clip of clipHandles(r, scope)) options.clips.enqueue({ sessionId: saved.id, ...clip });
          }
        }
        delete state.errors[g.key];
        state.saved.push({ eventId, name: g.track.name, dates: groupDatesText(g, ctx.fmtDate) });
      } catch (err) {
        state.errors[g.key] = err.message;
      }
    }
    state.busy = false;
    // Done when nothing with laps is left unsaved; otherwise the cards that
    // failed or still need a track stay, with what was saved listed above.
    const left = state.results.some((r, i) => !r.error && r.savedTo == null && r.parsed.laps.length && checks.has(i));
    const unanswered = buildGroups(state, ctx).length;
    if (!left && !unanswered) ctx.onDone(state.saved.map((s) => s.eventId));
    else again();
  };
}
