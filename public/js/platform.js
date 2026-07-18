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

  // Small-value persistence that survives app restarts (recorder checkpoints,
  // recovery state). localStorage on the web; the native shell swaps in
  // Capacitor Preferences, which the OS never evicts. Async on both.
  prefGet: async (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  prefSet: async (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  prefRemove: async (key) => {
    try {
      localStorage.removeItem(key);
    } catch {}
  },

  // Native-only hooks — null on web, filled in by the shell:
  login: null, // system-browser OAuth (web uses <a href="/auth/login">)
  openExternal: null, // open an absolute URL in the system browser
  shareLink: null, // OS share sheet for a URL
  hapticPB: () => {}, // haptic buzz on a personal-best celebration
  openServerSettings: null, // the shell's server-URL settings panel
  // Background GPS watcher for the live lap recorder (public/js/record/) —
  // keeps delivering fixes with the screen locked. Filled in by the native
  // shell when its background-geolocation plugin is present; null on web,
  // which hides the record feature entirely.
  //   { start(onFix, onError) → Promise, stop() → Promise, openSettings() }
  //   onFix receives {timeMs, lat, lon, speed, accuracy}
  bgLocation: null,

  // Registered by app.js so the shell can re-enter the app:
  onAuthed: null, // called after a native sign-in completes
  navigate: null, // full-page navigation for deep links (/share/<slug>)
};
