// Season Wrapped (NS-36) — the story: one full-viewport card at a time, in the
// order wrappedCards decides. Shared by the signed-in view (#/wrapped/:year)
// and the public share page, the way yearReviewHtml is. Cards are real DOM so
// text selects and screen readers read them; the card in view is announced
// through a live region. Navigation: tap the right or left third, swipe, the
// arrow keys and Space, or the progress dots, which are buttons.
//
// Only the transitions are CSS, and `prefers-reduced-motion` cuts them (the
// celebrate.js rule) — nothing here animates in script.

import { esc, fmtMs } from "./format.js";
import {
  CARD_TITLES, fmtDay, fmtDays, fmtGain, fmtHoursWord, fmtWrappedTemp, plural, posterLines,
  trackDistance, wrappedCards,
} from "./wrapped.js";
import { fmtSpeedKph } from "./units.js";

const n = (v) => Math.round(v).toLocaleString("en-US");

function cardBody(card, data, ctx) {
  const { units, share } = ctx;
  const t = data.totals;
  const whose = share ? (data.name ? `${esc(data.name)}'s` : "A driver's") : "Your";
  switch (card.kind) {
    case "cover":
      return `
        <div class="wr-kicker">Track Evolution · Wrapped</div>
        <h1 class="wr-huge">${whose} ${data.year}</h1>
        <p class="wr-lede">${share ? "A season on track, in cards." : "Your season on track, handed back to you."}</p>
        ${data.through ? `<p class="wr-foot">So far — through ${esc(fmtDay(data.through))}.</p>` : ""}
        ${ctx.yearPickerHtml ?? ""}
        <p class="wr-hint" aria-hidden="true">Tap or swipe →</p>`;
    case "numbers": {
      const dist = trackDistance(t.miles, units);
      const cells = [
        [fmtDays(t.track_days), plural(t.track_days, "track day")],
        [n(t.tracks), plural(t.tracks, "track")],
        [n(t.laps), plural(t.laps, "lap")],
        ...(t.miles_tracks_counted ? [[dist.value, dist.unit]] : []),
      ];
      return `
        <div class="wr-kicker">The numbers</div>
        <div class="wr-stats">${cells
          .map(([v, l]) => `<div class="wr-stat"><div class="wr-stat-v">${esc(v)}</div><div class="wr-stat-l">${esc(l)}</div></div>`)
          .join("")}</div>
        ${
          t.miles_tracks_counted && t.miles_tracks_counted < t.tracks
            ? `<p class="wr-foot">Distance across ${t.miles_tracks_counted} of ${t.tracks} tracks — the ones whose lap length we know.</p>`
            : `<p class="wr-foot">${n(t.events)} ${plural(t.events, "event")} in the logbook.</p>`
        }`;
    }
    case "most_driven": {
      const m = data.most_driven;
      return `
        <div class="wr-kicker">Most driven</div>
        <p class="wr-lede">${share ? "They" : "You"} kept coming back to</p>
        <h2 class="wr-big">${esc(m.track_name)}</h2>
        <p class="wr-line">${fmtDays(m.track_days)} ${plural(m.track_days, "day")} · ${n(m.laps)} ${plural(m.laps, "lap")}${
          m.best_ms != null ? ` · best <strong>${fmtMs(m.best_ms)}</strong>` : ""
        }</p>`;
    }
    case "improvement": {
      const g = data.improvement;
      const first = g.baseline === "first_event";
      return `
        <div class="wr-kicker">Biggest improvement</div>
        <p class="wr-lede">${first ? `A first year at ${esc(g.track_name)} — and` : `At ${esc(g.track_name)},`} ${share ? "they" : "you"} found</p>
        <div class="wr-huge wr-num">${esc(fmtGain(g.gain_ms))}</div>
        <p class="wr-line">${fmtMs(g.best_before)} → <strong>${fmtMs(g.best_this_year)}</strong></p>
        <p class="wr-foot">${first ? "From the first timed day there this year to the best." : `Against the best from every year before ${data.year}.`}</p>`;
    }
    case "fastest": {
      const f = data.fastest;
      return `
        <div class="wr-kicker">Fastest lap</div>
        <div class="wr-huge wr-num">${fmtMs(f.best_ms)}</div>
        <p class="wr-line">${esc(f.track_name)} · ${esc(fmtDay(f.date))}</p>`;
    }
    case "new_tracks": {
      const list = data.new_tracks;
      return `
        <div class="wr-kicker">New tracks</div>
        <p class="wr-lede">First time at</p>
        <ul class="wr-list">${list.map((tr) => `<li>${esc(tr.track_name)}</li>`).join("")}</ul>`;
    }
    case "hours":
      return `
        <div class="wr-kicker">Hours behind the wheel</div>
        <div class="wr-huge wr-num">${esc(fmtHoursWord(t.hours))}</div>
        <p class="wr-line">${plural(t.hours, "hour")} on track</p>
        <p class="wr-foot">Two hours a track day, or the logged lap time when that's more.</p>`;
    case "hottest": {
      const h = data.hottest;
      return `
        <div class="wr-kicker">Hottest day</div>
        <div class="wr-huge wr-num">${esc(fmtWrappedTemp(h.temp_c, units))}</div>
        <p class="wr-line">${esc(h.track_name)} · ${esc(fmtDay(h.date))}</p>`;
    }
    case "tire":
      if (card.locked)
        return lockedBody("Favourite tyre", "The tyre with the most track days on it this year, from your garage.", ctx);
      return `
        <div class="wr-kicker">Favourite tyre</div>
        <p class="wr-lede">The rubber ${share ? "they" : "you"} lived on</p>
        <h2 class="wr-big">${esc(data.pro.tire.name)}</h2>
        <p class="wr-line">${fmtDays(data.pro.tire.track_days)} ${plural(data.pro.tire.track_days, "track day")} · ${esc(data.pro.tire.vehicle_name)}</p>`;
    case "top_speed":
      if (card.locked)
        return lockedBody("Top speed", "The fastest your telemetry ever saw you go this year, and where.", ctx);
      return `
        <div class="wr-kicker">Top speed</div>
        <div class="wr-huge wr-num">${esc(fmtSpeedKph(data.pro.top_speed.kph, units))}</div>
        <p class="wr-line">${esc(data.pro.top_speed.track_name)} · ${esc(fmtDay(data.pro.top_speed.date))}</p>`;
    case "poster": {
      const p = posterLines(data, units, { share });
      return `
        <div class="wr-poster" id="wr-poster">
          <div class="wr-poster-title">${esc(p.title)}</div>
          <p class="wr-poster-head">${p.headline.map(esc).join(" · ")}</p>
          <dl class="wr-poster-rows">${p.rows
            .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
            .join("")}</dl>
          <div class="wr-poster-brand">trackevolution.app</div>
        </div>
        ${ctx.posterActionsHtml ?? ""}`;
    }
    default:
      return "";
  }
}

function lockedBody(title, what, ctx) {
  return `
    <div class="wr-kicker">${esc(title)} <span class="pro-badge">Pro</span></div>
    <div class="wr-locked" aria-hidden="true">•••</div>
    <p class="wr-line">${esc(what)}</p>
    ${ctx.lockedHtml ?? ""}`;
}

// The whole story as markup. `ctx`: units, share (a public page), and the
// three pieces the caller owns — the year picker, the locked cards' store
// links and the poster's buttons — plus closeHref for the ✕.
export function wrappedStoryHtml(data, ctx) {
  const cards = wrappedCards(data);
  const total = cards.length;
  const slides = cards
    .map(
      (c, i) => `<section class="wr-card wr-card--${c.kind}${c.locked ? " wr-is-locked" : ""}${i === 0 ? " is-current" : ""}"
        data-i="${i}" role="group" aria-roledescription="card" aria-label="${i + 1} of ${total}: ${esc(CARD_TITLES[c.kind])}"
        ${i === 0 ? "" : 'aria-hidden="true" inert'}>
        <div class="wr-card-inner">${cardBody(c, data, ctx)}</div>
      </section>`
    )
    .join("");
  const dots = cards
    .map(
      (c, i) => `<button type="button" class="wr-dot${i === 0 ? " is-current" : ""}" data-go="${i}"
        aria-label="Card ${i + 1}: ${esc(CARD_TITLES[c.kind])}"${i === 0 ? ' aria-current="step"' : ""}></button>`
    )
    .join("");
  return `<div class="wrapped" id="wrapped-story" data-count="${total}">
    <div class="wr-top">
      <div class="wr-dots" role="group" aria-label="Cards">${dots}</div>
      ${ctx.closeHref ? `<a class="wr-close" href="${esc(ctx.closeHref)}" aria-label="Close Wrapped">✕</a>` : ""}
    </div>
    <div class="wr-stage">${slides}</div>
    <div class="wr-nav">
      <button type="button" class="wr-step" data-step="-1" aria-label="Previous card">←</button>
      <button type="button" class="wr-step" data-step="1" aria-label="Next card">→</button>
    </div>
    <div class="visually-hidden" aria-live="polite" id="wr-live"></div>
  </div>`;
}

// ---------- navigation ------------------------------------------------------

// One story is on screen at a time, and the router re-renders the page on
// every navigation, so the key handler is bound once at module level and
// drives whichever story is current rather than accumulating per render.
let active = null;

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (!active || !active.root.isConnected) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Space on a focused button or link is that control's own activation.
    if (e.key === " " && (tag === "BUTTON" || tag === "A")) return;
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      active.go(active.index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      active.go(active.index - 1);
    }
  });
}

export function bindWrappedStory(root) {
  const cards = [...root.querySelectorAll(".wr-card")];
  const dots = [...root.querySelectorAll(".wr-dot")];
  const live = root.querySelector("#wr-live");
  const ctl = {
    root,
    index: 0,
    go(i) {
      const next = Math.max(0, Math.min(cards.length - 1, i));
      if (next === ctl.index) return;
      const back = next < ctl.index;
      ctl.index = next;
      cards.forEach((c, k) => {
        const cur = k === next;
        c.classList.toggle("is-current", cur);
        c.classList.toggle("is-before", k < next);
        c.classList.toggle("from-left", cur && back);
        if (cur) {
          c.removeAttribute("aria-hidden");
          c.removeAttribute("inert");
        } else {
          c.setAttribute("aria-hidden", "true");
          c.setAttribute("inert", "");
        }
      });
      dots.forEach((d, k) => {
        d.classList.toggle("is-current", k === next);
        d.classList.toggle("is-done", k < next);
        if (k === next) d.setAttribute("aria-current", "step");
        else d.removeAttribute("aria-current");
      });
      root.querySelector('.wr-step[data-step="-1"]').disabled = next === 0;
      root.querySelector('.wr-step[data-step="1"]').disabled = next === cards.length - 1;
      if (live) live.textContent = cards[next].getAttribute("aria-label");
    },
  };
  active = ctl;
  root.querySelector('.wr-step[data-step="-1"]').disabled = true;

  root.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) return ctl.go(Number(go.dataset.go));
    const step = e.target.closest("[data-step]");
    if (step) return ctl.go(ctl.index + Number(step.dataset.step));
    // A tap on the card itself: the left third goes back, the right third
    // forward, the middle does nothing — so selecting text still works, and
    // anything interactive on the card keeps its own click.
    if (e.target.closest("a, button, input, select, textarea, label, summary")) return;
    const stage = e.target.closest(".wr-stage");
    if (!stage || String(window.getSelection?.() ?? "")) return;
    const rect = stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 1 / 3) ctl.go(ctl.index - 1);
    else if (x > 2 / 3) ctl.go(ctl.index + 1);
  });

  // A horizontal swipe: far enough, and more across than down, so a vertical
  // scroll inside a tall card is never read as a page turn.
  let start = null;
  const stage = root.querySelector(".wr-stage");
  stage.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // The click that follows a touch is suppressed so the swipe doesn't also
    // count as a tap on a third.
    e.preventDefault();
    ctl.go(ctl.index + (dx < 0 ? 1 : -1));
  });
  return ctl;
}
