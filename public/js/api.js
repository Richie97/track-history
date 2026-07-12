// Thin fetch wrapper for the JSON API. Throws ApiError so callers can branch
// on status (the app treats 401 as "show the login screen").

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(err.error || `Request failed (${res.status})`, res.status);
  }
  return res.json();
}
