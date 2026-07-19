import { beforeEach, describe, expect, it } from "vitest";
import {
  cachePut,
  cachedGet,
  enqueue,
  flush,
  isQueueable,
  isTempPath,
  recomputeDetail,
  reapplyQueue,
  resetOfflineForTests,
  resolveId,
  syncStatus,
} from "../../public/js/offline.js";

// A cached event-detail body in the exact shape GET /api/events/:id returns.
const detail = (over = {}) => ({
  id: 10,
  track_id: 3,
  track_name: "Test Ring",
  start_date: "2026-05-01",
  days: 2,
  club: null,
  run_group: null,
  car: null,
  notes: null,
  conditions: null,
  temp_f: null,
  checklist: null,
  best_time_ms: null,
  lap_best_ms: null,
  lap_count: 0,
  session_count: 0,
  best_ms: null,
  consistency: null,
  updated_at: 111,
  sessions: [],
  ...over,
});
const listRow = (d) => {
  const { sessions, ...row } = d;
  return row;
};

beforeEach(() => resetOfflineForTests());

describe("response cache", () => {
  it("stores and returns bodies by path", async () => {
    await cachePut("/me", { user: { id: 1 } });
    expect(await cachedGet("/me")).toEqual({ user: { id: 1 } });
    expect(await cachedGet("/nope")).toBeUndefined();
  });

  it("derives a track-filtered events list from the cached full list", async () => {
    await cachePut("/events", [listRow(detail({ id: 1, track_id: 3 })), listRow(detail({ id: 2, track_id: 4 }))]);
    expect((await cachedGet("/events?track_id=4")).map((e) => e.id)).toEqual([2]);
  });
});

describe("recomputeDetail", () => {
  // Mirrors withComputed in src/lib/stats.ts — the best-time rule and the
  // coefficient of variation with the 3-lap minimum.
  it("applies the MIN(manual, best lap) rule and the 3-lap consistency minimum", () => {
    const laps = (ms) => ms.map((t, i) => ({ id: i, session_id: 1, lap_num: i + 1, time_ms: t }));
    const d = detail({ best_time_ms: 105000, sessions: [{ id: 1, laps: laps([110000, 120000]) }] });
    recomputeDetail(d);
    expect(d.best_ms).toBe(105000);
    expect(d.lap_best_ms).toBe(110000);
    expect(d.lap_count).toBe(2);
    expect(d.consistency).toBeNull();

    d.sessions[0].laps = laps([100000, 110000, 120000]);
    recomputeDetail(d);
    expect(d.best_ms).toBe(100000);
    expect(d.consistency).toBeCloseTo(8164.97 / 110000, 4);
  });
});

describe("offline mutation queue", () => {
  it("whitelists only mirrorable mutations", () => {
    expect(isQueueable("POST", "/events")).toBe(true);
    expect(isQueueable("POST", "/events/12/sessions")).toBe(true);
    expect(isQueueable("DELETE", "/laps/5")).toBe(true);
    expect(isQueueable("PUT", "/tracks/2")).toBe(true);
    expect(isQueueable("PUT", "/share")).toBe(false);
    expect(isQueueable("POST", "/vehicles")).toBe(false);
  });

  it("creates an event locally with a temp id, inserted in date order", async () => {
    await cachePut("/events", [listRow(detail({ id: 1, start_date: "2026-06-01" })), listRow(detail({ id: 2, start_date: "2026-04-01" }))]);
    const res = await enqueue("POST", "/events", { track_name: "New Ring", start_date: "2026-05-01" });
    expect(isTempPath(`/events/${res.id}`)).toBe(true);
    expect(syncStatus.pending).toBe(1);

    const list = await cachedGet("/events");
    expect(list.map((e) => e.id)).toEqual([1, res.id, 2]);
    const d = await cachedGet(`/events/${res.id}`);
    expect(d.track_name).toBe("New Ring");
    expect(d.sessions).toEqual([]);
  });

  it("adds a session with laps and recomputes event aggregates everywhere", async () => {
    const d = detail({ id: 10 });
    await cachePut("/events/10", d);
    await cachePut("/events", [listRow(d)]);
    const res = await enqueue("POST", "/events/10/sessions", { label: "S1", laps: [121000.4, 0, -5, null, 119000] });
    const after = await cachedGet("/events/10");
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0].id).toBe(res.id);
    expect(after.sessions[0].laps.map((l) => l.time_ms)).toEqual([121000, 119000]);
    expect(after.best_ms).toBe(119000);
    expect(after.session_count).toBe(1);
    const row = (await cachedGet("/events"))[0];
    expect(row.lap_count).toBe(2);
    expect(row.best_ms).toBe(119000);
    expect(row.sessions).toBeUndefined();
  });

  it("patches event edits and deletes into detail and lists", async () => {
    const d = detail({ id: 10 });
    await cachePut("/events/10", d);
    await cachePut("/events", [listRow(d)]);
    await enqueue("PUT", "/events/10", { notes: "wet all day", best_time_ms: 130000 });
    expect((await cachedGet("/events/10")).notes).toBe("wet all day");
    expect((await cachedGet("/events"))[0].best_ms).toBe(130000);

    await enqueue("DELETE", "/events/10");
    expect(await cachedGet("/events/10")).toBeUndefined();
    expect(await cachedGet("/events")).toEqual([]);
  });

  it("cancels queued creates (and their children) when a temp row is deleted", async () => {
    await cachePut("/events", []);
    const ev = await enqueue("POST", "/events", { track_name: "X", start_date: "2026-05-01" });
    await enqueue("POST", `/events/${ev.id}/sessions`, { laps: [121000] });
    expect(syncStatus.pending).toBe(2);
    await enqueue("DELETE", `/events/${ev.id}`);
    expect(syncStatus.pending).toBe(0);
    expect(await cachedGet(`/events/${ev.id}`)).toBeUndefined();
    expect(await cachedGet("/events")).toEqual([]);
  });

  it("updates and deletes sessions and laps inside a cached detail", async () => {
    const d = detail({
      id: 10,
      sessions: [
        { id: 7, label: "S1", notes: null, sort: 1, trace: null, channels: null, laps: [{ id: 70, session_id: 7, lap_num: 1, time_ms: 121000 }] },
      ],
    });
    recomputeDetail(d);
    await cachePut("/events/10", d);
    await cachePut("/events", [listRow(d)]);

    await enqueue("PUT", "/sessions/7", { label: "Renamed" });
    expect((await cachedGet("/events/10")).sessions[0].label).toBe("Renamed");

    await enqueue("POST", "/sessions/7/laps", { laps: [119000] });
    expect((await cachedGet("/events/10")).sessions[0].laps.map((l) => l.lap_num)).toEqual([1, 2]);
    expect((await cachedGet("/events"))[0].best_ms).toBe(119000);

    await enqueue("DELETE", "/laps/70");
    expect((await cachedGet("/events/10")).sessions[0].laps).toHaveLength(1);

    await enqueue("DELETE", "/sessions/7");
    expect((await cachedGet("/events/10")).sessions).toEqual([]);
    expect((await cachedGet("/events"))[0].lap_count).toBe(0);
  });

  it("patches track goal and notes into the cached tracks list", async () => {
    await cachePut("/tracks", [{ id: 3, name: "Test Ring", goal_ms: null, notes: null }]);
    await enqueue("PUT", "/tracks/3", { goal_ms: 119500 });
    expect((await cachedGet("/tracks"))[0].goal_ms).toBe(119500);
  });
});

describe("flush", () => {
  it("replays in order, maps temp ids into later paths, and reports flushed", async () => {
    await cachePut("/events", []);
    const ev = await enqueue("POST", "/events", { track_name: "X", start_date: "2026-05-01" });
    await enqueue("POST", `/events/${ev.id}/sessions`, { laps: [121000] });
    const sent = [];
    await flush(async (method, path, body) => {
      sent.push(`${method} ${path}`);
      return { ok: true, status: 201, body: { id: sent.length === 1 ? 42 : 43 } };
    });
    expect(sent).toEqual(["POST /events", "POST /events/42/sessions"]);
    expect(resolveId(ev.id)).toBe(42);
    expect(syncStatus.pending).toBe(0);
    expect(syncStatus.failed).toBe(0);
  });

  it("stops on network failure and keeps the remainder queued", async () => {
    await cachePut("/events", []);
    await enqueue("PUT", "/tracks/3", { goal_ms: 1 });
    await enqueue("PUT", "/tracks/3", { goal_ms: 2 });
    let calls = 0;
    await flush(async () => {
      if (++calls === 2) throw new TypeError("network gone");
      return { ok: true, status: 200, body: { ok: true } };
    });
    expect(syncStatus.pending).toBe(1);
    expect(syncStatus.offline).toBe(true);
  });

  it("drops server-rejected items and counts them as failed", async () => {
    await enqueue("PUT", "/tracks/3", { goal_ms: -1 });
    await enqueue("PUT", "/tracks/4", { goal_ms: 2 });
    const sent = [];
    await flush(async (method, path) => {
      sent.push(path);
      return path === "/tracks/3"
        ? { ok: false, status: 400, body: { error: "invalid goal" } }
        : { ok: true, status: 200, body: { ok: true } };
    });
    expect(sent).toEqual(["/tracks/3", "/tracks/4"]);
    expect(syncStatus.pending).toBe(0);
    expect(syncStatus.failed).toBe(1);
  });

  it("drops items whose temp-id dependency never resolved", async () => {
    await cachePut("/events", []);
    const ev = await enqueue("POST", "/events", { track_name: "X", start_date: "2026-05-01" });
    await enqueue("POST", `/events/${ev.id}/sessions`, { laps: [121000] });
    await flush(async (method, path) => {
      if (path === "/events") return { ok: false, status: 400, body: { error: "nope" } };
      throw new Error("should not send the dependent item");
    });
    expect(syncStatus.pending).toBe(0);
    expect(syncStatus.failed).toBe(2);
  });
});

describe("reapplyQueue", () => {
  it("re-patches a fresh server response without duplicating queued rows", async () => {
    const d = detail({ id: 10 });
    await cachePut("/events/10", d);
    await cachePut("/events", [listRow(d)]);
    await enqueue("POST", "/events/10/sessions", { label: "S1", laps: [121000] });

    // A fresh (pre-sync) server body lands, then the overlay re-applies —
    // twice, to prove idempotence.
    await cachePut("/events/10", detail({ id: 10 }));
    await reapplyQueue();
    await reapplyQueue();
    const after = await cachedGet("/events/10");
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0].laps).toHaveLength(1);
  });
});
