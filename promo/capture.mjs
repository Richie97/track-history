// Film the app: build the demo logbook on a scratch database, start the real
// Worker on it, and screenshot every screen the promo cuts to — plus the
// facts the motion graphics draw (the PB lap's racing line, the lap-time
// progression, the leaderboard) into out/data.json, so the video's numbers
// are the app's numbers.
//
//   node capture.mjs            fresh demo logbook, then capture
//   node capture.mjs --reuse    capture against the logbook already in .state

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildDemo, sessionBody } from "./demo/seed.mjs";
import * as LB from "./demo/logbook.mjs";
import { loadCota } from "./demo/track.mjs";
import { launch, newContext } from "./lib/browser.mjs";
import { apiClient, PROMO, signIn, startWorker } from "./lib/worker.mjs";
import { buildGpmfMp4 } from "../test/fixtures/build.mjs";
import { alignLapPair, lapMetrics } from "../public/js/compare-laps.js";
import { deltaSeries } from "../public/js/channel-graphs.js";
import { sectorTimes } from "../public/js/sectors.js";

const OUT = path.join(PROMO, "out");
const SHOTS = path.join(OUT, "screens");
mkdirSync(SHOTS, { recursive: true });
const reuse = process.argv.includes("--reuse");
const log = (...a) => console.log(...a);

let worker, base;
if (reuse) ({ worker, base } = await startWorker({ email: LB.DRIVER.email, name: LB.DRIVER.name }));
else ({ worker, base } = await buildDemo({ log }));
const token = await signIn(base);
const api = apiClient(base, token);

// --- what's in the logbook -------------------------------------------------
const events = await api("GET", "/events");
const cotaEvents = events.filter((e) => e.track_name === LB.COTA && e.best_ms != null).sort((a, b) => a.start_date.localeCompare(b.start_date));
const trackId = cotaEvents[0].track_id;
const pbEvent = await api("GET", `/events/${cotaEvents[cotaEvents.length - 1].id}`);
const firstEvent = await api("GET", `/events/${cotaEvents[0].id}`);
const bestLapOf = (ev) => {
  let best = null;
  for (const s of ev.sessions) for (const l of s.laps) if (!best || l.time_ms < best.lap.time_ms) best = { session: s, lap: l };
  return best;
};
const pb = bestLapOf(pbEvent);
const first = bestLapOf(firstEvent);
const lapKey = (b) => `${b.session.id}:${b.lap.lap_num ?? b.session.laps.indexOf(b.lap) + 1}`;
const vehicles = await api("GET", "/vehicles");
const z06 = vehicles.find((v) => v.name === LB.Z06_NAME);
const board = await api("GET", `/tracks/${trackId}/leaderboard`);
const garage = await api("GET", "/garage");
log(`PB ${pb.lap.time_ms} in "${pb.session.label}", first COTA best ${first.lap.time_ms}`);

// What an AI assistant would find comparing the PB with February's best —
// computed by the app's own analysis modules (the ones the MCP tools use),
// so the video's chat quotes real numbers.
function aiCompare(evA, evB) {
  const bestEntry = (ev) => {
    let b = null;
    for (const s of ev.sessions) for (const e of s.channels?.laps ?? []) if (!b || e.timeMs < b.e.timeMs) b = { e, step: s.channels.dStepM };
    return b;
  };
  const a = bestEntry(evA), b = bestEntry(evB);
  const sa = sectorTimes(a.e, a.step), sb = sectorTimes(b.e, b.step);
  const pair = alignLapPair(a.e, a.step, b.e, b.step);
  const d = deltaSeries(pair.laps[0], pair.laps[1], pair.dStepM);
  // the two 400 m stretches where the gap to the older lap closed fastest
  const W = Math.round(400 / pair.dStepM);
  const wins = [];
  for (let k = 0; k + W < d.length; k++) wins.push({ k, g: d[k + W] - d[k] });
  wins.sort((x, y) => x.g - y.g);
  const picked = [];
  for (const w of wins) {
    if (picked.every((p) => Math.abs(p.k - w.k) > 2 * W)) picked.push(w);
    if (picked.length === 2) break;
  }
  const zone = (w) => {
    // the braking onset and the slowest point inside the stretch, per lap
    const on = (e) => {
      for (let k = Math.max(1, w.k - 10); k < w.k + W; k++) if (e.brake[k] >= 20 && e.brake[k - 1] < 20) return k;
      return null;
    };
    const apex = (e) => {
      let m = w.k;
      for (let k = w.k; k < w.k + W; k++) if (e.speed[k] < e.speed[m]) m = k;
      return e.speed[m];
    };
    const [la, lb] = pair.laps;
    const oa = on(la), ob = on(lb);
    return {
      fromM: w.k * pair.dStepM, gainS: -w.g,
      laterM: oa != null && ob != null ? (oa - ob) * pair.dStepM : null,
      apexGainKph: apex(la) - apex(lb),
    };
  };
  const ma = lapMetrics(a.e), mb = lapMetrics(b.e);
  return {
    a: { ms: a.e.timeMs, date: evA.start_date }, b: { ms: b.e.timeMs, date: evB.start_date },
    sectorsS: sa.map((v, i) => (v - sb[i]) / 1000),
    zones: picked.sort((x, y) => x.k - y.k).map(zone),
    latG: [mb.maxLatG, ma.maxLatG],
  };
}
const febEvent = await api("GET", `/events/${cotaEvents.find((e) => e.start_date.startsWith("2026-02")).id}`);

const facts = {
  driver: LB.DRIVER.name,
  track: LB.COTA,
  pb: { ms: pb.lap.time_ms, date: pbEvent.start_date, session: pb.session.label, trace: pb.session.trace },
  progression: cotaEvents.map((e) => ({ date: e.start_date, best_ms: e.best_ms, ambient: [e.ambient_lo_c, e.ambient_hi_c] })),
  pbSessionLaps: pb.session.laps.map((l) => l.time_ms),
  leaderboard: board.entries.map((e) => ({ name: e.name, best_ms: e.best_ms, you: e.you })),
  garage: garage.vehicles?.map((v) => ({ name: v.name, parts: v.parts.map((p) => ({ kind: p.kind, name: p.name, wear: p.wear })) })),
  boxes: {},
  ai: aiCompare(pbEvent, febEvent),
  // The driver's evolution at one track, for the App Store header: the best
  // lap of the first visit, a middle one and the PB weekend, as the channel
  // panel overlays them — speed (km/h) on the driven-distance grid.
  overlay: (() => {
    const bestEntry = (ev) => {
      let b = null;
      for (const s of ev.sessions) for (const e of s.channels?.laps ?? []) if (!b || e.timeMs < b.e.timeMs) b = { e, step: s.channels.dStepM };
      return b;
    };
    const picks = [firstEvent, febEvent, pbEvent].map(bestEntry).filter(Boolean);
    return { dStepM: picks[0]?.step, laps: picks.map((p) => ({ ms: p.e.timeMs, speed: p.e.speed })) };
  })(),
};

// --- the camera --------------------------------------------------------------
const browser = await launch();
const settle = async (page, ms = 500) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
};
const go = async (page, hash, waitFor, ms) => {
  await page.goto(hash.startsWith("/") ? base + hash : `${base}/${hash}`);
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 });
  await settle(page, ms);
};
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
// The top bar is sticky, so it would paint over the top of any element
// screenshot taken below the fold; element captures unstick it first.
const unstick = (page) => page.addStyleTag({ content: ".topbar { position: static !important; }" });
// Bounding boxes of elements relative to a container, in CSS px — the
// video zooms onto these.
async function boxes(page, container, named) {
  return page.evaluate(
    ([container, named]) => {
      const root = typeof container === "string" ? document.querySelector(container) : null;
      const r0 = root ? root.getBoundingClientRect() : { left: -window.scrollX, top: -window.scrollY };
      const out = {};
      for (const [key, sel] of Object.entries(named)) {
        const el = typeof sel === "string" ? (root ?? document).querySelector(sel) : null;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out[key] = { x: Math.round(r.left - r0.left), y: Math.round(r.top - r0.top), w: Math.round(r.width), h: Math.round(r.height) };
      }
      if (root) {
        const r = root.getBoundingClientRect();
        out._size = { w: Math.round(r.width), h: Math.round(r.height) };
      }
      return out;
    },
    [container, named]
  );
}

const desktop = await newContext(browser, { width: 1440, height: 900, scale: 2, base });
await desktop.addCookies([{ name: "session", value: token, domain: "localhost", path: "/" }]);
const page = await desktop.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));

// Dashboard.
await go(page, "#/", ".hero, .tracks, h2");
await shot(page, "dash");
await shot(page, "dash-full", { fullPage: true });
log("dash");

// Track page: the progress chart, with and without its line (the video
// draws the line in over the bare card).
await go(page, `#/track/${trackId}`, ".chart-card svg");
await shot(page, "track");
await unstick(page);
const chartCard = page.locator(".chart-card").first();
await chartCard.screenshot({ path: path.join(SHOTS, "track-chart.png") });
await page.addStyleTag({
  content: `.chart-card:first-of-type svg path[stroke="var(--chart-line)"], .chart-card:first-of-type svg circle[fill="var(--chart-line)"] { visibility: hidden }`,
});
await page.waitForTimeout(100);
await chartCard.screenshot({ path: path.join(SHOTS, "track-chart-bare.png") });
facts.boxes.trackChart = await page.evaluate(() => {
  const card = document.querySelector(".chart-card");
  const svg = card.querySelector("svg");
  const c = card.getBoundingClientRect();
  const s = svg.getBoundingClientRect();
  return { card: { w: c.width, h: c.height }, plot: { x: s.left - c.left, y: s.top - c.top, w: s.width, h: s.height } };
});
log("track");

// Event page: the PB weekend.
await go(page, `#/event/${pbEvent.id}`, "#trackmap");
await shot(page, "event", { fullPage: true, clip: { x: 0, y: 0, width: 1440, height: 1500 } });
await unstick(page);
await page.locator(".chart-card:has(#trackmap)").screenshot({ path: path.join(SHOTS, "event-map.png") });
// The PB session's panel, opened, with a second lap lit so the delta shows.
const pbCard = page.locator("div.session").filter({ has: page.locator("button.ch-chip.on", { hasText: "★" }) }).filter({ hasText: pb.session.label });
await pbCard.locator("summary").first().click();
await page.waitForTimeout(400);
const chips = pbCard.locator("button.ch-chip");
const nChips = await chips.count();
// the slowest-but-clean comparison: the session's second-best lap
const lapTimes = [];
for (let i = 0; i < nChips; i++) lapTimes.push({ i, text: await chips.nth(i).innerText() });
const order = pb.session.laps.map((l, i) => ({ i, t: l.time_ms })).sort((a, b) => a.t - b.t);
await chips.nth(order[1].i).click();
await page.waitForTimeout(400);
await pbCard.scrollIntoViewIfNeeded();
const tabs = ["time", "inputs", "grip", "car"];
facts.boxes.panel = {};
for (const tab of tabs) {
  await pbCard.locator(`[data-ch-tab="${tab}"]`).click();
  await page.waitForTimeout(500);
  await pbCard.screenshot({ path: path.join(SHOTS, `panel-${tab}.png`) });
  facts.boxes.panel[tab] = await page.evaluate((label) => {
    const card = [...document.querySelectorAll("div.session")].find((d) => d.querySelector(".s-label")?.textContent === label);
    const c = card.getBoundingClientRect();
    const rel = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - c.left), y: Math.round(r.top - c.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const panel = card.querySelector(".ch-tabpanel:not([hidden])");
    const charts = panel ? [...panel.querySelectorAll("svg, table, .chart-card, .ch-chart")].filter((e) => e.getBoundingClientRect().height > 40) : [];
    return {
      size: { w: Math.round(c.width), h: Math.round(c.height) },
      stats: rel(card.querySelector(".s-stats")),
      chips: rel(card.querySelector(".laps, .ch-chips")),
      tabs: rel(card.querySelector(".ch-tabs")),
      panel: rel(panel),
      items: charts.map(rel),
      titles: charts.map((e) => (e.closest("figure, .ch-chart, .chart-card")?.querySelector("figcaption, .chart-title, .ch-title")?.textContent ?? e.getAttribute("aria-label") ?? e.tagName).trim().slice(0, 60)),
    };
  }, pb.session.label);
  log(`panel ${tab}`);
}

// Two laps, two seasons apart.
await go(page, `#/track/${trackId}/lap-compare?a=${encodeURIComponent(lapKey(pb))}&b=${encodeURIComponent(lapKey(first))}`, "#cmp-charts svg");
// Tall pages are clipped to the part the video uses: a Chromium page
// decoding several 20-megapixel captures at once starts refusing them.
const CMP_CLIP = { x: 0, y: 600, width: 1440, height: 900 };
await shot(page, "compare", { fullPage: true, clip: CMP_CLIP });
facts.boxes.compare = { ...(await boxes(page, null, { charts: "#cmp-charts", table: "table" })), clipY: CMP_CLIP.y };
log("compare");

// Garage and the car.
await go(page, "#/garage", ".card, .tile");
await shot(page, "garage");
await go(page, `#/vehicle/${z06.id}`, "h1");
await shot(page, "vehicle", { fullPage: true, clip: { x: 0, y: 0, width: 1440, height: 1800 } });
facts.boxes.vehicle = await page.evaluate(() => {
  const rel = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const cards = [...document.querySelectorAll("div")].filter((d) => /Carbotech XP20/.test(d.textContent) && d.querySelector("button") && d.getBoundingClientRect().height < 260 && d.getBoundingClientRect().height > 80);
  cards.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
  return { frontPads: rel(cards[cards.length - 1]), page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight } };
});
log("garage");

// Leaderboard, and one row opened.
await go(page, `#/track/${trackId}/leaderboard`, "table");
await shot(page, "leaderboard");
facts.boxes.leaderboard = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("tr")];
  const you = rows.find((r) => /\(you\)/.test(r.textContent));
  const table = document.querySelector("table");
  const rel = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return { you: you && rel(you), table: rel(table) };
});
await go(page, `#/track/${trackId}/leaderboard/${board.entries[0].lap_id}`, "svg");
await shot(page, "lb-lap", { fullPage: true });
log("leaderboard");

// Coaching, the public share page, the year in review.
await go(page, "#/coaching", "h1");
await shot(page, "coaching");
await go(page, `/share/${LB.SHARE_SLUG}`, "h1");
await shot(page, "share");
await go(page, "#/year", "h1");
await shot(page, "year");
log("coaching, share, year");

// Import: a GoPro clip of a session at the PB weekend, through the real
// importer — the review, then the start/finish line picked on its map.
{
  const track = await loadCota(path.join(PROMO, ".cache"));
  const { sim } = sessionBody(track, {
    skill: 0.7, laps: 5, seed: 4242, startTod: 0, ambientC: 31, odometerKm: 14500,
    label: "import", file: "GX010057.MP4",
  });
  const gps = sim.gps.filter((_, i) => i % 1 === 0);
  const mp4 = buildGpmfMp4(gps, { utc: "260912151500.000" });
  await go(page, `#/event/${pbEvent.id}`, "#trackmap");
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: "GX010057.MP4", mimeType: "video/mp4", buffer: Buffer.from(mp4) });
  await page.waitForSelector("#line-map", { timeout: 30000 });
  await unstick(page);
  await settle(page, 300);
  const panel = page.locator(".panel:has(#line-map)");
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(SHOTS, "import-pick.png") });
  // the start/finish is where the first timed lap begins
  const sfT = sim.laps[0].startT;
  let sfIdx = 0;
  gps.forEach((p, i) => { if (Math.abs(p.t - sfT) < Math.abs(gps[sfIdx].t - sfT)) sfIdx = i; });
  const pt = await page.evaluate((idx) => {
    const svg = document.querySelector("#line-map");
    const pts = svg.querySelector("polyline").getAttribute("points").trim().split(/\s+/).map((s) => s.split(",").map(Number));
    const [px, py] = pts[idx];
    const r = svg.getBoundingClientRect();
    return { x: r.left + (px / 380) * r.width, y: r.top + (py / 260) * r.height, rel: { x: px / 380, y: py / 260 } };
  }, sfIdx);
  facts.boxes.importClick = pt.rel;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(600);
  await panel.screenshot({ path: path.join(SHOTS, "import-laps.png") });
  facts.boxes.importPanel = await boxes(page, ".panel:has(#line-map)", { map: "#line-map", laps: ".laps" });
  log("import");
}

await desktop.close();

// --- the phone -----------------------------------------------------------------
const phone = await newContext(browser, { width: 390, height: 844, scale: 3, mobile: true, base });
await phone.addCookies([{ name: "session", value: token, domain: "localhost", path: "/" }]);
const m = await phone.newPage();
m.on("pageerror", (e) => log("pageerror:", e.message));
await go(m, "#/", "h2");
await shot(m, "m-dash", { fullPage: true, clip: { x: 0, y: 0, width: 390, height: 2000 } });
await go(m, `#/event/${pbEvent.id}`, "#trackmap");
await shot(m, "m-event", { fullPage: true, clip: { x: 0, y: 0, width: 390, height: 2600 } });
await go(m, `#/track/${trackId}/leaderboard`, "table");
await shot(m, "m-leaderboard");
// The App Store preview's draft stand-ins (appstore/preview.js): the screens
// it cuts to, at phone width, until the native footage is recorded.
const pageShot = async (name, maxH) => {
  const h = await m.evaluate(() => document.documentElement.scrollHeight);
  await shot(m, name, { fullPage: true, clip: { x: 0, y: 0, width: 390, height: Math.min(h, maxH) } });
};
await go(m, `#/track/${trackId}`, ".chart-card svg");
await pageShot("m-track", 1800);
await go(m, `#/vehicle/${z06.id}`, "h1");
await pageShot("m-vehicle", 2400);
{
  await go(m, `#/event/${pbEvent.id}`, "#trackmap");
  await unstick(m);
  const card = m.locator("div.session").filter({ has: m.locator("button.ch-chip.on", { hasText: "★" }) }).filter({ hasText: pb.session.label });
  await card.locator("summary").first().click();
  await m.waitForTimeout(400);
  await card.locator("button.ch-chip").nth(order[1].i).click();
  await m.waitForTimeout(400);
  for (const tab of ["time", "grip"]) {
    await card.locator(`[data-ch-tab="${tab}"]`).click();
    await m.waitForTimeout(500);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: path.join(SHOTS, `m-panel-${tab}.png`) });
    // where the tab's first chart starts, so the draft can scroll to it
    facts.boxes[`mPanel_${tab}`] = await card.evaluate((c) => {
      const r0 = c.getBoundingClientRect();
      const panel = c.querySelector(".ch-tabpanel:not([hidden])");
      const r = panel ? panel.getBoundingClientRect() : r0;
      return { panelY: Math.round(r.top - r0.top), h: Math.round(r0.height) };
    });
  }
}
// Season Wrapped, card by card.
await go(m, "#/wrapped/2025", ".wrapped");
let cards = 0;
for (let i = 0; i < 14; i++) {
  await m.waitForTimeout(350);
  await shot(m, `m-wrapped-${i}`);
  cards++;
  const next = m.locator('button.wr-step[data-step="1"]');
  if (!(await next.isEnabled().catch(() => false))) break;
  const before = await m.evaluate(() => document.querySelector(".wr-dot.is-current") && [...document.querySelectorAll(".wr-dot")].indexOf(document.querySelector(".wr-dot.is-current")));
  await next.click();
  await m.waitForTimeout(250);
  const after = await m.evaluate(() => document.querySelector(".wr-dot.is-current") && [...document.querySelectorAll(".wr-dot")].indexOf(document.querySelector(".wr-dot.is-current")));
  if (after === before) break;
}
facts.wrappedCards = cards;
log(`phone (${cards} wrapped cards)`);
await phone.close();

await browser.close();
await worker.dispose();
writeFileSync(path.join(OUT, "data.json"), JSON.stringify(facts, null, 1));
log(`wrote ${path.relative(PROMO, OUT)}/data.json`);
