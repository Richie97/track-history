// Fetch wrapper for the JSON API, routed through the offline layer
// (offline.js). Throws ApiError so callers can branch on status (the app
// treats 401 as "show the login screen"). All requests go through the
// platform seam: on the web apiBase is "" (same-origin, cookie auth); the
// native shells set an absolute server origin and a bearer token.
//
// GETs are network-first: a successful response refreshes the offline cache;
// a network failure falls back to it (an ApiError — the server answered —
// never does). Mutations the offline layer knows how to mirror are queued
// when the network is down (or when earlier writes are already queued, to
// keep them ordered) and replayed once the server is reachable.

import { platform } from "./platform.js";
import * as offline from "./offline.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Low-level fetch for server endpoints outside /api (e.g. /auth/logout):
// applies the platform's base URL and bearer token, returns the raw Response.
export function authFetch(path, opts = {}) {
  return fetch(`${platform.apiBase}${path}`, {
    ...opts,
    headers: {
      ...(platform.authToken ? { Authorization: `Bearer ${platform.authToken}` } : {}),
      ...opts.headers,
    },
  });
}

// One request → {ok, status, body}; throws only on network failure. Also the
// sender the offline layer replays its queue through.
async function send(method, path, body) {
  const res = await authFetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}
offline.setSender(send);

const toError = (r) => new ApiError(r.body?.error || `Request failed (${r.status})`, r.status);

export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  if (method === "GET") {
    // Rows created offline only exist in the cache until the queue flushes —
    // the server would 404 their temp ids.
    if (offline.isTempPath(path)) {
      const cached = await offline.cachedGet(path);
      if (cached !== undefined) return cached;
    }
    let r;
    try {
      r = await send(method, path);
    } catch (err) {
      offline.noteOffline();
      const cached = await offline.cachedGet(path);
      if (cached !== undefined) return cached;
      throw err;
    }
    offline.noteOnline();
    if (!r.ok) throw toError(r);
    await offline.cachePut(path, r.body);
    if (offline.pendingCount()) {
      // Fresh server state predates the queued writes — re-patch it so they
      // stay visible until the flush lands.
      await offline.reapplyQueue();
      return (await offline.cachedGet(path)) ?? r.body;
    }
    return r.body;
  }

  // While writes are queued, later queueable writes must queue too — sending
  // them directly would reorder them ahead of the queue.
  if (offline.pendingCount() && offline.isQueueable(method, path)) {
    const synthetic = await offline.enqueue(method, path, opts.body);
    offline.kickFlush();
    return synthetic;
  }
  let r;
  try {
    r = await send(method, path, opts.body);
  } catch (err) {
    if (offline.isQueueable(method, path)) {
      offline.noteOffline();
      return offline.enqueue(method, path, opts.body);
    }
    offline.noteOffline();
    throw err;
  }
  offline.noteOnline();
  if (!r.ok) throw toError(r);
  return r.body;
}
