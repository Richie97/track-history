// The screenshots in the docs site's guides (site/docs/img/): the real web app,
// on the promo's demo logbook, cropped to the feature each guide ends on.
//
//   node guides.mjs            fresh demo logbook, then capture
//   node guides.mjs --reuse    capture against the logbook already in .state
//
// Every shot is taken twice — dark and light — because the docs site follows
// the reader's colour scheme and a dark screenshot on a light page reads as a
// hole in it. Output is WebP (ffmpeg with libwebp, on PATH or named by $FFMPEG);
// a page references the pair through <picture>. Re-run this when a screen a
// guide shows changes, and commit what it writes.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { buildDemo, sessionBody } from "./demo/seed.mjs";
import * as LB from "./demo/logbook.mjs";
import { loadCota } from "./demo/track.mjs";
import { launch, newContext } from "./lib/browser.mjs";
import { apiClient, PROMO, ROOT, signIn, startWorker } from "./lib/worker.mjs";
import { buildGpmfMp4 } from "../test/fixtures/build.mjs";

const OUT = path.join(ROOT, "site", "docs", "img");
const TMP = path.join(PROMO, "out", "guides");
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const reuse = process.argv.includes("--reuse");
const log = (...a) => console.log(...a);

// The docs column is about 720px wide; a 920px window keeps the app's type
// readable once a capture is scaled into it.
const WIDTH = 920;
const PAD = 14;

let worker, base;
if (reuse) ({ worker, base } = await startWorker({ email: LB.DRIVER.email, name: LB.DRIVER.name }));
else ({ worker, base } = await buildDemo({ log }));
const token = await signIn(base);
const api = apiClient(base, token);

const events = await api("GET", "/events");
const cota = events.filter((e) => e.track_name === LB.COTA).sort((a, b) => a.start_date.localeCompare(b.start_date));
const pbEvent = cota.filter((e) => e.best_ms != null).at(-1);
const nextEvent = cota.find((e) => e.best_ms == null && e.lap_count === 0);
const z06 = (await api("GET", "/vehicles")).find((v) => v.name === LB.Z06_NAME);
const pbDetail = await api("GET", `/events/${pbEvent.id}`);
// A session whose theoretical best beats its real best has something to say
// in the sector table; the weekend's second session of day two is one.
const SESSION = "Day 2 — Session 2";
const session = pbDetail.sessions.find((s) => s.label === SESSION);
if (!session) throw new Error(`no "${SESSION}" on the PB weekend`);
const byTime = session.laps.map((l, i) => ({ i, t: l.time_ms })).sort((a, b) => a.t - b.t);

const names = new Set();
const browser = await launch();

for (const theme of ["dark", "light"]) {
  const ctx = await newContext(browser, { width: WIDTH, height: 900, scale: 2, base });
  await ctx.addCookies([{ name: "session", value: token, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  page.on("pageerror", (e) => log("pageerror:", e.message));

  const go = async (hash, waitFor) => {
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector(waitFor, { timeout: 20000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    // The sticky top bar would paint over anything captured below the fold.
    await page.addStyleTag({ content: ".topbar { position: static !important; }" });
    await page.waitForTimeout(500);
  };

  // One capture: the union of some elements' boxes, padded, in page coordinates.
  // `pad` is tightened where the next thing on the page sits closer than
  // the default and would show as a sliver of cut-off text.
  const shoot = async (name, locators, pad = PAD) => {
    const rects = [];
    for (const loc of locators) {
      const el = loc.first();
      await el.waitFor({ state: "visible", timeout: 10000 });
      rects.push(await el.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY };
      }));
    }
    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    const x = Math.max(0, Math.min(...rects.map((r) => r.x)) - pad);
    const y = Math.max(0, Math.min(...rects.map((r) => r.y)) - pad);
    const right = Math.min(docW, Math.max(...rects.map((r) => r.r)) + pad);
    const bottom = Math.max(...rects.map((r) => r.b)) + pad;
    const clip = { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
    const png = path.join(TMP, `${name}-${theme}.png`);
    await page.screenshot({ path: png, fullPage: true, clip });
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", png, "-c:v", "libwebp", "-quality", "86", "-compression_level", "6",
      path.join(OUT, `${name}-${theme}.webp`)]);
    names.add(name);
    log(`${theme} ${name} ${clip.width}×${clip.height}`);
  };

  // --- the next event: countdown and prep checklist -------------------------
  await go(`#/event/${nextEvent.id}`, "#checklist-panel");
  const useDefault = page.locator("#check-default");
  if (await useDefault.count()) {
    await useDefault.click();
    await page.waitForSelector('#checklist-panel input[type="checkbox"]');
    // a list part-way through reads as a list in use
    for (const i of [0, 1, 3]) {
      await page.locator('#checklist-panel input[type="checkbox"]').nth(i).check();
      await page.waitForTimeout(250);
    }
    await go(`#/event/${nextEvent.id}`, "#checklist-panel");
  }
  await shoot("prep-checklist", [page.locator("h2", { hasText: "Prep checklist" }), page.locator("#checklist-panel")]);

  // --- the PB weekend: cost, setup notebook, one session's analysis ----------
  await go(`#/event/${pbEvent.id}`, "#trackmap");
  await shoot("track-day-cost", [page.locator(".tiles"), page.locator(".cost-breakdown")]);

  await page.locator("#setup-notebook > summary").click();
  await page.waitForTimeout(300);
  await shoot("setup-notebook", [page.locator("#setup-notebook")]);
  await page.locator("#setup-notebook > summary").click();

  const card = page.locator("div.session").filter({ has: page.locator(".s-label", { hasText: SESSION }) }).first();
  await card.locator("details.ch-details > summary").click();
  await page.waitForTimeout(400);
  // the session's second-best lap beside its best, so the delta has two laps
  await card.locator("button.ch-chip").nth(byTime[1].i).click();
  await page.waitForTimeout(500);
  const tab = async (name) => {
    await card.locator(`[data-ch-tab="${name}"]`).click();
    await page.waitForTimeout(600);
  };
  const charts = card.locator(".ch-tabpanel:not([hidden]) .ch-chart");

  await tab("traces");
  await shoot("lap-consistency", [card.locator(".s-head"), card.locator(".s-stats"), card.locator(".ch-chips")], 2);
  await shoot("lap-consistency-sectors", [card.locator(".ch-sectors")]);
  await shoot("lap-delta", [charts.nth(0), charts.nth(1)]);
  await shoot("brake-throttle-traces", [charts.nth(1), charts.nth(2), charts.nth(3)]);
  await shoot("shift-points", [charts.nth(5), charts.nth(6), card.locator(".ch-shifts")], 6);

  await tab("grip");
  await shoot("friction-circle", [card.locator(".ch-grip .grip-plot"), card.locator(".ch-grip .table-wrap")], 6);
  await shoot("understeer-oversteer", [card.locator(".ch-balance .balance-plot"), card.locator(".ch-balance .table-wrap")], 6);

  await tab("car");
  await shoot("temperatures", [card.locator(".health-group").first(), card.locator(".health-group").last()]);
  await shoot("tire-pressures", [card.locator(".health-loop")]);

  // --- the car: what is due, and a part with measurements -------------------
  await go(`#/vehicle/${z06.id}`, ".part-card");
  await shoot("consumables", [page.locator(".garage-alerts"), page.locator(".part-card").first()]);

  // --- coaching: who can see the logbook, and the driver profile -------------
  await go("#/coaching", "#coaches-panel");
  await shoot("working-with-a-coach", [page.locator("h3", { hasText: "Coaches who can see" }), page.locator(".profile-card")]);

  // --- import: a GPS-only clip, its start/finish line picked on the map ------
  // Nothing is saved: the review is left open and the page navigated away.
  {
    const track = await loadCota(path.join(PROMO, ".cache"));
    const { sim } = sessionBody(track, {
      skill: 0.7, laps: 5, seed: 4242, startTod: 0, ambientC: 31, odometerKm: 14500, label: "import", file: "GX010057.MP4",
    });
    const mp4 = buildGpmfMp4(sim.gps, { utc: "260912151500.000" });
    await go(`#/event/${pbEvent.id}`, "#trackmap");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "GX010057.MP4", mimeType: "video/mp4", buffer: Buffer.from(mp4) });
    await page.waitForSelector("#line-map", { timeout: 30000 });
    await page.locator("#line-map").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const sfT = sim.laps[0].startT;
    let sfIdx = 0;
    sim.gps.forEach((p, i) => { if (Math.abs(p.t - sfT) < Math.abs(sim.gps[sfIdx].t - sfT)) sfIdx = i; });
    const pt = await page.evaluate((idx) => {
      const svg = document.querySelector("#line-map");
      const pts = svg.querySelector("polyline").getAttribute("points").trim().split(/\s+/).map((s) => s.split(",").map(Number));
      const [px, py] = pts[idx];
      const r = svg.getBoundingClientRect();
      return { x: r.left + (px / 380) * r.width, y: r.top + (py / 260) * r.height };
    }, sfIdx);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(700);
    await shoot("phone-gps-lap-timing", [page.locator(".panel:has(#line-map)")]);
  }

  await ctx.close();
}

await browser.close();
await worker.dispose();
rmSync(TMP, { recursive: true, force: true });
log(`wrote ${names.size * 2} images to site/docs/img`);
process.exit(0);
