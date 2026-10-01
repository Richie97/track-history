// Build the demo logbook through the app's own API, on the promo's scratch
// database. Telemetry sessions are cut by the importer's own channel builder
// (public/js/import/channels.js) and traced by its own geometry
// (public/js/import/geo.js), so what the app shows is exactly what an import
// of these recordings would have stored.

import { buildLapChannels, D_STEP_M } from "../../public/js/import/channels.js";
import { lapTrace, projectTrace } from "../../public/js/import/geo.js";
import { apiClient, execSql, freshDatabase, newToken, PROMO, signIn, startWorker } from "../lib/worker.mjs";
import * as LB from "./logbook.mjs";
import { rng, simulateSession, slowChannels, Z06 } from "./sim.mjs";
import { COTA_ELEVATION_RANGE_M, COTA_ORIGIN, loadCota } from "./track.mjs";
import path from "node:path";

const cents = (dollars) => (dollars == null ? null : Math.round(dollars * 100));
const parseLap = (s) => {
  const [m, rest] = s.split(":");
  return Math.round((Number(m) * 60 + Number(rest)) * 1000);
};
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const fmtMph = (kmh) => `${Math.round(kmh / 1.609344)} mph`;

// One recorded session as the body of POST /events/:id/sessions — the same
// shape importSessionBody (public/js/import/ui.js) posts.
export function sessionBody(track, { skill, laps, seed, startTod, ambientC, odometerKm, label, file, hotDay = 0, trouble = true }) {
  const R = rng(seed * 7 + 3);
  const lapTrouble = {};
  if (trouble && laps > 3) {
    // one lap per session caught in traffic: a lift somewhere on the lap
    const lap = 2 + Math.floor(R.next() * (laps - 2));
    const from = [2700, 1150, 4400, 800][Math.floor(R.next() * 4)];
    lapTrouble[lap] = { from, to: from + 500 + Math.floor(R.next() * 400), power: 0.4 };
  }
  const sim = simulateSession(track, Z06, { skill, laps, seed, startTod, lapTrouble });
  const slow = slowChannels({ durationS: sim.durationS, startTod, ambientC, seed: seed + 11, hotDay });
  const meta = { ambientC, intakeC: ambientC + 9, elevationM: COTA_ELEVATION_RANGE_M, odometerKm };
  const channels = buildLapChannels(sim.laps, sim.dist, sim.chans, D_STEP_M, { scalars: slow, meta });
  if (!channels) throw new Error(`no channels for ${label}`);
  const projected = projectTrace(sim.gps, COTA_ORIGIN);
  const best = sim.laps.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
  const trace = lapTrace(projected, best.startT, best.endT);
  const top = Math.max(...sim.chans.speed.map((p) => p.v));
  const maxRpm = Math.max(...sim.chans.rpm.map((p) => p.v));
  const maxLat = Math.max(...sim.chans.latG.map((p) => p.v));
  return {
    body: {
      label,
      notes: `Imported from ${file} — top speed ${fmtMph(top)} · max ${Math.round(maxRpm).toLocaleString("en-US")} rpm · ${maxLat.toFixed(2)} G lateral`,
      laps: sim.laps.map((l) => l.timeMs),
      trace,
      channels,
    },
    sim,
  };
}

// Typed-in laps around a session best, the way a driver copies them off a
// lap timer: the best plus a handful of slower ones.
function typedLaps(bestMs, seed) {
  const R = rng(seed);
  const n = 4 + Math.floor(R.next() * 3);
  const laps = Array.from({ length: n }, () => bestMs + Math.round(300 + 2200 * R.next() ** 1.6));
  laps[Math.floor(R.next() * (n - 1)) + 1] = bestMs;
  return laps;
}

export async function buildDemo({ log = console.log } = {}) {
  const track = await loadCota(path.join(PROMO, ".cache"));
  freshDatabase();

  // Rivals and the coach are ordinary accounts made in SQL with a session
  // each, as the API tests make theirs (test/api/helpers.ts).
  const others = [...LB.RIVALS.map(([name]) => ({ name })), { name: LB.COACH.name, coach: true }];
  const sql = [];
  others.forEach((o, i) => {
    o.token = newToken();
    o.email = o.coach ? LB.COACH.email : `${o.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
    sql.push(`INSERT INTO users (id, email, name) VALUES (${100 + i}, '${o.email}', '${o.name.replace(/'/g, "''")}');`);
    sql.push(`INSERT INTO auth_sessions (token, user_id, expires_at) VALUES ('${o.token.hash}', ${100 + i}, ${Date.now() + 30 * 86_400_000});`);
  });
  execSql(sql.join("\n"));

  const { worker, base } = await startWorker({ email: LB.DRIVER.email, name: LB.DRIVER.name });
  const token = await signIn(base);
  const api = apiClient(base, token);
  await api("POST", "/auth/dev/entitlement", { pro: true });

  // --- the garage -----------------------------------------------------------
  const catalog = await api("GET", "/car-catalog");
  const vehicleIds = {};
  const partIds = {};
  for (const v of LB.VEHICLES) {
    const row = catalog.find((c) => c.make === v.catalog[0] && c.model === v.catalog[1] && c.generation === v.catalog[2]);
    const created = await api("POST", "/vehicles", {
      name: v.name, notes: v.notes, is_default: !!v.default, target_hot_psi: v.target_hot_psi ?? null,
      catalog_id: row?.id ?? null,
    });
    vehicleIds[v.name] = created.id;
    for (const p of v.parts) {
      const part = await api("POST", `/vehicles/${created.id}/parts`, {
        kind: p.kind, name: p.name, size: p.size ?? null, installed_on: p.installed_on,
        retired_on: p.retired_on ?? null, cost_cents: cents(p.cost), expected_hours: p.expected_hours ?? null,
        wear_limit: p.wear_limit ?? null, notes: p.notes ?? null,
        ...(p.equipped === false ? { equipped: false } : {}),
      });
      partIds[`${v.name}|${p.kind}|${p.name}|${p.installed_on}`] = part.id;
      for (const [on, value, unit] of p.measurements ?? []) {
        await api("POST", `/parts/${part.id}/measurements`, { measured_on: on, value, unit });
      }
    }
  }
  log(`garage: ${Object.keys(vehicleIds).length} cars`);

  // --- COTA weekends, with telemetry ---------------------------------------
  const eventIds = {};
  let seed = 1;
  const sessionOffsets = [-0.06, -0.025, 0, -0.015, 0.012, 0.022];
  for (const w of LB.COTA_WEEKENDS) {
    const ev = await api("POST", "/events", {
      start_date: w.start, days: w.days, club: w.club, run_group: w.group, track_name: LB.COTA,
      car: LB.Z06_NAME, notes: w.notes, conditions: "dry",
      cost_entry_cents: cents(w.costs?.entry), cost_fuel_cents: cents(w.costs?.fuel),
      cost_travel_cents: cents(w.costs?.travel), cost_misc_cents: cents(w.costs?.misc),
    });
    eventIds[w.start] = ev.id;
    let n = 0;
    for (let day = 1; day <= w.days; day++) {
      for (let s = 1; s <= 3; s++, n++) {
        const skill = Math.max(0, w.skill + sessionOffsets[n % sessionOffsets.length]);
        const hour = [9.25, 11.5, 14.75][s - 1];
        const { body } = sessionBody(track, {
          skill, laps: 5 + ((seed + s) % 3), seed: seed++, startTod: hour * 3600,
          ambientC: w.ambientC + (s - 2) * 2 + (day - 1), odometerKm: w.odometerKm + (n * 22),
          label: `Day ${day} — Session ${s}`, file: `PDR ${addDays(w.start, day - 1)} ${String(Math.floor(hour)).padStart(2, "0")}-${String(Math.round((hour % 1) * 60)).padStart(2, "0")}.mp4`,
          hotDay: w.ambientC > 30 ? 6 : 0,
        });
        await api("POST", `/events/${ev.id}/sessions`, body);
      }
    }
    log(`COTA ${w.start}: ${n} sessions`);
  }

  // --- typed-in days elsewhere ---------------------------------------------
  for (const [start, days, club, group, trackName, car, bests, notes, costs] of LB.OTHER_EVENTS) {
    const ev = await api("POST", "/events", {
      start_date: start, days, club, run_group: group, track_name: trackName, car, notes, conditions: "dry",
      temp_f: 70 + ((seed * 13) % 22),
      cost_entry_cents: cents(costs?.entry), cost_fuel_cents: cents(costs?.fuel),
      cost_travel_cents: cents(costs?.travel), cost_misc_cents: cents(costs?.misc),
    });
    eventIds[start] = ev.id;
    for (let i = 0; i < bests.length; i++) {
      await api("POST", `/events/${ev.id}/sessions`, {
        label: `Session ${i + 1}`, notes: null, laps: typedLaps(parseLap(bests[i]), seed++),
      });
    }
  }

  // --- the next weekend ------------------------------------------------------
  const next = await api("POST", "/events", {
    start_date: LB.inDays(LB.NEXT_EVENT.daysAway), days: LB.NEXT_EVENT.days, club: LB.NEXT_EVENT.club,
    run_group: LB.NEXT_EVENT.group, track_name: LB.COTA, car: LB.Z06_NAME,
    cost_entry_cents: cents(625),
  });
  eventIds.next = next.id;

  // --- setup sheets ----------------------------------------------------------
  for (const s of LB.SETUPS) await api("PUT", `/events/${eventIds[s.start]}/setups/${s.day}`, s.data);

  // --- account: leaderboard consent, share page, profile ---------------------
  await api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
  await api("PUT", "/share", { slug: LB.SHARE_SLUG });
  await api("PUT", "/me/profile", { profile: LB.PROFILE });

  // --- rivals on the COTA leaderboard ---------------------------------------
  for (let i = 0; i < LB.RIVALS.length; i++) {
    const [name, skill, date] = LB.RIVALS[i];
    const rival = apiClient(base, others[i].token.token);
    const ev = await rival("POST", "/events", { start_date: date, days: 1, club: "NASA Texas", track_name: LB.COTA });
    const { body } = sessionBody(track, {
      skill, laps: 5, seed: 500 + i, startTod: 10 * 3600, ambientC: 27, odometerKm: 20000 + i * 1000,
      label: "Session 1", file: "recording.vbo", trouble: false,
    });
    await rival("POST", `/events/${ev.id}/sessions`, body);
    await rival("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    log(`rival ${name}`);
  }

  // --- a coach, invited and accepted the way the app does it ----------------
  const invite = await api("POST", "/coaching/invites", {});
  const inviteToken = invite.url.split("/coach/")[1];
  const coach = apiClient(base, others[others.length - 1].token.token);
  await coach("POST", `/coaching/invites/${inviteToken}/accept`, {});
  // The coach has looked at the logbook: a read under the student mount.
  const me = await api("GET", "/me");
  await coach("GET", `/students/${me.user.id}/events`);

  return { worker, base, token, api, eventIds, vehicleIds, partIds, track, me, coachToken: others[others.length - 1].token.token };
}
