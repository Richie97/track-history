// New-PB detection and celebration. detectPB is pure and unit-tested; the
// confetti burst owns a singleton canvas and is skipped entirely under
// prefers-reduced-motion.

// Compare a track's best before and after a mutation. No celebration for a
// track's first-ever time (importing history shouldn't set off fireworks).
export function detectPB(prevBest, newBest, goalMs) {
  if (prevBest == null || newBest == null || newBest >= prevBest) return null;
  return {
    ms: newBest,
    delta: prevBest - newBest,
    goalBeaten: goalMs != null && newBest <= goalMs && prevBest > goalMs,
  };
}

let canvas = null;
let particles = [];
let raf = null;

function tick() {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.16;
    p.vx *= 0.99;
    p.rot += p.vr;
    p.life--;
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life / 30);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.c;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  if (particles.length) {
    raf = requestAnimationFrame(tick);
  } else {
    raf = null;
    canvas.remove();
    canvas = null;
  }
}

// One burst of confetti from (x, y) in viewport coordinates.
export function confettiBurst(x, y) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:60";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
  }
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const styles = getComputedStyle(document.documentElement);
  const colors = [
    styles.getPropertyValue("--accent").trim(),
    styles.getPropertyValue("--chart-line-b").trim(),
    styles.getPropertyValue("--text-strong").trim(),
  ];
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 3 + Math.random() * 6.5;
    particles.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 3.5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      w: 4 + Math.random() * 5,
      h: 2.5 + Math.random() * 3,
      c: colors[i % colors.length],
      life: 70 + Math.random() * 40,
    });
  }
  if (!raf) raf = requestAnimationFrame(tick);
}
