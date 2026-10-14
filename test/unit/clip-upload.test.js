// The clip uploader's state machine (NS-47), ported from the iOS Kit's
// ClipUploadQueueTests one for one (Android's ClipUploadQueueTest ports the
// same cases), plus the web's own: sourceUnreadable, the page's wording, and
// the driver over injected transport.

import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  DropReason,
  MAX_RESTARTS,
  apply,
  backoffMs,
  clipBannerText,
  clipFailureText,
  clipStatusText,
  createBody,
  createClipUploads,
  newJob,
  nextAction,
  partRange,
  sessionState,
} from "../../public/js/import/clip-upload.js";

const MiB = 1024 * 1024;
const now = 1_800_000_000_000;

// A 120 MiB clip: three parts of 50, 50 and 20 MiB.
const job = (sessionId = 42) =>
  newJob({
    id: "job-1",
    sessionId,
    timeMs: 121_345,
    sizeBytes: 120 * MiB,
    durationMs: 126_400,
    lapOffsetMs: 3_317,
    createdAtMs: now,
  });

const real = (id) => ({ kind: "real", id });
const createAction = (j = job()) => ({ kind: "create", sessionId: 42, body: createBody(j) });
const part = (n, offset, length) => ({ kind: "uploadPart", clipId: 7, part: n, offset, length });

// The job once its create answered.
function started(uploaded = []) {
  const out = apply(job(), createAction(), { kind: "created", start: { clipId: 7, partBytes: 50 * MiB, parts: 3, uploaded } }, now);
  expect(out.kind).toBe("continue");
  return out.job;
}

describe("the session", () => {
  it("a real session id is used as is", () => {
    expect(sessionState(42, null, false)).toEqual(real(42));
  });

  it("a temp session id waits while its create is queued", () => {
    expect(sessionState("tmp-3", null, true)).toEqual({ kind: "waiting" });
    expect(nextAction(job("tmp-3"), { kind: "waiting" }, now)).toEqual({ kind: "waitForSession" });
  });

  it("a temp session id maps to the real one once flushed", () => {
    expect(sessionState("tmp-3", 42, false)).toEqual(real(42));
    expect(nextAction(job("tmp-3"), real(42), now)).toEqual({ kind: "create", sessionId: 42, body: createBody(job()) });
  });

  it("a temp session the server refused drops the job", () => {
    expect(sessionState("tmp-3", null, false)).toEqual({ kind: "lost" });
    expect(nextAction(job("tmp-3"), { kind: "lost" }, now)).toEqual({ kind: "drop", reason: DropReason.sessionLost });
  });
});

describe("create", () => {
  it("a fresh job starts with the create", () => {
    const body = createBody(job());
    expect(body).toEqual({ time_ms: 121_345, size_bytes: 120 * MiB, duration_ms: 126_400, lap_offset_ms: 3_317 });
    expect(nextAction(job(), real(42), now)).toEqual({ kind: "create", sessionId: 42, body });
  });

  it("the create answer sets up the parts and the first part follows", () => {
    const j = started();
    expect([j.clipId, j.partBytes, j.parts, j.uploaded]).toEqual([7, 50 * MiB, 3, []]);
    expect(nextAction(j, real(42), now)).toEqual(part(1, 0, 50 * MiB));
  });

  it("a resumed create picks up after the parts the server holds", () => {
    const j = started([2, 1, 9]);
    expect(j.uploaded).toEqual([1, 2]); // a part number past the count is ignored
    expect(nextAction(j, real(42), now)).toEqual(part(3, 100 * MiB, 20 * MiB));
  });

  it("storage full and already-has-a-clip drop the job", () => {
    expect(apply(job(), createAction(), { kind: "status", status: 409, error: "clip storage full" }, now)).toEqual({
      kind: "dropped",
      reason: DropReason.storageFull,
    });
    expect(apply(job(), createAction(), { kind: "status", status: 409, error: "lap already has a clip" }, now)).toEqual({
      kind: "dropped",
      reason: DropReason.alreadyHasClip,
    });
  });

  it("a create refused for any other reason drops the job", () => {
    const status = (s, error) => apply(job(), createAction(), { kind: "status", status: s, error }, now);
    expect(status(402, "pro required")).toEqual({ kind: "dropped", reason: DropReason.proRequired });
    expect(status(404, "not found")).toEqual({ kind: "dropped", reason: DropReason.notFound });
    expect(status(400, "clip too long")).toEqual({ kind: "dropped", reason: DropReason.refused });
  });
});

describe("parts", () => {
  it("a part uploaded moves to the next", () => {
    const out = apply(started(), part(1, 0, 50 * MiB), { kind: "ok" }, now);
    expect(out.job.uploaded).toEqual([1]);
    expect(nextAction(out.job, real(42), now)).toEqual(part(2, 50 * MiB, 50 * MiB));
  });

  it("every part held means complete", () => {
    expect(nextAction(started([1, 2, 3]), real(42), now)).toEqual({ kind: "complete", clipId: 7 });
  });

  it("a part refused because the clip is already ready goes to complete", () => {
    const out = apply(started(), part(1, 0, 50 * MiB), { kind: "status", status: 409, error: "clip already uploaded" }, now);
    expect(nextAction(out.job, real(42), now)).toEqual({ kind: "complete", clipId: 7 });
  });

  it("a part of the wrong size drops the job", () => {
    const a = part(1, 0, 50 * MiB);
    expect(apply(started(), a, { kind: "status", status: 400, error: "part 1 must be …" }, now)).toEqual({
      kind: "dropped",
      reason: DropReason.refused,
    });
    expect(apply(started(), a, { kind: "status", status: 411, error: null }, now)).toEqual({
      kind: "dropped",
      reason: DropReason.refused,
    });
  });

  it("a part the server lost restarts from the create and gives up eventually", () => {
    const a = part(2, 50 * MiB, 50 * MiB);
    let j = started([1]);
    for (let restart = 1; restart <= MAX_RESTARTS; restart++) {
      const out = apply(j, a, { kind: "status", status: 404, error: "not found" }, now);
      expect(out.kind).toBe("continue");
      expect([out.job.clipId, out.job.uploaded, out.job.restarts]).toEqual([null, [], restart]);
      expect(nextAction(out.job, real(42), now)).toEqual({ kind: "create", sessionId: 42, body: createBody(out.job) });
      j = { ...out.job, clipId: 7, partBytes: 50 * MiB, parts: 3 };
    }
    expect(apply(j, a, { kind: "status", status: 404, error: "not found" }, now)).toEqual({
      kind: "dropped",
      reason: DropReason.tooManyRestarts,
    });
  });

  it("a source file that can no longer be read drops the job (web only)", () => {
    expect(apply(started(), part(1, 0, 50 * MiB), { kind: "unreadable" }, now)).toEqual({
      kind: "dropped",
      reason: DropReason.sourceUnreadable,
    });
  });
});

describe("complete", () => {
  it("complete finishes the job", () => {
    expect(apply(started([1, 2, 3]), { kind: "complete", clipId: 7 }, { kind: "ok" }, now)).toEqual({ kind: "finished" });
  });

  it("complete missing parts sends exactly those again", () => {
    const out = apply(started([1, 2, 3]), { kind: "complete", clipId: 7 }, { kind: "missingParts", missing: [2] }, now);
    expect(out.job.uploaded).toEqual([1, 3]);
    expect(nextAction(out.job, real(42), now)).toEqual(part(2, 50 * MiB, 50 * MiB));
  });

  it("complete on a lost upload restarts", () => {
    const out = apply(started([1, 2, 3]), { kind: "complete", clipId: 7 }, { kind: "status", status: 404, error: "not found" }, now);
    expect([out.job.clipId, out.job.restarts]).toEqual([null, 1]);
  });
});

describe("backoff", () => {
  it("transport failures and server errors back off and never drop", () => {
    const a = part(1, 0, 50 * MiB);
    let j = started();
    const waits = [];
    for (const response of [
      { kind: "transport" },
      { kind: "status", status: 503, error: null },
      { kind: "status", status: 429, error: null },
      { kind: "status", status: 401, error: null },
      { kind: "transport" },
    ]) {
      const out = apply(j, a, response, now);
      expect(out.kind).toBe("continue");
      waits.push(out.job.notBeforeMs - now);
      j = out.job;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(nextAction(j, real(42), now)).toEqual({ kind: "waitUntil", ms: now + 480_000 });
    expect(nextAction(j, real(42), now + 480_000)).toEqual(a);
    const recovered = apply(j, a, { kind: "ok" }, now + 480_000);
    expect([recovered.job.failures, recovered.job.notBeforeMs]).toEqual([0, null]);
  });

  it("the backoff is capped at an hour", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(8)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(500)).toBe(BACKOFF_MAX_MS);
  });

  it("a temp session waits even during a backoff", () => {
    const j = { ...job("tmp-3"), notBeforeMs: now + 10_000 };
    expect(nextAction(j, { kind: "waiting" }, now)).toEqual({ kind: "waitForSession" });
  });
});

describe("part geometry", () => {
  it("part ranges match the server's part size", () => {
    expect(partRange(120 * MiB, 50 * MiB, 3, 1)).toEqual({ offset: 0, length: 50 * MiB });
    expect(partRange(120 * MiB, 50 * MiB, 3, 3)).toEqual({ offset: 100 * MiB, length: 20 * MiB });
    // A clip smaller than a part is one part of its own size.
    expect(partRange(2048, 50 * MiB, 1, 1)).toEqual({ offset: 0, length: 2048 });
  });
});

describe("what the page says", () => {
  it("each failure has a sentence, and an existing clip has none", () => {
    expect(clipFailureText(DropReason.alreadyHasClip)).toBe("");
    expect(clipFailureText(DropReason.storageFull)).toMatch(/storage is full/);
    expect(clipFailureText(DropReason.sourceUnreadable)).toMatch(/card removed/);
    expect(clipFailureText("cut no-keyframe")).toBe("Couldn't save this lap's video.");
    expect(clipFailureText(DropReason.tooManyRestarts)).toBe("Couldn't save this lap's video.");
  });

  it("the card line and the banner", () => {
    expect(clipStatusText({ state: "cutting" })).toBe("Saving lap video…");
    expect(clipStatusText({ state: "waiting" })).toBe("Lap video waiting to sync");
    expect(clipStatusText({ state: "uploading", fraction: 0.4 })).toBe("Saving lap video · 40%");
    expect(clipStatusText({ state: "uploading", fraction: 0.4, retrying: true })).toBe(
      "Saving lap video · 40% · retrying shortly"
    );
    expect(clipBannerText([])).toBe("");
    expect(clipBannerText([{ state: "failed", sizeBytes: 10 }])).toBe("");
    expect(
      clipBannerText([
        { state: "uploading", sizeBytes: 100, fraction: 1 },
        { state: "uploading", sizeBytes: 300, fraction: 0 },
      ])
    ).toBe("Uploading 2 lap videos — keep this tab open · 25%");
  });
});

// --- the driver ------------------------------------------------------------------

// A fake server and clock for createClipUploads. Every call is recorded.
function harness({ parts = 3, partBytes = 4, size = 10, tempIds = {}, createAnswers = [], putAnswers = [] } = {}) {
  const calls = [];
  let clock = now;
  const timers = [];
  const finished = [];
  const blob = new Blob([new Uint8Array(size)]);
  const deps = {
    now: () => clock,
    setTimer: (fn, ms) => (timers.push({ fn, at: clock + ms }), timers.length),
    clearTimer: () => {},
    cut: async () => ({ blob, sizeBytes: size, durationMs: 5000, lapOffsetMs: 3000 }),
    tempIdState: async (id) => tempIds[id] ?? { mapped: null, queued: false },
    create: async (sessionId, body) => {
      calls.push(["create", sessionId, body.size_bytes]);
      return createAnswers.shift() ?? { kind: "created", start: { clipId: 7, partBytes, parts, uploaded: [] } };
    },
    putPart: async (clipId, n, b, onProgress) => {
      calls.push(["part", n, b.size]);
      onProgress?.(b.size);
      return putAnswers.shift() ?? { kind: "ok" };
    },
    complete: async (clipId) => {
      calls.push(["complete", clipId]);
      return { kind: "ok" };
    },
    onFinished: (id) => finished.push(id),
  };
  const uploads = createClipUploads(deps);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    uploads,
    calls,
    finished,
    timers,
    settle,
    advance: async (ms) => {
      clock += ms;
      for (const t of timers.splice(0)) if (t.at <= clock) t.fn();
      for (let i = 0; i < 10; i++) await settle();
    },
  };
}

const enqueueArgs = (sessionId = 42) => ({ sessionId, timeMs: 100_000, file: null, window: {}, lapStartS: 0 });

async function drain(h) {
  for (let i = 0; i < 20; i++) await h.settle();
}

describe("the driver", () => {
  it("cuts, creates, sends every part from the cut and completes", async () => {
    const h = harness();
    h.uploads.enqueue(enqueueArgs());
    await drain(h);
    expect(h.calls).toEqual([
      ["create", 42, 10],
      ["part", 1, 4],
      ["part", 2, 4],
      ["part", 3, 2],
      ["complete", 7],
    ]);
    expect(h.finished).toEqual([42]);
    expect(h.uploads.statuses()).toEqual([]);
    expect(h.uploads.active()).toBe(false);
  });

  it("a cut that fails leaves a failed entry and sends nothing", async () => {
    const uploads = createClipUploads({
      now: () => now,
      cut: async () => {
        const e = new Error("no");
        e.reason = "no-keyframe";
        throw e;
      },
      tempIdState: async () => ({ mapped: null, queued: false }),
      create: async () => {
        throw new Error("should not create");
      },
    });
    await uploads.enqueue(enqueueArgs());
    const [s] = uploads.statuses();
    expect([s.state, s.reason]).toEqual(["failed", "cut no-keyframe"]);
    expect(clipStatusText(s)).toBe("Couldn't save this lap's video.");
    expect(uploads.active()).toBe(false);
  });

  it("waits for a temp session, then uploads under its real id once kicked", async () => {
    const tempIds = { "tmp-5": { mapped: null, queued: true } };
    const h = harness({ tempIds });
    h.uploads.enqueue(enqueueArgs("tmp-5"));
    await drain(h);
    expect(h.calls).toEqual([]);
    expect(h.uploads.statuses()[0].state).toBe("waiting");
    tempIds["tmp-5"] = { mapped: 99, queued: false };
    h.uploads.kick();
    await drain(h);
    expect(h.calls[0]).toEqual(["create", 99, 10]);
    expect(h.finished).toEqual(["tmp-5"]);
  });

  it("backs off on a dropped connection and resumes when the timer fires", async () => {
    const h = harness({ putAnswers: [{ kind: "transport" }] });
    h.uploads.enqueue(enqueueArgs());
    await drain(h);
    expect(h.calls).toEqual([
      ["create", 42, 10],
      ["part", 1, 4],
    ]);
    expect(h.uploads.statuses()[0].retrying).toBe(true);
    await h.advance(30_000);
    expect(h.calls.slice(2)).toEqual([
      ["part", 1, 4],
      ["part", 2, 4],
      ["part", 3, 2],
      ["complete", 7],
    ]);
  });

  it("a resumed create sends only the parts the server is missing", async () => {
    const h = harness({ createAnswers: [{ kind: "created", start: { clipId: 7, partBytes: 4, parts: 3, uploaded: [1, 2] } }] });
    h.uploads.enqueue(enqueueArgs());
    await drain(h);
    expect(h.calls).toEqual([
      ["create", 42, 10],
      ["part", 3, 2],
      ["complete", 7],
    ]);
  });

  it("a lap that already has a clip finishes quietly", async () => {
    const h = harness({ createAnswers: [{ kind: "status", status: 409, error: "lap already has a clip" }] });
    h.uploads.enqueue(enqueueArgs());
    await drain(h);
    expect(h.uploads.statuses()).toEqual([]);
    expect(h.finished).toEqual([42]);
  });

  it("storage full is a failed entry with the quota sentence", async () => {
    const h = harness({ createAnswers: [{ kind: "status", status: 409, error: "clip storage full" }] });
    h.uploads.enqueue(enqueueArgs());
    await drain(h);
    const [s] = h.uploads.statuses();
    expect(s.state).toBe("failed");
    expect(clipStatusText(s)).toMatch(/storage is full/);
    h.uploads.dismiss(s.key);
    expect(h.uploads.statuses()).toEqual([]);
  });

  it("cancelAll stops and forgets everything", async () => {
    const h = harness({ tempIds: { "tmp-1": { mapped: null, queued: true } } });
    h.uploads.enqueue(enqueueArgs("tmp-1"));
    await drain(h);
    h.uploads.cancelAll();
    expect(h.uploads.statuses()).toEqual([]);
    expect(h.uploads.active()).toBe(false);
  });
});
