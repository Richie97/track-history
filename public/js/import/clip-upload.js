// Best-lap clip uploads from the browser (NS-47, ticket 2,
// docs/specs/native/NS-47-web-clip-upload.md).
//
// Two halves in one file:
//
// - **The queue** (`nextAction`, `apply` and the helpers): the uploader's state
//   machine, pure, a port of the iOS Kit's `ClipUploadQueue` under the same
//   names, with its Swift test cases ported one for one
//   (test/unit/clip-upload.test.js). Android's `:core` carries the same port.
//   This copy is the reference: contracts/logic/clip-upload.json is generated
//   from it, and both phones' queue tests assert against that fixture. Two
//   differences from the Kit, both additive: the `sourceUnreadable` drop (the
//   web reads the driver's own file until the last part, and a card ejected
//   mid-upload can't be read again), and temp ids are the web's `tmp-N`
//   strings where the phones use negative numbers.
// - **The driver** (`createClipUploads`, and the app's `clipUploads`): cuts the
//   clip with mp4cut.js, runs the queue one job and one part at a time while
//   the tab is open, and tells the page how it's going. Nothing is persisted:
//   a File can't outlive the tab. A closed tab is recovered by cutting the
//   same file again, which gives the same bytes, so the create answers the
//   parts the server already holds.
//
// A job goes **create → parts → complete**: `POST /sessions/:id/clip` answers a
// clip id, the part size and (on a resume) the parts already held; each part is
// `PUT /clips/:id/parts/:n`, exactly `partBytes` long but the last; `POST
// /clips/:id/complete` stitches them. The transitions:
//
// | Step | Answer | Then |
// |---|---|---|
// | any | session id still temp, its create still queued | wait for the offline queue |
// | any | session id temp, create gone (the server refused it) | **drop** |
// | any | `notBeforeMs` in the future | wait until then |
// | create | 2xx | take `clip_id`, `part_bytes`, `parts`, `uploaded` |
// | create | 409 *clip storage full* / *lap already has a clip* | **drop** — neither changes on retry |
// | create | 402, 404, 400, any other 4xx | **drop** |
// | part | 2xx | mark the part uploaded |
// | part | 409 (*clip already uploaded*) | treat every part as held; complete |
// | part | 404 | **restart** from create (the server lost the upload) |
// | part | 400 / 411 (sizes disagree) | **drop** |
// | part | the source file can't be read | **drop** (web only) |
// | complete | 2xx | **finished** |
// | complete | 409 with `missing` | forget those parts; send them again |
// | complete | 404 | **restart** |
// | any | transport, 401, 408, 429, 5xx | **back off**: `failures + 1`, wait `backoffMs` |
//
// A restart past `MAX_RESTARTS` drops the job. Nothing is dropped for being
// offline, however long.

import { clipFullText } from "./clip.js";

// --- the queue ---------------------------------------------------------------

// The first retry's wait, doubled per consecutive failure up to the cap.
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const MAX_RESTARTS = 3;

// Why a job was given up — the Kit's DropReason raw values, plus the web's own.
export const DropReason = Object.freeze({
  sessionLost: "session lost",
  storageFull: "clip storage full",
  alreadyHasClip: "lap already has a clip",
  proRequired: "pro required",
  notFound: "not found",
  refused: "refused",
  tooManyRestarts: "too many restarts",
  // Web only: the source file stopped being readable mid-upload.
  sourceUnreadable: "source unreadable",
});

const isTemp = (id) => typeof id === "string" && id.startsWith("tmp-");

// One clip on its way up. `sessionId` is what the session POST answered — a
// `tmp-N` id when the save was queued offline. Everything from `clipId` on is
// the server's answer to the create.
export function newJob({ id, sessionId, timeMs, sizeBytes, durationMs, lapOffsetMs, createdAtMs }) {
  return {
    id,
    sessionId,
    timeMs,
    sizeBytes,
    durationMs,
    lapOffsetMs,
    clipId: null,
    partBytes: null,
    parts: null,
    uploaded: [],
    failures: 0,
    restarts: 0,
    notBeforeMs: null,
    createdAtMs,
  };
}

// The body of POST /sessions/:id/clip.
export const createBody = (job) => ({
  time_ms: job.timeMs,
  size_bytes: job.sizeBytes,
  duration_ms: job.durationMs,
  lap_offset_ms: job.lapOffsetMs,
});

// Where a job's session stands: { kind: "real", id } | { kind: "waiting" } |
// { kind: "lost" }. `mapped` is the offline layer's real id for a temp one,
// `queued` whether its create is still in the queue.
export function sessionState(sessionId, mapped, queued) {
  if (!isTemp(sessionId)) return { kind: "real", id: sessionId };
  if (mapped != null) return { kind: "real", id: mapped };
  return queued ? { kind: "waiting" } : { kind: "lost" };
}

// What to do next:
//   { kind: "waitForSession" } | { kind: "waitUntil", ms }
//   { kind: "create", sessionId, body }
//   { kind: "uploadPart", clipId, part, offset, length }
//   { kind: "complete", clipId } | { kind: "drop", reason }
export function nextAction(job, session, nowMs) {
  if (session.kind === "lost") return { kind: "drop", reason: DropReason.sessionLost };
  if (session.kind === "waiting") return { kind: "waitForSession" };
  if (job.notBeforeMs != null && job.notBeforeMs > nowMs) return { kind: "waitUntil", ms: job.notBeforeMs };
  if (job.clipId == null || job.partBytes == null || job.parts == null) {
    return { kind: "create", sessionId: session.id, body: createBody(job) };
  }
  const part = nextPart(job);
  if (part != null) {
    const { offset, length } = partRange(job.sizeBytes, job.partBytes, job.parts, part);
    return { kind: "uploadPart", clipId: job.clipId, part, offset, length };
  }
  return { kind: "complete", clipId: job.clipId };
}

// The lowest part the server doesn't hold, or null when it holds them all.
export function nextPart(job) {
  if (!(job.parts > 0)) return null;
  const held = new Set(job.uploaded);
  for (let p = 1; p <= job.parts; p++) if (!held.has(p)) return p;
  return null;
}

// Byte range of part `part` (1-based): every part `partBytes` long but the last,
// which is the remainder — partSize in src/lib/clips.ts.
export function partRange(sizeBytes, partBytes, parts, part) {
  const offset = (part - 1) * partBytes;
  const length = part < parts ? partBytes : sizeBytes - partBytes * (parts - 1);
  return { offset, length };
}

// The wait after `failures` consecutive failures: 30 s, 1 min, 2 min … 1 h.
export function backoffMs(failures) {
  if (!(failures > 0)) return 0;
  const exponent = Math.min(failures - 1, 20);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

// Which answers mean "try again later". Responses:
//   { kind: "created", start: { clipId, partBytes, parts, uploaded } }
//   { kind: "ok" } | { kind: "missingParts", missing } | { kind: "transport" }
//   { kind: "status", status, error } | { kind: "unreadable" }  (web only)
export function isRetryable(response) {
  if (response.kind === "transport") return true;
  if (response.kind === "status") {
    const s = response.status;
    return s === 401 || s === 408 || s === 429 || s >= 500;
  }
  return false;
}

// Outcomes: { kind: "continue", job } | { kind: "finished" } |
// { kind: "dropped", reason }. Never mutates `job`.
export function apply(job, action, response, nowMs) {
  if (isRetryable(response)) {
    const failures = job.failures + 1;
    return { kind: "continue", job: { ...job, failures, notBeforeMs: nowMs + backoffMs(failures) } };
  }
  switch (action.kind) {
    case "create": {
      if (response.kind === "created") {
        const { clipId, partBytes, parts, uploaded } = response.start;
        if (!(partBytes > 0) || !(parts > 0)) return dropped(DropReason.refused);
        const held = [...new Set((uploaded ?? []).filter((p) => Number.isInteger(p) && p >= 1 && p <= parts))];
        return succeeded({ ...job, clipId, partBytes, parts, uploaded: held.sort((a, b) => a - b) });
      }
      if (response.kind === "status") {
        if (response.status === 409) {
          if (response.error === DropReason.storageFull) return dropped(DropReason.storageFull);
          if (response.error === DropReason.alreadyHasClip) return dropped(DropReason.alreadyHasClip);
          return dropped(DropReason.refused);
        }
        if (response.status === 402) return dropped(DropReason.proRequired);
        if (response.status === 404) return dropped(DropReason.notFound);
      }
      return dropped(DropReason.refused);
    }
    case "uploadPart": {
      if (response.kind === "ok") {
        const uploaded = job.uploaded.includes(action.part)
          ? job.uploaded
          : [...job.uploaded, action.part].sort((a, b) => a - b);
        return succeeded({ ...job, uploaded });
      }
      if (response.kind === "unreadable") return dropped(DropReason.sourceUnreadable);
      if (response.kind === "status" && response.status === 409) {
        // The clip is already ready (a complete whose answer was lost):
        // `complete` answers it, so go straight there.
        const all = job.parts > 0 ? Array.from({ length: job.parts }, (_, i) => i + 1) : job.uploaded;
        return succeeded({ ...job, uploaded: all });
      }
      if (response.kind === "status" && response.status === 404) return restart(job);
      return dropped(DropReason.refused);
    }
    case "complete": {
      if (response.kind === "ok") return { kind: "finished" };
      if (response.kind === "missingParts") {
        const gone = new Set(response.missing);
        return succeeded({ ...job, uploaded: job.uploaded.filter((p) => !gone.has(p)) });
      }
      if (response.kind === "status" && response.status === 404) return restart(job);
      return dropped(DropReason.refused);
    }
    default:
      return { kind: "continue", job };
  }
}

const dropped = (reason) => ({ kind: "dropped", reason });
const succeeded = (job) => ({ kind: "continue", job: { ...job, failures: 0, notBeforeMs: null } });

function restart(job) {
  const restarts = job.restarts + 1;
  if (restarts > MAX_RESTARTS) return dropped(DropReason.tooManyRestarts);
  return succeeded({ ...job, restarts, clipId: null, partBytes: null, parts: null, uploaded: [] });
}

// --- what the page says ------------------------------------------------------

// The session card's sentence for a job given up. "" when there is nothing to
// tell the driver: a lap that already has a clip shows that clip.
export function clipFailureText(reason) {
  switch (reason) {
    case DropReason.alreadyHasClip:
      return "";
    case DropReason.storageFull:
      return clipFullText(null);
    case DropReason.proRequired:
      return "Saving lap videos needs Track Evolution Pro.";
    case DropReason.sessionLost:
      return "This session didn't sync, so its lap video couldn't be saved.";
    case DropReason.notFound:
      return "The session was deleted before its lap video was saved.";
    case DropReason.sourceUnreadable:
      return "Couldn't read the video file — was the card removed or the file moved?";
    default:
      return "Couldn't save this lap's video.";
  }
}

// One running job's line on its session card.
export function clipStatusText(status) {
  if (!status) return "";
  if (status.state === "failed") return clipFailureText(status.reason);
  if (status.state === "cutting") return "Saving lap video…";
  if (status.state === "waiting") return "Lap video waiting to sync";
  const pct = `${Math.floor((status.fraction ?? 0) * 100)}%`;
  return status.retrying ? `Saving lap video · ${pct} · retrying shortly` : `Saving lap video · ${pct}`;
}

// The shell's banner over every running job, or "" when none is.
export function clipBannerText(statuses) {
  const active = statuses.filter((s) => s.state !== "failed");
  if (!active.length) return "";
  const bytes = active.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0);
  const done = active.reduce((sum, s) => sum + (s.sizeBytes ?? 0) * (s.fraction ?? 0), 0);
  const pct = bytes ? ` · ${Math.floor((done / bytes) * 100)}%` : "";
  const n = active.length;
  return `Uploading ${n} lap video${n === 1 ? "" : "s"} — keep this tab open${pct}`;
}

// --- the driver --------------------------------------------------------------

// The uploader, with every outside effect injected so the tests drive it with
// no network, file or clock:
//   cut(file, window, lapStartS)   → { blob, sizeBytes, durationMs, lapOffsetMs }
//                                    (cutClip from mp4cut.js; app.js wires the live set)
//   create(sessionId, body)        → a Response (above)
//   putPart(clipId, n, blob, onProgress(sentBytes)) → a Response
//   complete(clipId)               → a Response
//   tempIdState(tempId)            → (a promise of) { mapped, queued }
//   onFinished(sessionId)          → the page re-reads the event
//   now(), setTimer(fn, ms) → handle, clearTimer(handle)
export function createClipUploads(deps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  /** @type {Array<{ key: string, job: any, blob: Blob | null, state: string, reason?: string, sent: number, session: any }>} */
  const entries = [];
  const listeners = new Set();
  let seq = 0;
  let running = false;
  let generation = 0; // bumped by cancelAll, so a loop in flight stands down
  let timer = null;
  let abortCurrent = null;

  const emit = () => {
    const list = statuses();
    for (const fn of listeners) fn(list);
  };

  function statuses() {
    return entries.map((e) => ({
      key: e.key,
      sessionId: e.job?.sessionId ?? e.session,
      timeMs: e.job?.timeMs ?? null,
      state: e.state,
      reason: e.reason ?? null,
      sizeBytes: e.job?.sizeBytes ?? 0,
      fraction: fractionOf(e),
      retrying: e.job?.notBeforeMs != null && e.job.notBeforeMs > now(),
    }));
  }

  function fractionOf(e) {
    const j = e.job;
    if (!j || !j.sizeBytes || !j.parts) return 0;
    let held = 0;
    for (const p of j.uploaded) held += partRange(j.sizeBytes, j.partBytes, j.parts, p).length;
    return Math.min(1, (held + e.sent) / j.sizeBytes);
  }

  // Hand a saved session's best lap over. Never throws: a cut that fails is a
  // failed entry, said on the session card, and the session is already saved.
  async function enqueue({ sessionId, timeMs, file, window, lapStartS }) {
    const gen = generation;
    const entry = { key: `clip-${++seq}`, job: null, blob: null, state: "cutting", sent: 0, session: sessionId };
    entries.push(entry);
    emit();
    try {
      const cut = await deps.cut(file, window, lapStartS);
      if (gen !== generation) return;
      entry.blob = cut.blob;
      entry.job = newJob({
        id: entry.key,
        sessionId,
        timeMs,
        sizeBytes: cut.sizeBytes,
        durationMs: cut.durationMs,
        lapOffsetMs: cut.lapOffsetMs,
        createdAtMs: now(),
      });
      entry.state = "uploading";
    } catch (e) {
      if (gen !== generation) return;
      entry.state = "failed";
      entry.reason = e?.reason ? `cut ${e.reason}` : "cut failed";
    }
    emit();
    kick();
  }

  // Wake the loop: a new job, a flushed offline queue, the network back.
  function kick() {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    if (!running) run();
  }

  function finish(entry, outcome) {
    const i = entries.indexOf(entry);
    if (outcome.kind === "finished" || outcome.reason === DropReason.alreadyHasClip) {
      if (i >= 0) entries.splice(i, 1);
      deps.onFinished?.(entry.job.sessionId);
    } else {
      entry.state = "failed";
      entry.reason = outcome.reason;
    }
    entry.blob = null;
  }

  async function run() {
    running = true;
    const gen = generation;
    try {
      for (;;) {
        if (gen !== generation) return;
        let soonest = Infinity;
        let picked = null;
        let action = null;
        for (const e of entries) {
          if (e.state !== "uploading" && e.state !== "waiting") continue;
          const sid = e.job.sessionId;
          const t = isTemp(sid) ? await deps.tempIdState(sid) : { mapped: null, queued: false };
          const a = nextAction(e.job, sessionState(sid, t.mapped, t.queued), now());
          if (a.kind === "waitForSession") {
            if (e.state !== "waiting") {
              e.state = "waiting";
              emit();
            }
            continue;
          }
          if (e.state === "waiting") {
            e.state = "uploading";
            emit();
          }
          if (a.kind === "waitUntil") {
            soonest = Math.min(soonest, a.ms);
            continue;
          }
          picked = e;
          action = a;
          break;
        }
        if (!picked) {
          if (soonest < Infinity) timer = setTimer(() => ((timer = null), kick()), Math.max(0, soonest - now()));
          return;
        }
        if (action.kind === "drop") {
          finish(picked, { kind: "dropped", reason: action.reason });
          emit();
          continue;
        }
        const response = await perform(picked, action);
        if (gen !== generation) return;
        picked.sent = 0;
        const outcome = apply(picked.job, action, response, now());
        if (outcome.kind === "continue") picked.job = outcome.job;
        else finish(picked, outcome);
        emit();
      }
    } finally {
      if (gen === generation) running = false;
    }
  }

  async function perform(entry, action) {
    try {
      if (action.kind === "create") return await deps.create(action.sessionId, action.body);
      if (action.kind === "complete") return await deps.complete(action.clipId);
      const part = entry.blob.slice(action.offset, action.offset + action.length);
      // Probe the part's first and last byte before sending it: an ejected
      // card or a file changed since it was picked fails a read, where the
      // upload itself would only look like a dropped connection.
      try {
        await part.slice(0, 1).arrayBuffer();
        await part.slice(part.size - 1).arrayBuffer();
      } catch {
        return { kind: "unreadable" };
      }
      let last = 0;
      const response = await deps.putPart(action.clipId, action.part, part, (sent) => {
        entry.sent = sent;
        // Repaint at most every couple of percent of the clip.
        if ((sent - last) / entry.job.sizeBytes >= 0.02) {
          last = sent;
          emit();
        }
      }, (abort) => (abortCurrent = abort));
      abortCurrent = null;
      return response;
    } catch {
      return { kind: "transport" };
    }
  }

  // Sign-out: stop everything, forget everything.
  function cancelAll() {
    generation += 1;
    running = false;
    if (timer != null) clearTimer(timer);
    timer = null;
    abortCurrent?.();
    abortCurrent = null;
    entries.length = 0;
    emit();
  }

  // Forget a failed job once the page has nothing more to do with it.
  function dismiss(key) {
    const i = entries.findIndex((e) => e.key === key && e.state === "failed");
    if (i >= 0) {
      entries.splice(i, 1);
      emit();
    }
  }

  return {
    enqueue,
    kick,
    cancelAll,
    dismiss,
    statuses,
    active: () => entries.some((e) => e.state !== "failed"),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// --- the app's uploader ------------------------------------------------------

// The live transport: create and complete as JSON with the session cookie,
// parts through XMLHttpRequest, which (unlike fetch) reports upload progress.
// None of it goes through api(): these are live writes, never queued offline.
async function jsonPost(path, body) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

export async function liveCreate(sessionId, body) {
  const { res, json } = await jsonPost(`/sessions/${encodeURIComponent(sessionId)}/clip`, body);
  if (res.ok) {
    return {
      kind: "created",
      start: { clipId: json.clip_id, partBytes: json.part_bytes, parts: json.parts, uploaded: json.uploaded ?? [] },
    };
  }
  return { kind: "status", status: res.status, error: json.error ?? null };
}

export async function liveComplete(clipId) {
  const { res, json } = await jsonPost(`/clips/${encodeURIComponent(clipId)}/complete`);
  if (res.ok) return { kind: "ok" };
  if (res.status === 409 && Array.isArray(json.missing)) return { kind: "missingParts", missing: json.missing };
  return { kind: "status", status: res.status, error: json.error ?? null };
}

export function livePutPart(clipId, n, blob, onProgress, onAbortable) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/clips/${encodeURIComponent(clipId)}/parts/${n}`);
    xhr.upload.onprogress = (ev) => onProgress?.(ev.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ kind: "ok" });
      let error = null;
      try {
        error = JSON.parse(xhr.responseText)?.error ?? null;
      } catch {}
      resolve({ kind: "status", status: xhr.status, error });
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => resolve({ kind: "transport" });
    onAbortable?.(() => xhr.abort());
    xhr.send(blob);
  });
}
