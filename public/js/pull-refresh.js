// Pull-to-refresh: touch gesture on the page scroller. Pull down from the top
// past the threshold and release to re-run the current route's data fetches;
// while refreshing, the brand chevron sweeps left→right inside a pill below
// the top edge. Desktop is unaffected (touch events never fire).
// Node-import-safe: no DOM access at module scope — initPullRefresh wires it.

export const PULL_MAX = 96; // px the pill can travel (asymptotic cap)
export const PULL_THRESHOLD = 60; // dampened px that arm a refresh (~120px of finger travel)

// Asymptotic resistance: early finger travel moves the pill almost 1:1, then
// it eases toward PULL_MAX so long pulls don't drag the pill off into space.
export function dampen(dy) {
  if (!(dy > 0)) return 0;
  return PULL_MAX * (1 - Math.exp(-dy / 120));
}

const HIDDEN_Y = -56; // pill parked above the viewport (its height + shadow)
const REST_Y = 10; // where the pill settles while refreshing

export function initPullRefresh({ chevronHtml, onRefresh }) {
  const el = document.createElement("div");
  el.className = "ptr";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="ptr-pill"><span class="ptr-mark">${chevronHtml}</span></div>`;
  document.body.appendChild(el);
  const pill = el.querySelector(".ptr-pill");

  let startY = null; // touchstart Y while tracking a candidate pull
  let pulling = false; // the gesture has moved downward from the top
  let pulled = 0; // current dampened distance
  let refreshing = false;

  const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;

  function hide() {
    pulled = 0;
    pulling = false;
    pill.style.transition = "";
    pill.style.opacity = "0";
    pill.style.transform = `translateY(${HIDDEN_Y}px)`;
    el.classList.remove("armed");
  }

  function onTouchStart(e) {
    startY = !refreshing && e.touches.length === 1 && atTop() ? e.touches[0].clientY : null;
    pulling = false;
  }

  function onTouchMove(e) {
    if (startY == null || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (!pulling && (dy <= 0 || !atTop())) {
      startY = null; // it's a scroll, not a pull — stay out of the way
      return;
    }
    pulling = true;
    if (e.cancelable) e.preventDefault(); // suppress rubber-band / native refresh
    pulled = dampen(dy);
    el.classList.toggle("armed", pulled >= PULL_THRESHOLD);
    pill.style.transition = "none"; // track the finger directly
    pill.style.opacity = String(Math.min(1, pulled / 40));
    pill.style.transform = `translateY(${HIDDEN_Y + pulled}px)`;
  }

  async function onTouchEnd() {
    if (startY == null) return;
    const go = pulling && pulled >= PULL_THRESHOLD;
    startY = null;
    if (!go) {
      hide();
      return;
    }
    refreshing = true;
    el.classList.remove("armed");
    el.classList.add("refreshing");
    pill.style.transition = "";
    pill.style.opacity = "1";
    pill.style.transform = `translateY(${REST_Y}px)`;
    try {
      // Hold the chevron sweep for at least one pass so a fast (or cached)
      // refresh still reads as one, not a flicker.
      await Promise.all([onRefresh(), new Promise((r) => setTimeout(r, 600))]);
    } finally {
      refreshing = false;
      el.classList.remove("refreshing");
      hide();
    }
  }

  function onTouchCancel() {
    // System took the gesture (edge swipe, notification shade) — stand down.
    if (startY == null) return;
    startY = null;
    if (!refreshing) hide();
  }

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", onTouchCancel, { passive: true });
}
