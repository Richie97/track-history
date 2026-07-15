// SPA entry: shell, hash router and views. Pure helpers live in js/*.js so
// they can be unit-tested; this module owns the DOM and app state.

import { esc, fmtMs, parseTime, parseLapList, fmtDate, fmtConsistency, fmtDelta } from "./js/format.js";
import { lineChart, multiLineChart } from "./js/chart.js";
import { bestNAvg, paceSlope, warmupLapCount } from "./js/lap-stats.js";
import { yearsAvailable, yearReview } from "./js/year-review.js";
import { api as apiFetch, ApiError } from "./js/api.js";
import { confettiBurst, detectPB } from "./js/celebrate.js";
import { renderTrackMap } from "./js/trackmap.js";
import { themeToggleHtml, wireThemeToggle } from "./js/theme.js";
import { US_TRACKS } from "./js/us-tracks.js";
import { bindTelemetryImport } from "./js/import/ui.js";

const $app = document.getElementById("app");

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

// Config is part of the track identity: "VIR — Full" vs "VIR — Patriot".
const trackLabel = (name, config) => (config ? `${name} — ${config}` : name);

const CONDITIONS = [
  ["dry", "☀️ Dry"],
  ["damp", "🌦️ Damp"],
  ["wet", "🌧️ Wet"],
  ["mixed", "⛅ Mixed"],
];
const condLabel = (c) => (CONDITIONS.find(([v]) => v === c) || [])[1] ?? "";
const fmtConditions = (e) =>
  [condLabel(e.conditions), e.temp_f != null ? `${e.temp_f}°F` : ""].filter(Boolean).join(" · ");

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
      <div class="hero-track">${esc(trackLabel(e.track_name, e.track_config))}</div>
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
const DOCS_URL = "https://docs.trackhistory.app";

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

function footerHtml() {
  startTipRotator();
  return `<footer class="site-footer">
    <span class="footer-left">
      <span>© ${new Date().getFullYear()} Speedshift LLC</span>
      <a class="footer-link" href="${DOCS_URL}/docs/privacy.html" target="_blank" rel="noopener">Privacy</a>
      <a class="footer-link" href="${DOCS_URL}/docs/terms.html" target="_blank" rel="noopener">Terms</a>
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

function renderLogin() {
  document.querySelector(".shell")?.remove();
  $app.innerHTML = `
    <div class="login-wrap">
      <span class="login-toggle">${themeToggleHtml()}</span>
      <div class="login-card">
        <div class="flag">${appLogoHtml("lg")}</div>
        <h1>Track History</h1>
        <p>Lap times, sessions and notes — per track, over time.</p>
        <a class="btn primary" href="/auth/login">Sign in with Google</a>
        ${footerHtml()}
      </div>
    </div>`;
  wireThemeToggle();
}

function shell(content) {
  const me = state.me;
  $app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/">${appLogoHtml()} Track History</a>
        <span class="spacer"></span>
        <div class="user-menu">
          <button class="user-trigger" id="user-trigger" aria-haspopup="menu" aria-expanded="false">
            ${me?.picture ? `<img class="avatar" src="${esc(me.picture)}" alt="">` : ""}
            <span class="who">${esc(me?.name || me?.email || "")}</span>
            <span class="caret" aria-hidden="true">▾</span>
          </button>
          <div class="menu" id="user-dropdown" hidden>
            <div class="menu-row">
              <span class="menu-label">Theme</span>
              ${themeToggleHtml()}
            </div>
            <div class="menu-sep"></div>
            <button class="menu-item" id="logout">Sign out</button>
          </div>
        </div>
      </header>
      <div id="view">${content}</div>
      ${footerHtml()}
    </div>`;
  wireThemeToggle();
  const trigger = document.getElementById("user-trigger");
  const dropdown = document.getElementById("user-dropdown");
  trigger.onclick = () => {
    const open = dropdown.hidden;
    dropdown.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  document.getElementById("logout").onclick = async () => {
    await fetch("/auth/logout", { method: "POST" });
    renderLogin();
  };
  return document.getElementById("view");
}

const state = { me: null, totals: null };

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
  const [tracks, events] = await Promise.all([api("/tracks"), api("/events")]);
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
        <div class="name">${esc(trackLabel(t.name, t.config))}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · last ${fmtDate(t.last_date)}</div>
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
        <div class="name">${esc(trackLabel(e.track_name, e.track_config))}</div>
        <div class="countdown">${fmtCountdown(e.start_date)}</div>
        <div class="meta">${fmtDate(e.start_date)}${e.club ? " · " + esc(e.club) : ""}${cl.length ? ` · checklist ${done}/${cl.length}` : ""}</div>
      </a>`;
    })
    .join("");

  const recentRows = recent
    .map(
      (e) => `<tr class="rowlink" data-href="#/event/${e.id}">
        <td class="date">${fmtDate(e.start_date)}</td>
        <td>${esc(trackLabel(e.track_name, e.track_config))}</td>
        <td>${esc(e.club ?? "")}</td>
        <td class="num">${fmtMs(e.best_ms)}</td>
      </tr>`
    )
    .join("");

  const slug = state.me.share_slug || "";
  const view = shell(`
    <div class="btn-row" style="margin-top:20px">
      <a class="btn primary" href="#/new">+ Add event</a>
      <a class="btn" href="#/year">Year in review</a>
    </div>
    ${heroEvent ? heroEventHtml(heroEvent) : ""}
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${state.totals.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${state.totals.track_days}</div></div>
      <div class="tile"><div class="label">Tracks</div><div class="value">${withData.length}</div></div>
    </div>
    ${upcomingCards ? `<h2>Also upcoming</h2><div class="cards">${upcomingCards}</div>` : ""}
    <h2>Tracks</h2>
    ${cards ? `<div class="cards">${cards}</div>` : `<div class="empty">No events yet — add your first track day.</div>`}
    ${recent.length ? `<h2>Recent events</h2>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Track</th><th>Club</th><th class="num">Best</th></tr></thead>
    <tbody>${recentRows}</tbody></table></div>` : ""}
    <h2>Share your history</h2>
    <div class="panel share-panel">
      <div class="hint" style="margin:0 0 10px">Publish a read-only page of your track history — bests, run groups and consistency (notes stay private). Handy for HPDE run-group placement. Anyone with the link can view it.</div>
      <div class="btn-row">
        <span class="share-url">
          <span class="share-prefix">${esc(location.host)}/share/</span>
          <input id="share-slug" placeholder="your-name" maxlength="32" value="${esc(slug)}" spellcheck="false">
        </span>
        <button class="btn small primary" id="share-save">${slug ? "Update path" : "Create link"}</button>
        ${slug ? `<button class="btn small" id="share-copy">Copy link</button>
        <a class="btn small ghost" href="/share/${esc(slug)}" target="_blank" rel="noopener">Open ↗</a>
        <button class="btn small danger" id="share-disable">Disable</button>` : ""}
      </div>
      <div id="share-msg" class="hint" style="margin-top:6px"></div>
    </div>
  `);
  wireRowLinks(view);

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
    view.querySelector("#share-copy").onclick = async () => {
      await navigator.clipboard.writeText(`${location.origin}/share/${slug}`);
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

async function viewTrack(trackId, params) {
  const [tracks, allEvents] = await Promise.all([api("/tracks"), api(`/events?track_id=${trackId}`)]);
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

  const label = trackLabel(track.name, track.config);
  const view = shell(`
    <h1>${esc(label)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong>${dryOnly ? " (dry)" : ""} · ${events.length} event${events.length === 1 ? "" : "s"}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — <span class="dir">down is faster</span>${dryToggle}</div><div class="chart-wrap" id="chart">${chart.svg}</div>${goalControl}${compareControl}</div>` : `<div class="chart-card">${dryToggle}${goalControl}</div>`}
    <div class="btn-row">
      <a class="btn primary" href="#/new?track=${encodeURIComponent(track.name)}&config=${encodeURIComponent(track.config || "")}">+ Add event at ${esc(label)}</a>
      ${shareBtn}
      <span id="track-msg" class="goal-msg"></span>
    </div>
    <h2>Course notes</h2>
    <div class="panel">
      <div class="form-grid">
        <div class="field"><label>Configuration / layout</label>
          <input id="track-config" value="${esc(track.config ?? "")}" placeholder="Full, Patriot, CCW…">
          <div class="hint">Part of the track's identity — bests and goals don't mix across configs</div>
        </div>
      </div>
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
        body: { config: view.querySelector("#track-config").value, notes: view.querySelector("#track-notes").value },
      });
      msg.textContent = "Saved.";
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  const shareTrack = view.querySelector("#share-track");
  if (shareTrack)
    shareTrack.onclick = async () => {
      await navigator.clipboard.writeText(`${location.origin}/share/${state.me.share_slug}#/track/${track.id}`);
      view.querySelector("#track-msg").textContent = "Share link copied.";
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
    <p style="margin:22px 0 0"><a class="backlink" href="#/track/${trackId}">← ${esc(trackLabel(ea.track_name, ea.track_config))}</a></p>
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

async function viewEvent(eventId) {
  const [e, tracks] = await Promise.all([api(`/events/${eventId}`), api("/tracks")]);
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
      const laps = s.laps
        .map(
          (l) => `<span class="lap${l.time_ms === best ? " best" : ""}" title="Lap ${l.lap_num}">
            ${fmtMs(l.time_ms)}<span class="x" data-del-lap="${l.id}" title="Delete lap">✕</span>
          </span>`
        )
        .join("");
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
        <div class="laps">${laps}</div>
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
        <span class="pb-sub"><b>${fmtDelta(pb.delta).replace("+", "")}</b> faster than your previous best at ${esc(trackLabel(e.track_name, e.track_config))}${pb.goalBeaten ? ` — and under your <b>${fmtMs(track.goal_ms)}</b> goal` : ""}.</span>
        <div class="btn-row">
          <a class="btn small primary" href="#/track/${e.track_id}">${pb.goalBeaten ? "Set a new goal" : "See your progress"}</a>
          <button class="btn small ghost" id="pb-dismiss">Dismiss</button>
        </div>
      </div>`
    : "";

  const view = shell(`
    <h1>${esc(trackLabel(e.track_name, e.track_config))} — ${fmtDate(e.start_date)}</h1>
    <p class="sub">${esc([e.club, e.run_group].filter(Boolean).join(" · ") || "")}${fmtConditions(e) ? `${e.club || e.run_group ? " · " : ""}${fmtConditions(e)}` : ""}</p>
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
    ${checklistHtml}
    ${traceHtml}
    <h2>Sessions</h2>
    ${sessionsHtml || `<div class="empty">No sessions recorded yet.</div>`}
    <div class="pdr-dropzone" id="pdr-dropzone">
      <input type="file" id="pdr-files" accept="video/mp4,.mp4,.vbo,.fit" multiple hidden>
      <div class="pdr-dropzone-inner">
        <span class="pdr-dropzone-icon">📼</span>
        <div>
          <button class="btn" id="pdr-import" type="button">Import video / telemetry…</button>
          <span class="pdr-dropzone-hint">or drag &amp; drop <code>.mp4</code> / <code>.vbo</code> / <code>.fit</code> files here</span>
        </div>
        <span class="hint" style="font-size:12px;color:var(--text-muted)">Reads lap times from Corvette PDR &amp; GoPro video, Racelogic VBO and Garmin FIT telemetry — files never leave your computer</span>
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
  view.querySelectorAll("[data-del-session]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this session and its laps?")) return;
      await api(`/sessions/${btn.dataset.delSession}`, { method: "DELETE" });
      route();
    };
  });
  view.querySelectorAll("[data-del-lap]").forEach((x) => {
    x.onclick = async () => {
      await api(`/laps/${x.dataset.delLap}`, { method: "DELETE" });
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

// Custom combobox for the track field. A native <datalist> would be simpler,
// but iOS Safari never shows datalist suggestions and Android only surfaces a
// few after typing — so we render our own tappable option list.
function bindTrackCombo(view, options) {
  const input = view.querySelector('[name="track"]');
  const list = view.querySelector("#track-combo-list");
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

async function viewEventForm(eventId, presetTrack, presetConfig) {
  const tracks = await api("/tracks");
  const existing = eventId ? await api(`/events/${eventId}`) : null;
  // User's own tracks first (deduped across configs), then common US tracks.
  const ownNames = [...new Set(tracks.map((t) => t.name))];
  const seen = new Set(ownNames.map((n) => n.toLowerCase()));
  const trackOpts = [...ownNames, ...US_TRACKS.filter((n) => !seen.has(n.toLowerCase()))];

  const view = shell(`
    <h1>${existing ? "Edit event" : "New event"}</h1>
    <form class="panel" id="event-form">
      <div class="form-grid">
        <div class="field"><label>Track</label>
          <div class="combo">
            <input name="track" required autocomplete="off" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="track-combo-list"
              value="${esc(existing?.track_name ?? presetTrack ?? "")}" placeholder="VIR Full">
            <div class="combo-list" id="track-combo-list" role="listbox" hidden></div>
          </div>
          <div class="hint">Pick from your tracks and common US tracks, or type a new name</div>
        </div>
        <div class="field"><label>Configuration (optional)</label>
          <input name="track_config" value="${esc(existing?.track_config ?? presetConfig ?? "")}" placeholder="Full, Patriot, CCW…">
          <div class="hint">Layouts time differently — keep them separate so PBs stay honest</div>
        </div>
        <div class="field"><label>Start date</label>
          <input name="start_date" type="date" required value="${esc(existing?.start_date ?? new Date().toISOString().slice(0, 10))}">
        </div>
        <div class="field"><label>Days</label>
          <input name="days" type="number" min="0.5" step="0.5" value="${existing?.days ?? 2}">
        </div>
        <div class="field"><label>Club / organizer</label>
          <input name="club" value="${esc(existing?.club ?? "")}" placeholder="VIR Club">
        </div>
        <div class="field"><label>Run group</label>
          <input name="run_group" value="${esc(existing?.run_group ?? "")}" placeholder="High Speed">
        </div>
        <div class="field"><label>Car</label>
          <input name="car" value="${esc(existing?.car ?? "")}" placeholder="Corvette Z06, Miata, GT3…">
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

  bindTrackCombo(view, trackOpts);

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
    const body = {
      track_name: f.track.value.trim(),
      track_config: f.track_config.value.trim(),
      start_date: f.start_date.value,
      days: Number(f.days.value) || 1,
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
        <td>${esc(trackLabel(g.track_name, g.track_config))}</td>
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
    ${r.new_tracks.length ? `<p class="sub">First time at ${r.new_tracks.map((t) => `<strong>${esc(trackLabel(t.track_name, t.track_config))}</strong>`).join(", ")} 🎉</p>` : ""}
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
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/">${appLogoHtml()} Track History</a>
        <span class="share-badge">Read-only shared view</span>
        <span class="spacer"></span>
        ${themeToggleHtml()}
        <a class="btn small" href="/">Track your own laps</a>
      </header>
      <div id="view">${content}</div>
      ${footerHtml()}
    </div>`;
  wireThemeToggle();
  return document.getElementById("view");
}

function shareEventRows(events, { withTrack = false } = {}) {
  return events
    .map(
      (e) => `<tr${withTrack ? ` class="rowlink" data-href="#/track/${e.track_id}"` : ""}>
        <td class="date">${fmtDate(e.start_date)}</td>
        ${withTrack ? `<td>${esc(trackLabel(e.track_name, e.track_config))}</td>` : ""}
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
        <div class="name">${esc(trackLabel(t.name, t.config))}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · last ${fmtDate(t.last_date)}</div>
        ${spark}
      </a>`;
    })
    .join("");

  const view = shareShell(`
    <h1>${esc(name || "Driver")} — Track History</h1>
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
    <h1>${esc(trackLabel(track.name, track.config))}</h1>
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
    const res = await fetch(`/api/share/${encodeURIComponent(SHARE_SLUG)}`);
    if (!res.ok) {
      $app.innerHTML = `
        <div class="login-wrap">
          <div class="login-card">
            <div class="flag">${appLogoHtml("lg")}</div>
            <h1>Link not found</h1>
            <p>This share link doesn't exist or has been disabled.</p>
            <a class="btn primary" href="/">Go to Track History</a>
            ${footerHtml()}
          </div>
        </div>`;
      return;
    }
    shareData = await res.json();
    document.title = `${shareData.name || "Driver"} — Track History`;
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
  } catch {
    return; // renderLogin already ran on 401
  }
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts.length === 0) return await viewDashboard();
    if (parts[0] === "track" && parts[1] && parts[2] === "compare") return await viewCompare(parts[1], params);
    if (parts[0] === "track" && parts[1]) return await viewTrack(parts[1], params);
    if (parts[0] === "event" && parts[1] && parts[2] === "edit") return await viewEventForm(parts[1]);
    if (parts[0] === "event" && parts[1]) return await viewEvent(parts[1]);
    if (parts[0] === "new") return await viewEventForm(null, params.get("track"), params.get("config"));
    if (parts[0] === "year") return await viewYear(params);
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
