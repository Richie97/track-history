// SPA entry: shell, hash router and views. Pure helpers live in js/*.js so
// they can be unit-tested; this module owns the DOM and app state.

import { esc, fmtMs, parseTime, parseLapList, fmtDate, fmtConsistency, fmtDelta } from "./js/format.js";
import { lineChart, multiLineChart } from "./js/chart.js";
import { bindChannelGraphs, channelDefs, deltaChartSvg, deltaSeries, channelChartSvg, matchLapsToChannels, showDistanceMark } from "./js/channel-graphs.js";
import {
  LENGTH_MISMATCH_WARN, alignLapPair, comparableLaps, defaultComparePicks, lapMetrics,
  lengthMismatchRatio,
} from "./js/compare-laps.js";
import { bestNAvg, paceSlope, warmupLapCount } from "./js/lap-stats.js";
import { sectorTableHtml, sessionSectors } from "./js/sectors.js";
import { fmtRpm, gearRibbonSvg, ordinal, shiftPoints, shiftTableHtml } from "./js/gears.js";
import { LIMIT_KINDS, activeLimitLabels, kindDef, limitGlyphSvg, limitMarkers, limitSummary } from "./js/limits.js";
import { bindGripCircle, gripCircleHtml } from "./js/grip.js";
import {
  balanceHtml, balanceSummary, bindBalance, estimateSteeringRatio, measuredRatioLine, measuredRatioValue, ratioAgrees,
} from "./js/balance.js";
import { healthHtml, healthSummary, nextTimeNote, pressureLoop, pressureLoopHtml } from "./js/health.js";
import {
  ambientText, bandLabel, conditionsBand, conditionsChipHtml, conditionsLegendHtml,
  elevationText, eventAmbient, tempText, trackElevationM,
} from "./js/conditions.js";
import { yearsAvailable, yearReview } from "./js/year-review.js";
import { posterLines, wrappedSeason } from "./js/wrapped.js";
import { bindWrappedStory, wrappedStoryHtml } from "./js/wrapped-story.js";
import { downloadBlob, posterBlob, posterFileName, sharePosterBlob } from "./js/wrapped-image.js";
import { COST_FIELDS, centsToDollars, dollarsToCents, fmtPerSecond, fmtSpend, spendSummary } from "./js/costs.js";
import { api as apiFetch, ApiError } from "./js/api.js";
import { clearFailed, clearOffline, onSyncChange, pendingCount, resolveId, syncStatus } from "./js/offline.js";
import { scheduleWarm } from "./js/prefetch.js";
import { confettiBurst, detectPB } from "./js/celebrate.js";
import { DEFAULT_CHECKLIST } from "./js/checklist.js";
import { renderTrackMap, traceIndexAtFraction } from "./js/trackmap.js";
import { themeToggleHtml, wireThemeToggle } from "./js/theme.js";
import { bindTelemetryImport } from "./js/import/ui.js";
import { sessionsToCreate, stagedSummary } from "./js/event-form.js";
import {
  AXLE_KEYS, CORNER_KEYS, PART_KINDS, PART_REFS, SETUP_FIELDS,
  catalogCarLabel, catalogCarName, catalogPrefill,
  defaultMeasurementUnit, diffSetups, flatLabel, fmtCost, fmtHours, fmtRemaining, fmtSetupValue,
  matchCatalogCars, partOdometerLine, vehicleOdometerLine,
  partKindLabel, partStatus, setupFieldFor, setupStep, setupToDisplay, setupToStored, setupUnit,
  vehicleLogbook, vehicleTileLine, wearLimitHint,
} from "./js/garage.js";
import { UNIT_SYSTEMS, cacheUnits, clearUnitsCache, currentUnits, fmtDist, fmtSpeedKph, speedUnit, tempInputSpec, tempToDisplay, tempToStored, tempUnit, usUnits } from "./js/units.js";
import { initPullRefresh } from "./js/pull-refresh.js";
import {
  canCompareEvents, canUseGarage, canUseSetups, canViewChannels, canViewSpend,
  canViewYearInReview, entitlementSummary, isPro, manageUrl,
} from "./js/entitlement.js";

const $app = document.getElementById("app");

// Host shown in share URLs.
const serverHost = () => location.host;

// API wrapper: a 401 anywhere means the session is gone — show the login view.
async function api(path, opts) {
  try {
    return await apiFetch(path, opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderLogin();
      throw new Error("unauthorized");
    }
    throw err;
  }
}

// ---------- shared helpers ---------------------------------------------------

const CONDITIONS = [
  ["dry", "☀️ Dry"],
  ["damp", "🌦️ Damp"],
  ["wet", "🌧️ Wet"],
  ["mixed", "⛅ Mixed"],
];
const condLabel = (c) => (CONDITIONS.find(([v]) => v === c) || [])[1] ?? "";
// Sky plus air temperature. The temperature reconciles the two sources rather
// than showing both (#191): what the sessions' telemetry recorded if any did —
// a range when the day warmed up — else the number the driver typed. Neither
// is ever written from the other; they only meet here.
const fmtConditions = (e) =>
  [condLabel(e.conditions), ambientText(eventAmbient(e), usUnits())].filter(Boolean).join(" · ");

// ---------- tier / paywall ---------------------------------------------------

// Everything the client decides about tier goes through js/entitlement.js
// (ported under the same names to both apps). `state.entitlement` is whatever
// GET /api/me last said — read, never recomputed from the clock, so the cached
// answer stands offline: a driver who was Pro at the last sync keeps their
// analysis in a paddock with no signal.
const pro = () => isPro(state.entitlement);

const PRO_PRICE = "$1.99/month or $19.99/year";

// The web app has no purchase surface on purpose (NS-32 fixed decisions): it
// is the one client with no store behind it, so every paywall here points at
// the phone apps rather than offering a button that cannot charge anyone.
// `underHeading` is for the whole-page gates, where the route's own <h1>
// already names the feature and a second heading just says it twice.
function proPanelHtml(heading, what, { underHeading = false } = {}) {
  return `<div class="panel pro-panel">
    <div class="pro-badge">Pro</div>
    ${underHeading ? "" : `<h3>${esc(heading)}</h3>`}
    <p>${what}</p>
    <p class="hint">Track Evolution Pro is ${PRO_PRICE}, and it covers all three apps and this
      site — your logbook, sharing, lap times and telemetry import stay free forever.</p>
    <div class="btn-row">
      <a class="btn small primary" href="${APP_STORE_URL}" target="_blank" rel="noopener">Subscribe on iPhone ↗</a>
      <a class="btn small primary" href="${PLAY_STORE_URL}" target="_blank" rel="noopener">Subscribe on Android ↗</a>
    </div>
    <p class="hint" style="margin-top:8px">Already subscribed? Sign in to the app with this
      account — the subscription follows the account, not the device.</p>
  </div>`;
}

// A one-line Pro note, for places where the full panel would be too loud —
// import is free, so the dropzone is not a paywall, but a free account should
// learn *before* importing that the channel graphs inside the file are the Pro
// half. The client can't tell a session that never had channels from one whose
// channels were stripped, so the honest place to say it is next to the import.
function proNoteHtml(text) {
  return `<div class="pro-note"><span class="pro-badge">Pro</span> ${text}</div>`;
}

// What the Pro half of a channel blob is (#264): a free account keeps the
// speed, throttle and brake traces and the server strips the rest, so this is
// the one sentence every free channel panel ends on. "Where the recording
// carries them" because a GoPro clip has none of these for anyone.
const PRO_CHANNELS_NOTE =
  "Pro unlocks the rest of the recording where it carries them: steering, RPM, lateral G and yaw traces, " +
  "the gear ribbon and shift points, ABS and wheelspin marks on the map, sector splits with a theoretical best, " +
  "the car-health strip, and lap-vs-lap delta charts.";

// ---------- garage & setup-sheet renderers -----------------------------------

// Every part in the garage payload, across vehicles — resolves the part ids
// a setup sheet references into names.
const garagePartsById = (garage) =>
  new Map((garage ?? []).flatMap((v) => v.parts.map((p) => [p.id, p])));

const wearBarHtml = (wear) => {
  if (!wear || wear.pct_used == null) return "";
  const pct = Math.round(Math.min(1, wear.pct_used) * 100);
  return `<div class="wear-bar ${partStatus(wear) ?? "ok"}" role="img" aria-label="${pct}% used">
    <span style="width:${Math.max(2, pct)}%"></span></div>`;
};

// One-line wear story for a part: accrued usage, remaining life, and how much
// to trust the projection.
function wearStatusHtml(p) {
  const w = p.wear;
  const bits = [`<span class="t">${fmtHours(w.hours)}</span> on part`];
  if (p.kind === "tires") bits.push(`${w.cycles} heat cycle${w.cycles === 1 ? "" : "s"}`);
  else if (w.events) bits.push(`${w.events} event${w.events === 1 ? "" : "s"}`);
  const remaining = fmtRemaining(w);
  if (remaining) {
    const cls = { due: "unmet", low: "unmet", ok: "met" }[partStatus(w)] ?? "";
    bits.push(`<span class="goal-status ${cls}">${remaining}</span>`);
    bits.push(
      w.source === "measured"
        ? `measured ${Math.round(w.wear_per_hour * 100) / 100} ${esc(w.unit ?? "")}/h`
        : `vs. ${fmtHours(w.expected_hours)} expected`
    );
  } else if (!p.retired_on) {
    bits.push(`<span class="hint-inline">no life estimate — set expected hours or log two measurements</span>`);
  }
  return bits.join(" · ");
}

// The maintenance items worth shouting about: active parts at or near the
// end of their life, worst first.
const garageAlerts = (garage) =>
  (garage ?? [])
    .flatMap((v) =>
      v.parts
        .filter((p) => !p.retired_on)
        .map((p) => ({ vehicle: v, part: p, status: partStatus(p.wear) }))
        .filter((a) => a.status === "due" || a.status === "low")
    )
    .sort((a, b) => (a.status === "due" ? 0 : 1) - (b.status === "due" ? 0 : 1));

// The garage page and a car's page both lead with it — maintenance is the
// point of both views, so the chips show outright.
const alertStripHtml = (garage) => {
  const alerts = garageAlerts(garage);
  if (!alerts.length) return "";
  const chips = `<div class="ga-chips">${alerts
    .map(
      (a) => `<a class="ga-chip ${a.status}" href="#/vehicle/${a.vehicle.id}">
        ${esc(partKindLabel(a.part.kind))} — ${
          a.status === "due" ? "replace now" : fmtRemaining(a.part.wear)
        }<span class="ga-veh">${esc(a.vehicle.name)}</span></a>`
    )
    .join("")}</div>`;
  return `<div class="panel garage-alerts">
    <span class="ga-icon" aria-hidden="true">🔧</span>
    <div class="ga-body"><strong>Maintenance due</strong>${chips}</div>
  </div>`;
};

// Compact spec-sheet rendering of a setup: one box per field group, values
// that differ from `prev` highlighted. prev=null renders without highlights.
function setupSheetHtml(sheet, prev, partsById) {
  const units = currentUnits();
  const changed = new Set(diffSetups(prev, sheet).map((d) => d.key));
  // Values are stored in psi/gal and shown in the user's system; the diff
  // (and the "changed" highlight) runs on stored values, so it is unaffected.
  const sv = (f, key, value) =>
    `<span class="sv${changed.has(key) && prev ? " changed" : ""}">${esc(String(setupToDisplay(f, value, units)))}</span>`;
  const labelHtml = (f) => {
    const unit = setupUnit(f, units);
    return `${f.label}${unit ? ` <em>${unit}</em>` : ""}`;
  };
  const boxes = [];
  for (const f of SETUP_FIELDS) {
    if (f.shape === "number") {
      if (sheet[f.key] == null) continue;
      boxes.push(
        `<div class="setup-box"><span class="sb-label">${labelHtml(f)}</span>
         <span class="sb-vals">${sv(f, f.key, sheet[f.key])}</span></div>`
      );
      continue;
    }
    const group = sheet[f.key];
    if (!group) continue;
    const keys = f.shape === "corners" ? CORNER_KEYS : AXLE_KEYS;
    const vals = keys
      .filter(([k]) => group[k] != null)
      .map(([k, lbl]) => `<span class="sv-wrap" title="${f.label} ${lbl}">${sv(f, `${f.key}.${k}`, group[k])}</span>`);
    if (!vals.length) continue;
    boxes.push(
      `<div class="setup-box"><span class="sb-label">${labelHtml(f)}</span>
       <span class="sb-vals">${vals.join('<span class="sep">/</span>')}</span></div>`
    );
  }
  for (const [key, label] of PART_REFS) {
    if (sheet[key] == null) continue;
    const p = partsById?.get(sheet[key]);
    boxes.push(
      `<div class="setup-box"><span class="sb-label">${label}</span>
       <span class="sb-vals">${sv(key, p ? p.name : `#${sheet[key]}`)}</span></div>`
    );
  }
  return `${boxes.length ? `<div class="setup-grid">${boxes.join("")}</div>` : ""}
    ${sheet.notes ? `<div class="notes-block">${esc(sheet.notes)}</div>` : ""}`;
}

// The editable form for one day's sheet. Inputs are named sf:<flat-key> and
// read back by readSetupForm; blank inputs mean "not recorded".
function setupFormHtml(day, sheet, partOptions, existing) {
  const units = currentUnits();
  // Pre-filled values are converted into the user's system here and back to
  // the stored one by readSetupForm — the form never holds a stored value.
  const val = (f, sub) => {
    const v = sub ? sheet?.[f.key]?.[sub] : sheet?.[f.key];
    return setupToDisplay(f, v, units) ?? "";
  };
  const label = (f) => {
    const unit = setupUnit(f, units);
    return `${f.label}${unit ? ` (${unit})` : ""}`;
  };
  const fields = SETUP_FIELDS.map((f) => {
    if (f.shape === "number")
      return `<div class="field"><label>${label(f)}</label>
        <input name="sf:${f.key}" type="number" step="${setupStep(f, units)}" inputmode="decimal" value="${val(f)}"></div>`;
    const keys = f.shape === "corners" ? CORNER_KEYS : AXLE_KEYS;
    return `<div class="field"><label>${label(f)}</label>
      <div class="setup-inputs ${f.shape}">${keys
        .map(
          ([k, lbl]) =>
            `<input name="sf:${f.key}.${k}" type="number" step="${setupStep(f, units)}" inputmode="decimal"
               placeholder="${lbl}" aria-label="${f.label} ${lbl}" value="${val(f, k)}">`
        )
        .join("")}</div></div>`;
  }).join("");
  const refs = PART_REFS.map(([key, label, kind]) => {
    const opts = partOptions.filter((p) => p.kind === kind);
    if (!opts.length) return "";
    return `<div class="field"><label>${label}</label>
      <select name="sf:${key}"><option value="">—</option>${opts
        .map(
          (p) => `<option value="${p.id}"${sheet?.[key] === p.id ? " selected" : ""}>${esc(p.name)}${
            p.retired_on ? " (retired)" : ""
          }</option>`
        )
        .join("")}</select></div>`;
  }).join("");
  return `<form class="panel setup-form" data-setup-form="${day}">
    <div class="form-grid setup-form-grid">${fields}${refs}</div>
    <div class="field"><label>Setup notes</label>
      <textarea name="sf:notes" placeholder="What changed and why — pushing in T5, went two clicks stiffer front…">${esc(sheet?.notes ?? "")}</textarea></div>
    <div class="btn-row">
      <button class="btn small primary">Save day ${day} setup</button>
      <button class="btn small" type="button" data-setup-cancel="${day}">Cancel</button>
      ${existing ? `<button class="btn small danger" type="button" data-setup-del="${day}">Delete</button>` : ""}
      <span class="goal-msg" data-setup-msg="${day}"></span>
    </div>
  </form>`;
}

function readSetupForm(form) {
  const units = currentUnits();
  const out = {};
  for (const el of form.elements) {
    if (!el.name?.startsWith("sf:")) continue;
    const raw = el.value.trim();
    if (raw === "") continue;
    const [root, sub] = el.name.slice(3).split(".");
    if (root === "notes") {
      out.notes = raw;
      continue;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    const field = setupFieldFor(root);
    const v = PART_REFS.some(([k]) => k === root) ? Math.round(num) : field ? setupToStored(field, num, units) : num;
    if (sub) (out[root] ??= {})[sub] = v;
    else out[root] = v;
  }
  return out;
}

// "Camber F −3.0 → −3.2" chips for the track page's correlation table.
function diffChipsHtml(prev, cur, partsById, max = 8) {
  const fmtV = (key, v) => {
    if (v == null) return "—";
    if (PART_REFS.some(([k]) => k === key)) {
      const p = partsById?.get(v);
      return p ? p.name : `#${v}`;
    }
    return fmtSetupValue(key, v, currentUnits());
  };
  const diffs = diffSetups(prev, cur);
  if (!diffs.length) return `<span class="hint-inline">no changes</span>`;
  const chips = diffs
    .slice(0, max)
    .map(
      (d) => `<span class="diff-chip"><span class="dc-label">${esc(flatLabel(d.key))}</span>
        ${prev ? `${esc(fmtV(d.key, d.from))} → ` : ""}<b>${esc(fmtV(d.key, d.to))}</b></span>`
    )
    .join("");
  return chips + (diffs.length > max ? ` <span class="hint-inline">+${diffs.length - max} more</span>` : "");
}

// Track page: what changed setup-wise across visits, next to what it did to
// the times. One row per event-day sheet in date order; the Changes column
// diffs against the previous sheet, so the human does the causal reasoning —
// this table just does the recall a paper notebook can't.
function setupHistoryHtml(setupRows, partsById) {
  if (!setupRows?.length) return "";
  const rows = setupRows
    .map((r, i) => {
      const prev = setupRows[i - 1] ?? null;
      return `<tr class="rowlink" data-href="#/event/${r.event_id}">
        <td class="date">${fmtDate(r.start_date)}${r.day > 1 ? ` <span class="hint-inline">day ${r.day}</span>` : ""}</td>
        <td>${fmtConditions(r)}</td>
        <td class="num">${fmtMs(r.best_ms)}</td>
        <td class="num">${fmtConsistency(r.consistency)}</td>
        <td class="diff-cell">${
          prev
            ? diffChipsHtml(prev.data, r.data, partsById)
            : `<span class="diff-chip baseline">baseline — ${diffSetups(null, r.data).length} values logged</span>${
                r.data.notes ? ` <span class="hint-inline">${esc(r.data.notes)}</span>` : ""
              }`
        }</td>
      </tr>`;
    })
    .join("");
  return `<h2>Setup vs. lap times</h2>
    <div class="hint" style="margin:0 0 4px">Every setup sheet logged at this track, oldest first, with what changed between sheets. Best and consistency are the event's — decide for yourself what a change bought you.</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Conditions</th><th class="num">Best</th><th class="num">Consistency</th><th>Setup changes</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ISO date of an event's Nth day (day 1 = start_date).
function eventDayISO(startDate, day) {
  const d = new Date(startDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + day - 1);
  return d.toISOString().slice(0, 10);
}

// Dashboard hero for the nearest upcoming event: countdown, checklist
// progress ring, and the still-open items by name.
function heroEventHtml(e) {
  const cl = e.checklist || [];
  const done = cl.filter((i) => i.done).length;
  const open = cl.filter((i) => !i.done);
  const R = 30;
  const C = 2 * Math.PI * R;
  const ring = cl.length
    ? `<div class="hero-ring">
        <div class="ring-box">
          <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
            <circle cx="38" cy="38" r="${R}" fill="none" stroke="var(--surface-raised)" stroke-width="7"/>
            <circle cx="38" cy="38" r="${R}" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round"
              stroke-dasharray="${((done / cl.length) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 38 38)"/>
          </svg>
          <span class="ring-label">${done}/${cl.length}</span>
        </div>
        <div class="ring-cap"><b>Prep checklist</b><br>${
          open.length
            ? `Still open: ${esc(open.slice(0, 2).map((i) => i.text).join(", "))}${open.length > 2 ? ` +${open.length - 2} more` : ""}`
            : "All done ✓"
        }</div>
      </div>`
    : "";
  return `<a class="hero-event" href="#/event/${e.id}">
    <div class="hero-main">
      <span class="hero-kicker">Next event</span>
      <div class="hero-track">${esc(e.track_name)}</div>
      <div class="hero-meta">${fmtDate(e.start_date)}${e.club ? " · " + esc(e.club) : ""}${e.run_group ? " · " + esc(e.run_group) : ""}</div>
      <div class="hero-count">${fmtCountdown(e.start_date)}</div>
    </div>
    ${ring}
    <span class="btn">${cl.length && open.length ? "Finish prep →" : "Open event →"}</span>
  </a>`;
}

// The next event's car, when something on it needs attention first (NS-37) —
// the one thing the dashboard still says about the garage now the garage has
// its own page. Its own link under the hero, since the hero is a link already.
function heroGarageHtml(e, garage) {
  const v = e.vehicle_id == null ? null : garage.find((x) => x.id === e.vehicle_id);
  const alerts = v ? garageAlerts([v]) : [];
  if (!alerts.length) return "";
  const [first] = alerts;
  const more = alerts.length - 1;
  return `<a class="hero-garage ${first.status}" href="#/vehicle/${v.id}">
    <span aria-hidden="true">🔧</span> ${esc(partKindLabel(first.part.kind))} ${
      first.status === "due" ? "due" : "due soon"
    } on the ${esc(v.name)}${more ? ` · +${more} more` : ""} →</a>`;
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const isUpcoming = (e) => e.start_date > todayISO();
function daysUntil(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}
const fmtCountdown = (iso) => {
  const dd = daysUntil(iso);
  return dd <= 0 ? "Today" : dd === 1 ? "Tomorrow" : `In ${dd} days`;
};

// The list the event page's "Use my list" button actually uses: the user's own
// (Settings → Prep checklist, stored server-side), else the app's built-in one.
// `state.me` is loaded by ensureMe() before any view renders.
const checklistTemplate = () => state.me?.checklist_template ?? DEFAULT_CHECKLIST;

// ---------- branding & footer ------------------------------------------------

// Speedshift.io mark: two diagonal bars (inlined from speedshift.io/logo.svg),
// tinted via CSS variable instead of brand amber.
const ssBars = (cls, fill) => `<svg class="${cls}" viewBox="0 0 429 629" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="0.589722" y="115.848" width="163" height="442.765" transform="rotate(-44.9265 0.589722 115.848)" fill="${fill}"/>
  <rect x="311.969" y="198.246" width="163" height="442.765" transform="rotate(44.5184 311.969 198.246)" fill="${fill}"/>
</svg>`;
const SS_LOGO = ssBars("ss-logo", "var(--accent-ink)");
// App mark: the bars on a lime circle (dark text always sits on the lime fill).
const appLogoHtml = (cls = "") => `<span class="app-logo${cls ? " " + cls : ""}">${ssBars("", "var(--accent-contrast)")}</span>`;

// Small portions of track- and AI-inspired things to buy the maker.
const TIP_ITEMS = [
  "a coffee ☕",
  "a beer 🍺",
  "some tires 🛞",
  "a set of brake pads 🛑",
  "a tank of race fuel ⛽",
  "a set of spark plugs ⚡",
  "some Claude tokens 🤖",
  "some Codex time 💻",
  "some track time 🏁",
  "an oil change 🛢️",
  "some GPU hours 🔥",
];
const TIP_URL = "https://buymeacoffee.com/speedshift";
const REPO_URL = "https://github.com/Richie97/track-history";
const DOCS_URL = "https://docs.trackevolution.app";
const APP_STORE_URL = "https://apps.apple.com/us/app/track-evolution/id6792941186";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=app.trackevolution";

let tipIdx = 0;
let tipTimer = null;
function startTipRotator() {
  if (tipTimer) return; // singleton — footer re-renders shouldn't stack intervals
  tipTimer = setInterval(() => {
    const el = document.querySelector(".tip-blank");
    if (!el) return;
    tipIdx = (tipIdx + 1) % TIP_ITEMS.length;
    el.style.opacity = "0";
    setTimeout(() => {
      el.textContent = TIP_ITEMS[tipIdx];
      el.style.opacity = "1";
    }, 220);
  }, 4000);
}

// legal:true adds the Privacy/Terms links — used on signed-out and public
// pages (login, unreachable, share), where the account menu's Settings page
// (which carries them for signed-in users) isn't reachable.
function footerHtml({ legal = false } = {}) {
  startTipRotator();
  return `<footer class="site-footer">
    <span class="footer-left">
      <span>© ${new Date().getFullYear()} Speedshift LLC</span>
      ${
        legal
          ? `<a class="footer-link" href="${DOCS_URL}/docs/privacy.html" target="_blank" rel="noopener">Privacy</a>
      <a class="footer-link" href="${DOCS_URL}/docs/terms.html" target="_blank" rel="noopener">Terms</a>`
          : ""
      }
      <a class="contribute-link" href="${REPO_URL}" target="_blank" rel="noopener"
         data-tip="Fix my bugs — or add your own 🐛">
        Contribute ↗
      </a>
    </span>
    <a class="tip-btn" href="${TIP_URL}" target="_blank" rel="noopener">
      Buy me <span class="tip-blank">${TIP_ITEMS[tipIdx]}</span>
    </a>
    <a class="ss-credit" href="https://speedshift.io" target="_blank" rel="noopener">
      Built by <span class="ss-mark">${SS_LOGO} <span class="ss-wordmark">Speedshift</span></span>
    </a>
  </footer>`;
}

// ---------- shell & login ----------------------------------------------------

const APPLE_LOGO = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z"/></svg>`;

// "Also in the app stores" under the sign-in buttons. Deliberately not
// carrying APPLE_LOGO: it would sit directly under the Apple sign-in button,
// where a second Apple mark reads as another way to sign in.
//
// The Mac is named in words, not as a third link: the iPad build installs on
// Apple silicon Macs from the same App Store listing (epic #230), so the pair
// the docs site offers everywhere stays a pair here too.
function appStoreLinkHtml() {
  return `<p class="login-store">
    <a href="${APP_STORE_URL}" target="_blank" rel="noopener">Download for iPhone, iPad and Mac ↗</a>
    <a href="${PLAY_STORE_URL}" target="_blank" rel="noopener">Download for Android ↗</a>
  </p>`;
}

// The login screen is static HTML but the Apple button depends on server
// config (a self-hosted instance may not carry Apple credentials), so it's
// injected only after the server says it offers the provider. Errors are
// swallowed: an unreachable server still gets a working Google-only screen.
async function showAppleLoginIfAvailable() {
  try {
    const res = await fetch("/auth/providers");
    if (!res.ok) return;
    const { apple } = await res.json();
    const slot = document.querySelector(".login-buttons");
    if (!apple || !slot || document.getElementById("apple-login")) return;
    slot.insertAdjacentHTML(
      "beforeend",
      `<a class="btn apple" id="apple-login" href="/auth/apple/login">${APPLE_LOGO} Sign in with Apple</a>`
    );
  } catch {}
}

function renderLogin() {
  document.querySelector(".shell")?.remove();
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="flag">${appLogoHtml("lg")}</div>
        <h1>Track Evolution</h1>
        <p>Lap times, sessions and notes — per track, over time.</p>
        <div class="login-buttons">
          <a class="btn primary" href="/auth/login">Sign in with Google</a>
        </div>
        ${appStoreLinkHtml()}
        ${footerHtml({ legal: true })}
      </div>
    </div>`;
  showAppleLoginIfAvailable();
}

// Rendered when the server can't be reached at all (offline and nothing
// cached) — without this the boot fetch failing would leave a blank page.
function renderUnreachable(err) {
  document.querySelector(".shell")?.remove();
  $app.innerHTML = `
    <div class="login-wrap">
      <span class="login-toggle">${themeToggleHtml()}</span>
      <div class="login-card">
        <div class="flag">${appLogoHtml("lg")}</div>
        <h1>Can't reach the server</h1>
        <p>${esc(serverHost())} didn't answer${err?.message ? ` (${esc(err.message)})` : ""}. Check your connection and try again.</p>
        <button class="btn primary" id="retry-connect">Try again</button>
        ${footerHtml({ legal: true })}
      </div>
    </div>`;
  wireThemeToggle();
  document.getElementById("retry-connect").onclick = () => route();
}

// The two halves of the app (NS-37): the logbook and the garage. The phones
// draw these as tabs; here they are two links in the top bar, since a tab bar
// on a web page is an imitation of a phone. Settings belongs to neither.
function navSection() {
  const first = (location.hash || "#/").slice(2).split(/[/?]/)[0];
  if (first === "garage" || first === "vehicle") return "garage";
  if (first === "settings") return null;
  return "events";
}

function sectionNavHtml() {
  const cur = navSection();
  const link = (id, href, label, extra = "") =>
    `<a href="${href}" class="${cur === id ? "active" : ""}"${cur === id ? ' aria-current="page"' : ""}>${label}${extra}</a>`;
  return `<nav class="section-nav" aria-label="Sections">
    ${link("events", "#/", "Events")}
    ${link("garage", "#/garage", "Garage", `<span class="nav-badge" id="garage-badge" hidden></span>`)}
  </nav>`;
}

// The Garage link's count: every maintenance reminder (due or low) across the
// cars, the number the Pro GET /api/garage decides. Pages that already read
// /garage report it through noteGarage; everywhere else the shell refreshes it
// in the background at most once a minute, so the count is on every page
// without every page waiting for the garage.
const GARAGE_BADGE_TTL_MS = 60_000;

function noteGarage(garage) {
  state.garageAlertCount = garageAlerts(garage).length;
  state.garageAlertsAt = Date.now();
  paintGarageBadge();
}

function paintGarageBadge() {
  const el = document.getElementById("garage-badge");
  if (!el) return;
  const n = canUseGarage(state.entitlement) ? (state.garageAlertCount ?? 0) : 0;
  el.hidden = !n;
  el.innerHTML = n
    ? `<span aria-hidden="true">${n}</span><span class="visually-hidden">, ${n} maintenance reminder${n === 1 ? "" : "s"}</span>`
    : "";
}

function refreshGarageBadge() {
  if (!canUseGarage(state.entitlement)) return;
  if (state.garageAlertsAt && Date.now() - state.garageAlertsAt < GARAGE_BADGE_TTL_MS) return;
  state.garageAlertsAt = Date.now();
  apiFetch("/garage").then(noteGarage, () => {});
}

function shell(content) {
  const me = state.me;
  $app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/">${appLogoHtml()} <span class="brand-text">Track Evolution</span></a>
        ${sectionNavHtml()}
        <span class="spacer"></span>
        <div class="user-menu">
          <button class="user-trigger" id="user-trigger" aria-haspopup="menu" aria-expanded="false"
            aria-label="Account menu — ${esc(me?.name || me?.email || "")}">
            ${
              me?.picture
                ? `<img class="avatar" src="${esc(me.picture)}" alt="">`
                : `<span class="avatar avatar-fallback" aria-hidden="true">${esc((me?.name || me?.email || "?").trim().charAt(0).toUpperCase())}</span>`
            }
          </button>
          <div class="menu" id="user-dropdown" hidden>
            <div class="menu-who">${esc(me?.name || me?.email || "")}</div>
            <div class="menu-sep"></div>
            <div class="menu-row">
              <span class="menu-label">Theme</span>
              ${themeToggleHtml()}
            </div>
            <div class="menu-sep"></div>
            <a class="menu-item" href="#/settings">Settings</a>
            <button class="menu-item" id="logout">Sign out</button>
          </div>
        </div>
      </div>
    </header>
    <div class="shell">
      <div id="sync-banner" class="sync-banner" hidden></div>
      <div id="view">${content}</div>
      ${footerHtml()}
    </div>`;
  wireThemeToggle();
  updateSyncBanner();
  paintGarageBadge();
  refreshGarageBadge();
  const trigger = document.getElementById("user-trigger");
  const dropdown = document.getElementById("user-dropdown");
  trigger.onclick = () => {
    const open = dropdown.hidden;
    dropdown.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  document.getElementById("logout").onclick = async () => {
    if (pendingCount() && !confirm("You have offline changes that haven't synced yet — signing out discards them. Sign out anyway?")) return;
    await fetch("/auth/logout", { method: "POST" });
    // Delete the service worker's cached API responses (named th-data-* in
    // sw.js) so the logbook doesn't linger in Cache Storage on a shared device.
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("th-data")).map((k) => caches.delete(k)));
    }
    // Same reasoning for the offline layer's response cache and write queue.
    await clearOffline();
    clearUnitsCache();
    renderLogin();
  };
  return document.getElementById("view");
}

const state = { me: null, totals: null, entitlement: null };

// ---------- offline / sync status --------------------------------------------

// The shell renders an empty #sync-banner strip; this fills it in place from
// syncStatus (shell() re-renders per route, so the banner is re-applied there
// and updated live by the onSyncChange subscription below).
function updateSyncBanner() {
  const el = document.getElementById("sync-banner");
  if (!el) return;
  const n = syncStatus.pending;
  const changes = (k) => `${k} change${k === 1 ? "" : "s"}`;
  const parts = [];
  if (syncStatus.offline) {
    parts.push(n ? `📴 Offline — ${changes(n)} saved on this device, syncing when you're back online` : "📴 Offline — showing saved data");
  } else if (n) {
    parts.push(`Syncing ${changes(n)}…`);
  }
  if (syncStatus.failed) {
    parts.push(`${changes(syncStatus.failed)} couldn't be synced and ${syncStatus.failed === 1 ? "was" : "were"} discarded
      <button class="btn small ghost" id="sync-dismiss">Dismiss</button>`);
  }
  el.hidden = !parts.length;
  el.innerHTML = parts.join(" · ");
  const dismiss = document.getElementById("sync-dismiss");
  if (dismiss) dismiss.onclick = () => clearFailed();
}

onSyncChange((_st, change) => {
  updateSyncBanner();
  // After a flush, a view parked on an offline-created row's temp URL is
  // remapped to the real id (which triggers a fresh route). Other views are
  // left alone — a form could be mid-edit — and pick up synced state on the
  // next navigation or pull-refresh.
  if (change.flushed) {
    const remapped = location.hash.replace(/tmp-\d+/g, (t) => resolveId(t) ?? t);
    if (remapped !== location.hash) location.hash = remapped;
  }
});

// Close the user dropdown on outside click or Escape (module-level: shell()
// re-renders per route, so per-render listeners would accumulate).
function closeUserMenu() {
  const dropdown = document.getElementById("user-dropdown");
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    document.getElementById("user-trigger")?.setAttribute("aria-expanded", "false");
  }
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".user-menu")) closeUserMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeUserMenu();
});

async function ensureMe() {
  const data = await api("/me");
  state.me = data.user;
  state.totals = data.totals;
  // The account's unit system; cached so share pages and the import review
  // (which have no /me) read the same value.
  cacheUnits(state.me.units);
  // Free until the server says otherwise — an older server that carries no
  // entitlement field must not read as Pro.
  state.entitlement = data.entitlement ?? null;
}

// --- dashboard ---

async function viewDashboard() {
  const pro = canUseGarage(state.entitlement);
  const [tracks, events, garage] = await Promise.all([
    api("/tracks"),
    api("/events"),
    // Only for the hero's due-part line now that the garage has its own page
    // (NS-37) — Pro, and allowed to fail: offline or lapsed, the dashboard
    // renders without it rather than failing whole.
    pro ? api("/garage").catch(() => null) : null,
  ]);
  if (garage) noteGarage(garage);
  const withData = tracks.filter((t) => t.event_count > 0).sort((a, b) => (b.last_date || "").localeCompare(a.last_date || ""));
  const upcoming = events.filter(isUpcoming).sort((a, b) => a.start_date.localeCompare(b.start_date));

  const cards = withData
    .map(
      (t) => `<a class="card" href="#/track/${t.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · ${fmtDate(t.last_date)}</div>
      </a>`
    )
    .join("");

  // The nearest upcoming event gets a hero slot above the tiles; any others
  // stay as cards.
  const heroEvent = upcoming[0] ?? null;
  const upcomingCards = upcoming
    .slice(1)
    .map((e) => {
      const cl = e.checklist || [];
      const done = cl.filter((i) => i.done).length;
      return `<a class="card" href="#/event/${e.id}">
        <div class="name">${esc(e.track_name)}</div>
        <div class="countdown">${fmtCountdown(e.start_date)}</div>
        <div class="meta">${fmtDate(e.start_date)}${e.club ? " · " + esc(e.club) : ""}${cl.length ? ` · checklist ${done}/${cl.length}` : ""}</div>
      </a>`;
    })
    .join("");

  // Season Wrapped's reveal (NS-36): 1 Nov – 31 Jan, for a year this driver
  // actually drove, until they dismiss it for that season.
  const wrapYear = wrappedSeason();
  const showWrapped =
    wrapYear != null &&
    !wrappedDismissed(wrapYear) &&
    events.some((e) => !isUpcoming(e) && e.start_date.startsWith(`${wrapYear}-`));

  const slug = state.me.share_slug || "";
  const view = shell(`
    <div class="btn-row" style="margin-top:20px">
      <a class="btn primary" href="#/new">+ Add event</a>
      <a class="btn" href="#/year">Year in review</a>
    </div>
    ${showWrapped ? wrappedHeroHtml(wrapYear) : ""}
    ${heroEvent ? heroEventHtml(heroEvent) : ""}
    ${heroEvent && garage ? heroGarageHtml(heroEvent, garage) : ""}
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${state.totals.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${state.totals.track_days}</div></div>
      <div class="tile"><div class="label">Tracks</div><div class="value">${withData.length}</div></div>
    </div>
    ${upcomingCards ? `<h2>Also upcoming</h2><div class="cards">${upcomingCards}</div>` : ""}
    <h2>Tracks</h2>
    ${cards ? `<div class="cards">${cards}</div>` : `<div class="empty">No events yet — add your first track day.</div>`}
    <h2>Share your history</h2>
    <div class="panel share-panel">
      <div class="hint" style="margin:0 0 10px">Publish a read-only page of your track history — bests, run groups and consistency (notes stay private). Handy for HPDE run-group placement. Anyone with the link can view it.</div>
      <div class="btn-row">
        <span class="share-url">
          <span class="share-prefix">${esc(serverHost())}/share/</span>
          <input id="share-slug" placeholder="your-name" maxlength="32" value="${esc(slug)}" spellcheck="false">
        </span>
        <button class="btn small primary" id="share-save">${slug ? "Update path" : "Create link"}</button>
        ${slug ? `<button class="btn small" id="share-copy">Copy link</button>
        <a class="btn small ghost" href="${esc(location.origin)}/share/${esc(slug)}" target="_blank" rel="noopener">Open ↗</a>
        <button class="btn small danger" id="share-disable">Disable</button>` : ""}
      </div>
      <div id="share-msg" class="hint" style="margin-top:6px"></div>
    </div>
  `);
  // Warm the offline cache in the background while we're on the dashboard.
  scheduleWarm();

  view.querySelector("#wrapped-dismiss")?.addEventListener("click", () => {
    dismissWrapped(wrapYear);
    view.querySelector(".wrapped-hero")?.remove();
  });

  const shareMsg = view.querySelector("#share-msg");
  const shareInput = view.querySelector("#share-slug");
  view.querySelector("#share-save").onclick = async () => {
    try {
      const saved = await api("/share", { method: "PUT", body: { slug: shareInput.value } });
      state.me.share_slug = saved.slug;
      route();
    } catch (err) {
      shareMsg.textContent = err.message;
    }
  };
  shareInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") view.querySelector("#share-save").click();
  });
  if (slug) {
    const shareUrl = `${location.origin}/share/${slug}`;
    view.querySelector("#share-copy").onclick = async () => {
      await navigator.clipboard.writeText(shareUrl);
      shareMsg.textContent = "Link copied.";
    };
    view.querySelector("#share-disable").onclick = async () => {
      if (!confirm("Disable your public share link? The URL will stop working.")) return;
      await api("/share", { method: "DELETE" });
      state.me.share_slug = null;
      route();
    };
  }
}

// --- track detail ---

// The per-track community leaderboard — the body of `viewLeaderboard`. Only
// catalog tracks have one (catalog_id gives the same physical track an
// identity across users), and it is strictly opt-in: drivers who haven't
// opted in — the viewer included — simply aren't on it. Only device-timed laps
// rank (NS-33) — the server decides that — so `viewerBestMs`, the viewer's
// logbook best at the track (manual bests included), is what explains a row
// that's slower than the track page's own headline, or a missing row.
function leaderboardHtml(lb, viewerBestMs = null, trackId = null) {
  if (lb.catalog_id == null) return `<div class="empty">This track isn't in the catalog, so it has no leaderboard.</div>`;
  const you = lb.entries.find((en) => en.you);
  let yourNote = "";
  if (lb.opted_in && !you && viewerBestMs != null)
    yourNote = "None of your laps here were timed by a device, so you aren't ranked yet. Record with the app or import telemetry to appear.";
  else if (you && viewerBestMs != null && viewerBestMs < you.best_ms)
    yourNote = `Your best here (${fmtMs(viewerBestMs)}) was entered by hand and isn't ranked.`;
  // A row is openable when its owner published the lap itself (NS-35) — the
  // server decides that, and withholds `lap_id` otherwise. The time stays a
  // plain cell in that case rather than a link that would 404.
  const rows = lb.entries
    .map((en, i) => {
      const time = fmtMs(en.best_ms);
      const timeCell =
        en.lap_id != null && trackId != null
          ? `<a href="#/track/${trackId}/leaderboard/${en.lap_id}" title="Open this lap">${time}</a>`
          : time;
      return `<tr${en.you ? ` class="you-row"` : ""}>
        <td class="num">${i + 1}</td>
        <td>${esc(en.name ?? "Driver")}${en.you ? ` <span class="hint">(you)</span>` : ""}</td>
        <td class="num">${timeCell}</td>
        <td class="date">${fmtDate(en.date)}</td>
      </tr>`;
    })
    .join("");
  const anyOpenable = lb.entries.some((en) => en.lap_id != null);
  // The second consent sits with the first, because it is the one place a
  // driver is looking at exactly what it would publish.
  const shareControl = lb.opted_in
    ? lb.share_laps
      ? `<div class="hint" style="margin:4px 0 0">Your ranked lap is open to other drivers here — its racing line and telemetry, and nothing else from your logbook. <button class="btn small" id="lb-unshare">Stop sharing my laps</button></div>`
      : `<div class="hint" style="margin:4px 0 0">Your ranked lap is a time only. Sharing it lets other drivers ranked here open its racing line and telemetry — never your notes, your car, your setup or any other lap. <button class="btn small" id="lb-share">Share my ranked laps</button></div>`
    : "";
  const optControl = lb.opted_in
    ? `<div class="hint" style="margin:8px 0 0">You're on the leaderboards — your name and best device-timed lap per track are visible to other signed-in drivers. <button class="btn small" id="lb-leave">Leave leaderboards</button></div>`
    : `<div class="hint" style="margin:8px 0 0">You're not on the leaderboards. Joining shares exactly two things with other signed-in drivers, per track: your name and your best device-timed lap. <button class="btn small primary" id="lb-join">Join leaderboards</button></div>`;
  return `<div class="hint" style="margin:0 0 4px">Best device-timed laps by Track Evolution drivers at this track. Laps recorded with the app or imported from telemetry count; hand-entered times don't.</div>
    ${
      rows
        ? `<div class="table-wrap"><table><thead><tr><th class="num">#</th><th>Driver</th><th class="num">Best</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty">No opted-in drivers here yet${lb.opted_in ? "" : " — be the first"}.</div>`
    }
    ${anyOpenable ? `<div class="hint" style="margin:6px 0 0">Times in blue open the lap — its racing line and telemetry, next to your own best here.</div>` : ""}
    ${yourNote ? `<div class="hint" style="margin:8px 0 0">${yourNote}</div>` : ""}
    ${optControl}
    ${shareControl}
    <span id="lb-msg" class="goal-msg"></span>`;
}

async function viewTrack(trackId, params) {
  const [tracks, allEvents, trackSetups, garage] = await Promise.all([
    api("/tracks"),
    api(`/events?track_id=${trackId}`),
    api(`/tracks/${trackId}/setups`).catch(() => []),
    api("/garage").catch(() => []),
  ]);
  const track = tracks.find((t) => String(t.id) === String(trackId));
  if (!track) return viewNotFound();

  // "Dry only" keeps a rain weekend from reading as regression. Only offered
  // once any event at this track has recorded non-dry conditions.
  const dryOnly = params?.get("dry") === "1";
  const hasWetData = allEvents.some((e) => e.conditions && e.conditions !== "dry");
  // "Dry only" hides events *known* to be damp/wet/mixed; unlabeled history stays.
  const events = dryOnly ? allEvents.filter((e) => !e.conditions || e.conditions === "dry") : allEvents;

  const chrono = [...events].reverse().filter((e) => e.best_ms != null);
  const points = chrono.map((e) => ({
    x: new Date(e.start_date).getTime(),
    y: e.best_ms,
    xlabel: fmtDate(e.start_date),
    tip: `${fmtDate(e.start_date)}${e.club ? " · " + e.club : ""}${fmtConditions(e) ? " · " + fmtConditions(e) : ""}`,
    href: `#/event/${e.id}`,
  }));
  // Conditions band (#191): a wash behind the line, one cell per event,
  // deepening with the air temperature — so a run of slower times in August
  // reads as August. The numbers are on the tooltip and in the key below.
  const band = conditionsBand(chrono);
  const chart = points.length
    ? lineChart(points, {
        goal: track.goal_ms,
        bands: band ? { cells: band.cells, label: bandLabel(band, usUnits()) } : null,
      })
    : null;
  // Elevation change is a property of the track, so it comes from every event
  // at it, dry-only filter or no filter.
  const elevM = trackElevationM(allEvents);
  // What this track has cost (#147): every past event here that was costed,
  // dry-only filter or no filter — a rain weekend still cost the entry fee.
  // Upcoming events aren't spent yet, on the same rule as the totals.
  // A roll-up across events, so Pro (NS-37); each event's own total stays free.
  const spend = canViewSpend(state.entitlement) ? spendSummary(allEvents.filter((e) => !isUpcoming(e))) : null;
  const spentText = spend
    ? ` · ${fmtSpend(spend.total_cents)} spent${
        spend.costed_events < spend.events ? ` (${spend.costed_events} of ${spend.events} events costed)` : ""
      }`
    : "";

  const rows = events
    .map(
      (e) => `<tr class="rowlink" data-href="#/event/${e.id}">
        <td class="date">${fmtDate(e.start_date)}</td>
        <td>${e.days}</td>
        <td>${esc(e.club ?? "")}</td>
        <td>${esc(e.run_group ?? "")}</td>
        <td>${fmtConditions(e)}</td>
        <td class="num">${fmtMs(e.best_ms)}</td>
        <td class="num">${fmtConsistency(e.consistency)}</td>
        <td>${esc(e.notes ?? "")}</td>
      </tr>`
    )
    .join("");

  const bests = events.map((e) => e.best_ms).filter((v) => v != null);
  const pb = bests.length ? Math.min(...bests) : null;
  const goal = track.goal_ms;
  const goalMet = goal != null && pb != null && pb <= goal;
  const goalStatus =
    goal == null
      ? ""
      : goalMet
        ? `<span class="goal-status met">Goal beaten by ${fmtDelta(goal - pb).replace("+", "")} ✓</span>`
        : `<span class="goal-status unmet">${pb != null ? `${fmtDelta(pb - goal)} to goal` : "Not yet beaten"}</span>`;

  const dryToggle = hasWetData
    ? `<label class="dry-toggle"><input type="checkbox" id="dry-only" ${dryOnly ? "checked" : ""}> Dry only</label>`
    : "";

  const goalControl = `<div class="goal-control">
    <span class="goal-label">Goal lap</span>
    <input id="goal-input" type="text" placeholder="e.g. 1:59.0" value="${goal != null ? esc(fmtMs(goal)) : ""}">
    <button class="btn small" id="goal-save">Save</button>
    ${goal != null ? `<button class="btn small" id="goal-clear">Clear</button>` : ""}
    ${goalStatus}
    <span id="goal-msg" class="goal-msg"></span>
  </div>`;

  // Comparing two events lap-by-lap needs recorded laps on both sides; the
  // two-lap telemetry compare needs laps at all (it explains itself when no
  // lap has channel data). Selection lives on the compare screens themselves.
  const comparable = allEvents.filter((e) => e.lap_count > 0);
  const compareBtns = [
    comparable.length >= 2 ? `<a class="btn small" href="#/track/${trackId}/compare">Compare two events</a>` : "",
    comparable.length >= 1 ? `<a class="btn small" href="#/track/${trackId}/lap-compare">Compare two laps</a>` : "",
  ].join("");
  const compareControl = compareBtns.trim()
    ? `<div class="btn-row" style="margin-top:10px">${compareBtns}</div>`
    : "";

  const shareBtn = state.me.share_slug
    ? `<button class="btn" id="share-track">Copy share link</button>`
    : "";
  // The leaderboard is its own page rather than a section here: this page is
  // the driver's own history, and a board they may not care about was costing
  // it a screen of space. Offered for every catalog track — before the driver
  // is on it, and before they have been here at all.
  const leaderboardBtn =
    track.catalog_id != null ? `<a class="btn" href="#/track/${trackId}/leaderboard">Leaderboard</a>` : "";

  const view = shell(`
    <h1>${esc(track.name)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong>${dryOnly ? " (dry)" : ""} · ${events.length} event${events.length === 1 ? "" : "s"}${elevM != null ? ` · ${esc(elevationText(elevM, usUnits()))}` : ""}${spentText}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — <span class="dir">down is faster</span>${dryToggle}</div><div class="chart-wrap" id="chart">${chart.svg}</div>${conditionsLegendHtml(band)}${goalControl}${compareControl}</div>` : `<div class="chart-card">${dryToggle}${goalControl}</div>`}
    <div class="btn-row">
      <a class="btn primary" href="#/new?track=${encodeURIComponent(track.name)}">+ Add event at ${esc(track.name)}</a>
      ${leaderboardBtn}
      ${shareBtn}
      <span id="track-msg" class="goal-msg"></span>
    </div>
    <h2>Course notes</h2>
    <div class="panel">
      <div class="field"><label>Notes to reread the night before</label>
        <textarea id="track-notes" rows="6" placeholder="T1: brake at the 300 board, 4th gear&#10;T5a: patience — late apex, track out over the curb…">${esc(track.notes ?? "")}</textarea>
      </div>
      <div class="btn-row">
        <button class="btn small primary" id="track-save">Save</button>
        <span id="track-notes-msg" class="goal-msg"></span>
      </div>
    </div>
    <h2>Events${dryOnly ? " (dry only)" : ""}</h2>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Days</th><th>Club</th><th>Group</th><th>Conditions</th><th class="num">Best</th><th class="num">Consistency</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${
      canUseSetups(state.entitlement)
        ? setupHistoryHtml(trackSetups, garagePartsById(garage))
        : proPanelHtml(
            "Setup vs. lap times",
            "Every setup sheet you have logged at this track, oldest first, with what changed " +
              "between sheets beside what it did to your best and your consistency."
          )
    }
  `);
  if (chart) chart.bind(view.querySelector("#chart"));

  const dryBox = view.querySelector("#dry-only");
  if (dryBox)
    dryBox.onchange = () => {
      location.hash = dryBox.checked ? `#/track/${trackId}?dry=1` : `#/track/${trackId}`;
    };

  const goalInput = view.querySelector("#goal-input");
  const goalMsg = view.querySelector("#goal-msg");
  const saveGoal = async (value) => {
    try {
      await api(`/tracks/${trackId}`, { method: "PUT", body: { goal_ms: value } });
      route();
    } catch (err) {
      goalMsg.textContent = err.message;
    }
  };
  view.querySelector("#goal-save").onclick = () => {
    const raw = goalInput.value.trim();
    if (!raw) return saveGoal(null);
    const ms = parseTime(raw);
    if (ms == null || ms <= 0) {
      goalMsg.textContent = `Couldn't parse "${raw}" — use 1:59.0`;
      return;
    }
    saveGoal(ms);
  };
  goalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") view.querySelector("#goal-save").click();
  });
  const goalClear = view.querySelector("#goal-clear");
  if (goalClear) goalClear.onclick = () => saveGoal(null);

  view.querySelector("#track-save").onclick = async () => {
    const msg = view.querySelector("#track-notes-msg");
    try {
      await api(`/tracks/${trackId}`, {
        method: "PUT",
        body: { notes: view.querySelector("#track-notes").value },
      });
      msg.textContent = "Saved.";
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  const shareTrack = view.querySelector("#share-track");
  if (shareTrack)
    shareTrack.onclick = async () => {
      const url = `${location.origin}/share/${state.me.share_slug}#/track/${track.id}`;
      await navigator.clipboard.writeText(url);
      view.querySelector("#track-msg").textContent = "Share link copied.";
    };

  wireRowLinks(view);
}

// A Pro-only page rendered as the paywall rather than as its content. The
// route still resolves — a shared or bookmarked link has to land somewhere
// that explains itself, not on "not found".
function viewProGate(trackId, heading, what) {
  shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}">← Back to track</a></p>
    <h1>${esc(heading)}</h1>
    ${proPanelHtml(heading, what, { underHeading: true })}
  `);
}

// --- lap overlay: two events at one track, lap-by-lap ---

async function viewCompare(trackId, params) {
  if (!canCompareEvents(state.entitlement)) return viewProGate(trackId, "Lap overlay",
    "Put two track days at the same circuit on one chart, lap by lap, and see where the " +
      "second one actually gained.");
  const allEvents = await api(`/events?track_id=${trackId}`);
  // Only events with recorded laps can be overlaid; list is most recent first.
  const comparable = allEvents.filter((e) => e.lap_count > 0);
  if (comparable.length < 2) {
    shell(`
      <p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}">← Back to track</a></p>
      <h1>Lap overlay</h1>
      <div class="empty">Comparing needs two events with recorded laps at this track.</div>
    `);
    return;
  }
  const has = (id) => id != null && comparable.some((e) => String(e.id) === String(id));
  // Default to the two most recent events with laps.
  const idA = has(params.get("a")) ? params.get("a") : String(comparable[1].id);
  const idB = has(params.get("b")) ? params.get("b") : String(comparable[0].id);
  const [ea, eb] = await Promise.all([api(`/events/${idA}`), api(`/events/${idB}`)]);

  const flatLaps = (e) => e.sessions.flatMap((s) => s.laps.map((l) => l.time_ms));
  const mkSeries = (e, color) => {
    const laps = flatLaps(e);
    return { e, laps, label: fmtDate(e.start_date), color, points: laps.map((ms, i) => ({ x: i + 1, y: ms })) };
  };
  const A = mkSeries(ea, "var(--chart-line)");
  const B = mkSeries(eb, "var(--chart-line-b)");
  const chart = multiLineChart([A, B]);

  const statRow = (label, fmt, pick, deltaFmt = fmtDelta) => {
    const [va, vb] = [pick(A), pick(B)];
    const delta = va != null && vb != null ? deltaFmt(vb - va) : "—";
    return `<tr><td>${label}</td><td class="num">${fmt(va)}</td><td class="num">${fmt(vb)}</td><td class="num">${delta}</td></tr>`;
  };
  const plainDelta = (d) => `${d > 0 ? "+" : ""}${d}`;
  const ppDelta = (d) => `${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;

  const pickerOpts = (sel) =>
    comparable
      .map(
        (e) =>
          `<option value="${e.id}" ${String(e.id) === String(sel) ? "selected" : ""}>${fmtDate(e.start_date)}${e.club ? " · " + esc(e.club) : ""} — ${fmtMs(e.best_ms)}</option>`
      )
      .join("");

  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}">← ${esc(ea.track_name)}</a></p>
    <h1>Lap overlay</h1>
    <p class="sub">
      <span class="swatch" style="background:var(--chart-line)"></span> <select id="cmp-a">${pickerOpts(idA)}</select>
      &nbsp;vs&nbsp;
      <span class="swatch" style="background:var(--chart-line-b)"></span> <select id="cmp-b">${pickerOpts(idB)}</select>
    </p>
    ${chart.svg ? `<div class="chart-card"><div class="chart-title">All laps in running order — <span class="dir">down is faster</span></div><div class="chart-wrap" id="chart">${chart.svg}</div></div>` : `<div class="empty">One of these events has no recorded laps.</div>`}
    <h2>Head to head</h2>
    <div class="table-wrap"><table><thead><tr><th></th><th class="num">${fmtDate(A.e.start_date)}</th><th class="num">${fmtDate(B.e.start_date)}</th><th class="num">Δ</th></tr></thead>
    <tbody>
      ${statRow("Best lap", fmtMs, (s) => (s.laps.length ? Math.min(...s.laps) : s.e.best_ms))}
      ${statRow("Best 3 avg", fmtMs, (s) => bestNAvg(s.laps, 3))}
      ${statRow("Laps", (v) => v ?? "—", (s) => s.laps.length, plainDelta)}
      ${statRow("Consistency", fmtConsistency, (s) => s.e.consistency, ppDelta)}
    </tbody></table></div>
    <div class="btn-row" style="margin-top:10px">
      <a class="btn small" href="#/track/${trackId}/lap-compare">Compare two laps' telemetry</a>
    </div>
  `);
  if (chart.svg) chart.bind(view.querySelector("#chart"));

  const [selA, selB] = [view.querySelector("#cmp-a"), view.querySelector("#cmp-b")];
  const go = () => {
    location.hash = `#/track/${trackId}/compare?a=${selA.value}&b=${selB.value}`;
  };
  // Picking the same event on both sides swaps instead of comparing it to itself.
  selA.onchange = () => {
    if (selA.value === selB.value) selB.value = idA;
    go();
  };
  selB.onchange = () => {
    if (selA.value === selB.value) selA.value = idB;
    go();
  };
}

// --- compare two laps: full telemetry for any two laps at one track (#165) ---

// Tooltip for a hand-built set of channel charts: nearest grid point by x, one
// row per side. The multi-lap version of the readout `bindChannelGraphs` binds
// for a whole session, used wherever a small fixed set of laps is drawn
// directly — the two-lap compare (#165) and the leaderboard lap (NS-35), which
// draws either one side or two depending on whether the viewer has a lap of
// their own to put beside it. Sides come from `sideLabels`, so a one-sided
// render needs no special case; `delta` and `refIdx` are the delta chart's, and
// omitting them simply leaves it out.
function bindPairTooltip(container, aligned, { sideColors, sideLabels, delta = null, refIdx = -1 }) {
  if (!container) return;
  const $tooltip = document.getElementById("tooltip");
  const units = currentUnits();
  const defs = channelDefs(units);
  container.querySelectorAll("svg[data-channel]").forEach((svgEl) => {
    const def = defs.find((d) => d.key === svgEl.dataset.channel);
    const x1 = Number(svgEl.dataset.x1);
    const padL = Number(svgEl.dataset.padl), padR = Number(svgEl.dataset.padr);
    const vbW = svgEl.viewBox.baseVal.width;
    svgEl.addEventListener("mousemove", (evt) => {
      const rect = svgEl.getBoundingClientRect();
      const frac = (((evt.clientX - rect.left) / rect.width) * vbW - padL) / (vbW - padL - padR);
      const k = Math.round((Math.max(0, Math.min(1, frac)) * x1) / aligned.dStepM);
      const d = Math.round(k * aligned.dStepM);
      const tipRows = sideLabels
        .map((label, i) => {
          if (svgEl.dataset.channel === "delta") {
            if (i === refIdx || !delta || k >= delta.length) return "";
            const v = delta[k];
            return `<div class="t-sub"><span style="color:${sideColors[i]}">●</span> ${esc(label)} — ${v >= 0 ? "+" : ""}${v.toFixed(2)} s</div>`;
          }
          if (svgEl.dataset.channel === "gear") {
            const arr = aligned.laps[i]?.gear;
            if (!arr || k >= arr.length) return "";
            return `<div class="t-sub"><span style="color:${sideColors[i]}">●</span> ${esc(label)} — ${esc(ordinal(arr[k]))}</div>`;
          }
          const arr = aligned.laps[i]?.[def.key];
          if (!arr || k >= arr.length) return "";
          const lim = activeLimitLabels(aligned.laps[i], k);
          return `<div class="t-sub"><span style="color:${sideColors[i]}">●</span> ${esc(label)} — ${def.conv(arr[k]).toFixed(def.dp)} ${esc(def.unit)}${lim.length ? ` · ${esc(lim.join(", "))}` : ""}</div>`;
        })
        .join("");
      if (!tipRows) { $tooltip.hidden = true; return; }
      $tooltip.innerHTML = `<div class="t-val">${esc(fmtDist(d, units))}</div>${tipRows}`;
      $tooltip.hidden = false;
      const tw = $tooltip.offsetWidth;
      let left = evt.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
      $tooltip.style.left = `${left}px`;
      $tooltip.style.top = `${evt.clientY - 12}px`;
    });
    svgEl.addEventListener("mouseleave", () => ($tooltip.hidden = true));
  });
}

async function viewLapCompare(trackId, params) {
  if (!canViewChannels(state.entitlement)) return viewProGate(trackId, "Compare two laps",
    "Any two laps at this track, head to head: the time delta as it builds through the lap, " +
      "speed, throttle, brake and steering side by side, and sector splits.");
  const allEvents = await api(`/events?track_id=${trackId}`);
  // Channel data lives on event details. The prefetcher warms these after any
  // dashboard visit, so this is mostly cache reads — and works offline.
  const details = await Promise.all(
    allEvents.filter((e) => e.lap_count > 0).map((e) => api(`/events/${e.id}`))
  );
  const rows = comparableLaps(details);
  const backHtml = `<p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}">← ${esc(details[0]?.track_name ?? "Back to track")}</a></p>`;
  if (rows.length < 2) {
    shell(`${backHtml}
      <h1>Compare two laps</h1>
      <div class="empty">Comparing laps needs two laps with telemetry at this track — import a session (or record laps in the app) first.</div>`);
    return;
  }

  const sessionsById = new Map(details.flatMap((e) => e.sessions.map((s) => [String(s.id), s])));
  const keyOf = (r) => `${r.sessionId}:${r.lapNum}`;
  const picks = defaultComparePicks(rows);
  const rowA = rows.find((r) => keyOf(r) === params.get("a")) ?? rows[picks.a];
  let rowB = rows.find((r) => keyOf(r) === params.get("b")) ?? rows[picks.b];
  if (rowB === rowA) rowB = rows[picks.a === rows.indexOf(rowA) ? picks.b : picks.a];
  if (rowB === rowA) rowB = rows.find((r) => r !== rowA);

  const chanFor = (r) => sessionsById.get(String(r.sessionId)).channels;
  const [entryA, entryB] = [chanFor(rowA).laps[rowA.chIdx], chanFor(rowB).laps[rowB.chIdx]];
  const [stepA, stepB] = [chanFor(rowA).dStepM, chanFor(rowB).dStepM];
  const aligned = alignLapPair(entryA, stepA, entryB, stepB);
  const mismatch = lengthMismatchRatio(entryA, stepA, entryB, stepB);
  const sideColors = ["var(--chart-line)", "var(--chart-line-b)"];
  const sideLabels = [rowA, rowB].map((r) => `Lap ${r.lapNum} (${fmtDate(r.date)})`);
  const lit = new Map(sideColors.map((c, i) => [i, c]));
  const refIdx = aligned.laps[0].timeMs <= aligned.laps[1].timeMs ? 0 : 1;
  const delta = deltaSeries(aligned.laps[1 - refIdx], aligned.laps[refIdx], aligned.dStepM);

  // Head-to-head numbers come from the *unresampled* entries.
  const [mA, mB] = [lapMetrics(entryA), lapMetrics(entryB)];
  const mphFmt = (v) => (v == null ? "—" : fmtSpeedKph(v, currentUnits()));
  const metricRow = (label, fmt, va, vb, deltaFmt) => {
    const d = va != null && vb != null ? deltaFmt(vb - va) : "—";
    return `<tr><td>${label}</td><td class="num">${fmt(va)}</td><td class="num">${fmt(vb)}</td><td class="num">${d}</td></tr>`;
  };
  const signed = (fmt) => (d) => `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d))}`;
  const mphDelta = signed((d) => fmtSpeedKph(d, currentUnits()));
  const tableHtml = `<div class="table-wrap"><table>
    <thead><tr><th></th><th class="num">${esc(sideLabels[0])}</th><th class="num">${esc(sideLabels[1])}</th><th class="num">Δ</th></tr></thead>
    <tbody>
      ${metricRow("Lap time", fmtMs, mA.timeMs, mB.timeMs, fmtDelta)}
      ${metricRow("Top speed", mphFmt, mA.topSpeedKph, mB.topSpeedKph, mphDelta)}
      ${metricRow("Min speed", mphFmt, mA.minSpeedKph, mB.minSpeedKph, mphDelta)}
      ${metricRow("Avg speed", mphFmt, mA.avgSpeedKph, mB.avgSpeedKph, mphDelta)}
      ${metricRow("Max RPM", (v) => (v == null ? "—" : Math.round(v)), mA.maxRpm, mB.maxRpm, signed((d) => `${Math.round(d)}`))}
      ${metricRow("Max lateral G", (v) => (v == null ? "—" : v.toFixed(2)), mA.maxLatG, mB.maxLatG, signed((d) => d.toFixed(2)))}
      ${metricRow("Full throttle", (v) => (v == null ? "—" : `${v.toFixed(0)}% of lap`), mA.fullThrottlePct, mB.fullThrottlePct, signed((d) => `${d.toFixed(1)}pp`))}
      ${metricRow("On the brakes", (v) => (v == null ? "—" : `${v.toFixed(0)}% of lap`), mA.brakingPct, mB.brakingPct, signed((d) => `${d.toFixed(1)}pp`))}
    </tbody></table></div>`;

  const pickerOpts = (selKey) => {
    let html = "", lastGroup = null;
    for (const r of rows) {
      const g = `${fmtDate(r.date)}${r.club ? " · " + esc(r.club) : ""}${r.sessionLabel ? " — " + esc(r.sessionLabel) : ""}`;
      if (g !== lastGroup) {
        html += `${lastGroup != null ? "</optgroup>" : ""}<optgroup label="${g}">`;
        lastGroup = g;
      }
      html += `<option value="${keyOf(r)}" ${keyOf(r) === selKey ? "selected" : ""}>Lap ${r.lapNum} — ${fmtMs(r.timeMs)}</option>`;
    }
    return `${html}</optgroup>`;
  };

  // Distance is measured from each lap's own start line, so laps from
  // different imports can be shifted relative to each other; a big length gap
  // means the comparison probably isn't corner-for-corner.
  const warnHtml =
    mismatch > LENGTH_MISMATCH_WARN
      ? `<div class="hint" style="margin:8px 0">⚠️ These laps cover driven distances ${Math.round(mismatch * 100)}% apart — likely a different layout or start/finish line, so the distance alignment may be off.</div>`
      : "";

  // Sector splits for the pair, on the same aligned grid the charts use; the
  // "best sectors" row is the theoretical best of the two.
  const sectorsHtml = sectorTableHtml(aligned, lit, (i) => sideLabels[i]);
  const chartsHtml = [
    deltaChartSvg(aligned, lit, refIdx, `${[rowA, rowB][refIdx].lapNum} (${fmtDate([rowA, rowB][refIdx].date)})`),
    ...channelDefs(currentUnits()).flatMap((def) => [
      channelChartSvg(def, aligned, lit),
      // Gear ribbon under the RPM trace, outlined where the two laps disagree.
      def.key === "rpm" ? gearRibbonSvg(aligned, lit, (i) => sideLabels[i]) : "",
    ]),
  ]
    .filter(Boolean)
    .map((c) => `<div class="ch-chart">${c}</div>`)
    .join("");

  const view = shell(`
    ${backHtml}
    <h1>Compare two laps</h1>
    <p class="sub">
      <span class="swatch" style="background:${sideColors[0]}"></span> <select id="lap-a">${pickerOpts(keyOf(rowA))}</select>
      &nbsp;vs&nbsp;
      <span class="swatch" style="background:${sideColors[1]}"></span> <select id="lap-b">${pickerOpts(keyOf(rowB))}</select>
    </p>
    ${warnHtml}
    <h2>Head to head</h2>
    ${tableHtml}
    ${sectorsHtml}
    <div class="chart-card">
      <div class="chart-title">Telemetry — shared driven-distance axis</div>
      <div class="hint" style="margin:2px 0 6px">The delta chart shows where time is gained or lost vs the faster lap; the channels below show why.</div>
      <div class="ch-graphs" id="cmp-charts">${chartsHtml}</div>
    </div>
  `);

  bindPairTooltip(view.querySelector("#cmp-charts"), aligned, { sideColors, sideLabels, delta, refIdx });

  const [selA, selB] = [view.querySelector("#lap-a"), view.querySelector("#lap-b")];
  const go = () => {
    location.hash = `#/track/${trackId}/lap-compare?a=${encodeURIComponent(selA.value)}&b=${encodeURIComponent(selB.value)}`;
  };
  // Picking the same lap on both sides swaps instead of comparing it to itself.
  selA.onchange = () => {
    if (selA.value === selB.value) selB.value = keyOf(rowA);
    go();
  };
  selB.onchange = () => {
    if (selA.value === selB.value) selA.value = keyOf(rowB);
    go();
  };
}

// --- track leaderboard ---

// One track's leaderboard, as its own page behind the track page's button.
// It used to be a section of the track page; it moved out because that page
// is the driver's own history and a board they may not care about was costing
// it a screen of space — and because a driver who *does* care wants to read
// it before they are on it, when the section had nothing of theirs to sit
// beside. The opt-in controls live here, where the driver is looking at
// exactly what joining publishes.
async function viewLeaderboard(trackId) {
  const [tracks, allEvents, leaderboard] = await Promise.all([
    api("/tracks"),
    // The viewer's logbook best here, manual bests included, is what explains a
    // row slower than the track page's headline — the dry-only filter has no
    // say, because the board ignores it too.
    api(`/events?track_id=${trackId}`).catch(() => []),
    // Older server or offline: say so rather than render a broken page.
    api(`/tracks/${trackId}/leaderboard`).catch(() => null),
  ]);
  const track = tracks.find((t) => String(t.id) === String(trackId));
  if (!track) return viewNotFound();
  const bests = allEvents.map((e) => e.best_ms).filter((v) => v != null);
  const viewerBest = bests.length ? Math.min(...bests) : null;

  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}">← ${esc(track.name)}</a></p>
    <h1>Leaderboard</h1>
    <p class="sub">${esc(track.name)} · opt-in only</p>
    ${
      leaderboard
        ? leaderboardHtml(leaderboard, viewerBest, track.id)
        : `<div class="empty">Couldn't load the leaderboard — it needs a connection.</div>`
    }
  `);

  // Leaderboard opt-in/out — a live server write on purpose (not queueable):
  // publishing your name is not something to replay silently later.
  const lbToggle = (optIn, shareLaps) => async () => {
    try {
      await api("/me/leaderboard", {
        method: "PUT",
        body: { opt_in: optIn, ...(shareLaps === undefined ? {} : { share_laps: shareLaps }) },
      });
      state.me.leaderboard_opt_in = optIn;
      // Leaving clears the second consent server-side; mirror that here so the
      // re-render doesn't show a control the server has already turned off.
      if (!optIn) state.me.leaderboard_share_laps = false;
      else if (shareLaps !== undefined) state.me.leaderboard_share_laps = shareLaps;
      route();
    } catch (err) {
      view.querySelector("#lb-msg").textContent = err.message;
    }
  };
  const lbJoin = view.querySelector("#lb-join");
  if (lbJoin) lbJoin.onclick = lbToggle(true);
  const lbLeave = view.querySelector("#lb-leave");
  if (lbLeave)
    lbLeave.onclick = () => {
      if (confirm("Leave the leaderboards? Your name and times disappear from every track's leaderboard.")) lbToggle(false)();
    };
  const lbShare = view.querySelector("#lb-share");
  if (lbShare) lbShare.onclick = lbToggle(true, true);
  const lbUnshare = view.querySelector("#lb-unshare");
  if (lbUnshare) lbUnshare.onclick = lbToggle(true, false);
}

// --- leaderboard lap: another driver's ranked lap, and yours beside it (NS-35) ---

// One row of the track leaderboard, opened. What the server publishes is the
// lap and nothing else — no session, no event, no car, nothing user-entered —
// so this page is deliberately thin above the charts: a name, a time, a date,
// and what the recorder measured.
//
// The comparison is the point of the page rather than a feature on it. When the
// viewer has a lap of their own with telemetry at this track, the two go
// through `alignLapPair` and render exactly as the two-lap compare does; when
// they don't, the same charts draw one side, and the page says why there is
// only one. Their lap is always side A, so the leaderboard lap keeps the same
// colour whether or not you have something to put beside it.
async function viewLeaderboardLap(trackId, lapId, params) {
  const lap = await api(`/tracks/${trackId}/leaderboard/laps/${lapId}`);
  // The viewer's own name for the track — never the owner's row, which is
  // user-entered and not published.
  const tracks = await api("/tracks").catch(() => []);
  const track = tracks.find((t) => String(t.id) === String(trackId));
  const backHtml = `<p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}/leaderboard">← ${esc(track?.name ?? "Track")} leaderboard</a></p>`;

  const who = lap.you ? "Your leaderboard lap" : `${lap.name ?? "Driver"}'s leaderboard lap`;
  const context = [
    fmtDate(lap.date),
    lap.ambient_c != null ? tempText(lap.ambient_c, usUnits()) : "",
    elevationText(lap.elevation_m, usUnits()),
  ].filter(Boolean);

  const headHtml = `${backHtml}
    <h1>${esc(fmtMs(lap.time_ms))}</h1>
    <p class="sub">${esc(who)}${context.length ? ` · ${esc(context.join(" · "))}` : ""}</p>`;

  // The racing line is free — only `channels` is the Pro field (NS-32 rule 4),
  // so a free account still gets the shape of the lap and the paywall sits
  // under it rather than over the whole page.
  const mapHtml = lap.trace
    ? `<div class="chart-card">
         <div class="chart-title">Racing line — <span class="dir">brighter is faster</span></div>
         <canvas id="lb-trackmap" class="trackmap" aria-label="Racing line of this lap, coloured by speed"></canvas>
       </div>`
    : "";

  // A free account gets the lap's speed, throttle and brake traces — the
  // server keeps those three (#264) — with the delta chart and the sector
  // table, which derive from them, behind the Pro panel under the charts.
  const proOk = canViewChannels(state.entitlement);
  if (!lap.channels?.laps?.length) {
    const view = shell(`${headHtml}${mapHtml}
      <div class="empty">This lap's telemetry isn't available.</div>`);
    if (lap.trace) renderTrackMap(view.querySelector("#lb-trackmap"), lap.trace);
    return;
  }

  const theirEntry = lap.channels.laps[0];
  const theirStep = lap.channels.dStepM;
  const theirLabel = lap.you ? "Your ranked lap" : `${lap.name ?? "Driver"} — ${fmtMs(lap.time_ms)}`;

  // The viewer's own comparable laps at this track. Channel data lives on event
  // details, which the prefetcher warms after any dashboard visit, so this is
  // mostly cache reads and works offline. A failure here costs the comparison,
  // never the page: their lap still renders.
  let mine = [];
  try {
    const allEvents = await api(`/events?track_id=${trackId}`);
    const details = await Promise.all(
      allEvents.filter((e) => e.lap_count > 0).map((e) => api(`/events/${e.id}`))
    );
    const sessionsById = new Map(details.flatMap((e) => e.sessions.map((s) => [String(s.id), s])));
    mine = comparableLaps(details).map((r) => ({
      ...r,
      key: `${r.sessionId}:${r.lapNum}`,
      entry: sessionsById.get(String(r.sessionId)).channels.laps[r.chIdx],
      step: sessionsById.get(String(r.sessionId)).channels.dStepM,
    }));
  } catch {
    mine = [];
  }
  // Default to the viewer's own fastest — the comparison anyone opening a
  // leaderboard row actually wants is "my best against theirs".
  const fastest = mine.reduce((m, r) => (m == null || r.timeMs < m.timeMs ? r : m), null);
  const pick = mine.find((r) => r.key === params.get("mine")) ?? fastest;

  const sideColors = ["var(--chart-line)", "var(--chart-line-b)"];
  const aligned = pick
    ? alignLapPair(theirEntry, theirStep, pick.entry, pick.step)
    : { v: 1, dStepM: theirStep, laps: [theirEntry] };
  const sideLabels = pick ? [theirLabel, `You — ${fmtMs(pick.timeMs)} (${fmtDate(pick.date)})`] : [theirLabel];
  const lit = new Map(sideLabels.map((_, i) => [i, sideColors[i]]));

  let delta = null, refIdx = -1;
  if (pick && proOk) {
    refIdx = aligned.laps[0].timeMs <= aligned.laps[1].timeMs ? 0 : 1;
    delta = deltaSeries(aligned.laps[1 - refIdx], aligned.laps[refIdx], aligned.dStepM);
  }

  const mismatch = pick ? lengthMismatchRatio(theirEntry, theirStep, pick.entry, pick.step) : 0;
  const warnHtml =
    mismatch > LENGTH_MISMATCH_WARN
      ? `<div class="hint" style="margin:8px 0">⚠️ These laps cover driven distances ${Math.round(mismatch * 100)}% apart — likely a different layout or start/finish line, so the distance alignment may be off.</div>`
      : "";

  // Head to head, from the *unresampled* entries — the same rule the two-lap
  // compare follows, so a resampling artefact never reaches a number.
  const mphFmt = (v) => (v == null ? "—" : fmtSpeedKph(v, currentUnits()));
  const signed = (fmt) => (d) => `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d))}`;
  const mphDelta = signed((d) => fmtSpeedKph(d, currentUnits()));
  const [mT, mM] = [lapMetrics(theirEntry), pick ? lapMetrics(pick.entry) : null];
  const metricRow = (label, fmt, va, vb, deltaFmt) => {
    const d = va != null && vb != null ? deltaFmt(vb - va) : "—";
    return `<tr><td>${label}</td><td class="num">${fmt(va)}</td>${
      pick ? `<td class="num">${fmt(vb)}</td><td class="num">${d}</td>` : ""
    }</tr>`;
  };
  const tableHtml = `<div class="table-wrap"><table>
    <thead><tr><th></th><th class="num">${esc(sideLabels[0])}</th>${
      pick ? `<th class="num">${esc(sideLabels[1])}</th><th class="num">Δ</th>` : ""
    }</tr></thead>
    <tbody>
      ${metricRow("Lap time", fmtMs, mT.timeMs, mM?.timeMs, fmtDelta)}
      ${metricRow("Top speed", mphFmt, mT.topSpeedKph, mM?.topSpeedKph, mphDelta)}
      ${metricRow("Min speed", mphFmt, mT.minSpeedKph, mM?.minSpeedKph, mphDelta)}
      ${metricRow("Avg speed", mphFmt, mT.avgSpeedKph, mM?.avgSpeedKph, mphDelta)}
      ${metricRow("Max lateral G", (v) => (v == null ? "—" : v.toFixed(2)), mT.maxLatG, mM?.maxLatG, signed((d) => d.toFixed(2)))}
      ${metricRow("Full throttle", (v) => (v == null ? "—" : `${v.toFixed(0)}% of lap`), mT.fullThrottlePct, mM?.fullThrottlePct, signed((d) => `${d.toFixed(1)}pp`))}
      ${metricRow("On the brakes", (v) => (v == null ? "—" : `${v.toFixed(0)}% of lap`), mT.brakingPct, mM?.brakingPct, signed((d) => `${d.toFixed(1)}pp`))}
    </tbody></table></div>`;

  const chartsHtml = [
    pick && proOk ? deltaChartSvg(aligned, lit, refIdx, sideLabels[refIdx]) : "",
    ...channelDefs(currentUnits()).flatMap((def) => [
      channelChartSvg(def, aligned, lit),
      def.key === "rpm" && proOk ? gearRibbonSvg(aligned, lit, (i) => sideLabels[i]) : "",
    ]),
  ]
    .filter(Boolean)
    .map((c) => `<div class="ch-chart">${c}</div>`)
    .join("");

  // The picker only exists once there is a choice to make; with one lap of your
  // own it is already the one shown, and a select with a single option is a
  // control that does nothing.
  const pickerHtml =
    mine.length > 1
      ? `<p class="sub"><span class="swatch" style="background:${sideColors[1]}"></span> Your lap:
           <select id="lb-mine">${mine
             .map(
               (r) =>
                 `<option value="${esc(r.key)}" ${r.key === pick.key ? "selected" : ""}>${fmtDate(r.date)} — Lap ${r.lapNum} — ${fmtMs(r.timeMs)}</option>`
             )
             .join("")}</select></p>`
      : "";

  const noneHtml = pick
    ? ""
    : `<div class="hint" style="margin:8px 0">You have no lap with telemetry at this track yet, so there's nothing to overlay. Record with the app or import a session and this page will put the two side by side.</div>`;

  const view = shell(`${headHtml}
    ${pickerHtml}
    ${warnHtml}
    ${noneHtml}
    ${mapHtml}
    <h2>${pick ? "Head to head" : "This lap"}</h2>
    ${tableHtml}
    ${proOk ? sectorTableHtml(aligned, lit, (i) => sideLabels[i]) : ""}
    <div class="chart-card">
      <div class="chart-title">Telemetry — shared driven-distance axis</div>
      ${
        pick && proOk
          ? `<div class="hint" style="margin:2px 0 6px">The delta chart shows where you gain or lose against this lap; the channels below show why.</div>`
          : ""
      }
      <div class="ch-graphs" id="lb-charts">${chartsHtml}</div>
    </div>
    ${
      proOk
        ? ""
        : proPanelHtml(
            "The rest of this lap",
            (pick ? "The delta chart that shows where you gain or lose against this lap, sector splits, and " : "Sector splits, lap-vs-lap deltas against your own laps, and ") +
              "the steering, RPM, lateral G and yaw traces where the recording carries them."
          )
    }
  `);

  if (lap.trace) renderTrackMap(view.querySelector("#lb-trackmap"), lap.trace);
  bindPairTooltip(view.querySelector("#lb-charts"), aligned, { sideColors, sideLabels, delta, refIdx });

  const sel = view.querySelector("#lb-mine");
  if (sel)
    sel.onchange = () => {
      location.hash = `#/track/${trackId}/leaderboard/${lapId}?mine=${encodeURIComponent(sel.value)}`;
    };
}

// --- event detail ---

// Track best as of the previous render, so a re-render after adding laps /
// importing telemetry can tell "new personal best" from "just another save".
let pbWatch = null;

// Event ids whose setup notebook is expanded — collapsed by default, but the
// route() re-render after saving a sheet must not snap it shut mid-session.
const setupNotebookOpen = new Set();
// The channel panel's state per session id (open, tab, lit laps), kept for
// the same reason: the Car tab's actions save through route().
const channelPanelMemory = new Map();
// Which event day's setup sheet the Car tab's pressure loop reads, per
// session id — a session doesn't record its day, so the driver picks.
const healthDayBySession = new Map();

// "Entry $450 · Fuel $120 · Travel & lodging $300" under a cost figure — only
// when there is more than one line item to break down; one item *is* the
// total. `by` is an event (its own line items) or a spendSummary's by_field.
function costBreakdownHtml(by) {
  const parts = COST_FIELDS.filter(([field]) => by?.[field] != null && by[field] > 0).map(
    ([field, label]) => `${label} ${fmtSpend(by[field])}`
  );
  return parts.length > 1 ? `<div class="hint cost-breakdown">${parts.join(" · ")}</div>` : "";
}

async function viewEvent(eventId) {
  const [e, tracks, garage] = await Promise.all([
    api(`/events/${eventId}`),
    api("/tracks"),
    api("/garage").catch(() => []),
  ]);
  const track = tracks.find((t) => t.id === e.track_id);
  const pb =
    pbWatch && track && pbWatch.trackId === track.id
      ? detectPB(pbWatch.best, track?.best_ms, track?.goal_ms)
      : null;
  if (track) pbWatch = { trackId: track.id, best: track.best_ms };

  const sessionsHtml = e.sessions
    .map((s) => {
      const lapsMs = s.laps.map((l) => l.time_ms);
      const best = lapsMs.length ? Math.min(...lapsMs) : null;
      // Imported sessions get their lap list from the channel panel (chips +
      // collapsible graphs); plain sessions render the same chip layout.
      const lapsHtml = s.channels?.laps?.length
        ? `<div data-channel-graphs="${s.id}"></div>`
        : `<div class="laps">${s.laps
            .map(
              (l) =>
                `<span class="lap${l.time_ms === best ? " best" : ""}">Lap ${l.lap_num} · ${fmtMs(l.time_ms)}${l.time_ms === best ? " ★" : ""}</span>`
            )
            .join("")}</div>`;
      // Session analysis from the laps we already have: representative pace,
      // how long it took to get up to speed, and whether pace faded late.
      const stats = [];
      const b3 = bestNAvg(lapsMs, 3);
      if (b3 != null) stats.push(`best 3 avg <span class="t">${fmtMs(b3)}</span>`);
      const warm = warmupLapCount(lapsMs);
      if (warm != null) stats.push(warm === 1 ? "on pace from lap 1" : `up to speed by lap ${warm}`);
      const slope = paceSlope(lapsMs);
      if (slope != null)
        stats.push(
          `pace ${fmtDelta(slope)}/lap${slope > 150 ? " — fading (tires? heat?)" : slope < -150 ? " — still improving" : ""}`
        );
      // Sector analysis (js/sectors.js): what stringing the session's best
      // sectors together would have been worth. The splits themselves are in
      // the channel panel below.
      const sec = pro() && s.channels?.laps?.length ? sessionSectors(s.channels) : null;
      if (sec && sec.laps.length >= 2 && sec.gapMs > 0)
        stats.push(`theoretical best <span class="t">${fmtMs(sec.theoreticalBestMs)}</span>`);
      // Shift points (js/gears.js): the typical upshift rpm across the
      // session; the per-gear breakdown sits in the channel panel.
      const sp = s.channels?.laps?.length ? shiftPoints(s.channels) : null;
      if (sp) stats.push(`upshifts ≈ <span class="t">${fmtRpm(sp.medianRpm)}</span> rpm`);
      // Where the car hit its limit (js/limits.js): ABS / traction / slip,
      // counted as places on track across the session. The marks themselves
      // are on the best-lap trace and shaded on the pedal traces.
      const lim = s.channels?.laps?.length ? limitSummary(s.channels) : null;
      if (lim) stats.push(esc(lim));
      // Balance (js/balance.js): the corners whose rotation sits off this
      // car's typical response, pooled across the session; the per-corner
      // table and the scatter are on the panel's Grip tab.
      const bal = s.channels?.laps?.length ? balanceSummary(s.channels) : null;
      if (bal) stats.push(esc(bal));
      // Car health (js/health.js): any slow reading past its watch line, and
      // the fuel outlook; the strip itself is the panel's Car tab.
      const car = s.channels?.laps?.length ? healthSummary(s.channels, usUnits()) : null;
      if (car) stats.push(esc(car));
      return `<div class="session">
        <div class="s-head">
          <span class="s-label">${esc(s.label || "Session")}</span>
          <span class="s-best">${best != null ? `best <span class="t">${fmtMs(best)}</span> · ${s.laps.length} lap${s.laps.length === 1 ? "" : "s"}` : "no laps"}</span>
          ${conditionsChipHtml(s, usUnits())}
          <span class="grow"></span>
          <button class="btn small danger" data-del-session="${s.id}">Delete</button>
        </div>
        ${stats.length ? `<div class="s-stats">${stats.join(" · ")}</div>` : ""}
        ${s.notes ? `<div class="notes-block">${esc(s.notes)}</div>` : ""}
        ${lapsHtml}
        <div class="btn-row" style="margin-top:16px">
          <input class="add-laps-input" data-add-laps-input="${s.id}" placeholder="Add laps: 2:01.24, 2:03.1 …">
          <button class="btn small" data-add-laps="${s.id}">Add</button>
        </div>
      </div>`;
    })
    .join("");

  // Best-lap trace card: among imported sessions that stored a GPS trace,
  // show the racing line of the one holding the fastest lap.
  const traced = e.sessions.filter((s) => s.trace && s.trace.length >= 10 && s.laps.length);
  const traceSession = traced.length
    ? traced.reduce((a, b) =>
        Math.min(...b.laps.map((l) => l.time_ms)) < Math.min(...a.laps.map((l) => l.time_ms)) ? b : a
      )
    : null;
  // Limit markers for the map (#188): the trace is the best lap only, so the
  // marks come from the best lap's channel entry and the legend says so.
  let traceMarkers = [];
  // The channel lap the trace *is* — the friction circle's hover can only be
  // placed on the line for that one lap (#186), same reason the marks are.
  let traceBestChIdx = null;
  if (traceSession?.channels?.laps?.length) {
    const matched = matchLapsToChannels(traceSession.laps, traceSession.channels.laps).filter((r) => r.chIdx >= 0);
    const bestRow = matched.length ? matched.reduce((a, b) => (b.lap.time_ms < a.lap.time_ms ? b : a)) : null;
    if (bestRow) {
      traceBestChIdx = bestRow.chIdx;
      traceMarkers = limitMarkers(traceSession.channels.laps[bestRow.chIdx], traceSession.channels.dStepM, traceSession.trace);
    }
  }
  const markerKinds = LIMIT_KINDS.filter((k) => traceMarkers.some((m) => m.kind === k.key));
  const traceHtml = traceSession
    ? `<div class="chart-card">
        <div class="chart-title">Best lap trace — <span class="dir">brighter is faster</span>
          <span class="trackmap-lap">${fmtMs(Math.min(...traceSession.laps.map((l) => l.time_ms)))}</span></div>
        <div class="trackmap-wrap"><canvas id="trackmap" role="img" aria-label="Racing line of the best lap, colored by speed${markerKinds.length ? `, marked where ${markerKinds.map((k) => k.label).join(", ")} were active` : ""}"></canvas></div>
        <div class="trackmap-legend"><span>slow</span><span class="ramp" aria-hidden="true"></span><span>fast</span></div>
        ${
          markerKinds.length
            ? `<div class="trackmap-legend limit-legend"><span>at the limit on this lap:</span>${markerKinds
                .map((k) => `<span class="lk">${limitGlyphSvg(k)}${esc(k.label)}</span>`)
                .join("")}</div>`
            : ""
        }
      </div>`
    : "";

  // Setup notebook: one sheet per event day. Sheets copy forward — the form
  // prefills from the previous day (or this car's last event) so only the
  // changes need typing.
  const partsById = garagePartsById(garage);
  const vehicleParts = e.vehicle_id
    ? garage.find((v) => String(v.id) === String(e.vehicle_id))?.parts ?? []
    : [];
  const setupsByDay = new Map((e.setups ?? []).map((s) => [s.day, s.data]));
  const setupDays = [...Array(Math.max(1, Math.ceil(e.days))).keys()].map((i) => i + 1);
  for (const s of e.setups ?? []) if (!setupDays.includes(s.day)) setupDays.push(s.day);
  const prevSheetFor = (day) => {
    for (let d = day - 1; d >= 1; d--) if (setupsByDay.has(d)) return setupsByDay.get(d);
    return null;
  };
  const setupDayHtml = (day) => {
    const sheet = setupsByDay.get(day);
    return `<div class="session setup-day">
      <div class="s-head">
        <span class="s-label">Day ${day}</span>
        <span class="s-best">${setupDays.length > 1 || sheet ? fmtDate(eventDayISO(e.start_date, day)) : ""}</span>
        <span class="grow"></span>
        ${
          sheet
            ? `<button class="btn small" data-setup-edit="${day}">Edit</button>`
            : `<button class="btn small" data-setup-log="${day}">Log setup</button>`
        }
      </div>
      <div data-setup-body="${day}">${
        sheet
          ? setupSheetHtml(sheet, prevSheetFor(day), partsById)
          : `<div class="hint">No setup sheet yet — pressures, alignment, dampers and which consumables were on the car.</div>`
      }</div>
    </div>`;
  };
  const sheetCount = e.setups?.length ?? 0;
  const setupsAllowed = canUseSetups(state.entitlement);
  const setupNotebookHtml = `
    <details class="setup-notebook" id="setup-notebook"${setupNotebookOpen.has(e.id) ? " open" : ""}>
      <summary>
        <h2>Setup notebook</h2>
        <span class="ga-count">${
          !setupsAllowed
            ? "Pro"
            : sheetCount
              ? `${sheetCount} day sheet${sheetCount === 1 ? "" : "s"}`
              : "pressures, alignment, dampers…"
        }</span>
        <span class="ga-caret" aria-hidden="true">▸</span>
      </summary>
      ${
        !setupsAllowed
          ? proPanelHtml(
              "Setup notebook",
              "One sheet per event day — pressures, alignment, dampers and which consumables " +
                "were on the car — copied forward from the last one so only the changes need typing, " +
                "and diffed against your lap times on the track page."
            )
          : ""
      }
      ${setupsAllowed && sheetCount && setupDays.length > 1 ? `<div class="hint" style="margin:0 0 4px">Values <span class="sv changed">highlighted</span> changed from the previous day.</div>` : ""}
      ${setupsAllowed ? setupDays.map(setupDayHtml).join("") : ""}
      ${
        setupsAllowed && !e.vehicle_id && garage.length
          ? `<div class="hint" style="margin:6px 0 0">Tip: set this event's Car to one of your garage vehicles and setups will carry over between its events.</div>`
          : ""
      }
    </details>`;

  const upcoming = isUpcoming(e);
  const checklist = e.checklist;
  const showChecklist = upcoming || checklist != null;
  const checklistHtml = !showChecklist
    ? ""
    : `<h2>Prep checklist</h2>
      <div class="panel" id="checklist-panel">
        ${(checklist ?? [])
          .map(
            (it, i) => `<label class="check-item${it.done ? " done" : ""}">
              <input type="checkbox" data-check-toggle="${i}" ${it.done ? "checked" : ""}>
              <span>${esc(it.text)}</span>
              <button type="button" class="x" data-check-del="${i}" title="Remove">✕</button>
            </label>`
          )
          .join("")}
        <div class="btn-row" style="margin-top:${checklist?.length ? 12 : 0}px">
          <input id="check-new" placeholder="Add item…" maxlength="200">
          <button class="btn small" id="check-add">Add</button>
          ${!checklist?.length ? `<button class="btn small" id="check-default">Use ${state.me?.checklist_template ? "my" : "default"} list</button>` : ""}
        </div>
      </div>`;

  const pbBanner = pb
    ? `<div class="pb-banner" id="pb-banner">
        <span class="pb-trophy" aria-hidden="true">🏆</span>
        <span class="pb-kicker">New personal best${pb.goalBeaten ? " · goal beaten" : ""}</span>
        <span class="pb-time">${fmtMs(pb.ms)}</span>
        <span class="pb-sub"><b>${fmtDelta(pb.delta).replace("+", "")}</b> faster than your previous best at ${esc(e.track_name)}${pb.goalBeaten ? ` — and under your <b>${fmtMs(track.goal_ms)}</b> goal` : ""}.</span>
        <div class="btn-row">
          <a class="btn small primary" href="#/track/${e.track_id}">${pb.goalBeaten ? "Set a new goal" : "See your progress"}</a>
          <button class="btn small ghost" id="pb-dismiss">Dismiss</button>
        </div>
      </div>`
    : "";

  const carHtml = e.car
    ? e.vehicle_id
      ? `<a href="#/vehicle/${e.vehicle_id}">${esc(e.car)}</a>`
      : esc(e.car)
    : "";
  const view = shell(`
    <h1>${esc(e.track_name)} — ${fmtDate(e.start_date)}</h1>
    <p class="sub">${[esc([e.club, e.run_group].filter(Boolean).join(" · ") || ""), carHtml, fmtConditions(e)]
      .filter(Boolean)
      .join(" · ")}</p>
    ${pbBanner}
    ${upcoming ? `<div class="panel countdown-banner"><strong>${fmtCountdown(e.start_date)}</strong> — log sessions here once you're back from the track.</div>` : ""}
    <div class="tiles">
      <div class="tile"><div class="label">Best time</div><div class="value">${fmtMs(e.best_ms)}</div></div>
      <div class="tile"><div class="label">Days</div><div class="value">${e.days}</div></div>
      <div class="tile"><div class="label">Laps recorded</div><div class="value">${e.lap_count}</div></div>
      <div class="tile"><div class="label">Consistency</div><div class="value">${fmtConsistency(e.consistency)}</div></div>
      ${e.cost_cents != null ? `<div class="tile"><div class="label">Cost</div><div class="value">${fmtSpend(e.cost_cents)}</div></div>` : ""}
    </div>
    ${costBreakdownHtml(e)}
    ${e.notes ? `<div class="panel notes-block">${esc(e.notes)}</div>` : ""}
    <div class="btn-row">
      <a class="btn" href="#/event/${e.id}/edit">Edit event</a>
      <button class="btn danger" id="del-event">Delete event</button>
    </div>
    ${setupNotebookHtml}
    ${checklistHtml}
    ${traceHtml}
    <h2>Sessions</h2>
    ${sessionsHtml || `<div class="empty">No sessions recorded yet.</div>`}
    <h2>Add a session</h2>
    <div class="hint" style="margin:-4px 0 10px">Pull the laps out of a video or logger file, or type them in by hand.</div>
    <div class="pdr-dropzone" id="pdr-dropzone">
      <input type="file" id="pdr-files" accept="video/mp4,.mp4,.vbo" multiple hidden>
      <div class="pdr-dropzone-inner">
        <span class="pdr-dropzone-icon">📼</span>
        <div>
          <button class="btn" id="pdr-import" type="button">Import video / telemetry…</button>
          <span class="pdr-dropzone-hint">or drag &amp; drop <code>.mp4</code> / <code>.vbo</code> files here</span>
        </div>
        <span class="hint" style="font-size:12px;color:var(--text-muted)">Reads lap times from Corvette PDR &amp; GoPro video and Racelogic VBO telemetry — files never leave your computer</span>
      </div>
    </div>
    ${
      canViewChannels(state.entitlement)
        ? ""
        : proNoteHtml(
            "Importing is free — you get the lap times, the racing line, top speed, RPM and lateral G, and the " +
              "per-lap speed, throttle and brake traces. " + PRO_CHANNELS_NOTE
          )
    }
    <div id="pdr-review"></div>
    <form class="panel" id="add-session">
      <div class="add-session-head">Or enter lap times by hand</div>
      <div class="form-grid">
        <div class="field"><label>Session label</label><input name="label" placeholder="Day 1 — Session 2"></div>
      </div>
      <div class="field"><label>Lap times (comma / space / newline separated)</label>
        <textarea name="laps" placeholder="2:03.55&#10;2:01.24&#10;2:02.61"></textarea>
        <div class="hint">Formats: 2:01.24 · 2:01 · 121.24 (seconds)</div>
      </div>
      <div class="field"><label>Session notes</label><input name="notes" placeholder="Traffic, tire pressures, line changes…"></div>
      <button class="btn primary">Add session</button>
    </form>
  `);

  const trackMap = traceSession
    ? renderTrackMap(view.querySelector("#trackmap"), traceSession.trace, {
        markers: traceMarkers.map((m) => ({ idx: m.idx, ...kindDef(m.kind) })),
      })
    : null;

  if (pb) {
    const banner = view.querySelector("#pb-banner");
    view.querySelector("#pb-dismiss").onclick = () => banner.remove();
    const r = banner.getBoundingClientRect();
    confettiBurst(r.left + r.width / 2, r.top + 40);
  }

  view.querySelector("#del-event").onclick = async () => {
    if (!confirm("Delete this event and all its sessions/laps?")) return;
    await api(`/events/${e.id}`, { method: "DELETE" });
    location.hash = "#/";
  };

  if (showChecklist) {
    const items = checklist ?? [];
    const saveChecklist = async (next) => {
      await api(`/events/${e.id}`, { method: "PUT", body: { checklist: next.length ? next : null } });
      route();
    };
    view.querySelectorAll("[data-check-toggle]").forEach((box) => {
      box.onchange = () => {
        const next = items.map((it, i) => (i === Number(box.dataset.checkToggle) ? { ...it, done: box.checked } : it));
        saveChecklist(next);
      };
    });
    view.querySelectorAll("[data-check-del]").forEach((btn) => {
      btn.onclick = () => saveChecklist(items.filter((_, i) => i !== Number(btn.dataset.checkDel)));
    });
    const newInput = view.querySelector("#check-new");
    view.querySelector("#check-add").onclick = () => {
      const text = newInput.value.trim();
      if (!text) return;
      saveChecklist([...items, { text, done: false }]);
    };
    newInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        view.querySelector("#check-add").click();
      }
    });
    const useDefault = view.querySelector("#check-default");
    if (useDefault)
      useDefault.onclick = () => saveChecklist(checklistTemplate().map((text) => ({ text, done: false })));
  }
  const notebook = view.querySelector("#setup-notebook");
  notebook.addEventListener("toggle", () => {
    if (notebook.open) setupNotebookOpen.add(e.id);
    else setupNotebookOpen.delete(e.id);
  });

  // Setup notebook: swap a day's display for the form on Edit / Log setup;
  // Log setup prefills from the previous sheet (copy-forward) so only the
  // changes need typing.
  const openSetupForm = (day, sheet, existing, prefilled) => {
    const body = view.querySelector(`[data-setup-body="${day}"]`);
    body.innerHTML = `${
      prefilled
        ? `<div class="hint" style="margin:0 0 8px">Pre-filled from your last sheet — adjust what changed.</div>`
        : ""
    }${setupFormHtml(day, sheet, vehicleParts, existing)}`;
    const form = body.querySelector(`[data-setup-form="${day}"]`);
    const msg = body.querySelector(`[data-setup-msg="${day}"]`);
    form.onsubmit = async (evt) => {
      evt.preventDefault();
      const data = readSetupForm(form);
      if (!Object.keys(data).length) {
        msg.textContent = "Nothing filled in yet.";
        return;
      }
      try {
        await api(`/events/${e.id}/setups/${day}`, { method: "PUT", body: data });
        route();
      } catch (err) {
        msg.textContent = err.message;
      }
    };
    body.querySelector(`[data-setup-cancel="${day}"]`).onclick = () => route();
    const del = body.querySelector(`[data-setup-del="${day}"]`);
    if (del)
      del.onclick = async () => {
        if (!confirm(`Delete the day ${day} setup sheet?`)) return;
        await api(`/events/${e.id}/setups/${day}`, { method: "DELETE" });
        route();
      };
  };
  view.querySelectorAll("[data-setup-edit]").forEach((btn) => {
    btn.onclick = () => openSetupForm(Number(btn.dataset.setupEdit), setupsByDay.get(Number(btn.dataset.setupEdit)), true, false);
  });
  view.querySelectorAll("[data-setup-log]").forEach((btn) => {
    btn.onclick = async () => {
      const day = Number(btn.dataset.setupLog);
      let prefill = null;
      try {
        prefill = (await api(`/events/${e.id}/setups/prefill?day=${day}`)).data;
      } catch {
        // Offline or older server — start from a blank sheet.
      }
      openSetupForm(day, prefill, false, prefill != null);
    };
  });

  view.querySelector("#add-session").onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    const laps = parseLapList(f.laps.value);
    await api(`/events/${e.id}/sessions`, {
      method: "POST",
      body: { label: f.label.value.trim() || null, notes: f.notes.value.trim() || null, laps },
    });
    route();
  };
  // The channel panel owns the lap list for imported sessions; the graphs
  // inside it render lazily on first expand.
  view.querySelectorAll("[data-channel-graphs]").forEach((el) => {
    const s = e.sessions.find((x) => String(x.id) === el.dataset.channelGraphs);
    if (!s) return;
    // The Car tab's pressure loop (#190, web-only — it needs the setup
    // notebook): the sheet's cold pressures against the import's hot ones and
    // the vehicle's target. A session doesn't know its day, so the sheet
    // defaults to the last day with cold pressures logged and the driver can
    // pick another; the loop's context is rebuilt on every panel render.
    const vehicle = e.vehicle_id ? garage.find((v) => String(v.id) === String(e.vehicle_id)) ?? null : null;
    const defaultHealthDay = () => {
      const withCold = setupDays.filter((d) => setupsByDay.get(d)?.tp_cold);
      if (withCold.length) return withCold[withCold.length - 1];
      const withSheet = setupDays.filter((d) => setupsByDay.has(d));
      return withSheet.length ? withSheet[withSheet.length - 1] : 1;
    };
    const loopContext = () => {
      const day = healthDayBySession.get(s.id) ?? defaultHealthDay();
      const sheet = setupsByDay.get(day) ?? null;
      const loop = pressureLoop(s.channels, sheet, vehicle?.target_hot_psi ?? null);
      const nextDay = setupDays.includes(day + 1) ? day + 1 : null;
      return {
        loop,
        day,
        days: setupDays,
        sheet,
        vehicle: vehicle ? { id: vehicle.id, name: vehicle.name, target_hot_psi: vehicle.target_hot_psi ?? null } : null,
        nextDay,
        nextHasSheet: nextDay != null && setupsByDay.has(nextDay),
        noteLine: nextTimeNote(loop),
      };
    };
    if (!channelPanelMemory.has(s.id)) channelPanelMemory.set(s.id, {});
    const panel = bindChannelGraphs(el, s.channels, s.laps, {
      // Sector splits + theoretical best for the highlighted laps on the
      // Time tab, the session's shift points on Inputs, on Grip the
      // friction circle (#186) — a square scatter, so it gets its own
      // container rather than a slot on the distance axis — followed by the
      // balance scatter and per-corner table (#189), above the lateral-G and
      // yaw traces, and on Car the health strip (#190): the per-lap scalars
      // as small multiples, the tyre spread, the pressure loop and the
      // per-lap table.
      renderExtras: (lit, dispN) => ({
        time: sectorTableHtml(s.channels, lit, (chIdx) => `Lap ${dispN[chIdx]}`),
        inputs: shiftTableHtml(s.channels),
        grip:
          gripCircleHtml(s.channels, lit, (chIdx) => `Lap ${dispN[chIdx]}`) +
          balanceHtml(s.channels, lit, (chIdx) => `Lap ${dispN[chIdx]}`),
        car: healthHtml(s.channels, lit, (chIdx) => `Lap ${dispN[chIdx]}`, {
          units: usUnits(),
          loopHtml: setupsAllowed ? pressureLoopHtml(loopContext(), (chIdx) => `Lap ${dispN[chIdx]}`) : "",
        }),
      }),
      // The gear ribbon rides under the RPM trace (#187), where each shift
      // is the drop in the sawtooth above it.
      renderAfter: { rpm: (lit, dispN) => gearRibbonSvg(s.channels, lit, (chIdx) => `Lap ${dispN[chIdx]}`) },
      memory: channelPanelMemory.get(s.id),
      // A free account's channels arrive as speed, throttle and brake only
      // (#264); the panel skips the delta chart and the extras above, and
      // says what the rest of the file would show.
      pro: pro(),
      lockedHtml: pro() ? "" : proNoteHtml(PRO_CHANNELS_NOTE),
    });
    // The loop's actions, delegated from the panel container because the
    // Car tab re-renders with every chip toggle. Saves go through route() —
    // the notebook shows the sheet too — and the panel memory above brings
    // the driver back to the Car tab afterwards.
    el.addEventListener("change", (evt) => {
      const sel = evt.target.closest?.("[data-health-day]");
      if (!sel) return;
      healthDayBySession.set(s.id, Number(sel.value));
      panel.rerender();
    });
    el.addEventListener("submit", async (evt) => {
      const form = evt.target.closest?.("[data-health-target]");
      if (!form) return;
      evt.preventDefault();
      const raw = form.target.value.trim();
      const target = raw === "" ? null : Number(raw);
      if (target != null && !Number.isFinite(target)) return;
      try {
        await api(`/vehicles/${form.dataset.healthTarget}`, { method: "PUT", body: { target_hot_psi: target } });
        route();
      } catch (err) {
        showError(err);
      }
    });
    el.addEventListener("click", async (evt) => {
      const record = evt.target.closest?.("[data-health-record]");
      const next = evt.target.closest?.("[data-health-next]");
      if (!record && !next) return;
      const ctx = loopContext();
      if (!ctx.loop) return;
      if (record) {
        // Hot pressures onto the day's sheet, plus the "next time" line in
        // its notes when there is a suggestion — notes copy forward, so the
        // suggestion is in the next sheet's form before it is typed.
        const base = ctx.sheet ?? {};
        const data = { ...base, tp_hot: { ...(base.tp_hot ?? {}), ...ctx.loop.hotSheet } };
        if (ctx.noteLine && !base.notes?.includes(ctx.noteLine))
          data.notes = base.notes ? `${base.notes}\n${ctx.noteLine}` : ctx.noteLine;
        try {
          await api(`/events/${e.id}/setups/${ctx.day}`, { method: "PUT", body: data });
          route();
        } catch (err) {
          showError(err);
        }
        return;
      }
      // Open the next day's sheet with the suggested colds in place of the
      // day's: a new sheet copies this one forward (minus its hots, which
      // belong to today), an existing one keeps everything else it has.
      const day = Number(next.dataset.healthNext);
      const existing = setupsByDay.get(day) ?? null;
      let carried = existing;
      if (!carried) {
        const { tp_hot: _todaysHots, ...rest } = ctx.sheet ?? {};
        carried = rest;
      }
      notebook.open = true;
      openSetupForm(day, { ...carried, tp_cold: ctx.loop.coldSheet }, existing != null, true);
      view.querySelector(`[data-setup-body="${day}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // Hovering a point on the friction circle or the balance scatter answers
    // "which corner": the distance is marked on every chart that has a
    // distance axis, and — when this session owns the best-lap trace and the
    // hovered lap is the one the trace was drawn from — the place is ringed
    // on the map. A row of the balance table is a corner every lap shares
    // (chIdx null), so it rings the map whichever lap the trace is.
    const onHover = (hit) => {
      showDistanceMark(el, hit?.d ?? null);
      if (!trackMap || traceSession.id !== s.id) return;
      trackMap.setHighlight(
        hit && (hit.chIdx == null || hit.chIdx === traceBestChIdx) ? traceIndexAtFraction(traceSession.trace, hit.frac) : null
      );
    };
    bindGripCircle(el, s.channels, { onHover });
    bindBalance(el, s.channels, { onHover });
  });

  view.querySelectorAll("[data-del-session]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this session and its laps?")) return;
      await api(`/sessions/${btn.dataset.delSession}`, { method: "DELETE" });
      route();
    };
  });
  view.querySelectorAll("[data-add-laps]").forEach((btn) => {
    btn.onclick = async () => {
      const input = view.querySelector(`[data-add-laps-input="${btn.dataset.addLaps}"]`);
      const laps = parseLapList(input.value);
      if (!laps.length) return;
      await api(`/sessions/${btn.dataset.addLaps}/laps`, { method: "POST", body: { laps } });
      route();
    };
  });

  bindTelemetryImport(view, e, route);
}

// --- event form (new / edit) ---

// Custom combobox for the track and car fields. A native <datalist> would be
// simpler, but iOS Safari never shows datalist suggestions and Android only
// surfaces a few after typing — so we render our own tappable option list.
//
// `opts.search(query)` replaces the default substring filter with a ranked
// list of labels (the catalog picker's matchCatalogCars), and `opts.onPick`
// hears which label was chosen — by tap or Enter — for fields where a pick
// means more than the text it leaves in the input.
function bindCombo(input, list, options, opts = {}) {
  let matches = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  const setActive = (i) => {
    active = i;
    list.querySelectorAll(".combo-item").forEach((el, j) => el.classList.toggle("active", j === i));
    if (i >= 0) list.children[i].scrollIntoView({ block: "nearest" });
  };

  const pick = (i) => {
    input.value = matches[i];
    close();
    opts.onPick?.(matches[i]);
  };

  const open = () => {
    const q = input.value.trim().toLowerCase();
    matches = opts.search ? opts.search(q) : q ? options.filter((n) => n.toLowerCase().includes(q)) : options;
    if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === q)) return close();
    list.innerHTML = matches.map((n, i) => `<div class="combo-item" role="option" data-i="${i}">${esc(n)}</div>`).join("");
    list.hidden = false;
    list.scrollTop = 0;
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  input.addEventListener("focus", open);
  input.addEventListener("input", open);
  input.addEventListener("keydown", (e) => {
    if (list.hidden) {
      if (e.key === "ArrowDown") { open(); e.preventDefault(); }
      return;
    }
    if (e.key === "ArrowDown") { setActive(Math.min(active + 1, matches.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setActive(Math.max(active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { pick(active); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  // pointerdown (not click) so selection wins the race against the input's blur,
  // and preventDefault keeps focus in the field after tapping an option.
  list.addEventListener("pointerdown", (e) => {
    const item = e.target.closest(".combo-item");
    if (!item) return;
    e.preventDefault();
    pick(Number(item.dataset.i));
  });
  input.addEventListener("blur", close);
}

// --- car catalog picker (#222) ---

// The markup for a catalog field: one searchable combobox over
// GET /api/car-catalog, in place of year → make → model dropdowns. The label
// says what a pick *does*, because that is the only reason to pick rather than
// type, and a driver who never opens the Grip tab can skip it with a clear
// conscience.
function catalogFieldHtml(id, pick, { hint = true } = {}) {
  return `<div class="field"><label>Find your car in the catalog (optional)</label>
    <div class="combo">
      <input name="catalog" autocomplete="off" role="combobox" aria-expanded="false"
        aria-autocomplete="list" aria-controls="${id}" value="${esc(pick ? catalogCarLabel(pick) : "")}"
        placeholder="Corvette C7, MX-5 ND, 718 Cayman…">
      <div class="combo-list" id="${id}" role="listbox" hidden></div>
    </div>
    ${hint ? `<div class="hint">Picking a car fills in the wheelbase and steering ratio the balance read-out uses — nothing else changes, and a car the catalog doesn't know is just typed in.</div>` : ""}
  </div>`;
}

// Wire a catalog field. `onPick(row)` fires for a chosen row and `onClear()`
// when the field is emptied; typing over a pick without choosing another puts
// the pick's label back on blur, so the field always shows what is picked.
function bindCatalogPicker(input, list, rows, { onPick, onClear, initial = null }) {
  let pick = initial;
  const byLabel = new Map(rows.map((r) => [catalogCarLabel(r), r]));
  bindCombo(input, list, [], {
    search: (q) => matchCatalogCars(q, rows).slice(0, 12).map(catalogCarLabel),
    onPick: (label) => {
      pick = byLabel.get(label) ?? null;
      if (pick) onPick(pick);
    },
  });
  input.addEventListener("input", () => {
    if (input.value.trim() === "" && pick) {
      pick = null;
      onClear();
    }
  });
  input.addEventListener("blur", () => {
    if (pick && input.value !== catalogCarLabel(pick)) input.value = catalogCarLabel(pick);
  });
}

const GEOMETRY_LABELS = { wheelbase_mm: "wheelbase", steering_ratio: "steering ratio" };
const fmtGeometry = (field, v) => (field === "wheelbase_mm" ? `${v} mm` : `${v}:1`);

async function viewEventForm(eventId, presetTrack) {
  const [tracks, catalog, vehicles] = await Promise.all([
    api("/tracks"),
    api("/catalog"),
    api("/vehicles"),
  ]);
  const existing = eventId ? await api(`/events/${eventId}`) : null;
  const units = currentUnits();
  const tempSpec = tempInputSpec(units);
  // The user's own tracks first, then the rest of the seeded track catalog.
  const ownNames = tracks.map((t) => t.name);
  const seen = new Set(ownNames.map((n) => n.toLowerCase()));
  const trackOpts = [...ownNames, ...catalog.map((t) => t.name).filter((n) => !seen.has(n.toLowerCase()))];
  // New events start with the garage's default vehicle in the car field.
  const defaultCar = vehicles.find((v) => v.is_default)?.name ?? "";

  const view = shell(`
    <h1>${existing ? "Edit event" : "New event"}</h1>
    <form class="panel" id="event-form">
      <div class="form-grid">
        <div class="field"><label>Track</label>
          <div class="combo">
            <input name="track" required autocomplete="off" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="track-combo-list"
              value="${esc(existing?.track_name ?? presetTrack ?? "")}" placeholder="Virginia International Raceway (Full)">
            <div class="combo-list" id="track-combo-list" role="listbox" hidden></div>
          </div>
          <div class="hint">Pick from your tracks and known US tracks, or type a new name — layouts time differently, so name them separately ("Virginia International Raceway (Full)" vs "(Patriot)") to keep PBs honest</div>
        </div>
        <div class="field"><label>Start date</label>
          <input name="start_date" type="date" required value="${esc(existing?.start_date ?? new Date().toISOString().slice(0, 10))}">
        </div>
        <div class="field"><label>Days</label>
          <input name="days" type="number" min="0.5" step="0.5" value="${existing?.days ?? 2}">
        </div>
        <div class="field"><label>On-track hours (optional)</label>
          <input name="track_hours" type="number" min="0.5" max="200" step="0.5" value="${existing?.track_hours ?? ""}" placeholder="est. 2h per day">
          <div class="hint">Seat time for consumable wear tracking — leave blank for the 2h-per-day estimate</div>
        </div>
        <div class="field"><label>Club / organizer</label>
          <input name="club" value="${esc(existing?.club ?? "")}" placeholder="VIR Club">
        </div>
        <div class="field"><label>Run group</label>
          <input name="run_group" value="${esc(existing?.run_group ?? "")}" placeholder="High Speed">
        </div>
        <div class="field"><label>Car</label>
          <div class="combo">
            <input name="car" autocomplete="off" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="car-combo-list"
              value="${esc(existing ? (existing.car ?? "") : defaultCar)}" placeholder="Corvette Z06, Miata, GT3…">
            <div class="combo-list" id="car-combo-list" role="listbox" hidden></div>
          </div>
          <div class="hint">Pick from your garage or type anything — manage cars in the <a href="#/garage">Garage</a></div>
        </div>
        <div class="field"><label>Conditions</label>
          <select name="conditions">
            <option value="">—</option>
            ${CONDITIONS.map(([v, l]) => `<option value="${v}"${existing?.conditions === v ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Temp ${tempUnit(units)} (optional)</label>
          <input name="temp_f" type="number" min="${tempSpec.min}" max="${tempSpec.max}" step="1" value="${tempToDisplay(existing?.temp_f, units) ?? ""}" placeholder="${tempSpec.placeholder}">
        </div>
        <div class="field"><label>Best time (optional)</label>
          <input name="best_time" value="${existing?.best_time_ms != null ? fmtMs(existing.best_time_ms) : ""}" placeholder="2:01.24">
          <div class="hint">Only needed when you don't log laps — logged laps compute this automatically</div>
        </div>
      </div>
      <div class="field"><label>Notes</label>
        <textarea name="notes" placeholder="Weather, setup changes, incidents…">${esc(existing?.notes ?? "")}</textarea>
      </div>
      <div class="add-session-head">What it cost (optional)</div>
      <div class="form-grid">
        ${COST_FIELDS.map(
          ([field, label, placeholder]) => `<div class="field"><label>${label} ($)</label>
          <input name="${field}" type="number" min="0" max="100000" step="0.01" inputmode="decimal" value="${centsToDollars(existing?.[field])}" placeholder="${esc(placeholder)}"></div>`
        ).join("")}
      </div>
      <div class="field"><div class="hint">Rolled up per track, per car and in Year in review — where it prices the seconds you found. Private: never on your share page.</div></div>
    </form>
    ${
      existing
        ? ""
        : `<h2>Add laps</h2>
    <div class="hint" style="margin:-4px 0 10px">Optional — pull the laps out of a video or logger file, or type them in, and they're saved with the event. You can always add more from the event page.</div>
    <div class="pdr-dropzone" id="pdr-dropzone">
      <input type="file" id="pdr-files" accept="video/mp4,.mp4,.vbo" multiple hidden>
      <div class="pdr-dropzone-inner">
        <span class="pdr-dropzone-icon">📼</span>
        <div>
          <button class="btn" id="pdr-import" type="button">Import video / telemetry…</button>
          <span class="pdr-dropzone-hint">or drag &amp; drop <code>.mp4</code> / <code>.vbo</code> files here</span>
        </div>
        <span class="hint" style="font-size:12px;color:var(--text-muted)">Reads lap times from Corvette PDR &amp; GoPro video and Racelogic VBO telemetry — files never leave your computer</span>
      </div>
    </div>
    ${
      canViewChannels(state.entitlement)
        ? ""
        : proNoteHtml(
            "Importing is free — you get the lap times, the racing line and top speed, RPM and lateral G. " +
              "The per-lap speed, throttle, brake and steering traces in the same file, with sector splits and " +
              "lap-vs-lap deltas, need a subscription."
          )
    }
    <div id="pdr-review"></div>
    <div class="staged-sessions" id="staged-sessions" hidden></div>
    <div class="panel" id="hand-session">
      <div class="add-session-head">Or enter lap times by hand</div>
      <div class="form-grid">
        <div class="field"><label>Session label</label><input id="session-label" placeholder="Day 1 — Session 2"></div>
      </div>
      <div class="field"><label>Lap times (comma / space / newline separated)</label>
        <textarea id="session-laps" placeholder="2:03.55&#10;2:01.24&#10;2:02.61"></textarea>
        <div class="hint">Formats: 2:01.24 · 2:01 · 121.24 (seconds)</div>
      </div>
      <div class="field"><label>Session notes</label><input id="session-notes" placeholder="Traffic, tire pressures, line changes…"></div>
    </div>`
    }
    <div id="form-error"></div>
    <div class="btn-row">
      <button class="btn primary" form="event-form" id="event-submit">${existing ? "Save changes" : "Create event"}</button>
      <a class="btn" href="${existing ? `#/event/${existing.id}` : "#/"}">Cancel</a>
    </div>
  `);

  // The "Add laps" section (new events only): the import review hands back
  // session bodies, which are held here until the event exists, and the
  // hand-entry fields are read at submit. The section sits *outside* the
  // <form> — the review panel has its own buttons — and the submit button
  // reaches the form through its `form` attribute.
  const staged = [];
  // The event the sessions were created for, once it exists: a session post
  // that fails must be retried against this id, never by creating the event
  // a second time.
  let createdId = null;
  const renderStaged = () => {
    const list = view.querySelector("#staged-sessions");
    list.hidden = !staged.length;
    list.innerHTML = staged
      .map(
        (s, i) => `<div class="staged-session">
          <span class="staged-label">${esc(s.label)}</span>
          <span class="staged-meta">${esc(stagedSummary(s))}</span>
          <button class="btn small" type="button" data-unstage="${i}" aria-label="Remove ${esc(s.label)}">Remove</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("[data-unstage]").forEach((btn) => {
      btn.onclick = () => {
        staged.splice(Number(btn.dataset.unstage), 1);
        renderStaged();
      };
    });
  };
  if (!existing) {
    // The review's date warning reads the event's dates; on the form they
    // are whatever is typed right now.
    const pendingEvent = {
      get start_date() {
        return view.querySelector('[name="start_date"]').value;
      },
      get days() {
        return Number(view.querySelector('[name="days"]').value) || 1;
      },
    };
    bindTelemetryImport(view, pendingEvent, () => {}, {
      confirmLabel: "Add to this event",
      onSessions: (bodies) => {
        staged.push(...bodies);
        renderStaged();
      },
    });
  }

  bindCombo(view.querySelector('[name="track"]'), view.querySelector("#track-combo-list"), trackOpts);
  bindCombo(view.querySelector('[name="car"]'), view.querySelector("#car-combo-list"), vehicles.map((v) => v.name));

  view.querySelector("#event-form").onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    const bestRaw = f.best_time.value.trim();
    const best = bestRaw ? parseTime(bestRaw) : null;
    if (bestRaw && best == null) {
      view.querySelector("#form-error").innerHTML = `<div class="error-banner">Couldn't parse best time "${esc(bestRaw)}" — use 2:01.24 format.</div>`;
      return;
    }
    const tempRaw = f.temp_f.value.trim();
    const hoursRaw = f.track_hours.value.trim();
    const body = {
      track_name: f.track.value.trim(),
      start_date: f.start_date.value,
      days: Number(f.days.value) || 1,
      track_hours: hoursRaw === "" ? null : Number(hoursRaw),
      club: f.club.value.trim() || null,
      run_group: f.run_group.value.trim() || null,
      car: f.car.value.trim() || null,
      conditions: f.conditions.value || null,
      // Entered in the user's system, stored in °F.
      temp_f: tempRaw === "" ? null : tempToStored(Number(tempRaw), units),
      notes: f.notes.value.trim() || null,
      best_time_ms: best,
      // Typed in dollars, stored in cents; blank clears (#147).
      ...Object.fromEntries(COST_FIELDS.map(([field]) => [field, dollarsToCents(f[field].value)])),
    };
    try {
      if (existing) {
        await api(`/events/${existing.id}`, { method: "PUT", body });
        location.hash = `#/event/${existing.id}`;
        return;
      }
      if (createdId == null) createdId = (await api("/events", { method: "POST", body })).id;
      // Then the laps, onto the event that now exists: staged imports first,
      // then the hand-typed session. Each is posted once — a failure leaves
      // the rest staged, the error on the form, and the next submit retries
      // only what is left.
      const hand = {
        label: view.querySelector("#session-label").value,
        laps: view.querySelector("#session-laps").value,
        notes: view.querySelector("#session-notes").value,
      };
      const handSession = sessionsToCreate([], hand);
      while (staged.length) {
        await api(`/events/${createdId}/sessions`, { method: "POST", body: staged[0] });
        staged.shift();
        renderStaged();
      }
      if (handSession.length) {
        await api(`/events/${createdId}/sessions`, { method: "POST", body: handSession[0] });
        view.querySelector("#session-laps").value = "";
      }
      location.hash = `#/event/${createdId}`;
    } catch (err) {
      const prefix = createdId != null ? "The event was created, but a session couldn't be added: " : "";
      view.querySelector("#form-error").innerHTML = `<div class="error-banner">${esc(prefix + err.message)}</div>`;
      if (createdId != null) view.querySelector("#event-submit").textContent = "Add the laps";
    }
  };
}

// --- settings (garage + legal) ---

// Settings' tier card: what the account has, where it came from, and the one
// action that makes sense for it. There is no Subscribe button here on
// purpose — the web app has no store behind it, so the honest control is a
// pointer at the app that sold, or can sell, the subscription.
function subscriptionPanelHtml() {
  const e = state.entitlement;
  const manage = manageUrl(e);
  const summary = entitlementSummary(e, (ms) => fmtDate(new Date(ms).toISOString().slice(0, 10)));
  const detail = !isPro(e)
    ? e?.source
      ? `Your ${e.source === "apple" ? "App Store" : "Google Play"} subscription has ended. Resubscribe in the app to turn Pro back on — nothing was deleted.`
      : "The logbook, your lap times, charts, sharing and telemetry import are free and stay that way. Pro adds the lap recorder, the channel graphs and sector splits inside an imported session, the garage's consumables, the setup notebook and year in review."
    : e.source === "legacy"
      ? "You bought the app before it became a subscription, so Pro is yours for life. There is nothing to renew and nothing to cancel."
      : `Billed through ${e.source === "apple" ? "the App Store" : "Google Play"}.${
          e.auto_renew === false ? " Auto-renew is off — Pro runs until the date above." : ""
        }`;
  return `<div class="panel sub-panel">
    <div class="sub-head">
      <span class="sub-tier${isPro(e) ? " pro" : ""}">${esc(summary)}</span>
    </div>
    <div class="hint" style="margin:8px 0 0">${esc(detail)}</div>
    <div class="btn-row" style="margin-top:12px">
      ${
        manage
          ? `<a class="btn small" href="${manage}" target="_blank" rel="noopener">Manage subscription ↗</a>`
          : ""
      }
      ${
        isPro(e) && e.source === "legacy"
          ? ""
          : `<a class="btn small${isPro(e) ? "" : " primary"}" href="${APP_STORE_URL}" target="_blank" rel="noopener">iPhone app ↗</a>
             <a class="btn small${isPro(e) ? "" : " primary"}" href="${PLAY_STORE_URL}" target="_blank" rel="noopener">Android app ↗</a>`
      }
    </div>
    ${
      isPro(e)
        ? ""
        : `<div class="hint" style="margin:10px 0 0">Subscriptions are sold in the phone apps —
             ${PRO_PRICE}, covering all three apps and this site. Sign in there with this account
             and Pro appears here within a minute.</div>`
    }
  </div>`;
}

async function viewSettings() {
  // The user's own list, or the built-in one shown as the starting point.
  const template = checklistTemplate();
  const isCustom = !!state.me?.checklist_template;

  const units = currentUnits();

  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
    <h1>Settings</h1>
    <h2>Units</h2>
    <div class="hint" style="margin:0 0 4px">How speeds, distances, temperatures, tire pressures and fuel are shown and entered, on every device you sign in on. Nothing already logged changes — the same numbers are just converted.</div>
    <div class="panel">
      <div class="btn-row" role="group" aria-label="Unit system" id="units-toggle">
        ${UNIT_SYSTEMS.map(
          ([id, label, examples]) =>
            `<button type="button" class="btn small${units === id ? " primary" : ""}" data-units="${id}" aria-pressed="${units === id}">${label} <span class="hint-inline">${examples}</span></button>`
        ).join("")}
      </div>
      <div id="units-error"></div>
    </div>
    <h2>Cars</h2>
    <div class="panel">
      <div class="hint" style="margin:0 0 10px">Your cars live in the Garage now — add one there, set the default for new events, and open it to see what it has done.</div>
      <a class="btn small" href="#/garage">Open the Garage →</a>
    </div>
    <h2>Prep checklist</h2>
    <div class="hint" style="margin:0 0 4px">The list an upcoming event starts from. Edit it here and every checklist you start from now on uses your version — checklists already on an event keep whatever is on them.</div>
    <div class="panel" id="tmpl-panel">
      ${template
        .map(
          (text, i) => `<div class="check-item">
            <span>${esc(text)}</span>
            <button type="button" class="x" data-tmpl-up="${i}" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="x" data-tmpl-down="${i}" title="Move down" ${i === template.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" class="x" data-tmpl-del="${i}" title="Remove">✕</button>
          </div>`
        )
        .join("")}
      <div class="btn-row" style="margin-top:12px">
        <input id="tmpl-new" placeholder="Add item…" maxlength="200">
        <button class="btn small" id="tmpl-add">Add</button>
        ${isCustom ? `<button class="btn small" id="tmpl-reset">Reset to default</button>` : ""}
      </div>
      <div class="hint" style="margin:8px 0 0">${
        isCustom ? "This is your own list." : "This is the app's default — your first edit makes it yours."
      }</div>
      <div id="tmpl-error"></div>
    </div>
    <h2>Leaderboards</h2>
    <div class="panel">
      <label class="dry-toggle" style="display:block">
        <input type="checkbox" id="lb-opt" ${state.me?.leaderboard_opt_in ? "checked" : ""}>
        Appear on per-track leaderboards
      </label>
      <div class="hint" style="margin:8px 0 0">Opting in shares exactly two things with other signed-in drivers, per track: your name and your best device-timed lap (with its date). Only laps recorded with the app or imported from telemetry are ranked — hand-entered times stay in your logbook. Your events, notes, laps and garage stay private. Leaderboards exist only for tracks the app's catalog knows.</div>
      <label class="dry-toggle" style="display:block;margin-top:12px">
        <input type="checkbox" id="lb-share" ${state.me?.leaderboard_share_laps ? "checked" : ""} ${state.me?.leaderboard_opt_in ? "" : "disabled"}>
        Let other drivers open my ranked laps
      </label>
      <div class="hint" style="margin:8px 0 0">A second, separate choice, off unless you turn it on. It publishes one lap per track — the ranked one already on the board — as its racing line and telemetry traces, so a driver ranked at the same track can compare corner for corner. It never publishes any other lap, your notes, your session labels, your car, the conditions you typed, your setup sheets or your garage. Leaving the leaderboards turns it off.</div>
      <div id="lb-error"></div>
    </div>
    <h2>AI assistants</h2>
    <div class="hint" style="margin:0 0 4px">With Pro, you can connect Claude, ChatGPT or another AI assistant to your logbook and ask it about your laps, sessions and garage. It can read your data and can't change anything. <a href="${DOCS_URL}/docs/ai.html" target="_blank" rel="noopener">How to connect ↗</a></div>
    <div class="panel" id="conn-panel"><div class="hint" style="margin:0">Loading…</div></div>
    <h2>Subscription</h2>
    ${subscriptionPanelHtml()}
    <h2>About &amp; legal</h2>
    <div class="panel">
      <div class="btn-row">
        <a class="btn small" href="${DOCS_URL}/docs/privacy.html" target="_blank" rel="noopener">Privacy policy ↗</a>
        <a class="btn small" href="${DOCS_URL}/docs/terms.html" target="_blank" rel="noopener">Terms of use ↗</a>
        <a class="btn small" href="${DOCS_URL}" target="_blank" rel="noopener">Documentation ↗</a>
      </div>
      <div class="hint" style="margin:10px 0 0">© ${new Date().getFullYear()} Speedshift LLC</div>
    </div>
  `);

  // --- units ---
  view.querySelectorAll("[data-units]").forEach((btn) => {
    btn.onclick = async () => {
      const next = btn.dataset.units;
      if (next === units) return;
      try {
        await api("/me/units", { method: "PUT", body: { units: next } });
        state.me.units = next;
        cacheUnits(next);
        route();
      } catch (err) {
        view.querySelector("#units-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
      }
    };
  });

  // --- prep checklist template ---
  // Saved whole, not item by item: it is one ordered list, and a partial write
  // would leave the user staring at a list that isn't what they'll get.
  const saveTemplate = async (next) => {
    try {
      await api("/me/checklist-template", {
        method: "PUT",
        body: { checklist_template: next.length ? next : null },
      });
      // Keep the in-memory copy in step so the event page's button agrees
      // without a reload.
      state.me.checklist_template = next.length ? next : null;
      route();
    } catch (err) {
      view.querySelector("#tmpl-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  };
  const swap = (i, j) => {
    const next = [...template];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  view.querySelectorAll("[data-tmpl-del]").forEach((btn) => {
    btn.onclick = () => saveTemplate(template.filter((_, i) => i !== Number(btn.dataset.tmplDel)));
  });
  view.querySelectorAll("[data-tmpl-up]").forEach((btn) => {
    btn.onclick = () => saveTemplate(swap(Number(btn.dataset.tmplUp), Number(btn.dataset.tmplUp) - 1));
  });
  view.querySelectorAll("[data-tmpl-down]").forEach((btn) => {
    btn.onclick = () => saveTemplate(swap(Number(btn.dataset.tmplDown), Number(btn.dataset.tmplDown) + 1));
  });
  const tmplInput = view.querySelector("#tmpl-new");
  view.querySelector("#tmpl-add").onclick = () => {
    const text = tmplInput.value.trim();
    if (!text) return;
    saveTemplate([...template, text]);
  };
  tmplInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      view.querySelector("#tmpl-add").click();
    }
  });
  const tmplReset = view.querySelector("#tmpl-reset");
  if (tmplReset) tmplReset.onclick = () => saveTemplate([]);

  // --- connected AI assistants (MCP, #316) ---
  // Loaded after the page draws: it is the one section that needs its own
  // request, and a failure here shouldn't hold up the rest of Settings.
  // Disconnecting is a live write (off the offline queue), like every other
  // account setting.
  const connPanel = view.querySelector("#conn-panel");
  const dayOf = (ms) => fmtDate(new Date(ms).toISOString().slice(0, 10));
  const drawConnections = async () => {
    let rows;
    try {
      rows = await api("/me/connections");
    } catch (err) {
      connPanel.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
      return;
    }
    if (!connPanel.isConnected) return;
    connPanel.innerHTML = rows.length
      ? rows
          .map(
            (r) => `<div class="check-item">
              <span>${esc(r.name || "Unnamed app")} <span class="hint-inline">connected ${dayOf(r.connected_at)}${
                r.last_used_at ? ` · last used ${dayOf(r.last_used_at)}` : ""
              }</span></span>
              <button type="button" class="btn small" data-conn-del="${r.id}">Disconnect</button>
            </div>`
          )
          .join("") + `<div id="conn-error"></div>`
      : `<div class="hint" style="margin:0">No assistants connected.</div>`;
    connPanel.querySelectorAll("[data-conn-del]").forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api(`/me/connections/${btn.dataset.connDel}`, { method: "DELETE" });
          drawConnections();
        } catch (err) {
          btn.disabled = false;
          connPanel.querySelector("#conn-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
        }
      };
    });
  };
  drawConnections();

  // --- leaderboard opt-in, and the lap-sharing consent stacked on it (NS-35) ---
  const lbOpt = view.querySelector("#lb-opt");
  const lbShare = view.querySelector("#lb-share");
  const saveLeaderboard = async (optIn, shareLaps) => {
    try {
      await api("/me/leaderboard", { method: "PUT", body: { opt_in: optIn, share_laps: shareLaps } });
      state.me.leaderboard_opt_in = optIn;
      state.me.leaderboard_share_laps = optIn && shareLaps;
      view.querySelector("#lb-error").innerHTML = "";
      return true;
    } catch (err) {
      view.querySelector("#lb-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
      return false;
    }
  };
  lbOpt.onchange = async () => {
    // Leaving the board clears lap sharing server-side; the checkbox follows so
    // it never shows a consent that is no longer stored.
    const ok = await saveLeaderboard(lbOpt.checked, lbOpt.checked && lbShare.checked);
    if (!ok) lbOpt.checked = !lbOpt.checked; // the write failed — don't lie about the state
    lbShare.disabled = !lbOpt.checked;
    if (!lbOpt.checked) lbShare.checked = false;
  };
  lbShare.onchange = async () => {
    if (!(await saveLeaderboard(true, lbShare.checked))) lbShare.checked = !lbShare.checked;
  };
}

// --- the garage (NS-37) ---

// What a free account is shown in place of the garage's Pro half, here and on
// a car's page: locked in place, never simply missing.
const GARAGE_PRO_WHAT =
  "Pads, tires, rotors and fluid, each with the hours it has actually done — accrued from " +
  "your own track days — a wear projection from your measurements, reminders before the next " +
  "event, and what the car has cost you: its parts and its track days. Your cars and what " +
  "they've done stay free.";

async function viewGarage() {
  const pro = canUseGarage(state.entitlement);
  const [vehicles, events, carCatalog, garage] = await Promise.all([
    api("/vehicles"),
    api("/events"),
    api("/car-catalog").catch(() => []),
    // The Pro half rides alongside and is allowed to fail (offline, lapsed):
    // the tiles still render from the free list.
    pro ? api("/garage").catch(() => null) : null,
  ]);
  if (garage) noteGarage(garage);
  const today = todayISO();
  const catalogById = new Map(carCatalog.map((r) => [r.id, r]));
  // Vehicle writes need a live server (they are off the offline queue), so the
  // tile says so rather than failing on submit.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;

  const tile = (v) => {
    const g = garage?.find((x) => x.id === v.id);
    const row = v.catalog_id == null ? null : catalogById.get(v.catalog_id);
    let proLines = "";
    if (g) {
      const active = g.parts.filter((p) => !p.retired_on);
      const alerts = garageAlerts([g]);
      proLines = `<div class="meta">${fmtHours(g.hours)} on track</div>
        <div class="meta garage-status ${alerts[0]?.status ?? "ok"}">${
          alerts.length
            ? `● ${alerts.length} item${alerts.length === 1 ? "" : "s"} due soon`
            : active.length
              ? "● consumables OK"
              : "no consumables tracked yet"
        }</div>`;
    }
    return `<a class="card car-card" href="#/vehicle/${v.id}">
      <div class="name">${esc(v.name)}${v.is_default ? ' <span class="default-badge">Default</span>' : ""}</div>
      ${row ? `<div class="meta">${esc(catalogCarLabel(row))}</div>` : ""}
      <div class="meta">${esc(vehicleTileLine(vehicleLogbook(v.id, events, today)))}</div>
      ${proLines}
    </a>`;
  };

  const addTile = `<button type="button" class="card add-card" id="car-add-open" ${offline ? "disabled" : ""}>
      <span class="add-plus" aria-hidden="true">+</span>
      <span class="name">Add car</span>
      <span class="meta">${
        offline
          ? "Adding a car needs a connection"
          : vehicles.length
            ? "Pick it from the catalog or type it in"
            : "Add the car you drive — new events fill it in, and its page keeps what it has done"
      }</span>
    </button>`;

  const view = shell(`
    <h1>Garage</h1>
    ${garage ? alertStripHtml(garage) : ""}
    <div class="cards">${vehicles.map(tile).join("")}${addTile}</div>
    <form class="panel" id="veh-add" hidden>
      <div class="field"><label>Car</label><input name="name" required placeholder="2023 Corvette Z06"></div>
      ${catalogFieldHtml("veh-add-catalog-list", null)}
      <div class="field"><label>Modifications &amp; notes</label>
        <textarea name="notes" placeholder="Coilovers, pads, tires, alignment…"></textarea>
      </div>
      <label class="dry-toggle" style="display:block;margin:0 0 14px">
        <input type="checkbox" name="is_default" ${vehicles.length ? "" : "checked"}> Default car for new events
      </label>
      <div id="veh-error"></div>
      <div class="btn-row">
        <button class="btn primary">Add car</button>
        <button class="btn" type="button" id="veh-add-cancel">Cancel</button>
      </div>
    </form>
    ${pro ? "" : `<h2>Maintenance and costs</h2>${proPanelHtml("Maintenance and costs", GARAGE_PRO_WHAT, { underHeading: true })}`}
  `);

  // A new car picked from the catalog: the server pre-fills its wheelbase and
  // steering ratio from the row, and the pick names the car only when the
  // driver hasn't — a car already called "Betty" keeps its name.
  const vehAdd = view.querySelector("#veh-add");
  const openBtn = view.querySelector("#car-add-open");
  openBtn.onclick = () => {
    vehAdd.hidden = false;
    vehAdd.name.focus();
  };
  view.querySelector("#veh-add-cancel").onclick = () => {
    vehAdd.hidden = true;
    openBtn.focus();
  };
  let addPick = null;
  bindCatalogPicker(vehAdd.catalog, view.querySelector("#veh-add-catalog-list"), carCatalog, {
    onPick: (row) => {
      addPick = row;
      if (vehAdd.name.value.trim() === "") vehAdd.name.value = catalogCarName(row);
    },
    onClear: () => {
      addPick = null;
    },
  });
  vehAdd.onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    try {
      const body = { name: f.name.value.trim(), notes: f.notes.value.trim() || null };
      if (addPick) body.catalog_id = addPick.id;
      if (f.is_default.checked) body.is_default = true;
      const created = await api("/vehicles", { method: "POST", body });
      if (created?.id != null) location.hash = `#/vehicle/${created.id}`;
      else route();
    } catch (err) {
      view.querySelector("#veh-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  };
}

// --- vehicle / garage page ---

async function viewVehicle(vehicleId) {
  // Every account gets the car (NS-37): its logbook, its best laps and its
  // form, from the free vehicle list and the cached events. The Pro half —
  // hours, parts, wear, spend and the measured steering ratio — reads
  // GET /api/garage; a free account sees it locked in place.
  const pro = canUseGarage(state.entitlement);
  // The car's per-session steering fits (#223) ride along with the page: the
  // form's measured-ratio line needs them, and a failed read means the line is
  // absent, never an error on a page that is about the parts.
  const [vehicles, events, carCatalog, garage, fitsRes] = await Promise.all([
    api("/vehicles"),
    api("/events"),
    api("/car-catalog"),
    pro ? api("/garage") : null,
    pro ? api(`/vehicles/${vehicleId}/steering-fit`).catch(() => null) : null,
  ]);
  if (garage) noteGarage(garage);
  const steeringFits = fitsRes?.fits ?? [];
  const v = (garage ?? vehicles).find((x) => String(x.id) === String(vehicleId));
  if (!v) return viewNotFound();
  const logbook = vehicleLogbook(v.id, events, todayISO());
  // The catalog row the car's numbers came from, if it was picked from one.
  const initialPick = v.catalog_id == null ? null : carCatalog.find((r) => r.id === v.catalog_id) ?? null;
  const active = pro ? v.parts.filter((p) => !p.retired_on) : [];
  const retired = pro ? v.parts.filter((p) => p.retired_on) : [];
  // What the car has cost (#147): its parts and its track days, both summed
  // server-side on /garage (past events only — an upcoming one isn't spent).
  const spendCents = pro ? v.parts_cost_cents + v.event_cost_cents : 0;
  const today = todayISO();
  const units = currentUnits();

  const measurementChips = (p) =>
    p.measurements.length
      ? `<div class="laps">${p.measurements
          .map(
            (m) => `<span class="lap">${fmtDate(m.measured_on)} · ${m.value} ${esc(m.unit)}
              <button type="button" class="x" data-meas-del="${p.id}:${m.id}" title="Remove measurement">✕</button></span>`
          )
          .join("")}</div>`
      : "";

  const partEditForm = (p) => `
    <form class="part-edit" data-part-form="${p.id}" hidden>
      <div class="form-grid">
        <div class="field"><label>Type</label>
          <select name="kind">${PART_KINDS.map(([k, l]) => `<option value="${k}"${p.kind === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label>Part / compound</label><input name="name" required value="${esc(p.name)}"></div>
        <div class="field"><label>Installed</label><input name="installed_on" type="date" required value="${esc(p.installed_on)}"></div>
        <div class="field"><label>Retired (blank = in service)</label><input name="retired_on" type="date" value="${esc(p.retired_on ?? "")}"></div>
        <div class="field"><label>Cost ($)</label><input name="cost" type="number" min="0" step="0.01" value="${p.cost_cents != null ? (p.cost_cents / 100).toFixed(2) : ""}"></div>
        <div class="field"><label>Expected life (track hours)</label><input name="expected_hours" type="number" min="0" step="0.5" value="${p.expected_hours ?? ""}"></div>
        <div class="field"><label>Replace at (measured value)</label><input name="wear_limit" type="number" min="0" step="0.5" value="${p.wear_limit ?? ""}" placeholder="${wearLimitHint(p.kind, units)}"></div>
      </div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(p.notes ?? "")}" placeholder="Sizes, torque specs, where bought…"></div>
      <div class="btn-row">
        <button class="btn small primary">Save</button>
        <button class="btn small" type="button" data-part-cancel="${p.id}">Cancel</button>
        <button class="btn small danger" type="button" data-part-delete="${p.id}">Delete part</button>
      </div>
    </form>`;

  const partCard = (p) => `
    <div class="panel part-card">
      <div class="part-head">
        <span class="part-kind">${esc(partKindLabel(p.kind))}</span>
        <span class="part-name">${esc(p.name)}</span>
        <span class="grow"></span>
        <button class="btn small" data-meas-toggle="${p.id}">Measure</button>
        ${p.retired_on ? "" : `<button class="btn small" data-part-refresh="${p.id}">Refresh</button>
        <button class="btn small" data-part-retire="${p.id}">Retire</button>`}
        <button class="btn small" data-part-edit="${p.id}">Edit</button>
      </div>
      <div class="part-meta">Installed ${fmtDate(p.installed_on)}${p.retired_on ? ` — retired ${fmtDate(p.retired_on)}` : ""}${p.cost_cents != null ? ` · ${fmtCost(p.cost_cents)}` : ""}${p.notes ? ` · ${esc(p.notes)}` : ""}</div>
      ${wearBarHtml(p.wear)}
      <div class="part-status">${wearStatusHtml(p)}</div>
      ${p.odometer ? `<div class="hint part-odometer">${esc(partOdometerLine(p.odometer, units))}</div>` : ""}
      ${measurementChips(p)}
      <form class="btn-row meas-form" data-meas-form="${p.id}" data-meas-kind="${esc(p.kind)}" hidden>
        <input name="value" type="number" step="0.1" min="0" required placeholder="Value" style="max-width:110px">
        <input name="unit" value="${esc(p.measurements[p.measurements.length - 1]?.unit ?? defaultMeasurementUnit(p.kind, units))}" placeholder="mm" style="max-width:90px">
        <input name="measured_on" type="date" required value="${today}">
        <button class="btn small primary">Log measurement</button>
        <span class="hint-inline">two or more measurements unlock the wear projection</span>
      </form>
      ${partEditForm(p)}
    </div>`;

  const retiredRows = retired
    .map((p) => {
      const perHour = p.cost_cents != null && p.wear.hours > 0 ? `$${(p.cost_cents / 100 / p.wear.hours).toFixed(0)}/h` : "—";
      return `<tr>
        <td>${esc(partKindLabel(p.kind))}</td>
        <td>${esc(p.name)}</td>
        <td class="date">${fmtDate(p.installed_on)} – ${fmtDate(p.retired_on)}</td>
        <td class="num">${fmtHours(p.wear.hours)}</td>
        <td class="num">${fmtCost(p.cost_cents) ?? "—"}</td>
        <td class="num">${perHour}</td>
      </tr>`;
    })
    .join("");

  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/garage">← Garage</a></p>
    <h1>${esc(v.name)}${v.is_default ? ' <span class="default-badge">Default</span>' : ""}</h1>
    ${v.notes ? `<p class="sub">${esc(v.notes)}</p>` : ""}
    <div class="btn-row"><button class="btn small" id="veh-edit">Edit car</button></div>
    <form class="panel vehicle-edit" id="veh-form" hidden>
      <div class="field"><label>Car</label><input name="name" required value="${esc(v.name)}"></div>
      <div class="field"><label>Modifications &amp; notes</label>
        <textarea name="notes" placeholder="Coilovers, pads, tires, alignment…">${esc(v.notes ?? "")}</textarea>
      </div>
      <div class="form-grid">
        <div class="field"><label>Target hot tire pressure (psi, optional)</label>
          <input name="target_hot_psi" type="number" min="5" max="100" step="0.5" value="${v.target_hot_psi ?? ""}" placeholder="e.g. 34"></div>
        <div class="field"><label><input type="checkbox" name="is_default" ${v.is_default ? "checked" : ""}> Default car for new events</label></div>
      </div>
      ${catalogFieldHtml("veh-catalog-list", initialPick)}
      <div class="form-grid">
        <div class="field"><label>Wheelbase (mm, optional)</label>
          <input name="wheelbase_mm" type="number" min="1500" max="4500" step="1" value="${v.wheelbase_mm ?? ""}" placeholder="e.g. 2710"></div>
        <div class="field"><label>Steering ratio (optional)</label>
          <input name="steering_ratio" type="number" min="5" max="30" step="0.01" value="${v.steering_ratio ?? ""}" placeholder="e.g. 16.25 for 16.25:1"></div>
      </div>
      <div class="hint" id="veh-measured" hidden></div>
      <div id="veh-asks"></div>
      <div class="hint" id="veh-source" ${initialPick ? "" : "hidden"}>${initialPick ? esc(initialPick.source) : ""}</div>
      <div class="hint">Both are on the spec sheet or in the owner's manual. They let the balance read-out say how much understeer, rather than only which corner differs from the rest — leave them blank and it keeps the relative reading.</div>
      <div id="veh-error"></div>
      <div class="btn-row">
        <button class="btn small primary">Save</button>
        <button class="btn small" type="button" id="veh-cancel">Cancel</button>
        <span class="grow"></span>
        <button class="btn small danger" type="button" id="veh-delete">Delete car</button>
      </div>
    </form>
    ${pro ? proVehicleHtml() : freeVehicleHtml()}
  `);

  function freeVehicleHtml() {
    return `<div class="tiles">
      <div class="tile"><div class="label">Track days</div><div class="value">${logbook.track_days}</div></div>
      <div class="tile"><div class="label">Events</div><div class="value">${logbook.events}</div></div>
    </div>
    ${logbookLineHtml()}
    ${bestsHtml()}
    <h2>Consumables, hours and costs</h2>
    ${proPanelHtml("Consumables, hours and costs", GARAGE_PRO_WHAT, { underHeading: true })}`;
  }

  // Last out and next up, each a link to the event — the same two facts the
  // car's tile words, for both tiers.
  function logbookLineHtml() {
    const bits = [];
    const { last_event: last, next_event: next } = logbook;
    if (last) bits.push(`Last out at <a href="#/event/${last.id}">${esc(last.track_name)}</a> on ${fmtDate(last.start_date)}`);
    if (next) bits.push(`next: <a href="#/event/${next.id}">${esc(next.track_name)}</a> on ${fmtDate(next.start_date)}`);
    if (!bits.length) return `<p class="sub">No track days in this car yet — pick it on an event and they'll show up here.</p>`;
    return `<p class="sub">${bits.join(" · ")}</p>`;
  }

  // Best in this car, per track — free, since it is the driver's own logbook.
  function bestsHtml() {
    if (!logbook.bests.length) return "";
    const rows = logbook.bests
      .map(
        (b) => `<tr>
          <td><a href="#/track/${b.track_id}">${esc(b.track_name)}</a></td>
          <td class="num">${fmtMs(b.best_ms)}</td>
          <td class="date"><a href="#/event/${b.event_id}">${fmtDate(b.start_date)}</a></td>
        </tr>`
      )
      .join("");
    return `<h2>Best in this car</h2>
      <div class="table-wrap"><table><thead><tr><th>Track</th><th class="num">Best</th><th>Set on</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function proVehicleHtml() {
    return `${alertStripHtml([v])}
    <div class="tiles">
      <div class="tile"><div class="label">Track hours</div><div class="value">${fmtHours(v.hours).replace(" h", "")}<span class="unit">h</span></div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${v.event_days}</div></div>
      <div class="tile"><div class="label">Events</div><div class="value">${v.event_count}</div></div>
      <div class="tile"><div class="label">Spent</div><div class="value">${spendCents ? fmtSpend(spendCents) : "—"}</div></div>
    </div>
    ${
      v.parts_cost_cents && v.event_cost_cents
        ? `<div class="hint cost-breakdown">Parts ${fmtSpend(v.parts_cost_cents)} · track days ${fmtSpend(v.event_cost_cents)}</div>`
        : ""
    }
    ${
      // The car's own odometer (#192): ground truth for distance beside the
      // hours estimate above, from video imports only — so the line names the
      // recorded session it came from rather than claiming to be current.
      v.odometer ? `<div class="hint vehicle-odometer">${esc(vehicleOdometerLine(v.odometer, units))}</div>` : ""
    }
    ${logbookLineHtml()}
    ${bestsHtml()}
    <h2>Consumables in service</h2>
    <div class="hint" style="margin:0 0 4px">Wear accrues automatically from this car's logged events (2h per track day unless an event says otherwise). Log a quick pad or tread measurement between events and the projection switches from estimated to measured.</div>
    ${active.map(partCard).join("") || `<div class="empty">Nothing tracked yet — add pads, tires or fluid below and Track Evolution will tell you when they're due.</div>`}
    <form class="panel" id="part-add">
      <div class="form-grid">
        <div class="field"><label>Type</label>
          <select name="kind">${PART_KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
        <div class="field"><label>Part / compound</label><input name="name" required placeholder="Hawk DTC-60, RE-71RS 255/40…"></div>
        <div class="field"><label>Installed</label><input name="installed_on" type="date" required value="${today}"></div>
        <div class="field"><label>Cost ($, optional)</label><input name="cost" type="number" min="0" step="0.01" placeholder="389"></div>
        <div class="field"><label>Expected life (track hours)</label><input name="expected_hours" type="number" min="0" step="0.5" placeholder="auto from history"></div>
        <div class="field"><label>Replace at (optional)</label><input name="wear_limit" type="number" min="0" step="0.5" placeholder="${wearLimitHint("pads_front", units)}"></div>
      </div>
      <div class="field"><label>Notes</label><input name="notes" placeholder="Sizes, torque specs, where bought…"></div>
      <div id="part-error"></div>
      <button class="btn primary">+ Add part</button>
    </form>
    ${retired.length ? `<h2>Retired parts</h2>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Part</th><th>In service</th><th class="num">Hours</th><th class="num">Cost</th><th class="num">Cost/hour</th></tr></thead>
    <tbody>${retiredRows}</tbody></table></div>` : ""}`;
  }

  // The car itself — name, mods, the pressure the health strip aims at, and
  // whether new events start on it. This used to live only in Settings, a page
  // away from the garage it describes.
  const vehForm = view.querySelector("#veh-form");
  view.querySelector("#veh-edit").onclick = () => {
    vehForm.hidden = !vehForm.hidden;
    if (!vehForm.hidden) vehForm.querySelector('[name="name"]').focus();
  };
  view.querySelector("#veh-cancel").onclick = () => {
    vehForm.hidden = true;
  };

  // The catalog pick. `pick` is the row the form's numbers came from — the
  // stored one to begin with — which is what lets a re-pick tell the previous
  // pick's numbers (replaced silently) from the driver's own (asked about, per
  // field, inline under the fields). Clearing the pick keeps the numbers: they
  // are the driver's now.
  const numOrNull = (raw) => (raw.trim() === "" ? null : Number(raw));
  let pick = initialPick;
  const sourceHint = view.querySelector("#veh-source");
  const asksEl = view.querySelector("#veh-asks");
  const showSource = () => {
    sourceHint.hidden = !pick;
    sourceHint.textContent = pick ? pick.source : "";
  };
  // The measured steering ratio (#223): the car's recent sessions' fits pooled
  // against the wheelbase *in the form* — the line follows both fields as they
  // are typed. With the ratio field empty it offers the number; with a number
  // in it, it is the typo check ("— matches" / "well off this; check the
  // units"). Absent, not "not enough data", when nothing can be measured yet.
  // "Use this" writes the field, never the row — the driver still saves.
  const measuredEl = view.querySelector("#veh-measured");
  const currentEstimate = () => estimateSteeringRatio(steeringFits, numOrNull(vehForm.wheelbase_mm.value));
  const renderMeasured = () => {
    const est = currentEstimate();
    const typed = numOrNull(vehForm.steering_ratio.value);
    const line = measuredRatioLine(est, typed);
    measuredEl.hidden = !line;
    if (!line) {
      measuredEl.innerHTML = "";
      return;
    }
    measuredEl.innerHTML = `<span id="veh-measured-line">${esc(line)}</span>${
      ratioAgrees(est, typed) ? "" : ` <button type="button" class="btn small" id="veh-measured-use">Use this</button>`
    }`;
  };
  measuredEl.addEventListener("click", (e) => {
    if (!e.target.closest("#veh-measured-use")) return;
    const est = currentEstimate();
    if (est) vehForm.steering_ratio.value = measuredRatioValue(est);
    renderMeasured();
  });
  vehForm.wheelbase_mm.addEventListener("input", renderMeasured);
  vehForm.steering_ratio.addEventListener("input", renderMeasured);
  renderMeasured();
  const renderAsks = (asks) => {
    asksEl.innerHTML = asks
      .map(
        ({ field, value }) => `<div class="hint" data-ask="${field}">The catalog says ${esc(fmtGeometry(field, value))} for the ${GEOMETRY_LABELS[field]}; you have ${esc(fmtGeometry(field, vehForm[field].value))}.
          <button type="button" class="btn small" data-ask-use="${field}">Use ${esc(fmtGeometry(field, value))}</button>
          <button type="button" class="btn small" data-ask-keep="${field}">Keep mine</button></div>`
      )
      .join("");
  };
  asksEl.addEventListener("click", (e) => {
    const use = e.target.closest("[data-ask-use]");
    const keep = e.target.closest("[data-ask-keep]");
    const btn = use ?? keep;
    if (!btn) return;
    const field = btn.dataset.askUse ?? btn.dataset.askKeep;
    if (use && pick) vehForm[field].value = pick[field] ?? "";
    asksEl.querySelector(`[data-ask="${field}"]`)?.remove();
    renderMeasured();
  });
  bindCatalogPicker(vehForm.catalog, view.querySelector("#veh-catalog-list"), carCatalog, {
    initial: initialPick,
    onPick: (row) => {
      const plan = catalogPrefill(
        row,
        { wheelbase_mm: numOrNull(vehForm.wheelbase_mm.value), steering_ratio: numOrNull(vehForm.steering_ratio.value) },
        pick
      );
      const asks = [];
      for (const [field, { value, action }] of Object.entries(plan)) {
        if (action === "fill") vehForm[field].value = value ?? "";
        else if (action === "ask") asks.push({ field, value });
      }
      pick = row;
      renderAsks(asks);
      if (vehForm.name.value.trim() === "") vehForm.name.value = catalogCarName(row);
      showSource();
      renderMeasured();
    },
    onClear: () => {
      pick = null;
      renderAsks([]);
      showSource();
    },
  });

  vehForm.onsubmit = async (evt) => {
    evt.preventDefault();
    const body = {
      name: vehForm.name.value.trim(),
      notes: vehForm.notes.value.trim() || null,
      target_hot_psi: numOrNull(vehForm.target_hot_psi.value),
      // The pick and both numbers together: the server pre-fills only the
      // numbers a body leaves out, and this form never leaves one out, so what
      // is on screen is what gets saved — the pick is recorded as identity.
      catalog_id: pick?.id ?? null,
      wheelbase_mm: numOrNull(vehForm.wheelbase_mm.value),
      steering_ratio: numOrNull(vehForm.steering_ratio.value),
    };
    // Only when it changed: a PUT with is_default false would silently unset
    // the default when the box was merely left alone.
    if (vehForm.is_default.checked !== Boolean(v.is_default)) body.is_default = vehForm.is_default.checked;
    try {
      await api(`/vehicles/${v.id}`, { method: "PUT", body });
      route();
    } catch (err) {
      view.querySelector("#veh-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  };

  view.querySelector("#veh-delete").onclick = async () => {
    if (!confirm(`Delete ${v.name}? Past events keep the car name they were logged with${pro ? "; its consumables, measurements and wear history go with it" : ""}.`))
      return;
    try {
      await api(`/vehicles/${v.id}`, { method: "DELETE" });
      location.hash = "#/garage";
    } catch (err) {
      view.querySelector("#veh-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  };

  // Everything below wires the Pro half, which a free account never renders.
  if (!pro) return;

  const partError = (err) => {
    view.querySelector("#part-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  };

  // The replace-at hint follows the chosen kind (tread depth is not a pad
  // thickness), in the user's tread-depth idiom.
  const partAdd = view.querySelector("#part-add");
  partAdd.kind.onchange = () => {
    partAdd.wear_limit.placeholder = wearLimitHint(partAdd.kind.value, units);
  };
  partAdd.onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    try {
      await api(`/vehicles/${v.id}/parts`, {
        method: "POST",
        body: {
          kind: f.kind.value,
          name: f.name.value.trim(),
          installed_on: f.installed_on.value,
          cost_cents: f.cost.value.trim() === "" ? null : Math.round(Number(f.cost.value) * 100),
          expected_hours: numOrNull(f.expected_hours.value),
          wear_limit: numOrNull(f.wear_limit.value),
          notes: f.notes.value.trim() || null,
        },
      });
      route();
    } catch (err) {
      partError(err);
    }
  };

  view.querySelectorAll("[data-meas-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const form = view.querySelector(`[data-meas-form="${btn.dataset.measToggle}"]`);
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('[name="value"]').focus();
    };
  });
  view.querySelectorAll("[data-meas-form]").forEach((form) => {
    form.onsubmit = async (evt) => {
      evt.preventDefault();
      try {
        await api(`/parts/${form.dataset.measForm}/measurements`, {
          method: "POST",
          body: {
            measured_on: form.measured_on.value,
            value: Number(form.value.value),
            unit: form.unit.value.trim() || defaultMeasurementUnit(form.dataset.measKind, units),
          },
        });
        route();
      } catch (err) {
        partError(err);
      }
    };
  });
  view.querySelectorAll("[data-meas-del]").forEach((btn) => {
    btn.onclick = async () => {
      const [partId, measId] = btn.dataset.measDel.split(":");
      await api(`/parts/${partId}/measurements/${measId}`, { method: "DELETE" });
      route();
    };
  });
  view.querySelectorAll("[data-part-refresh]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Fresh set of the same part? This retires the current one today (keeping its history) and installs a new one with the same details — hours reset to zero. Edit the new part afterwards if the cost or compound changed."))
        return;
      try {
        await api(`/parts/${btn.dataset.partRefresh}/refresh`, { method: "POST", body: {} });
        route();
      } catch (err) {
        partError(err);
      }
    };
  });
  view.querySelectorAll("[data-part-retire]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Retire this part? Its wear stops accruing and it moves to the retired list.")) return;
      await api(`/parts/${btn.dataset.partRetire}`, { method: "PUT", body: { retired_on: today } });
      route();
    };
  });
  view.querySelectorAll("[data-part-edit]").forEach((btn) => {
    btn.onclick = () => {
      const form = view.querySelector(`[data-part-form="${btn.dataset.partEdit}"]`);
      form.hidden = !form.hidden;
    };
  });
  view.querySelectorAll("[data-part-cancel]").forEach((btn) => {
    btn.onclick = () => {
      view.querySelector(`[data-part-form="${btn.dataset.partCancel}"]`).hidden = true;
    };
  });
  view.querySelectorAll("[data-part-delete]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this part and its measurements? (Retire it instead to keep the history.)")) return;
      await api(`/parts/${btn.dataset.partDelete}`, { method: "DELETE" });
      route();
    };
  });
  view.querySelectorAll("[data-part-form]").forEach((form) => {
    form.onsubmit = async (evt) => {
      evt.preventDefault();
      try {
        await api(`/parts/${form.dataset.partForm}`, {
          method: "PUT",
          body: {
            kind: form.kind.value,
            name: form.name.value.trim(),
            installed_on: form.installed_on.value,
            retired_on: form.retired_on.value || null,
            cost_cents: form.cost.value.trim() === "" ? null : Math.round(Number(form.cost.value) * 100),
            expected_hours: numOrNull(form.expected_hours.value),
            wear_limit: numOrNull(form.wear_limit.value),
            notes: form.notes.value.trim() || null,
          },
        });
        route();
      } catch (err) {
        partError(err);
      }
    };
  });
}

// --- year in review ---

// Shared renderer: works for both the authed view and the public share page.
// `wrapped` links the season to its Season Wrapped story (NS-36): the href for
// a year, and whose season it is, for the button's words.
function yearReviewHtml(events, year, hashBase, wrapped = null) {
  const past = events.filter((e) => !isUpcoming(e));
  const years = yearsAvailable(past);
  if (!years.length) return `<div class="empty">No events yet — nothing to review.</div>`;
  const y = years.includes(year) ? year : years[0];
  const r = yearReview(past, y);

  const picker = years
    .map((v) => (v === y ? `<span class="btn small primary">${v}</span>` : `<a class="btn small" href="${hashBase}?y=${v}">${v}</a>`))
    .join("");

  // The cost columns (#147) only appear once something in the year was
  // costed, so an uncosted logbook's review reads exactly as it did.
  const costed = r.spend != null;
  const gainRows = r.gains
    .map((g) => {
      const label =
        g.gain_ms == null
          ? `<span class="goal-status met">new track</span>`
          : g.gain_ms > 0
            ? `<span class="goal-status met">found ${fmtDelta(-g.gain_ms).replace("-", "")}</span>`
            : g.gain_ms === 0
              ? "matched PB"
              : `${fmtDelta(-g.gain_ms)} off PB`;
      return `<tr class="rowlink" data-href="#/track/${g.track_id}">
        <td>${esc(g.track_name)}</td>
        <td class="num">${fmtMs(g.best_before)}</td>
        <td class="num">${fmtMs(g.best_this_year)}</td>
        <td>${label}</td>
        ${costed ? `<td class="num">${fmtSpend(g.spend_cents) ?? "—"}</td><td class="num">${fmtPerSecond(g.cents_per_second) ?? "—"}</td>` : ""}
      </tr>`;
    })
    .join("");
  // The wry headline: the cheapest seconds of the year. A track-year that spent
  // money and got slower has no price per second, so it can't win this.
  const priced = r.gains.filter((g) => g.cents_per_second != null).sort((a, b) => a.cents_per_second - b.cents_per_second);
  const spendHtml = !costed
    ? ""
    : `<p class="sub">${fmtSpend(r.spend.total_cents)} across ${r.spend.costed_events} costed event${r.spend.costed_events === 1 ? "" : "s"}${
        r.spend.costed_events < r.spend.events ? ` (${r.spend.events - r.spend.costed_events} not costed)` : ""
      }${
        priced.length
          ? ` — every second found at <strong>${esc(priced[0].track_name)}</strong> cost <strong>${fmtPerSecond(priced[0].cents_per_second)}</strong>`
          : ""
      }.</p>
    ${costBreakdownHtml(r.spend.by_field)}`;

  return `
    <h1>${y} in review</h1>
    <div class="btn-row" style="margin-top:10px">${picker}</div>
    ${wrapped ? wrappedLinkHtml(y, wrapped) : ""}
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${r.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${r.days}</div></div>
      <div class="tile"><div class="label">Laps logged</div><div class="value">${r.laps}</div></div>
      <div class="tile"><div class="label">Tracks visited</div><div class="value">${r.tracks_visited}</div></div>
      ${costed ? `<div class="tile"><div class="label">Spent</div><div class="value">${fmtSpend(r.spend.total_cents)}</div></div>` : ""}
    </div>
    ${spendHtml}
    ${r.new_tracks.length ? `<p class="sub">First time at ${r.new_tracks.map((t) => `<strong>${esc(t.track_name)}</strong>`).join(", ")} 🎉</p>` : ""}
    ${gainRows ? `<h2>Lap time progress</h2>
    <div class="table-wrap"><table><thead><tr><th>Track</th><th class="num">Best before ${y}</th><th class="num">Best in ${y}</th><th></th>${costed ? `<th class="num">Spent</th><th class="num">$/s found</th>` : ""}</tr></thead>
    <tbody>${gainRows}</tbody></table></div>` : `<div class="empty">No timed events in ${y}.</div>`}
  `;
}

// The way from the table to the story. "So far" while the year is still
// running, the same moment the story itself says "through <date>".
function wrappedLinkHtml(year, { href, whose = "your" }) {
  const running = year === new Date().getFullYear();
  return `<div class="btn-row" style="margin-top:12px"><a class="btn small" href="${href(year)}">✨ See ${esc(whose)} ${year} Wrapped${running ? " so far" : ""} →</a></div>`;
}

async function viewYear(params) {
  if (!canViewYearInReview(state.entitlement)) {
    shell(`
      <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
      <h1>Year in review</h1>
      ${proPanelHtml(
        "Year in review",
        "Your season in one page: events, track days and laps logged, tracks visited, and how " +
          "much time you found at each of them against every year before.",
        { underHeading: true }
      )}
      <p class="sub">Season Wrapped is free: <a href="#/wrapped${params.get("y") ? `/${esc(params.get("y"))}` : ""}">see your season as a story →</a></p>
    `);
    return;
  }
  const events = await api("/events");
  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
    ${yearReviewHtml(events, Number(params.get("y")), "#/year", { href: (y) => `#/wrapped/${y}` })}
  `);
  wireRowLinks(view);
}

// --- season wrapped (NS-36) ---

// The dashboard hero is dismissable per season. A per-viewer convenience, so
// localStorage — wrapped in try/catch like every other read of it here.
const wrappedDismissKey = (year) => `th-wrapped-dismissed-${year}`;
function wrappedDismissed(year) {
  try {
    return localStorage.getItem(wrappedDismissKey(year)) === "1";
  } catch {
    return false;
  }
}
function dismissWrapped(year) {
  try {
    localStorage.setItem(wrappedDismissKey(year), "1");
  } catch {
    /* private mode: the hero simply comes back next time */
  }
}

function wrappedHeroHtml(year) {
  return `<div class="wrapped-hero">
    <a href="#/wrapped/${year}"><span class="hero-kicker">Season Wrapped</span>Your ${year} Wrapped is ready →</a>
    <button type="button" id="wrapped-dismiss" aria-label="Hide the ${year} Wrapped reminder">✕</button>
  </div>`;
}

function wrappedYearPicker(years, current, hrefFor) {
  if (years.length < 2) return "";
  return `<div class="btn-row wr-years" role="group" aria-label="Year">${years
    .map((y) =>
      y === current
        ? `<span class="btn small primary" aria-current="page">${y}</span>`
        : `<a class="btn small" href="${hrefFor(y)}">${y}</a>`
    )
    .join("")}</div>`;
}

// The two Pro cards' store links on a free account — proPanelHtml's buttons,
// without the panel, since the card is already the panel's shape.
const wrappedLockedHtml = () => `<div class="btn-row">
    <a class="btn small primary" href="${APP_STORE_URL}" target="_blank" rel="noopener">Subscribe on iPhone ↗</a>
    <a class="btn small primary" href="${PLAY_STORE_URL}" target="_blank" rel="noopener">Subscribe on Android ↗</a>
  </div>
  <p class="hint">Track Evolution Pro is ${PRO_PRICE}. Wrapped itself is free.</p>`;

async function viewWrapped(yearParam) {
  let year = /^\d{4}$/.test(yearParam ?? "") ? Number(yearParam) : null;
  let years = null;
  const pastYears = async () => yearsAvailable((await api("/events")).filter((e) => !isUpcoming(e)));
  if (year == null) {
    years = await pastYears();
    year = years[0] ?? new Date().getFullYear();
  }
  let data;
  try {
    data = await api(`/wrapped/${year}`);
  } catch (err) {
    // A year with no track days is a page, not an error.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    years ??= await pastYears();
    shell(`
      <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
      <h1>No track days in ${year} — yet</h1>
      <p class="sub">Wrapped tells the story of a season once there's a track day in it.</p>
      ${wrappedYearPicker(years, year, (y) => `#/wrapped/${y}`) || (years.length ? `<div class="btn-row"><a class="btn small" href="#/wrapped/${years[0]}">See ${years[0]}</a></div>` : "")}
    `);
    return;
  }
  const slug = state.me.share_slug;
  const publicUrl = slug ? `${location.origin}/share/${encodeURIComponent(slug)}/wrapped/${data.year}` : null;
  const view = shell(
    wrappedStoryHtml(data, {
      units: currentUnits(),
      share: false,
      closeHref: "#/",
      yearPickerHtml: wrappedYearPicker(data.years, data.year, (y) => `#/wrapped/${y}`),
      lockedHtml: wrappedLockedHtml(),
      posterActionsHtml: `<div class="wr-actions">
        <div class="btn-row">
          <button type="button" class="btn small primary" data-wr="share">Share image</button>
          <button type="button" class="btn small" data-wr="save">Save image</button>
          <button type="button" class="btn small" data-wr="save-wide">Save wide</button>
          ${publicUrl ? `<button type="button" class="btn small" data-wr="copy">Copy link</button>` : ""}
        </div>
        ${
          publicUrl
            ? ""
            : `<p class="hint">Want a link to post instead? <a href="#/">Create a share link</a> on the dashboard and this season gets a page of its own.</p>`
        }
        <p class="hint" id="wr-msg" aria-live="polite"></p>
        <div class="btn-row"><a class="btn small ghost" href="#/year?y=${data.year}">The full year in review →</a></div>
      </div>`,
    })
  );
  const story = view.querySelector("#wrapped-story");
  bindWrappedStory(story);
  wireWrappedPoster(story, data, { share: false, publicUrl });
}

// The poster's buttons. The story image is drawn as soon as the page is up,
// not on the tap: Safari lets navigator.share run only inside the tap's user
// activation, and a font load plus a 1080×1920 draw can outlast it.
function wireWrappedPoster(root, data, { share, publicUrl }) {
  const units = currentUnits();
  let storyBlob = null;
  const drawStory = () => (storyBlob ??= posterBlob(data, { units, share, size: "story" }));
  setTimeout(drawStory, 300);
  const msg = root.querySelector("#wr-msg");
  const say = (text) => {
    if (msg) msg.textContent = text;
  };
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-wr]");
    if (!btn) return;
    try {
      if (btn.dataset.wr === "share") {
        const result = await sharePosterBlob(await drawStory(), {
          name: posterFileName(data.year, "story"),
          title: posterLines(data, units, { share }).title,
        });
        say(result === "downloaded" ? "This browser can't share images, so it was saved instead." : "");
      } else if (btn.dataset.wr === "save") {
        downloadBlob(await drawStory(), posterFileName(data.year, "story"));
      } else if (btn.dataset.wr === "save-wide") {
        downloadBlob(await posterBlob(data, { units, share, size: "wide" }), posterFileName(data.year, "wide"));
      } else if (btn.dataset.wr === "copy" && publicUrl) {
        await navigator.clipboard.writeText(publicUrl);
        say("Link copied.");
      }
    } catch (err) {
      say(err?.message || "Something went wrong.");
    }
  });
}

function viewNotFound() {
  shell(`<div class="empty">Not found. <a href="#/">Back to dashboard</a></div>`);
}

function wireRowLinks(view) {
  view.querySelectorAll("tr.rowlink").forEach((tr) => {
    tr.onclick = () => (location.hash = tr.dataset.href);
  });
}

// ---------- public share mode ------------------------------------------------
// Served at /share/<slug> via the SPA fallback: a read-only view of one user's
// history for anyone with the link (no sign-in). Hash-routes within the page.

// /share/<slug> is the logbook; /share/<slug>/wrapped/<year> is one season's
// Wrapped (NS-36), which renders the story and ignores the hash routes.
const SHARE_MATCH = location.pathname.match(/^\/share\/([^/]+)(?:\/wrapped\/(\d{4}))?\/?$/) || [];
const SHARE_SLUG = SHARE_MATCH[1];
const SHARE_WRAPPED_YEAR = SHARE_MATCH[2] ? Number(SHARE_MATCH[2]) : null;
let shareData = null;

function shareShell(content) {
  $app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/">${appLogoHtml()} Track Evolution</a>
        <span class="share-badge">Read-only shared view</span>
        <span class="spacer"></span>
        ${themeToggleHtml()}
        <a class="btn small" href="/">Track your own laps</a>
      </div>
    </header>
    <div class="shell">
      <div id="view">${content}</div>
      ${footerHtml({ legal: true })}
    </div>`;
  wireThemeToggle();
  return document.getElementById("view");
}

function shareEventRows(events, { withTrack = false } = {}) {
  return events
    .map(
      (e) => `<tr${withTrack ? ` class="rowlink" data-href="#/track/${e.track_id}"` : ""}>
        <td class="date">${fmtDate(e.start_date)}</td>
        ${withTrack ? `<td>${esc(e.track_name)}</td>` : ""}
        <td>${e.days}</td>
        <td>${esc(e.club ?? "")}</td>
        <td>${esc(e.run_group ?? "")}</td>
        <td>${esc(e.car ?? "")}</td>
        <td>${fmtConditions(e)}</td>
        <td class="num">${fmtMs(e.best_ms)}</td>
        <td class="num">${fmtConsistency(e.consistency)}</td>
      </tr>`
    )
    .join("");
}

function shareDashboard() {
  const { name, totals, tracks, events } = shareData;
  const withData = tracks
    .filter((t) => t.event_count > 0)
    .sort((a, b) => (b.last_date || "").localeCompare(a.last_date || ""));

  const cards = withData
    .map(
      (t) => `<a class="card" href="#/track/${t.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · ${fmtDate(t.last_date)}</div>
      </a>`
    )
    .join("");

  const view = shareShell(`
    <h1>${esc(name || "Driver")} — Track Evolution</h1>
    <p class="sub">Track-day and HPDE history, shared read-only.</p>
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${totals.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${totals.track_days}</div></div>
      <div class="tile"><div class="label">Tracks</div><div class="value">${withData.length}</div></div>
    </div>
    <div class="btn-row"><a class="btn small" href="#/year">Year in review</a></div>
    <h2>Tracks</h2>
    ${cards ? `<div class="cards">${cards}</div>` : `<div class="empty">No events shared yet.</div>`}
    ${events.length ? `<h2>All events</h2>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Track</th><th>Days</th><th>Club</th><th>Group</th><th>Car</th><th>Conditions</th><th class="num">Best</th><th class="num">Consistency</th></tr></thead>
    <tbody>${shareEventRows(events, { withTrack: true })}</tbody></table></div>` : ""}
  `);
  wireRowLinks(view);
}

function shareYear(params) {
  const view = shareShell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← Overview</a></p>
    ${yearReviewHtml(shareData.events, Number(params.get("y")), "#/year", {
      href: (y) => `/share/${encodeURIComponent(SHARE_SLUG)}/wrapped/${y}`,
      whose: shareData.name ? `${shareData.name}'s` : "the",
    })}
  `);
  wireRowLinks(view);
}

function shareTrack(trackId) {
  const track = shareData.tracks.find((t) => String(t.id) === String(trackId));
  if (!track) {
    shareShell(`<div class="empty">Not found. <a href="#/">Back</a></div>`);
    return;
  }
  const events = shareData.events.filter((e) => String(e.track_id) === String(trackId));
  const chrono = [...events].reverse().filter((e) => e.best_ms != null);
  const points = chrono.map((e) => ({
    x: new Date(e.start_date).getTime(),
    y: e.best_ms,
    xlabel: fmtDate(e.start_date),
    tip: `${fmtDate(e.start_date)}${e.club ? " · " + e.club : ""}${fmtConditions(e) ? " · " + fmtConditions(e) : ""}`,
  }));
  // Same conditions band as the signed-in track page (#191): the share payload
  // carries the event's ambient range, which is weather rather than anything
  // the driver wrote down.
  const band = conditionsBand(chrono);
  const chart = points.length
    ? lineChart(points, {
        goal: track.goal_ms,
        bands: band ? { cells: band.cells, label: bandLabel(band, usUnits()) } : null,
      })
    : null;
  const elevM = trackElevationM(events);
  const bests = events.map((e) => e.best_ms).filter((v) => v != null);
  const pb = bests.length ? Math.min(...bests) : null;

  const view = shareShell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← All tracks</a></p>
    <h1>${esc(track.name)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong> · ${events.length} event${events.length === 1 ? "" : "s"}${elevM != null ? ` · ${esc(elevationText(elevM, usUnits()))}` : ""}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — <span class="dir">down is faster</span></div><div class="chart-wrap" id="chart">${chart.svg}</div>${conditionsLegendHtml(band)}</div>` : ""}
    <h2>Events</h2>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Days</th><th>Club</th><th>Group</th><th>Car</th><th>Conditions</th><th class="num">Best</th><th class="num">Consistency</th></tr></thead>
    <tbody>${shareEventRows(events)}</tbody></table></div>
  `);
  if (chart) chart.bind(view.querySelector("#chart"));
}

function shareNotFound(heading, text) {
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="flag">${appLogoHtml("lg")}</div>
        <h1>${esc(heading)}</h1>
        <p>${esc(text)}</p>
        <a class="btn primary" href="/">Go to Track Evolution</a>
        ${footerHtml({ legal: true })}
      </div>
    </div>`;
}

// A shared season: the same story as the owner's, through the same renderer,
// with the free card set the public API serves — no Pro cards, locked or not.
async function shareWrapped(year) {
  const slug = encodeURIComponent(SHARE_SLUG);
  const res = await fetch(`/api/share/${slug}/wrapped/${year}`);
  if (!res.ok) {
    shareNotFound("Nothing to show", "This season isn't shared, or the link has been disabled.");
    return;
  }
  const data = await res.json();
  document.title = `${data.name || "A driver"}'s ${data.year} — Track Evolution`;
  const view = shareShell(
    wrappedStoryHtml(data, {
      units: currentUnits(),
      share: true,
      closeHref: `/share/${slug}`,
      yearPickerHtml: wrappedYearPicker(data.years, data.year, (y) => `/share/${slug}/wrapped/${y}`),
      posterActionsHtml: `<div class="wr-actions">
        <div class="btn-row">
          <a class="btn small primary" href="/">Track your own laps</a>
          <a class="btn small" href="/share/${slug}">${data.name ? `${esc(data.name)}'s` : "Their"} logbook →</a>
        </div>
      </div>`,
    })
  );
  bindWrappedStory(view.querySelector("#wrapped-story"));
}

async function shareRoute() {
  if (SHARE_WRAPPED_YEAR) return shareWrapped(SHARE_WRAPPED_YEAR);
  if (!shareData) {
    const res = await fetch(`/api/share/${encodeURIComponent(SHARE_SLUG)}`);
    if (!res.ok) {
      shareNotFound("Link not found", "This share link doesn't exist or has been disabled.");
      return;
    }
    shareData = await res.json();
    document.title = `${shareData.name || "Driver"} — Track Evolution`;
  }
  const [sharePath, shareQuery] = (location.hash || "#/").slice(1).split("?");
  const shareParams = new URLSearchParams(shareQuery || "");
  const parts = sharePath.split("/").filter(Boolean);
  if (parts[0] === "track" && parts[1]) return shareTrack(parts[1]);
  if (parts[0] === "year") return shareYear(shareParams);
  shareDashboard();
}

// ---------- router ----------------------------------------------------------

// Skeleton placeholder while the next route's data loads. Only rendered on
// hash navigation (not in-place refreshes after edits, where a flash would be
// worse than the wait), and only when a previous render left a #view to fill.
function showSkeleton() {
  const v = document.getElementById("view");
  if (!v) return;
  v.innerHTML = `
    <div class="tiles skeleton" aria-hidden="true">
      ${'<div class="tile"><div class="sk-line w40"></div><div class="sk-line big"></div></div>'.repeat(3)}
    </div>
    <div class="cards skeleton" aria-hidden="true">
      ${'<div class="card"><div class="sk-line w40"></div><div class="sk-line big"></div><div class="sk-line w70"></div></div>'.repeat(3)}
    </div>`;
}

async function route() {
  const hash = location.hash || "#/";
  try {
    await ensureMe();
  } catch (err) {
    // A 401 already rendered the login view; anything else means the server
    // never answered (offline, server down) — show that instead
    // of a blank page.
    if (err.message !== "unauthorized") renderUnreachable(err);
    return;
  }
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts.length === 0) return await viewDashboard();
    if (parts[0] === "track" && parts[1] && parts[2] === "compare") return await viewCompare(parts[1], params);
    if (parts[0] === "track" && parts[1] && parts[2] === "lap-compare") return await viewLapCompare(parts[1], params);
    if (parts[0] === "track" && parts[1] && parts[2] === "leaderboard" && parts[3])
      return await viewLeaderboardLap(parts[1], parts[3], params);
    if (parts[0] === "track" && parts[1] && parts[2] === "leaderboard") return await viewLeaderboard(parts[1]);
    if (parts[0] === "track" && parts[1]) return await viewTrack(parts[1], params);
    if (parts[0] === "event" && parts[1] && parts[2] === "edit") return await viewEventForm(parts[1]);
    if (parts[0] === "event" && parts[1]) return await viewEvent(parts[1]);
    if (parts[0] === "garage") return await viewGarage();
    if (parts[0] === "vehicle" && parts[1]) return await viewVehicle(parts[1]);
    if (parts[0] === "new") return await viewEventForm(null, params.get("track"));
    if (parts[0] === "year") return await viewYear(params);
    if (parts[0] === "wrapped") return await viewWrapped(parts[1]);
    if (parts[0] === "settings") return await viewSettings();
    viewNotFound();
  } catch (err) {
    if (err.message !== "unauthorized") {
      shell(`<div class="error-banner">${esc(err.message)}</div><a href="#/">Back to dashboard</a>`);
    }
  }
}

if (SHARE_SLUG) {
  window.addEventListener("hashchange", shareRoute);
  shareRoute();
} else {
  window.addEventListener("hashchange", () => {
    showSkeleton();
    route();
  });
  route();
}

// Pull-to-refresh (touch devices): re-run the current route's fetches in
// place — no skeleton, same as the post-edit refreshes. On share pages the
// cached payload is dropped so the pull re-fetches, not just re-renders.
initPullRefresh({
  chevronHtml: ssBars("", "var(--accent-ink)"),
  onRefresh: () => {
    if (SHARE_SLUG) {
      shareData = null;
      return shareRoute();
    }
    return route();
  },
});
