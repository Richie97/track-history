// A JSON fetch that fails with the store's own words. Both APIs explain a
// refusal in the body — App Store Connect as `errors[].detail`, Google as
// `error.message` — and that sentence is what a failed workflow run should
// show, not "HTTP 409".

export class StoreApiError extends Error {
  constructor(status, method, url, detail) {
    super(`${method} ${new URL(url).pathname} → ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export function apiErrorDetail(data, text) {
  if (data && typeof data === "object") {
    if (Array.isArray(data.errors) && data.errors.length) {
      return data.errors
        .map((e) => [e.title, e.detail].filter(Boolean).join(" — ") || e.code)
        .join("; ");
    }
    if (data.error?.message) return data.error.message;
    if (typeof data.error_description === "string") return data.error_description;
    if (typeof data.error === "string") return data.error;
  }
  return (text || "").slice(0, 500) || "(empty response)";
}

export async function requestJson(url, { method = "GET", headers = {}, body, form } = {}) {
  const init = { method, headers: { accept: "application/json", ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  } else if (form) {
    init.body = new URLSearchParams(form);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw new StoreApiError(res.status, method, url, apiErrorDetail(data, text));
  return data;
}
