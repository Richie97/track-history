// Offline cache warmer: after the dashboard loads, quietly fetch everything
// the app can show — every event detail plus the reference lists — so the
// whole logbook is browsable with no connection. Event details are only
// re-fetched when the list's updated_at says the cached copy is stale, so a
// warm pass on unchanged data is a handful of list requests.

import { api } from "./api.js";
import { cachedGet, cachedKeys, isTempId, removeCached, syncStatus } from "./offline.js";

let warming = false;
let warmedAt = 0;

export function scheduleWarm() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (syncStatus.offline || warming || Date.now() - warmedAt < 60_000) return;
  setTimeout(() => warm().catch(() => {}), 1500);
}

async function warm() {
  if (warming || syncStatus.offline) return;
  warming = true;
  try {
    const [events] = await Promise.all([
      api("/events"),
      api("/tracks"),
      api("/vehicles"),
      api("/catalog"),
    ]);
    for (const e of events) {
      if (isTempId(e.id)) continue;
      const cached = await cachedGet(`/events/${e.id}`);
      if (!cached || cached.updated_at !== e.updated_at) await api(`/events/${e.id}`);
    }
    // Drop cached details for events deleted elsewhere (another device, the
    // web app) — the list is authoritative for what still exists.
    const ids = new Set(events.map((e) => String(e.id)));
    for (const key of await cachedKeys()) {
      const m = key.match(/^\/events\/([^/?]+)$/);
      if (m && !isTempId(m[1]) && !ids.has(m[1])) await removeCached(key);
    }
    warmedAt = Date.now();
  } finally {
    warming = false;
  }
}
