// Best-lap trace renderer: draws a stored [x, y, v] polyline as a
// speed-painted racing line on a canvas — a wide "tarmac" underlay stroke,
// then short segments colored on a single-hue ramp from --map-slow (slow) to
// --map-fast (fast), plus a start/finish tick and, motion permitting, a
// replay dot that runs the lap. Colors are read from CSS variables at draw
// time so theme flips repaint correctly.

const W = 760;
const PAD = 26;

function hex2rgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// points: [[x, y, v], ...] in meters. Returns nothing; the renderer owns the
// canvas until it leaves the document (checked each frame / theme change).
export function renderTrackMap(canvas, points) {
  if (!points || points.length < 10) return;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const spanX = Math.max(1, x1 - x0);
  const spanY = Math.max(1, y1 - y0);
  // Height follows the track's aspect ratio within sane bounds.
  const H = Math.round(Math.min(460, Math.max(200, ((W - PAD * 2) * spanY) / spanX + PAD * 2)));
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const ox = (W - spanX * scale) / 2 - x0 * scale;
  const oy = (H + spanY * scale) / 2 + y0 * scale;
  const px = points.map(([x, y, v]) => [ox + x * scale, oy - y * scale, v ?? 0]); // north up

  const speeds = px.map((p) => p[2]);
  const vMin = Math.min(...speeds);
  const vMax = Math.max(...speeds);
  const vNorm = px.map((p) => (vMax > vMin ? (p[2] - vMin) / (vMax - vMin) : 0.5));

  const ctx = canvas.getContext("2d");
  let dot = 0;

  function draw() {
    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name) => styles.getPropertyValue(name).trim();
    const dpr = devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // tarmac underlay
    ctx.strokeStyle = cssVar("--map-tarmac");
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(px[0][0], px[0][1]);
    for (let i = 1; i < px.length; i++) ctx.lineTo(px[i][0], px[i][1]);
    ctx.stroke();

    // speed-colored line
    const slow = hex2rgb(cssVar("--map-slow"));
    const fast = hex2rgb(cssVar("--map-fast"));
    ctx.lineWidth = 4.5;
    for (let i = 1; i < px.length; i++) {
      const t = (vNorm[i - 1] + vNorm[i]) / 2;
      const c = slow.map((s, k) => Math.round(s + (fast[k] - s) * t));
      ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath();
      ctx.moveTo(px[i - 1][0], px[i - 1][1]);
      ctx.lineTo(px[i][0], px[i][1]);
      ctx.stroke();
    }

    // start/finish tick, perpendicular to the direction of travel
    const [sx, sy] = px[0];
    const hx = px[Math.min(3, px.length - 1)][0] - sx;
    const hy = px[Math.min(3, px.length - 1)][1] - sy;
    const hl = Math.hypot(hx, hy) || 1;
    const nx = -hy / hl;
    const ny = hx / hl;
    ctx.strokeStyle = cssVar("--text-strong");
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx + nx * 10, sy + ny * 10);
    ctx.lineTo(sx - nx * 10, sy - ny * 10);
    ctx.stroke();

    if (!reduceMotion) {
      const d = px[Math.floor(dot) % px.length];
      ctx.save();
      ctx.shadowColor = cssVar("--accent");
      ctx.shadowBlur = 10;
      ctx.fillStyle = cssVar("--accent");
      ctx.beginPath();
      ctx.arc(d[0], d[1], 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  if (reduceMotion) {
    draw();
    // repaint on theme flips; stop watching once the canvas is gone
    const obs = new MutationObserver(() => {
      if (!canvas.isConnected) return obs.disconnect();
      draw();
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return;
  }
  // ~8s per lap regardless of point count; faster sections move the dot faster.
  const meanV = vNorm.reduce((a, b) => a + b, 0) / vNorm.length || 0.5;
  const base = px.length / (8 * 60);
  (function loop() {
    if (!canvas.isConnected) return; // view re-rendered — stop this loop
    dot = (dot + (base * (0.4 + vNorm[Math.floor(dot) % px.length] * 1.2)) / (0.4 + meanV * 1.2)) % px.length;
    draw();
    requestAnimationFrame(loop);
  })();
}
