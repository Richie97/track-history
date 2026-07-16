// Platform seam between the web app and the native shells (mobile/).
// On the web these defaults apply and nothing changes; the Capacitor shell's
// native.js mutates this object (API base, bearer token, native hooks) before
// importing app.js. Node-import-safe: no top-level location/navigator access.

export const platform = {
  native: false,
  os: null, // "ios" | "android" | null
  apiBase: "", // absolute server origin on native, "" (same-origin) on web
  authToken: null, // bearer token on native; web auth is the session cookie

  // The origin share links should point at (the server, not the WebView).
  serverOrigin: () => location.origin,

  copyText: (text) => navigator.clipboard.writeText(text),

  logout: () => fetch("/auth/logout", { method: "POST" }),

  // Native-only hooks — null on web, filled in by the shell:
  login: null, // system-browser OAuth (web uses <a href="/auth/login">)
  openExternal: null, // open an absolute URL in the system browser
  shareLink: null, // OS share sheet for a URL
  hapticPB: () => {}, // haptic buzz on a personal-best celebration
  openServerSettings: null, // the shell's server-URL settings panel

  // Registered by app.js so the shell can re-enter the app:
  onAuthed: null, // called after a native sign-in completes
  navigate: null, // full-page navigation for deep links (/share/<slug>)
};
