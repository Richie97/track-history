"use strict";

const $app = document.getElementById("app");
const $tooltip = document.getElementById("tooltip");

// ---------- utilities -------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// ms -> "2:01.24" (trailing zeros trimmed, at least one decimal)
function fmtMs(ms) {
  if (ms == null) return "—";
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  let frac = String(total % 1000).padStart(3, "0").replace(/0+$/, "");
  if (!frac) frac = "0";
  return `${m}:${String(s).padStart(2, "0")}.${frac}`;
}

// "2:01.24" | "121.24" | "2:01" -> ms (null if unparseable)
function parseTime(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let m = /^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t);
  if (m) {
    const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
    return (Number(m[1]) * 60 + Number(m[2])) * 1000 + frac;
  }
  m = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(t);
  if (m) return Number(m[1]) * 1000 + (m[2] ? Number(m[2].padEnd(3, "0")) : 0);
  return null;
}

function parseLapList(text) {
  return String(text ?? "")
    .split(/[\s,;]+/)
    .map(parseTime)
    .filter((ms) => ms != null && ms > 0);
}

const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const fmtConsistency = (cv) => (cv == null ? "—" : `${(cv * 100).toFixed(1)}%`);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    renderLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------- charts ----------------------------------------------------------
// Single-series lap-time line charts: 2px line, >=8px markers with a 2px
// surface ring, hairline gridlines, hover tooltip. Lower = faster.

function niceTimeTicks(min, max, count = 4) {
  const span = Math.max(1, max - min);
  const rawStep = span / count;
  const steps = [100, 200, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000];
  const step = steps.find((s) => s >= rawStep) ?? 300000;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

// points: [{x: epochMs, y: lapMs, ...meta}]
// goal: optional target lap time (ms) drawn as a horizontal reference line —
// red while unbeaten, green once a point meets or beats it.
function lineChart(points, { width = 900, height = 300, sparkline = false, goal = null } = {}) {
  if (!points.length) return { svg: "", bind: () => {} };
  const hasGoal = !sparkline && typeof goal === "number" && Number.isFinite(goal);
  const goalMet = hasGoal && Math.min(...points.map((p) => p.y)) <= goal;
  const pad = sparkline
    ? { l: 2, r: 6, t: 4, b: 4 }
    : { l: 64, r: 20, t: 12, b: 28 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Keep the goal line inside the plotted range so it's always visible.
  if (hasGoal) { y0 = Math.min(y0, goal); y1 = Math.max(y1, goal); }
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const ypad = Math.max((y1 - y0) * 0.12, 500);
  y0 -= ypad; y1 += ypad;
  const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  // Invert: faster (smaller) lap times sit lower on the chart, so improvement trends downward.
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  const pts = points.map((p) => ({ ...p, px: X(p.x), py: Y(p.y) }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");

  let grid = "", labels = "", dots = "";
  if (!sparkline) {
    for (const tv of niceTimeTicks(y0, y1)) {
      const y = Y(tv).toFixed(1);
      grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
      labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--muted)" font-size="11" style="font-variant-numeric:tabular-nums">${fmtMs(tv)}</text>`;
    }
    // x labels: first, last, and up to 2 between
    const n = pts.length;
    const idxs = [...new Set([0, Math.floor((n - 1) / 3), Math.floor(((n - 1) * 2) / 3), n - 1])];
    for (const i of idxs) {
      const p = pts[i];
      const anchor = n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      labels += `<text x="${p.px.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" fill="var(--muted)" font-size="11">${esc(p.xlabel ?? "")}</text>`;
    }
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--baseline)" stroke-width="1"/>`;
    dots = pts
      .map(
        (p, i) =>
          `<circle data-i="${i}" cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" style="cursor:${p.href ? "pointer" : "default"}"/>`
      )
      .join("");
  } else {
    const last = pts[pts.length - 1];
    dots = `<circle cx="${last.px.toFixed(1)}" cy="${last.py.toFixed(1)}" r="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
  }

  let goalLayer = "";
  if (hasGoal) {
    const gy = Y(goal).toFixed(1);
    const col = goalMet ? "var(--good)" : "var(--danger)";
    goalLayer = `<line x1="${pad.l}" x2="${width - pad.r}" y1="${gy}" y2="${gy}" stroke="${col}" stroke-width="2" stroke-dasharray="6 4"/>
      <text x="${width - pad.r}" y="${(Number(gy) - 6).toFixed(1)}" text-anchor="end" fill="${col}" font-size="11" font-weight="600">Goal ${fmtMs(goal)}${goalMet ? " ✓" : ""}</text>`;
  }

  const strokeCol = sparkline ? "var(--baseline)" : "var(--accent)";
  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Lap time trend">
    ${grid}${labels}${goalLayer}
    <path d="${path}" fill="none" stroke="${strokeCol}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;

  // Hover/click wiring for the full chart (nearest point by x).
  const bind = (container) => {
    if (sparkline) return;
    const svgEl = container.querySelector("svg");
    const circles = [...svgEl.querySelectorAll("circle[data-i]")];
    const nearest = (evt) => {
      const rect = svgEl.getBoundingClientRect();
      const mx = ((evt.clientX - rect.left) / rect.width) * width;
      let best = 0, bestD = Infinity;
      pts.forEach((p, i) => {
        const d = Math.abs(p.px - mx);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };
    svgEl.addEventListener("mousemove", (evt) => {
      const i = nearest(evt);
      const p = pts[i];
      circles.forEach((el, j) => el.setAttribute("r", j === i ? "6" : "4.5"));
      $tooltip.innerHTML = `<div class="t-val">${fmtMs(p.y)}</div><div class="t-sub">${esc(p.tip ?? "")}</div>`;
      $tooltip.hidden = false;
      const tw = $tooltip.offsetWidth;
      let left = evt.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
      $tooltip.style.left = `${left}px`;
      $tooltip.style.top = `${evt.clientY - 12}px`;
    });
    svgEl.addEventListener("mouseleave", () => {
      $tooltip.hidden = true;
      circles.forEach((el) => el.setAttribute("r", "4.5"));
    });
    svgEl.addEventListener("click", (evt) => {
      const p = pts[nearest(evt)];
      if (p.href) location.hash = p.href;
    });
  };
  return { svg, bind };
}

// ---------- views -----------------------------------------------------------

// Speedshift.io mark: two amber diagonal bars (inlined from speedshift.io/logo.svg)
const SS_LOGO = `<svg class="ss-logo" viewBox="0 0 429 629" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="0.589722" y="115.848" width="163" height="442.765" transform="rotate(-44.9265 0.589722 115.848)" fill="#E79F02"/>
  <rect x="311.969" y="198.246" width="163" height="442.765" transform="rotate(44.5184 311.969 198.246)" fill="#E79F02"/>
</svg>`;

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
  }, 2600);
}

function footerHtml() {
  startTipRotator();
  return `<footer class="site-footer">
    <span>© ${new Date().getFullYear()} Speedshift LLC · Track History</span>
    <a class="contribute-link" href="${REPO_URL}" target="_blank" rel="noopener"
       data-tip="Fix my bugs — or add your own 🐛">
      🛠️ Contribute
    </a>
    <a class="tip-btn" href="${TIP_URL}" target="_blank" rel="noopener">
      Buy me <span class="tip-blank">${TIP_ITEMS[tipIdx]}</span>
    </a>
    <a class="ss-credit" href="https://speedshift.io" target="_blank" rel="noopener">
      <span class="muted-part">Built by</span> ${SS_LOGO} <span class="ss-wordmark">Speedshift</span>
    </a>
  </footer>`;
}

function renderLogin() {
  document.querySelector(".shell")?.remove();
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="flag">🏁</div>
        <h1>Track History</h1>
        <p>Lap times, sessions and notes — per track, over time.</p>
        <a class="btn primary" href="/auth/login">Sign in with Google</a>
        ${footerHtml()}
      </div>
    </div>`;
}

function shell(content) {
  const me = state.me;
  $app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/">🏁 Track History</a>
        <span class="spacer"></span>
        ${me?.picture ? `<img class="avatar" src="${esc(me.picture)}" alt="">` : ""}
        <span class="who">${esc(me?.name || me?.email || "")}</span>
        <button class="btn small" id="logout">Sign out</button>
      </header>
      <div id="view">${content}</div>
      ${footerHtml()}
    </div>`;
  document.getElementById("logout").onclick = async () => {
    await fetch("/auth/logout", { method: "POST" });
    renderLogin();
  };
  return document.getElementById("view");
}

const state = { me: null };

async function ensureMe() {
  if (!state.me) {
    const data = await api("/me");
    state.me = data.user;
    state.totals = data.totals;
  } else {
    const data = await api("/me");
    state.me = data.user;
    state.totals = data.totals;
  }
}

// --- dashboard ---

async function viewDashboard() {
  const [tracks, events] = await Promise.all([api("/tracks"), api("/events")]);
  const withData = tracks.filter((t) => t.event_count > 0).sort((a, b) => (b.last_date || "").localeCompare(a.last_date || ""));
  const recent = events.slice(0, 6);

  const cards = withData
    .map((t) => {
      const spark =
        t.series.length >= 2
          ? lineChart(t.series.map((p, i) => ({ x: i, y: p.best_ms })), { width: 220, height: 44, sparkline: true }).svg
          : "";
      return `<a class="card" href="#/track/${t.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="best">${fmtMs(t.best_ms)}</div>
        <div class="meta">${t.event_count} event${t.event_count === 1 ? "" : "s"} · ${t.track_days} day${t.track_days === 1 ? "" : "s"} · last ${fmtDate(t.last_date)}</div>
        ${spark}
      </a>`;
    })
    .join("");

  const recentRows = recent
    .map(
      (e) => `<tr class="rowlink" data-href="#/event/${e.id}">
        <td>${fmtDate(e.start_date)}</td>
        <td>${esc(e.track_name)}</td>
        <td>${esc(e.club ?? "")}</td>
        <td class="num">${fmtMs(e.best_ms)}</td>
      </tr>`
    )
    .join("");

  const slug = state.me.share_slug || "";
  const view = shell(`
    <div class="btn-row" style="margin-top:20px">
      <a class="btn primary" href="#/new">+ Add event</a>
    </div>
    <div class="tiles">
      <div class="tile"><div class="label">Events</div><div class="value">${state.totals.events}</div></div>
      <div class="tile"><div class="label">Track days</div><div class="value">${state.totals.track_days}</div></div>
      <div class="tile"><div class="label">Tracks</div><div class="value">${withData.length}</div></div>
    </div>
    <h2>Tracks</h2>
    ${cards ? `<div class="cards">${cards}</div>` : `<div class="empty">No events yet — add your first track day.</div>`}
    ${recent.length ? `<h2>Recent events</h2>
    <table><thead><tr><th>Date</th><th>Track</th><th>Club</th><th class="num">Best</th></tr></thead>
    <tbody>${recentRows}</tbody></table>` : ""}
    <h2>Share your history</h2>
    <div class="panel share-panel">
      <div class="hint" style="margin:0 0 10px">Publish a read-only page of your track history — bests, run groups and consistency (notes stay private). Handy for HPDE run-group placement. Anyone with the link can view it.</div>
      <div class="btn-row">
        <span class="share-prefix">${esc(location.origin)}/share/</span>
        <input id="share-slug" placeholder="your-name" maxlength="32" value="${esc(slug)}">
        <button class="btn small primary" id="share-save">${slug ? "Update path" : "Create link"}</button>
        ${slug ? `<button class="btn small" id="share-copy">Copy link</button>
        <a class="btn small" href="/share/${esc(slug)}" target="_blank" rel="noopener">Open ↗</a>
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

async function viewTrack(trackId) {
  const [tracks, events] = await Promise.all([api("/tracks"), api(`/events?track_id=${trackId}`)]);
  const track = tracks.find((t) => String(t.id) === String(trackId));
  if (!track) return viewNotFound();

  const chrono = [...events].reverse().filter((e) => e.best_ms != null);
  const points = chrono.map((e) => ({
    x: new Date(e.start_date).getTime(),
    y: e.best_ms,
    xlabel: fmtDate(e.start_date),
    tip: `${fmtDate(e.start_date)}${e.club ? " · " + e.club : ""}`,
    href: `#/event/${e.id}`,
  }));
  const chart = points.length ? lineChart(points, { goal: track.goal_ms }) : null;

  const rows = events
    .map(
      (e) => `<tr class="rowlink" data-href="#/event/${e.id}">
        <td>${fmtDate(e.start_date)}</td>
        <td>${e.days}</td>
        <td>${esc(e.club ?? "")}</td>
        <td>${esc(e.run_group ?? "")}</td>
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

  const goalControl = `<div class="goal-control">
    <span class="goal-label">Goal lap</span>
    <input id="goal-input" type="text" inputmode="decimal" placeholder="e.g. 1:59.0" value="${goal != null ? esc(fmtMs(goal)) : ""}">
    <button class="btn small" id="goal-save">Save</button>
    ${goal != null ? `<button class="btn small" id="goal-clear">Clear</button>` : ""}
    ${goal != null ? `<span class="goal-status ${goalMet ? "met" : "unmet"}">${goalMet ? "Goal beaten ✓" : "Not yet beaten"}</span>` : ""}
    <span id="goal-msg" class="goal-msg"></span>
  </div>`;

  const view = shell(`
    <h1>${esc(track.name)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong> · ${events.length} event${events.length === 1 ? "" : "s"}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — lower is faster</div><div class="chart-wrap" id="chart">${chart.svg}</div>${goalControl}</div>` : `<div class="chart-card">${goalControl}</div>`}
    <div class="btn-row"><a class="btn primary" href="#/new?track=${encodeURIComponent(track.name)}">+ Add event at ${esc(track.name)}</a></div>
    <h2>Events</h2>
    <table><thead><tr><th>Date</th><th>Days</th><th>Club</th><th>Group</th><th class="num">Best</th><th class="num">Consistency</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody></table>
  `);
  if (chart) chart.bind(view.querySelector("#chart"));

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

  wireRowLinks(view);
}

// --- event detail ---

async function viewEvent(eventId) {
  const e = await api(`/events/${eventId}`);

  const sessionsHtml = e.sessions
    .map((s) => {
      const best = s.laps.length ? Math.min(...s.laps.map((l) => l.time_ms)) : null;
      const laps = s.laps
        .map(
          (l) => `<span class="lap${l.time_ms === best ? " best" : ""}" title="Lap ${l.lap_num}">
            ${fmtMs(l.time_ms)}<span class="x" data-del-lap="${l.id}" title="Delete lap">✕</span>
          </span>`
        )
        .join("");
      return `<div class="session">
        <div class="s-head">
          <span class="s-label">${esc(s.label || "Session")}</span>
          <span class="s-best">${best != null ? `best ${fmtMs(best)} · ${s.laps.length} lap${s.laps.length === 1 ? "" : "s"}` : "no laps"}</span>
          <span class="grow"></span>
          <button class="btn small danger" data-del-session="${s.id}">Delete</button>
        </div>
        ${s.notes ? `<div class="notes-block" style="font-size:13px;color:var(--ink-2);margin-top:6px">${esc(s.notes)}</div>` : ""}
        <div class="laps">${laps}</div>
        <div class="btn-row" style="margin-top:10px">
          <input data-add-laps-input="${s.id}" placeholder="Add laps: 2:01.24, 2:03.1 …" style="flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--baseline);border-radius:8px;background:var(--page);color:var(--ink);font:inherit;font-size:13px">
          <button class="btn small" data-add-laps="${s.id}">Add</button>
        </div>
      </div>`;
    })
    .join("");

  const view = shell(`
    <h1>${esc(e.track_name)} — ${fmtDate(e.start_date)}</h1>
    <p class="sub">${esc([e.club, e.run_group].filter(Boolean).join(" · ") || "")}</p>
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
    <h2>Sessions</h2>
    ${sessionsHtml || `<div class="empty">No sessions recorded yet.</div>`}
    <div class="btn-row" style="margin:14px 0">
      <button class="btn" id="pdr-import">📼 Import PDR video…</button>
      <input type="file" id="pdr-files" accept="video/mp4,.mp4" multiple hidden>
      <span class="hint" style="font-size:12px;color:var(--muted)">Reads lap times from Corvette PDR telemetry — the video never leaves your computer</span>
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

  view.querySelector("#del-event").onclick = async () => {
    if (!confirm("Delete this event and all its sessions/laps?")) return;
    await api(`/events/${e.id}`, { method: "DELETE" });
    location.hash = "#/";
  };
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

  // --- PDR video import ---
  const fileInput = view.querySelector("#pdr-files");
  view.querySelector("#pdr-import").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    const box = view.querySelector("#pdr-review");
    box.innerHTML = `<div class="panel">Reading telemetry from ${files.length} file${files.length === 1 ? "" : "s"}…</div>`;
    const results = [];
    for (const f of files) {
      try {
        results.push({ file: f.name, parsed: await window.parsePdrFile(f) });
      } catch (err) {
        results.push({ file: f.name, error: err.message });
      }
    }
    results.sort((a, b) => ((a.parsed?.time ?? "") < (b.parsed?.time ?? "") ? -1 : 1));
    renderPdrReview(box, e, results);
  };
}

function renderPdrReview(box, event, results) {
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
      return `<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--grid)">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" data-pdr-include="${i}" ${p.laps.length ? "checked" : "disabled"}>
          <strong>${esc(r.file)}</strong>
          <span style="color:var(--muted);font-size:13px">${esc(p.date ?? "")} ${esc(p.time ?? "")} · ${(p.durationS / 60).toFixed(0)} min · ${p.laps.length} lap${p.laps.length === 1 ? "" : "s"}</span>
        </label>
        ${dateWarn}
        <div class="laps" style="margin-top:8px">${lapChips || `<span class="hint" style="color:var(--muted);font-size:13px">No complete laps found (no start/finish crossings in telemetry)</span>`}</div>
        ${estCount ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">~ = recovered from distance telemetry (±0.1–0.3s); unmarked laps are beacon-exact</div>` : ""}
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
    if (added) route();
    else box.innerHTML = "";
  };
}

// --- event form (new / edit) ---

async function viewEventForm(eventId, presetTrack) {
  const tracks = await api("/tracks");
  const existing = eventId ? await api(`/events/${eventId}`) : null;

  const view = shell(`
    <h1>${existing ? "Edit event" : "New event"}</h1>
    <form class="panel" id="event-form">
      <div class="form-grid">
        <div class="field"><label>Track</label>
          <input name="track" list="track-list" required value="${esc(existing?.track_name ?? presetTrack ?? "")}" placeholder="VIR Full">
          <datalist id="track-list">${tracks.map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>
          <div class="hint">Pick an existing track or type a new name</div>
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

  view.querySelector("#event-form").onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    const bestRaw = f.best_time.value.trim();
    const best = bestRaw ? parseTime(bestRaw) : null;
    if (bestRaw && best == null) {
      view.querySelector("#form-error").innerHTML = `<div class="error-banner">Couldn't parse best time "${esc(bestRaw)}" — use 2:01.24 format.</div>`;
      return;
    }
    const body = {
      track_name: f.track.value.trim(),
      start_date: f.start_date.value,
      days: Number(f.days.value) || 1,
      club: f.club.value.trim() || null,
      run_group: f.run_group.value.trim() || null,
      car: f.car.value.trim() || null,
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
        <a class="brand" href="#/">🏁 Track History</a>
        <span class="share-badge">Read-only shared view</span>
        <span class="spacer"></span>
        <a class="btn small" href="/">Track your own laps</a>
      </header>
      <div id="view">${content}</div>
      ${footerHtml()}
    </div>`;
  return document.getElementById("view");
}

function shareEventRows(events, { withTrack = false } = {}) {
  return events
    .map(
      (e) => `<tr${withTrack ? ` class="rowlink" data-href="#/track/${e.track_id}"` : ""}>
        <td>${fmtDate(e.start_date)}</td>
        ${withTrack ? `<td>${esc(e.track_name)}</td>` : ""}
        <td>${e.days}</td>
        <td>${esc(e.club ?? "")}</td>
        <td>${esc(e.run_group ?? "")}</td>
        <td>${esc(e.car ?? "")}</td>
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
    <h2>Tracks</h2>
    ${cards ? `<div class="cards">${cards}</div>` : `<div class="empty">No events shared yet.</div>`}
    ${events.length ? `<h2>All events</h2>
    <table><thead><tr><th>Date</th><th>Track</th><th>Days</th><th>Club</th><th>Group</th><th>Car</th><th class="num">Best</th><th class="num">Consistency</th></tr></thead>
    <tbody>${shareEventRows(events, { withTrack: true })}</tbody></table>` : ""}
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
    <p class="sub" style="margin:16px 0 0"><a href="#/">← All tracks</a></p>
    <h1>${esc(track.name)}</h1>
    <p class="sub">Personal best <strong>${fmtMs(pb)}</strong> · ${events.length} event${events.length === 1 ? "" : "s"}</p>
    ${chart ? `<div class="chart-card"><div class="chart-title">Best lap per event — lower is faster</div><div class="chart-wrap" id="chart">${chart.svg}</div></div>` : ""}
    <h2>Events</h2>
    <table><thead><tr><th>Date</th><th>Days</th><th>Club</th><th>Group</th><th>Car</th><th class="num">Best</th><th class="num">Consistency</th></tr></thead>
    <tbody>${shareEventRows(events)}</tbody></table>
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
            <div class="flag">🏁</div>
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
  const parts = (location.hash || "#/").slice(1).split("/").filter(Boolean);
  if (parts[0] === "track" && parts[1]) return shareTrack(parts[1]);
  shareDashboard();
}

// ---------- router ----------------------------------------------------------

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
    if (parts[0] === "track" && parts[1]) return await viewTrack(parts[1]);
    if (parts[0] === "event" && parts[1] && parts[2] === "edit") return await viewEventForm(parts[1]);
    if (parts[0] === "event" && parts[1]) return await viewEvent(parts[1]);
    if (parts[0] === "new") return await viewEventForm(null, params.get("track"));
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
  window.addEventListener("hashchange", route);
  route();
}
