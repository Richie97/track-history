// Thin fetch wrapper for the JSON API. Throws ApiError so callers can branch
// on status (the app treats 401 as "show the login screen"). All requests go
// through the platform seam: on the web apiBase is "" (same-origin, cookie
// auth); the native shells set an absolute server origin and a bearer token.

import { platform } from "./platform.js";

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

export async function api(path, opts = {}) {
  const res = await authFetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(err.error || `Request failed (${res.status})`, res.status);
  }
  return res.json();
}
