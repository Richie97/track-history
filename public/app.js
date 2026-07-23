// SPA entry: shell, hash router and views. Pure helpers live in js/*.js so
// they can be unit-tested; this module owns the DOM and app state.

import { esc, fmtMs, parseTime, parseLapList, fmtDate, fmtConsistency, fmtDelta } from "./js/format.js";
import { lineChart, multiLineChart } from "./js/chart.js";
import { bindChannelGraphs } from "./js/channel-graphs.js";
import { bestNAvg, paceSlope, warmupLapCount } from "./js/lap-stats.js";
import { yearsAvailable, yearReview } from "./js/year-review.js";
import { api as apiFetch, authFetch, ApiError } from "./js/api.js";
import { clearFailed, clearOffline, onSyncChange, pendingCount, resolveId, syncStatus } from "./js/offline.js";
import { scheduleWarm } from "./js/prefetch.js";
import { platform } from "./js/platform.js";
import { confettiBurst, detectPB } from "./js/celebrate.js";
import { renderTrackMap } from "./js/trackmap.js";
import { themeToggleHtml, wireThemeToggle } from "./js/theme.js";
import { bindTelemetryImport } from "./js/import/ui.js";
import {
  AXLE_KEYS, CORNER_KEYS, PART_KINDS, PART_REFS, SETUP_FIELDS, WEAR_LIMIT_HINTS,
  diffSetups, flatLabel, fmtCost, fmtHours, fmtRemaining, partKindLabel, partStatus,
} from "./js/garage.js";
import { activeEventId, bindRecorder, isRecording, pendingRecording, recorderAvailable } from "./js/record/ui.js";
import { initRemoteRecorder } from "./js/record/remote.js";
import { initPullRefresh } from "./js/pull-refresh.js";

const $app = document.getElementById("app");

// Host shown in share URLs — the server's, not the WebView's (which would be
// capacitor://localhost inside the native apps).
const serverHost = () => new URL(platform.serverOrigin()).host;

// Native shells open external links in the system browser; a plain WebView
// navigation would replace the app with no way back. No-op on web
// (openExternal is null) — the default target="_blank" behavior stands.
document.addEventListener("click", (ev) => {
  if (!platform.openExternal) return;
  const a = ev.target.closest?.('a[target="_blank"]');
  if (a && /^https?:\/\//.test(a.href)) {
    ev.preventDefault();
    platform.openExternal(a.href);
  }
});

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
const fmtConditions = (e) =>
  [condLabel(e.conditions), e.temp_f != null ? `${e.temp_f}°F` : ""].filter(Boolean).join(" · ");

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

// collapsible renders a <details> closed by default (the dashboard — a
// glanceable count that expands on tap); without it the chips show outright
// (the vehicle page, where maintenance is the point of the view).
const alertStripHtml = (garage, { collapsible = false } = {}) => {
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
  if (!collapsible)
    return `<div class="panel garage-alerts">
      <span class="ga-icon" aria-hidden="true">🔧</span>
      <div class="ga-body"><strong>Maintenance due</strong>${chips}</div>
    </div>`;
  const due = alerts.filter((a) => a.status === "due").length;
  return `<details class="panel garage-alerts">
    <summary>
      <span class="ga-icon" aria-hidden="true">🔧</span>
      <span class="ga-count${due ? " has-due" : ""}">${alerts.length} maintenance reminder${alerts.length === 1 ? "" : "s"}</span>
      <span class="ga-caret" aria-hidden="true">▸</span>
    </summary>
    ${chips}
  </details>`;
};

// Compact spec-sheet rendering of a setup: one box per field group, values
// that differ from `prev` highlighted. prev=null renders without highlights.
function setupSheetHtml(sheet, prev, partsById) {
  const changed = new Set(diffSetups(prev, sheet).map((d) => d.key));
  const sv = (key, value) =>
    `<span class="sv${changed.has(key) && prev ? " changed" : ""}">${esc(String(value))}</span>`;
  const boxes = [];
  for (const f of SETUP_FIELDS) {
    if (f.shape === "number") {
      if (sheet[f.key] == null) continue;
      boxes.push(
        `<div class="setup-box"><span class="sb-label">${f.label}${f.unit ? ` <em>${f.unit}</em>` : ""}</span>
         <span class="sb-vals">${sv(f.key, sheet[f.key])}</span></div>`
      );
      continue;
    }
    const group = sheet[f.key];
    if (!group) continue;
    const keys = f.shape === "corners" ? CORNER_KEYS : AXLE_KEYS;
    const vals = keys
      .filter(([k]) => group[k] != null)
      .map(([k, lbl]) => `<span class="sv-wrap" title="${f.label} ${lbl}">${sv(`${f.key}.${k}`, group[k])}</span>`);
    if (!vals.length) continue;
    boxes.push(
      `<div class="setup-box"><span class="sb-label">${f.label}${f.unit ? ` <em>${f.unit}</em>` : ""}</span>
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
  const val = (root, sub) => {
    const v = sub ? sheet?.[root]?.[sub] : sheet?.[root];
    return v ?? "";
  };
  const fields = SETUP_FIELDS.map((f) => {
    if (f.shape === "number")
      return `<div class="field"><label>${f.label}${f.unit ? ` (${f.unit})` : ""}</label>
        <input name="sf:${f.key}" type="number" step="${f.step}" inputmode="decimal" value="${val(f.key)}"></div>`;
    const keys = f.shape === "corners" ? CORNER_KEYS : AXLE_KEYS;
    return `<div class="field"><label>${f.label}${f.unit ? ` (${f.unit})` : ""}</label>
      <div class="setup-inputs ${f.shape}">${keys
        .map(
          ([k, lbl]) =>
            `<input name="sf:${f.key}.${k}" type="number" step="${f.step}" inputmode="decimal"
               placeholder="${lbl}" aria-label="${f.label} ${lbl}" value="${val(f.key, k)}">`
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
    const v = PART_REFS.some(([k]) => k === root) ? Math.round(num) : num;
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
    return String(v);
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

const DEFAULT_CHECKLIST = [
  "Tech inspection",
  "Torque lug nuts",
  "Check brake pads & fluid",
  "Set tire pressures",
  "Top off fuel",
  "Pack helmet & gloves",
  "Empty the car — remove loose items",
  "Charge camera / lap timer",
];

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
  // The native apps skip the footer entirely: its links (repo, tip jar — the
  // latter barred on iOS by Apple guideline 3.1.1, and the rest web-oriented
  // chrome) don't belong in an app screen. Privacy/terms live in Settings.
  if (platform.native) return "";
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

// The login screen is static HTML but the Apple button depends on server
// config (a self-hosted instance may not carry Apple credentials), so it's
// injected only after the server says it offers the provider. Errors are
// swallowed: an unreachable server still gets a working Google-only screen.
async function showAppleLoginIfAvailable() {
  try {
    const res = await fetch(`${platform.apiBase}/auth/providers`);
    if (!res.ok) return;
    const { apple } = await res.json();
    const slot = document.querySelector(".login-buttons");
    if (!apple || !slot || document.getElementById("apple-login")) return;
    slot.insertAdjacentHTML(
      "beforeend",
      platform.login
        ? `<button class="btn apple" id="apple-login">${APPLE_LOGO} Sign in with Apple</button>`
        : `<a class="btn apple" id="apple-login" href="/auth/apple/login">${APPLE_LOGO} Sign in with Apple</a>`
    );
    if (platform.login) {
      document.getElementById("apple-login").addEventListener("click", () => platform.login("apple"));
    }
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
          ${
            platform.login
              ? `<button class="btn primary" id="native-login">Sign in with Google</button>`
              : `<a class="btn primary" href="/auth/login">Sign in with Google</a>`
          }
        </div>
        ${footerHtml({ legal: true })}
      </div>
    </div>`;
  document.getElementById("native-login")?.addEventListener("click", () => platform.login());
  showAppleLoginIfAvailable();
}

// Rendered when the server can't be reached at all (offline, bad server URL
// in the native app, or a server missing the app's API) — without this the
// boot fetch failing would leave a blank page.
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
        ${
          platform.openServerSettings
            ? `<p class="hint" style="margin-top:12px"><a href="#" id="server-settings">Server: ${esc(serverHost())}</a></p>`
            : ""
        }
        ${footerHtml({ legal: true })}
      </div>
    </div>`;
  wireThemeToggle();
  document.getElementById("retry-connect").onclick = () => route();
  document.getElementById("server-settings")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    platform.openServerSettings();
  });
}

function shell(content) {
  const me = state.me;
  $app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/">${appLogoHtml()} Track Evolution</a>
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
  const trigger = document.getElementById("user-trigger");
  const dropdown = document.getElementById("user-dropdown");
  trigger.onclick = () => {
    const open = dropdown.hidden;
    dropdown.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  document.getElementById("logout").onclick = async () => {
    if (pendingCount() && !confirm("You have offline changes that haven't synced yet — signing out discards them. Sign out anyway?")) return;
    await platform.logout();
    // Delete the service worker's cached API responses (named th-data-* in
    // sw.js) so the logbook doesn't linger in Cache Storage on a shared device.
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("th-data")).map((k) => caches.delete(k)));
    }
    // Same reasoning for the offline layer's response cache and write queue.
    await clearOffline();
    renderLogin();
  };
  return document.getElementById("view");
}

const state = { me: null, totals: null };

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
}

// --- dashboard ---

async function viewDashboard() {
  const [tracks, events, garage] = await Promise.all([api("/tracks"), api("/events"), api("/garage")]);
  const withData = tracks.filter((t) => t.event_count > 0).sort((a, b) => (b.last_date || "").localeCompare(a.last_date || ""));
  const upcoming = events.filter(isUpcoming).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const recent = events.filter((e) => !isUpcoming(e)).slice(0, 6);

  const cards = withData
    .map((t) => {
      const spark =
        t.series.length >= 2
          ? lineChart(t.series.map((p, i) => ({ x: i, y: p.best_ms })), { width: 220, height: 44, sparkline: true }).svg
          : "";
      return `<a class="card" href="#/track/${t.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · ${fmtDate(t.last_date)}</div>
        ${spark}
      </a>`;
    })
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

  const recentRows = recent
    .map(
      (e) => `<tr class="rowlink" data-href="#/event/${e.id}">
        <td class="date">${fmtDate(e.start_date)}</td>
        <td>${esc(e.track_name)}</td>
        <td>${esc(e.club ?? "")}</td>
        <td class="num">${fmtMs(e.best_ms)}</td>
      </tr>`
    )
    .join("");

  // Garage cards: hours accrued, what's in service, and the loudest wear
  // status per vehicle.
  const garageCards = garage
    .map((v) => {
      const active = v.parts.filter((p) => !p.retired_on);
      const statuses = active.map((p) => partStatus(p.wear));
      const worst = statuses.includes("due") ? "due" : statuses.includes("low") ? "low" : "ok";
      const alertCount = statuses.filter((s) => s === "due" || s === "low").length;
      return `<a class="card" href="#/vehicle/${v.id}">
        <div class="name">${esc(v.name)}</div>
        <div class="best garage-hours">${fmtHours(v.hours)}</div>
        <div class="meta">${v.event_days} track day${v.event_days === 1 ? "" : "s"} · ${active.length} part${active.length === 1 ? "" : "s"} in service</div>
        <div class="meta garage-status ${worst}">${
          alertCount
            ? `● ${alertCount} item${alertCount === 1 ? "" : "s"} due soon`
            : active.length
              ? "● consumables OK"
              : "no consumables tracked yet"
        }</div>
      </a>`;
    })
    .join("");

  // Native apps: a recording that no event page can reach — active or stopped
  // with no event attached (CarPlay can start one before the event exists), or
  // stopped-but-unsaved — is surfaced here so it can't be forgotten.
  let recBanner = "";
  if (recorderAvailable()) {
    const pending = isRecording() ? null : await pendingRecording();
    const banner = (title, hint, href, label) => `<div class="panel" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:20px">
      <span style="font-size:22px" aria-hidden="true">⏱️</span>
      <div style="flex:1;min-width:200px"><strong>${title}</strong><div class="hint">${hint}</div></div>
      <a class="btn primary" href="${href}">${label}</a>
    </div>`;
    if (isRecording() && activeEventId() == null) {
      recBanner = banner(
        "● Recording track session",
        "No event for today yet — create it now or after you stop; the recording attaches when you open the event.",
        "#/new",
        "+ Add event"
      );
    } else if (pending && pending.eventId == null) {
      recBanner = banner(
        "Unsaved track recording",
        "Create its event to pick the start/finish line and save the laps.",
        "#/new",
        "+ Add event"
      );
    } else if (pending) {
      recBanner = banner(
        "Unsaved track recording",
        "Review it to save the laps to its event, or discard it.",
        `#/event/${esc(String(pending.eventId))}/record`,
        "Review & save"
      );
    }
  }

  const slug = state.me.share_slug || "";
  const view = shell(`
    ${recBanner}
    <div class="btn-row" style="margin-top:20px">
      <a class="btn primary" href="#/new">+ Add event</a>
      <a class="btn" href="#/year">Year in review</a>
    </div>
    ${alertStripHtml(garage, { collapsible: true })}
    ${heroEvent ? heroEventHtml(heroEvent) : ""}
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${state.totals.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${state.totals.track_days}</div></div>
      <div class="tile"><div class="label">Tracks</div><div class="value">${withData.length}</div></div>
    </div>
    ${upcomingCards ? `<h2>Also upcoming</h2><div class="cards">${upcomingCards}</div>` : ""}
    <h2>Tracks</h2>
    ${cards ? `<div class="cards">${cards}</div>` : `<div class="empty">No events yet — add your first track day.</div>`}
    ${garageCards ? `<h2>Garage</h2><div class="cards">${garageCards}</div>` : ""}
    ${recent.length ? `<h2>Recent events</h2>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Track</th><th>Club</th><th class="num">Best</th></tr></thead>
    <tbody>${recentRows}</tbody></table></div>` : ""}
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
        ${platform.shareLink ? `<button class="btn small" id="share-sheet">Share…</button>` : ""}
        <a class="btn small ghost" href="${esc(platform.serverOrigin())}/share/${esc(slug)}" target="_blank" rel="noopener">Open ↗</a>
        <button class="btn small danger" id="share-disable">Disable</button>` : ""}
      </div>
      <div id="share-msg" class="hint" style="margin-top:6px"></div>
    </div>
  `);
  wireRowLinks(view);
  // Warm the offline cache in the background while we're on the dashboard.
  scheduleWarm();

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
    const shareUrl = `${platform.serverOrigin()}/share/${slug}`;
    view.querySelector("#share-copy").onclick = async () => {
      await platform.copyText(shareUrl);
      shareMsg.textContent = "Link copied.";
    };
    const shareSheet = view.querySelector("#share-sheet");
    if (shareSheet) shareSheet.onclick = () => platform.shareLink(shareUrl);
    view.querySelector("#share-disable").onclick = async () => {
      if (!confirm("Disable your public share link? The URL will stop working.")) return;
      await api("/share", { method: "DELETE" });
      state.me.share_slug = null;
      route();
    };
  }
}

// --- track detail ---

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
  const chart = points.length ? lineChart(points, { goal: track.goal_ms }) : null;

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

  // Comparing two events lap-by-lap needs recorded laps on both sides.
  // Event selection lives on the compare screen itself.
  const comparable = allEvents.filter((e) => e.lap_count > 0);
  const compareControl =
    comparable.length >= 2
      ? `<div class="btn-row" style="margin-top:10px">
          <a class="btn small" href="#/track/${trackId}/compare">Compare two events</a>
        </div>`
      : "";

  const shareBtn = state.me.share_slug
    ? `<button class="btn" id="share-track">Copy share link</button>`
    : "";

  const view = shell(`
    <h1>${esc(track.name)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong>${dryOnly ? " (dry)" : ""} · ${events.length} event${events.length === 1 ? "" : "s"}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — <span class="dir">down is faster</span>${dryToggle}</div><div class="chart-wrap" id="chart">${chart.svg}</div>${goalControl}${compareControl}</div>` : `<div class="chart-card">${dryToggle}${goalControl}</div>`}
    <div class="btn-row">
      <a class="btn primary" href="#/new?track=${encodeURIComponent(track.name)}">+ Add event at ${esc(track.name)}</a>
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
    ${setupHistoryHtml(trackSetups, garagePartsById(garage))}
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
      const url = `${platform.serverOrigin()}/share/${state.me.share_slug}#/track/${track.id}`;
      if (platform.shareLink) platform.shareLink(url);
      else {
        await platform.copyText(url);
        view.querySelector("#track-msg").textContent = "Share link copied.";
      }
    };

  wireRowLinks(view);
}

// --- lap overlay: two events at one track, lap-by-lap ---

async function viewCompare(trackId, params) {
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

// --- event detail ---

// Track best as of the previous render, so a re-render after adding laps /
// importing telemetry can tell "new personal best" from "just another save".
let pbWatch = null;

// Event ids whose setup notebook is expanded — collapsed by default, but the
// route() re-render after saving a sheet must not snap it shut mid-session.
const setupNotebookOpen = new Set();

async function viewEvent(eventId) {
  const [e, tracks, garage] = await Promise.all([api(`/events/${eventId}`), api("/tracks"), api("/garage")]);
  // Live lap recorder entry (native apps only — recorderAvailable() is false
  // on web). The button doubles as the way back into an active recording and
  // the recovery path for an unsaved one.
  let recCta = "";
  if (recorderAvailable()) {
    const pending = isRecording() ? null : await pendingRecording();
    // An active recording with no event yet (started from CarPlay) is offered
    // to this event — opening the record screen adopts it.
    const otherEvent = isRecording() && activeEventId() != null && activeEventId() !== e.id;
    const recLabel = isRecording()
      ? otherEvent
        ? "Recording (other event)"
        : activeEventId() === e.id
          ? "Recording — open"
          : "Recording — attach to this event"
      : pending
        ? "Review unsaved recording"
        : "Start recording";
    const recHref = otherEvent ? `#/event/${activeEventId()}/record` : `#/event/${e.id}/record`;
    recCta = `<div class="panel" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-size:22px" aria-hidden="true">⏱️</span>
      <div style="flex:1;min-width:200px">
        <strong>Record laps with your phone</strong>
        <div class="hint">Start before heading out, stow the phone, stop back in the paddock — laps are timed from GPS.</div>
      </div>
      <a class="btn ${isRecording() || pending ? "primary" : ""}" href="${recHref}">${recLabel}</a>
    </div>`;
  }
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
      return `<div class="session">
        <div class="s-head">
          <span class="s-label">${esc(s.label || "Session")}</span>
          <span class="s-best">${best != null ? `best <span class="t">${fmtMs(best)}</span> · ${s.laps.length} lap${s.laps.length === 1 ? "" : "s"}` : "no laps"}</span>
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
  const traceHtml = traceSession
    ? `<div class="chart-card">
        <div class="chart-title">Best lap trace — <span class="dir">brighter is faster</span>
          <span class="trackmap-lap">${fmtMs(Math.min(...traceSession.laps.map((l) => l.time_ms)))}</span></div>
        <div class="trackmap-wrap"><canvas id="trackmap" role="img" aria-label="Racing line of the best lap, colored by speed"></canvas></div>
        <div class="trackmap-legend"><span>slow</span><span class="ramp" aria-hidden="true"></span><span>fast</span></div>
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
  const setupNotebookHtml = `
    <details class="setup-notebook" id="setup-notebook"${setupNotebookOpen.has(e.id) ? " open" : ""}>
      <summary>
        <h2>Setup notebook</h2>
        <span class="ga-count">${
          sheetCount
            ? `${sheetCount} day sheet${sheetCount === 1 ? "" : "s"}`
            : "pressures, alignment, dampers…"
        }</span>
        <span class="ga-caret" aria-hidden="true">▸</span>
      </summary>
      ${sheetCount && setupDays.length > 1 ? `<div class="hint" style="margin:0 0 4px">Values <span class="sv changed">highlighted</span> changed from the previous day.</div>` : ""}
      ${setupDays.map(setupDayHtml).join("")}
      ${
        !e.vehicle_id && garage.length
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
          ${!checklist?.length ? `<button class="btn small" id="check-default">Use default list</button>` : ""}
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
    </div>
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
    ${recCta}
    <div class="pdr-dropzone" id="pdr-dropzone">
      ${
        // iOS Files maps accept= to UTIs and .vbo matches none, which would
        // grey out VBO files entirely — so no accept filter on iOS.
        platform.native && platform.os === "ios"
          ? `<input type="file" id="pdr-files" multiple hidden>`
          : `<input type="file" id="pdr-files" accept="video/mp4,.mp4,.vbo" multiple hidden>`
      }
      <div class="pdr-dropzone-inner">
        <span class="pdr-dropzone-icon">📼</span>
        <div>
          <button class="btn" id="pdr-import" type="button">Import video / telemetry…</button>
          ${platform.native ? "" : `<span class="pdr-dropzone-hint">or drag &amp; drop <code>.mp4</code> / <code>.vbo</code> files here</span>`}
        </div>
        <span class="hint" style="font-size:12px;color:var(--text-muted)">Reads lap times from Corvette PDR &amp; GoPro video and Racelogic VBO telemetry — files never leave your ${platform.native ? "device" : "computer"}</span>
      </div>
    </div>
    <div id="pdr-review"></div>
    <form class="panel" id="add-session">
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

  if (traceSession) renderTrackMap(view.querySelector("#trackmap"), traceSession.trace);

  if (pb) {
    const banner = view.querySelector("#pb-banner");
    view.querySelector("#pb-dismiss").onclick = () => banner.remove();
    const r = banner.getBoundingClientRect();
    confettiBurst(r.left + r.width / 2, r.top + 40);
    platform.hapticPB();
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
      useDefault.onclick = () => saveChecklist(DEFAULT_CHECKLIST.map((text) => ({ text, done: false })));
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
    if (s) bindChannelGraphs(el, s.channels, s.laps);
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

// --- live lap recorder (native apps) ---

async function viewRecord(eventId) {
  if (!recorderAvailable()) {
    shell(`<div class="error-banner">Lap recording is only available in the iOS/Android app.</div>
      <a href="#/event/${esc(eventId)}">Back to event</a>`);
    return;
  }
  const e = await api(`/events/${eventId}`);
  const view = shell(`
    <h1>Record session</h1>
    <p class="sub">${esc(e.track_name)} — ${fmtDate(e.start_date)}</p>
    <div id="rec-panel"></div>
    <div id="rec-review"></div>
    <div class="btn-row" style="margin-top:16px"><a class="btn ghost" href="#/event/${e.id}">Back to event</a></div>
  `);
  // Saving lands the new session on the event page.
  bindRecorder(view, e, () => {
    location.hash = `#/event/${e.id}`;
  });
}

// --- event form (new / edit) ---

// Custom combobox for the track and car fields. A native <datalist> would be
// simpler, but iOS Safari never shows datalist suggestions and Android only
// surfaces a few after typing — so we render our own tappable option list.
function bindCombo(input, list, options) {
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

  const open = () => {
    const q = input.value.trim().toLowerCase();
    matches = q ? options.filter((n) => n.toLowerCase().includes(q)) : options;
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
    else if (e.key === "Enter" && active >= 0) { input.value = matches[active]; close(); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  // pointerdown (not click) so selection wins the race against the input's blur,
  // and preventDefault keeps focus in the field after tapping an option.
  list.addEventListener("pointerdown", (e) => {
    const item = e.target.closest(".combo-item");
    if (!item) return;
    e.preventDefault();
    input.value = matches[Number(item.dataset.i)];
    close();
  });
  input.addEventListener("blur", close);
}

async function viewEventForm(eventId, presetTrack) {
  const [tracks, catalog, vehicles] = await Promise.all([
    api("/tracks"),
    api("/catalog"),
    api("/vehicles"),
  ]);
  const existing = eventId ? await api(`/events/${eventId}`) : null;
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
          <div class="hint">Pick from your garage or type anything — manage cars in <a href="#/settings">Settings → Vehicles</a></div>
        </div>
        <div class="field"><label>Conditions</label>
          <select name="conditions">
            <option value="">—</option>
            ${CONDITIONS.map(([v, l]) => `<option value="${v}"${existing?.conditions === v ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Temp °F (optional)</label>
          <input name="temp_f" type="number" min="-40" max="150" step="1" value="${existing?.temp_f ?? ""}" placeholder="72">
        </div>
        <div class="field"><label>Best time (optional)</label>
          <input name="best_time" value="${existing?.best_time_ms != null ? fmtMs(existing.best_time_ms) : ""}" placeholder="2:01.24">
          <div class="hint">Only needed when you don't log laps — logged laps compute this automatically</div>
        </div>
      </div>
      <div class="field"><label>Notes</label>
        <textarea name="notes" placeholder="Weather, setup changes, incidents…">${esc(existing?.notes ?? "")}</textarea>
      </div>
      <div id="form-error"></div>
      <div class="btn-row">
        <button class="btn primary">${existing ? "Save changes" : "Create event"}</button>
        <a class="btn" href="${existing ? `#/event/${existing.id}` : "#/"}">Cancel</a>
      </div>
    </form>
  `);

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
      temp_f: tempRaw === "" ? null : Math.round(Number(tempRaw)),
      notes: f.notes.value.trim() || null,
      best_time_ms: best,
    };
    try {
      if (existing) {
        await api(`/events/${existing.id}`, { method: "PUT", body });
        location.hash = `#/event/${existing.id}`;
      } else {
        const created = await api("/events", { method: "POST", body });
        location.hash = `#/event/${created.id}`;
      }
    } catch (err) {
      view.querySelector("#form-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  };
}

// --- settings (garage + legal) ---

async function viewSettings() {
  const vehicles = await api("/vehicles");

  const vehicleHtml = (v) => `
    <div class="panel vehicle">
      <div class="vehicle-head">
        <span class="vehicle-name">${esc(v.name)}</span>
        ${v.is_default ? `<span class="default-badge">Default</span>` : ""}
        <span class="grow"></span>
        <a class="btn small primary" href="#/vehicle/${v.id}">Garage page</a>
        ${v.is_default ? "" : `<button class="btn small" data-veh-default="${v.id}">Set default</button>`}
        <button class="btn small" data-veh-edit="${v.id}">Edit</button>
        <button class="btn small danger" data-veh-del="${v.id}">Delete</button>
      </div>
      ${v.notes ? `<div class="notes-block">${esc(v.notes)}</div>` : ""}
      <form class="vehicle-edit" data-veh-form="${v.id}" hidden>
        <div class="field"><label>Car</label><input name="name" required value="${esc(v.name)}"></div>
        <div class="field"><label>Modifications &amp; notes</label>
          <textarea name="notes" placeholder="Coilovers, pads, tires, alignment…">${esc(v.notes ?? "")}</textarea>
        </div>
        <div class="btn-row">
          <button class="btn small primary">Save</button>
          <button class="btn small" type="button" data-veh-cancel="${v.id}">Cancel</button>
        </div>
      </form>
    </div>`;

  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
    <h1>Settings</h1>
    <h2>Vehicles</h2>
    <div class="hint" style="margin:0 0 4px">Your garage — the event form's Car field suggests these, and the default fills in automatically on new events. Open a car's garage page to track its consumables (pads, tires, fluid…) and see when they'll need replacing.</div>
    ${vehicles.map(vehicleHtml).join("") || `<div class="empty">No cars yet — add your first below.</div>`}
    <form class="panel" id="veh-add">
      <div class="field"><label>Car</label><input name="name" required placeholder="2023 Corvette Z06"></div>
      <div class="field"><label>Modifications &amp; notes</label>
        <textarea name="notes" placeholder="Coilovers, pads, tires, alignment…"></textarea>
      </div>
      <div id="veh-error"></div>
      <button class="btn primary">Add vehicle</button>
    </form>
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

  const showError = (err) => {
    view.querySelector("#veh-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  };

  view.querySelector("#veh-add").onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    try {
      await api("/vehicles", {
        method: "POST",
        body: { name: f.name.value.trim(), notes: f.notes.value.trim() || null },
      });
      route();
    } catch (err) {
      showError(err);
    }
  };
  view.querySelectorAll("[data-veh-default]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/vehicles/${btn.dataset.vehDefault}`, { method: "PUT", body: { is_default: true } });
        route();
      } catch (err) {
        showError(err);
      }
    };
  });
  view.querySelectorAll("[data-veh-del]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this vehicle? Past events keep the car name they were logged with.")) return;
      await api(`/vehicles/${btn.dataset.vehDel}`, { method: "DELETE" });
      route();
    };
  });
  view.querySelectorAll("[data-veh-edit]").forEach((btn) => {
    btn.onclick = () => {
      const form = view.querySelector(`[data-veh-form="${btn.dataset.vehEdit}"]`);
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('[name="name"]').focus();
    };
  });
  view.querySelectorAll("[data-veh-cancel]").forEach((btn) => {
    btn.onclick = () => {
      view.querySelector(`[data-veh-form="${btn.dataset.vehCancel}"]`).hidden = true;
    };
  });
  view.querySelectorAll("[data-veh-form]").forEach((form) => {
    form.onsubmit = async (evt) => {
      evt.preventDefault();
      try {
        await api(`/vehicles/${form.dataset.vehForm}`, {
          method: "PUT",
          body: { name: form.name.value.trim(), notes: form.notes.value.trim() || null },
        });
        route();
      } catch (err) {
        showError(err);
      }
    };
  });
}

// --- vehicle / garage page ---

async function viewVehicle(vehicleId) {
  const [garage, events] = await Promise.all([api("/garage"), api("/events")]);
  const v = garage.find((x) => String(x.id) === String(vehicleId));
  if (!v) return viewNotFound();
  const vehEvents = events.filter((e) => String(e.vehicle_id) === String(v.id) && !isUpcoming(e));
  const active = v.parts.filter((p) => !p.retired_on);
  const retired = v.parts.filter((p) => p.retired_on);
  const spendCents = v.parts.reduce((sum, p) => sum + (p.cost_cents ?? 0), 0);
  const today = todayISO();

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
        <div class="field"><label>Replace at (measured value)</label><input name="wear_limit" type="number" min="0" step="0.5" value="${p.wear_limit ?? ""}" placeholder="${WEAR_LIMIT_HINTS[p.kind] ?? ""}"></div>
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
      ${measurementChips(p)}
      <form class="btn-row meas-form" data-meas-form="${p.id}" hidden>
        <input name="value" type="number" step="0.1" min="0" required placeholder="Value" style="max-width:110px">
        <input name="unit" value="${esc(p.measurements[p.measurements.length - 1]?.unit ?? (p.kind === "tires" ? "32nds" : "mm"))}" placeholder="mm" style="max-width:90px">
        <input name="measured_on" type="date" required value="${today}">
        <button class="btn small primary">Log measurement</button>
        <span class="hint-inline">two or more measurements unlock the wear projection</span>
      </form>
      ${partEditForm(p)}
    </div>`;

  const ledgerRows = vehEvents
    .map(
      (e) => `<tr class="rowlink" data-href="#/event/${e.id}">
        <td class="date">${fmtDate(e.start_date)}</td>
        <td>${esc(e.track_name)}</td>
        <td>${e.days}</td>
        <td class="num">${fmtHours(e.hours)}${e.track_hours == null ? '<span class="hint-inline"> est.</span>' : ""}</td>
      </tr>`
    )
    .join("");

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
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
    <h1>${esc(v.name)}${v.is_default ? ' <span class="default-badge">Default</span>' : ""}</h1>
    ${v.notes ? `<p class="sub">${esc(v.notes)}</p>` : ""}
    ${alertStripHtml([v])}
    <div class="tiles">
      <div class="tile"><div class="label">Track hours</div><div class="value">${fmtHours(v.hours).replace(" h", "")}<span class="unit">h</span></div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${v.event_days}</div></div>
      <div class="tile"><div class="label">Events</div><div class="value">${v.event_count}</div></div>
      <div class="tile"><div class="label">Parts spend</div><div class="value">${spendCents ? fmtCost(spendCents) : "—"}</div></div>
    </div>
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
        <div class="field"><label>Replace at (optional)</label><input name="wear_limit" type="number" min="0" step="0.5" placeholder="3 (mm)"></div>
      </div>
      <div class="field"><label>Notes</label><input name="notes" placeholder="Sizes, torque specs, where bought…"></div>
      <div id="part-error"></div>
      <button class="btn primary">+ Add part</button>
    </form>
    ${retired.length ? `<h2>Retired parts</h2>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Part</th><th>In service</th><th class="num">Hours</th><th class="num">Cost</th><th class="num">Cost/hour</th></tr></thead>
    <tbody>${retiredRows}</tbody></table></div>` : ""}
    ${vehEvents.length ? `<h2>Track-hours ledger</h2>
    <div class="hint" style="margin:0 0 4px">Hours marked <em>est.</em> use the 2h-per-day default — set exact hours on an event's edit form if a day ran long or short.</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Track</th><th>Days</th><th class="num">Hours</th></tr></thead>
    <tbody>${ledgerRows}</tbody></table></div>` : ""}
  `);
  wireRowLinks(view);

  const partError = (err) => {
    view.querySelector("#part-error").innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  };
  const numOrNull = (raw) => (raw.trim() === "" ? null : Number(raw));

  view.querySelector("#part-add").onsubmit = async (evt) => {
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
            unit: form.unit.value.trim() || "mm",
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
function yearReviewHtml(events, year, hashBase) {
  const past = events.filter((e) => !isUpcoming(e));
  const years = yearsAvailable(past);
  if (!years.length) return `<div class="empty">No events yet — nothing to review.</div>`;
  const y = years.includes(year) ? year : years[0];
  const r = yearReview(past, y);

  const picker = years
    .map((v) => (v === y ? `<span class="btn small primary">${v}</span>` : `<a class="btn small" href="${hashBase}?y=${v}">${v}</a>`))
    .join("");

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
      </tr>`;
    })
    .join("");

  return `
    <h1>${y} in review</h1>
    <div class="btn-row" style="margin-top:10px">${picker}</div>
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${r.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${r.days}</div></div>
      <div class="tile"><div class="label">Laps logged</div><div class="value">${r.laps}</div></div>
      <div class="tile"><div class="label">Tracks visited</div><div class="value">${r.tracks_visited}</div></div>
    </div>
    ${r.new_tracks.length ? `<p class="sub">First time at ${r.new_tracks.map((t) => `<strong>${esc(t.track_name)}</strong>`).join(", ")} 🎉</p>` : ""}
    ${gainRows ? `<h2>Lap time progress</h2>
    <div class="table-wrap"><table><thead><tr><th>Track</th><th class="num">Best before ${y}</th><th class="num">Best in ${y}</th><th></th></tr></thead>
    <tbody>${gainRows}</tbody></table></div>` : `<div class="empty">No timed events in ${y}.</div>`}
  `;
}

async function viewYear(params) {
  const events = await api("/events");
  const view = shell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← Dashboard</a></p>
    ${yearReviewHtml(events, Number(params.get("y")), "#/year")}
  `);
  wireRowLinks(view);
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

const SHARE_SLUG = (location.pathname.match(/^\/share\/([^/]+)\/?$/) || [])[1];
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
    .map((t) => {
      const spark =
        t.series.length >= 2
          ? lineChart(t.series.map((p, i) => ({ x: i, y: p.best_ms })), { width: 220, height: 44, sparkline: true }).svg
          : "";
      return `<a class="card" href="#/track/${t.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · ${fmtDate(t.last_date)}</div>
        ${spark}
      </a>`;
    })
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
    ${yearReviewHtml(shareData.events, Number(params.get("y")), "#/year")}
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
    tip: `${fmtDate(e.start_date)}${e.club ? " · " + e.club : ""}`,
  }));
  const chart = points.length ? lineChart(points, { goal: track.goal_ms }) : null;
  const bests = events.map((e) => e.best_ms).filter((v) => v != null);
  const pb = bests.length ? Math.min(...bests) : null;

  const view = shareShell(`
    <p style="margin:22px 0 0"><a class="backlink" href="#/">← All tracks</a></p>
    <h1>${esc(track.name)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong> · ${events.length} event${events.length === 1 ? "" : "s"}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — <span class="dir">down is faster</span></div><div class="chart-wrap" id="chart">${chart.svg}</div></div>` : ""}
    <h2>Events</h2>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Days</th><th>Club</th><th>Group</th><th>Car</th><th>Conditions</th><th class="num">Best</th><th class="num">Consistency</th></tr></thead>
    <tbody>${shareEventRows(events)}</tbody></table></div>
  `);
  if (chart) chart.bind(view.querySelector("#chart"));
}

async function shareRoute() {
  if (!shareData) {
    const res = await authFetch(`/api/share/${encodeURIComponent(SHARE_SLUG)}`);
    if (!res.ok) {
      $app.innerHTML = `
        <div class="login-wrap">
          <div class="login-card">
            <div class="flag">${appLogoHtml("lg")}</div>
            <h1>Link not found</h1>
            <p>This share link doesn't exist or has been disabled.</p>
            <a class="btn primary" href="/">Go to Track Evolution</a>
            ${footerHtml({ legal: true })}
          </div>
        </div>`;
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
    // never answered (offline, wrong server URL, CORS) — show that instead
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
    if (parts[0] === "track" && parts[1]) return await viewTrack(parts[1], params);
    if (parts[0] === "event" && parts[1] && parts[2] === "edit") return await viewEventForm(parts[1]);
    if (parts[0] === "event" && parts[1] && parts[2] === "record") return await viewRecord(parts[1]);
    if (parts[0] === "event" && parts[1]) return await viewEvent(parts[1]);
    if (parts[0] === "vehicle" && parts[1]) return await viewVehicle(parts[1]);
    if (parts[0] === "new") return await viewEventForm(null, params.get("track"));
    if (parts[0] === "year") return await viewYear(params);
    if (parts[0] === "settings") return await viewSettings();
    viewNotFound();
  } catch (err) {
    if (err.message !== "unauthorized") {
      shell(`<div class="error-banner">${esc(err.message)}</div><a href="#/">Back to dashboard</a>`);
    }
  }
}

// Native-shell re-entry points: re-run the router after a system-browser
// sign-in completes, and full-page navigate for /share/<slug> deep links
// (SHARE_SLUG is read from location.pathname at module load, so a reload is
// what re-evaluates it — Capacitor's local server SPA-falls-back like the Worker).
platform.onAuthed = () => {
  showSkeleton();
  route();
};
platform.navigate = (path) => {
  history.pushState({}, "", path);
  location.reload();
};
// Remote start/stop of the lap recorder (the CarPlay scene in the iOS shell).
// Registers platform.recorderRemote; no-op on web, where there's no recorder.
initRemoteRecorder();

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
