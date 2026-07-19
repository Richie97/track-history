// Offline layer: an IndexedDB-backed cache of GET /api responses plus a
// persistent queue of writes made while offline. api.js routes every request
// through here — GETs fall back to the cache when the network is gone, and
// queueable mutations are stored and replayed (in order, with temp ids mapped
// to real ones) once the server is reachable again. Queued mutations also
// patch the cached responses they affect, so the UI renders the change
// immediately and consistently across views.
//
// Node-import-safe: no top-level IndexedDB/window access — in Node (unit
// tests) an in-memory backend is used automatically.

// ---------- storage backends -------------------------------------------------

// Shared shape: responses (path → body), queue (qid → mutation), kv (idMap,
// temp-id counter). All methods async so the two backends are interchangeable.
export function memBackend() {
  const responses = new Map();
  const queue = new Map();
  const kv = new Map();
  let qseq = 0;
  return {
    respGet: async (k) => (responses.has(k) ? structuredClone(responses.get(k)) : undefined),
    respPut: async (k, v) => void responses.set(k, structuredClone(v)),
    respDel: async (k) => void responses.delete(k),
    respKeys: async () => [...responses.keys()],
    queueAll: async () => [...queue.values()].sort((a, b) => a.qid - b.qid).map((i) => structuredClone(i)),
    queueAdd: async (item) => {
      const qid = ++qseq;
      queue.set(qid, structuredClone({ ...item, qid }));
      return qid;
    },
    queuePut: async (item) => void queue.set(item.qid, structuredClone(item)),
    queueDel: async (qid) => void queue.delete(qid),
    kvGet: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
    kvPut: async (k, v) => void kv.set(k, structuredClone(v)),
    clear: async () => {
      responses.clear();
      queue.clear();
      kv.clear();
    },
  };
}

function idbBackend() {
  let dbp = null;
  const open = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("th-offline", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("responses");
        db.createObjectStore("queue", { keyPath: "qid", autoIncrement: true });
        db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    respGet: (k) => tx("responses", "readonly", (s) => s.get(k)),
    respPut: (k, v) => tx("responses", "readwrite", (s) => s.put(v, k)),
    respDel: (k) => tx("responses", "readwrite", (s) => s.delete(k)),
    respKeys: () => tx("responses", "readonly", (s) => s.getAllKeys()),
    queueAll: () => tx("queue", "readonly", (s) => s.getAll()),
    queueAdd: (item) => tx("queue", "readwrite", (s) => s.add(item)),
    queuePut: (item) => tx("queue", "readwrite", (s) => s.put(item)),
    queueDel: (qid) => tx("queue", "readwrite", (s) => s.delete(qid)),
    kvGet: (k) => tx("kv", "readonly", (s) => s.get(k)),
    kvPut: (k, v) => tx("kv", "readwrite", (s) => s.put(v, k)),
    clear: async () => {
      await tx("responses", "readwrite", (s) => s.clear());
      await tx("queue", "readwrite", (s) => s.clear());
      await tx("kv", "readwrite", (s) => s.clear());
    },
  };
}

// ---------- module state -----------------------------------------------------

export const syncStatus = { offline: false, pending: 0, failed: 0 };

let backend = null;
let readyP = null;
let idMap = {}; // tempId → real server id, persisted across restarts
let tempSeq = 0;
let sender = null; // (method, path, body) → {ok, status, body}; set by api.js
let flushing = false;
const listeners = new Set();

async function ready() {
  return (readyP ??= (async () => {
    if (!backend) {
      backend = typeof indexedDB === "undefined" ? memBackend() : idbBackend();
      try {
        await backend.respKeys();
      } catch {
        backend = memBackend(); // IndexedDB unavailable (private mode etc.)
      }
    }
    idMap = (await backend.kvGet("idMap")) ?? {};
    tempSeq = (await backend.kvGet("tempSeq")) ?? 0;
    syncStatus.pending = (await backend.queueAll()).length;
  })());
}

function emit(change = {}) {
  for (const cb of listeners) cb(syncStatus, change);
}

export function onSyncChange(cb) {
  listeners.add(cb);
}

export function setSender(fn) {
  sender = fn;
}

export function isOffline() {
  return syncStatus.offline;
}

export function pendingCount() {
  return syncStatus.pending;
}

export function clearFailed() {
  syncStatus.failed = 0;
  emit();
}

// Called by api.js on every request outcome; a success while writes are
// queued kicks a flush. A "success" while the browser says it's offline is
// the web service worker answering from its cache — not the network.
export function noteOnline() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const was = syncStatus.offline;
  syncStatus.offline = false;
  if (was) emit();
  if (syncStatus.pending && !flushing) kickFlush();
}

export function noteOffline() {
  if (!syncStatus.offline) {
    syncStatus.offline = true;
    emit();
  }
}

if (typeof window !== "undefined") {
  // A page loaded while already offline gets no "offline" event — and on the
  // web the service worker answers GETs from its cache, so the fetch layer
  // never sees a failure either. navigator.onLine === false is trustworthy
  // (the reverse isn't, which is why requests still probe the network).
  if (typeof navigator !== "undefined" && navigator.onLine === false) syncStatus.offline = true;
  window.addEventListener("online", () => {
    syncStatus.offline = false;
    kickFlush();
    emit();
  });
  window.addEventListener("offline", () => noteOffline());
}

// Logout: a shared device must not retain the previous user's logbook or
// unsent writes.
export async function clearOffline() {
  await ready();
  await backend.clear();
  idMap = {};
  tempSeq = 0;
  syncStatus.pending = 0;
  syncStatus.failed = 0;
  emit();
}

// Unit-test hook: swap in a fresh memory backend and reset state.
export async function resetOfflineForTests() {
  backend = memBackend();
  readyP = null;
  idMap = {};
  tempSeq = 0;
  sender = null;
  flushing = false;
  syncStatus.offline = false;
  syncStatus.pending = 0;
  syncStatus.failed = 0;
  await ready();
}

// ---------- temp ids ---------------------------------------------------------

export const isTempId = (v) => typeof v === "string" && v.startsWith("tmp-");
export const isTempPath = (path) => path.split(/[/?]/).some(isTempId);

// tempId → real id once flushed (undefined until then).
export function resolveId(tempId) {
  return idMap[tempId];
}

async function nextTempId() {
  tempSeq += 1;
  await backend.kvPut("tempSeq", tempSeq);
  return `tmp-${tempSeq}`;
}

function substituteIds(path) {
  return path
    .split("/")
    .map((seg) => (idMap[seg] != null ? String(idMap[seg]) : seg))
    .join("/");
}

// ---------- response cache ---------------------------------------------------

export async function cachePut(path, body) {
  await ready();
  await backend.respPut(path, body);
}

export async function removeCached(path) {
  await ready();
  await backend.respDel(path);
}

export async function cachedKeys() {
  await ready();
  return backend.respKeys();
}

// Cache read, with one derivation: a track-filtered events list can be
// computed from the cached full list, so track pages work offline without
// ever having been visited.
export async function cachedGet(path) {
  await ready();
  const hit = await backend.respGet(path);
  if (hit !== undefined) return hit;
  const m = path.match(/^\/events\?track_id=([^&]+)$/);
  if (m) {
    const all = await backend.respGet("/events");
    if (all) return all.filter((e) => String(e.track_id) === String(decodeURIComponent(m[1])));
  }
  return undefined;
}

// ---------- offline mutation queue -------------------------------------------

// Only mutations whose effect we can mirror locally are queueable; everything
// else (vehicles, share links — flows that need a real server answer) simply
// fails offline with the normal error message.
const QUEUEABLE = [
  { method: "POST", re: /^\/events$/, creates: true },
  { method: "PUT", re: /^\/events\/[^/]+$/ },
  { method: "DELETE", re: /^\/events\/[^/]+$/ },
  { method: "POST", re: /^\/events\/[^/]+\/sessions$/, creates: true },
  { method: "PUT", re: /^\/sessions\/[^/]+$/ },
  { method: "DELETE", re: /^\/sessions\/[^/]+$/ },
  { method: "POST", re: /^\/sessions\/[^/]+\/laps$/ },
  { method: "DELETE", re: /^\/laps\/[^/]+$/ },
  { method: "PUT", re: /^\/tracks\/[^/]+$/ },
];

export function isQueueable(method, path) {
  return QUEUEABLE.some((q) => q.method === method && q.re.test(path));
}

// Deleting something that only exists as a queued create just cancels the
// queued items (including anything created under it — sessions of a temp
// event, laps of a temp session) instead of queueing a DELETE the server
// could never resolve.
async function dropQueuedFor(tempId) {
  let targets = new Set([tempId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of await backend.queueAll()) {
      const refs = item.path.split("/").some((seg) => targets.has(seg));
      if ((refs || targets.has(item.tempId)) && item.tempId && !targets.has(item.tempId)) {
        targets.add(item.tempId);
        grew = true;
      }
    }
  }
  for (const item of await backend.queueAll()) {
    if (targets.has(item.tempId) || item.path.split("/").some((seg) => targets.has(seg))) {
      await backend.queueDel(item.qid);
    }
  }
}

// Queue a mutation, patch the cache so the UI reflects it, and return the
// synthetic response the caller would have gotten from the server.
export async function enqueue(method, path, body) {
  await ready();
  const target = path.split("/").filter(Boolean).pop();
  if (method === "DELETE" && isTempId(target)) {
    await dropQueuedFor(target);
    await applyLocal({ method, path, body: body ?? null });
    syncStatus.pending = (await backend.queueAll()).length;
    emit();
    return { ok: true };
  }
  const spec = QUEUEABLE.find((q) => q.method === method && q.re.test(path));
  const tempId = spec?.creates ? await nextTempId() : null;
  const qid = await backend.queueAdd({ method, path, body: body ?? null, tempId, attempts: 0 });
  await applyLocal({ qid, method, path, body: body ?? null, tempId });
  syncStatus.pending = (await backend.queueAll()).length;
  emit();
  return tempId ? { id: tempId } : { ok: true };
}

// Re-patch caches from the queue — called after a fresh server response
// lands while writes are still pending, so queued changes stay visible.
// applyLocal is idempotent (patched rows carry temp ids and are deduped).
export async function reapplyQueue() {
  await ready();
  for (const item of await backend.queueAll()) await applyLocal(item);
}

// ---------- flush ------------------------------------------------------------

export function kickFlush() {
  if (sender) flush(sender).catch(() => {});
}

// Replay the queue in order. Stops (keeping the remainder) on network
// failure; drops items the server rejects (4xx) or that keep failing (5xx),
// counting them as failed so the UI can say so.
export async function flush(sendFn) {
  if (flushing) return;
  flushing = true;
  let flushedAny = false;
  try {
    await ready();
    for (const item of await backend.queueAll()) {
      const path = substituteIds(item.path);
      if (isTempPath(path)) {
        // References a create that failed or was dropped — unresolvable.
        await backend.queueDel(item.qid);
        syncStatus.failed += 1;
        continue;
      }
      let res;
      try {
        res = await sendFn(item.method, path, item.body);
      } catch {
        syncStatus.offline = true;
        break;
      }
      syncStatus.offline = false;
      if (res.ok) {
        if (item.tempId && res.body?.id != null) {
          idMap[item.tempId] = res.body.id;
          await backend.kvPut("idMap", idMap);
        }
        await backend.queueDel(item.qid);
        flushedAny = true;
      } else if (res.status >= 500) {
        item.attempts = (item.attempts ?? 0) + 1;
        if (item.attempts >= 5) {
          await backend.queueDel(item.qid);
          syncStatus.failed += 1;
        } else {
          await backend.queuePut(item);
          break; // server trouble — try the rest on the next kick
        }
      } else {
        await backend.queueDel(item.qid);
        syncStatus.failed += 1;
      }
    }
  } finally {
    syncStatus.pending = (await backend.queueAll()).length;
    flushing = false;
    emit({ flushed: flushedAny });
  }
}

// ---------- local application of queued mutations ----------------------------

// Mirror of sanitizeLaps in src/lib/validate.ts — keep in sync.
const cleanLaps = (laps) =>
  (Array.isArray(laps) ? laps : [])
    .map((v) => Math.round(Number(v)))
    .filter((v) => Number.isFinite(v) && v > 0);

// Mirror of withComputed in src/lib/stats.ts (best-time rule + coefficient
// of variation) — keep in sync.
export function recomputeDetail(d) {
  const laps = d.sessions.flatMap((s) => s.laps.map((l) => l.time_ms));
  d.lap_count = laps.length;
  d.session_count = d.sessions.length;
  d.lap_best_ms = laps.length ? Math.min(...laps) : null;
  const bests = [d.best_time_ms, d.lap_best_ms].filter((v) => v != null);
  d.best_ms = bests.length ? Math.min(...bests) : null;
  if (laps.length >= 3) {
    const mean = laps.reduce((a, b) => a + b, 0) / laps.length;
    const variance = Math.max(0, laps.reduce((a, b) => a + b * b, 0) / laps.length - mean * mean);
    d.consistency = Math.sqrt(variance) / mean;
  } else {
    d.consistency = null;
  }
  return d;
}

const listRowFrom = (detail) => {
  const { sessions, ...row } = detail;
  return row;
};

const EVENT_FIELDS = [
  "track_name", "start_date", "days", "club", "run_group", "car", "notes",
  "conditions", "temp_f", "checklist", "best_time_ms",
];

async function patchEventLists(fn) {
  for (const key of await backend.respKeys()) {
    if (key !== "/events" && !key.startsWith("/events?")) continue;
    const list = await backend.respGet(key);
    if (!Array.isArray(list)) continue;
    const next = fn(list, key);
    if (next) await backend.respPut(key, next);
  }
}

async function syncListsFromDetail(detail) {
  const row = listRowFrom(detail);
  await patchEventLists((list) =>
    list.map((e) => (String(e.id) === String(detail.id) ? row : e))
  );
}

// Every event-detail cache entry: [path, body] pairs.
async function eachEventDetail(fn) {
  for (const key of await backend.respKeys()) {
    if (!/^\/events\/[^/?]+$/.test(key)) continue;
    const d = await backend.respGet(key);
    if (d && (await fn(key, d)) === true) return;
  }
}

// Patch the cached responses a queued mutation affects. Missing cache
// entries are skipped — the patch is best-effort display state; the queue
// itself is the source of truth until flushed.
async function applyLocal(m) {
  const seg = m.path.split("/").filter(Boolean);

  if (m.method === "POST" && m.path === "/events") {
    const detail = recomputeDetail({
      id: m.tempId,
      track_id: m.body?.track_id ?? null,
      track_name: m.body?.track_name ?? "(new track)",
      start_date: m.body?.start_date,
      days: m.body?.days ?? 1,
      club: m.body?.club ?? null,
      run_group: m.body?.run_group ?? null,
      car: m.body?.car ?? null,
      notes: m.body?.notes ?? null,
      conditions: m.body?.conditions ?? null,
      temp_f: m.body?.temp_f ?? null,
      checklist: m.body?.checklist ?? null,
      best_time_ms: m.body?.best_time_ms ?? null,
      updated_at: 0,
      sessions: [],
    });
    if (m.body?.track_id != null) {
      const tracks = await backend.respGet("/tracks");
      const t = tracks?.find((t) => String(t.id) === String(m.body.track_id));
      if (t) detail.track_name = t.name;
    }
    await backend.respPut(`/events/${m.tempId}`, detail);
    const row = listRowFrom(detail);
    await patchEventLists((list, key) => {
      if (key !== "/events") return null; // track-filtered lists: track unknown offline
      const rest = list.filter((e) => String(e.id) !== String(m.tempId));
      const at = rest.findIndex((e) => e.start_date <= row.start_date);
      rest.splice(at === -1 ? rest.length : at, 0, row);
      return rest;
    });
    return;
  }

  if (m.method === "PUT" && seg[0] === "events") {
    const path = `/events/${seg[1]}`;
    const d = await backend.respGet(path);
    if (d) {
      for (const k of EVENT_FIELDS) if (m.body && k in m.body) d[k] = m.body[k];
      recomputeDetail(d);
      await backend.respPut(path, d);
      await syncListsFromDetail(d);
    } else if (m.body) {
      await patchEventLists((list) =>
        list.map((e) => {
          if (String(e.id) !== String(seg[1])) return e;
          const next = { ...e };
          for (const k of EVENT_FIELDS) if (k in m.body) next[k] = m.body[k];
          return next;
        })
      );
    }
    return;
  }

  if (m.method === "DELETE" && seg[0] === "events") {
    await backend.respDel(`/events/${seg[1]}`);
    await patchEventLists((list) => list.filter((e) => String(e.id) !== String(seg[1])));
    return;
  }

  if (m.method === "POST" && seg[0] === "events" && seg[2] === "sessions") {
    const path = `/events/${seg[1]}`;
    const d = await backend.respGet(path);
    if (!d) return;
    if (d.sessions.some((s) => s.id === m.tempId)) return; // reapply dedupe
    const laps = cleanLaps(m.body?.laps);
    d.sessions.push({
      id: m.tempId,
      label: m.body?.label ?? null,
      notes: m.body?.notes ?? null,
      sort: Math.max(0, ...d.sessions.map((s) => s.sort ?? 0)) + 1,
      trace: m.body?.trace ?? null,
      channels: m.body?.channels ?? null,
      laps: laps.map((ms, i) => ({
        id: `${m.tempId}-l${i + 1}`,
        session_id: m.tempId,
        lap_num: i + 1,
        time_ms: ms,
      })),
    });
    recomputeDetail(d);
    await backend.respPut(path, d);
    await syncListsFromDetail(d);
    return;
  }

  if ((m.method === "PUT" || m.method === "DELETE") && seg[0] === "sessions") {
    await eachEventDetail(async (key, d) => {
      const i = d.sessions.findIndex((s) => String(s.id) === String(seg[1]));
      if (i === -1) return false;
      if (m.method === "PUT") {
        // The route replaces both fields (missing → null) — mirror that.
        d.sessions[i].label = m.body?.label ?? null;
        d.sessions[i].notes = m.body?.notes ?? null;
      } else {
        d.sessions.splice(i, 1);
      }
      recomputeDetail(d);
      await backend.respPut(key, d);
      await syncListsFromDetail(d);
      return true;
    });
    return;
  }

  if (m.method === "POST" && seg[0] === "sessions" && seg[2] === "laps") {
    await eachEventDetail(async (key, d) => {
      const s = d.sessions.find((x) => String(x.id) === String(seg[1]));
      if (!s) return false;
      const marker = `q${m.qid}-l`;
      if (s.laps.some((l) => String(l.id).includes(marker))) return true; // reapply dedupe
      let n = Math.max(0, ...s.laps.map((l) => l.lap_num));
      for (const ms of cleanLaps(m.body?.laps)) {
        n += 1;
        s.laps.push({ id: `tmp-${marker}${n}`, session_id: s.id, lap_num: n, time_ms: ms });
      }
      recomputeDetail(d);
      await backend.respPut(key, d);
      await syncListsFromDetail(d);
      return true;
    });
    return;
  }

  if (m.method === "DELETE" && seg[0] === "laps") {
    await eachEventDetail(async (key, d) => {
      const s = d.sessions.find((x) => x.laps.some((l) => String(l.id) === String(seg[1])));
      if (!s) return false;
      s.laps = s.laps.filter((l) => String(l.id) !== String(seg[1]));
      recomputeDetail(d);
      await backend.respPut(key, d);
      await syncListsFromDetail(d);
      return true;
    });
    return;
  }

  if (m.method === "PUT" && seg[0] === "tracks") {
    const tracks = await backend.respGet("/tracks");
    if (!tracks) return;
    await backend.respPut(
      "/tracks",
      tracks.map((t) => {
        if (String(t.id) !== String(seg[1])) return t;
        const next = { ...t };
        for (const k of ["name", "notes", "goal_ms"]) if (m.body && k in m.body) next[k] = m.body[k];
        return next;
      })
    );
  }
}
