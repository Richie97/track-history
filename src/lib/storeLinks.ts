// The two store listings, and which one a visitor's device wants — behind
// GET /get (routes/download.ts). Mirrors APP_STORE_URL / PLAY_STORE_URL in
// public/app.js; the backend and frontend share no code, so keep them in step.
export const APP_STORE_URL = "https://apps.apple.com/us/app/track-evolution/id6792941186";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=app.trackevolution";

export type StorePlatform = "ios" | "android";

// Which store to send a User-Agent to, or null for "show both" — desktops,
// link-preview bots and anything unrecognised. iPadOS 13+ Safari sends a
// desktop Mac UA, which no server can tell from a Mac; the page's script
// catches that one from touch support (see download.ts).
export function storeFor(userAgent: string | null | undefined): StorePlatform | null {
  const ua = userAgent ?? "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return null;
}

export const storeUrl = (platform: StorePlatform) => (platform === "ios" ? APP_STORE_URL : PLAY_STORE_URL);
