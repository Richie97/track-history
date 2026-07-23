// Native shell bootstrap. sync-www.mjs installs this as the module entry in
// place of app.js: it fills in the platform seam (js/platform.js) with native
// behaviors — bearer-token auth against a configurable server, system-browser
// OAuth (Google or Apple), share sheet, haptics, status-bar theming — then imports the
// untouched app.js. Plugins come from the Capacitor bridge proxies
// (window.Capacitor.Plugins), so the app stays bundler-free vanilla JS.
// Every plugin call is feature-checked: a missing plugin degrades, never
// crashes boot.

const cap = window.Capacitor;
const plugins = cap?.Plugins ?? {};
const { App, Browser, Preferences, Share, StatusBar, Haptics, Clipboard, BackgroundGeolocation, CarPlayBridge } =
  plugins;

const DEFAULT_SERVER = "https://trackevolution.app";
const AUTH_SCHEME_PREFIX = "trackevolution://auth";

async function prefGet(key) {
  try {
    return (await Preferences.get({ key })).value;
  } catch {
    return null;
  }
}
async function prefSet(key, value) {
  try {
    await Preferences.set({ key, value });
  } catch {}
}
async function prefRemove(key) {
  try {
    await Preferences.remove({ key });
  } catch {}
}

const serverUrl = ((await prefGet("serverUrl")) || DEFAULT_SERVER).replace(/\/+$/, "");
const sessionToken = await prefGet("sessionToken");

const { platform } = await import("./js/platform.js");

platform.native = true;
platform.os = cap?.getPlatform?.() ?? null;
platform.apiBase = serverUrl;
platform.authToken = sessionToken;
platform.serverOrigin = () => serverUrl;

// Every Browser.open goes through openBrowser: on iOS, Capacitor's default
// fullscreen presentation builds a temporary UIWindow(frame:) — a classic-
// lifecycle window that has no windowScene under the scene lifecycle (which
// the CarPlay scene forced on the app), so it never becomes visible and the
// browser silently doesn't appear. The popover style presents directly on the
// web view's controller instead (adapting to a sheet on iPhone), which is
// scene-safe.
const openBrowser = (url) => Browser?.open({ url, presentationStyle: "popover" });

platform.openExternal = openBrowser;

// Recorder checkpoints go through Capacitor Preferences instead of
// localStorage — WKWebView storage can be evicted under disk pressure, and a
// half-recorded session must survive that.
platform.prefGet = prefGet;
platform.prefSet = prefSet;
platform.prefRemove = prefRemove;

// ---------- live lap recorder GPS ---------------------------------------------
// Background-geolocation watcher for public/js/record/: keeps GPS fixes
// flowing with the phone locked and stowed (Android: foreground service with
// the notification text below; iOS: the `location` background mode). The app
// only starts a watcher while the user is actively recording a session.

if (BackgroundGeolocation) {
  let watcherId = null;
  platform.bgLocation = {
    async start(onFix, onError) {
      if (watcherId != null) return;
      watcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: "Recording your session",
          backgroundMessage: "Lap times are timed from GPS when you stop.",
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
        },
        (location, error) => {
          if (error) {
            onError?.(error);
            return;
          }
          if (!location) return;
          onFix({
            timeMs: location.time ?? Date.now(),
            lat: location.latitude,
            lon: location.longitude,
            speed: location.speed ?? null,
            accuracy: location.accuracy ?? null,
          });
        }
      );
    },
    async stop() {
      if (watcherId == null) return;
      const id = watcherId;
      watcherId = null;
      try {
        await BackgroundGeolocation.removeWatcher({ id });
      } catch {}
    },
    openSettings: () => BackgroundGeolocation.openSettings().catch(() => {}),
  };
}

// ---------- CarPlay -----------------------------------------------------------
// The CarPlay scene (iOS only — mobile/ios/App/App/CarPlaySceneDelegate.swift,
// behind Apple's driving-task entitlement) is a remote control for the lap
// recorder: its Start/Stop button arrives here as a plugin "command" event and
// is routed into platform.recorderRemote (public/js/record/remote.js), and
// recorder state changes are pushed back so the car screen mirrors the phone.
// The plugin instance is registered by ViewController.capacitorDidLoad(); it's
// absent on Android, where this whole block is skipped.

if (CarPlayBridge) {
  const push = (state) => CarPlayBridge.updateState(state).catch(() => {});
  platform.onRecorderState = push;

  // Why a start couldn't happen, in words that make sense on a car screen.
  const START_FAILED = {
    "no-event": "No event for today — create one on your phone first.",
    auth: "Signed out — open the app on your phone to sign in.",
    offline: "Couldn't load your events — check the phone's connection.",
    gps: "Couldn't start GPS — check the app's location permission on the phone.",
  };

  CarPlayBridge.addListener("command", async ({ action }) => {
    const remote = platform.recorderRemote;
    if (!remote) return;
    if (action === "start") {
      const res = await remote.start().catch(() => ({ ok: false, reason: "offline" }));
      if (!res?.ok) push({ recording: false, message: START_FAILED[res?.reason] ?? "Couldn't start recording." });
    } else if (action === "stop") {
      await remote.stop().catch(() => {});
    }
  });
}

platform.copyText = async (text) => {
  if (Clipboard) await Clipboard.write({ string: text });
  else await navigator.clipboard.writeText(text);
};

if (Share) platform.shareLink = (url) => Share.share({ url });

if (Haptics) {
  platform.hapticPB = () => Haptics.notification({ type: "SUCCESS" }).catch(() => {});
}

platform.logout = async () => {
  try {
    await fetch(`${serverUrl}/auth/logout`, {
      method: "POST",
      headers: platform.authToken ? { Authorization: `Bearer ${platform.authToken}` } : {},
    });
  } catch {} // signing out locally must work offline too
  await prefRemove("sessionToken");
  platform.authToken = null;
};

// ---------- system-browser OAuth (PKCE S256) ----------------------------------
// native.js opens {server}/auth/login (or /auth/apple/login) with
// ?client=app&code_challenge=… in the
// system browser (Google forbids OAuth in webviews); the server bounces the
// callback to trackevolution://auth?code=…, and the appUrlOpen handler below
// trades code + verifier for a bearer token at /auth/exchange. The verifier
// is stashed in Preferences because Android may recycle the activity while
// the browser is up.

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

platform.login = async (provider) => {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
  await prefSet("pkceVerifier", verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  const path = provider === "apple" ? "/auth/apple/login" : "/auth/login";
  const url = `${serverUrl}${path}?client=app&code_challenge=${challenge}`;
  if (Browser) await openBrowser(url);
  else window.open(url, "_blank");
};

async function completeLogin(code) {
  try {
    await Browser?.close();
  } catch {}
  const verifier = await prefGet("pkceVerifier");
  await prefRemove("pkceVerifier");
  try {
    const res = await fetch(`${serverUrl}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const { token } = await res.json();
    await prefSet("sessionToken", token);
    platform.authToken = token;
    platform.onAuthed?.();
  } catch (err) {
    alert(`Sign-in failed: ${err.message}. Please try again.`);
  }
}

function handleAppUrl(url) {
  if (url.startsWith(AUTH_SCHEME_PREFIX)) {
    const code = /[?&]code=([0-9a-f]+)/.exec(url)?.[1];
    if (code) completeLogin(code);
    return;
  }
  // Universal/App Link to a public share page → full-page navigate so app.js
  // re-evaluates SHARE_SLUG. The pathname guard stops a reload loop when the
  // launch URL is re-reported after the reload.
  const share = /^https?:\/\/[^/]+(\/share\/[^/?#]+)/.exec(url)?.[1];
  if (share && location.pathname !== share) platform.navigate?.(share);
}

App?.addListener("appUrlOpen", ({ url }) => handleAppUrl(url));

// ---------- back navigation ---------------------------------------------------
// Android's system back gesture/button. Registering a listener replaces
// Capacitor's default handling, so all cases are covered here: dismiss the
// server-settings overlay if it's up, otherwise walk the hash-route history,
// and at the root minimize the app instead of killing it. iOS never fires this
// event — there the WKWebView edge-swipe gesture is enabled natively
// (mobile/ios/App/App/ViewController.swift).
App?.addListener("backButton", ({ canGoBack }) => {
  const overlay = document.getElementById("server-overlay");
  if (overlay) overlay.remove();
  else if (canGoBack) history.back();
  else App.minimizeApp();
});

// ---------- server settings ---------------------------------------------------
// Minimal overlay (reuses the app's .panel/.btn/.field styles) to point the
// app at a self-hosted instance. Saving clears the session and reloads.

platform.openServerSettings = () => {
  document.getElementById("server-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "server-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:24px";
  overlay.innerHTML = `
    <div class="panel" style="width:420px;max-width:100%">
      <h2 style="margin-top:0">Server</h2>
      <p class="hint">The Track Evolution server this app talks to. Leave as-is unless you run your own instance.</p>
      <div class="field"><label>Server URL</label>
        <input id="server-url" value="${serverUrl.replace(/"/g, "&quot;")}" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url">
      </div>
      <div class="btn-row">
        <button class="btn primary" id="server-save">Save</button>
        <button class="btn" id="server-reset">Use default</button>
        <button class="btn ghost" id="server-cancel">Cancel</button>
      </div>
      <div class="hint" id="server-msg" style="margin-top:8px"></div>
    </div>`;
  document.body.appendChild(overlay);

  const msg = overlay.querySelector("#server-msg");
  const input = overlay.querySelector("#server-url");
  const save = async (value) => {
    let candidate;
    try {
      candidate = new URL(value).origin;
    } catch {
      msg.textContent = "Enter a full URL, e.g. https://trackevolution.app";
      return;
    }
    msg.textContent = "Checking server…";
    try {
      // Any JSON answer from /api/me (200 or 401) proves this is a reachable
      // Track Evolution server with CORS for the app.
      const res = await fetch(`${candidate}/api/me`);
      await res.json();
      if (res.status !== 200 && res.status !== 401) throw new Error();
    } catch {
      msg.textContent = "That doesn't look like a reachable Track Evolution server.";
      return;
    }
    await prefSet("serverUrl", candidate);
    await prefRemove("sessionToken"); // sessions don't carry across servers
    location.reload();
  };
  overlay.querySelector("#server-save").onclick = () => save(input.value.trim());
  overlay.querySelector("#server-reset").onclick = () => save(DEFAULT_SERVER);
  overlay.querySelector("#server-cancel").onclick = () => overlay.remove();
};

// ---------- status-bar theming ------------------------------------------------
// Mirrors the app theme (data-theme attribute; absent = follow the device)
// onto the native status bar. Colors match the theme-color metas in index.html.

if (StatusBar) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const applyStatusBar = () => {
    const attr = document.documentElement.getAttribute("data-theme");
    const dark = attr ? attr === "dark" : media.matches;
    StatusBar.setStyle({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
    if (platform.os === "android") {
      StatusBar.setBackgroundColor({ color: dark ? "#0a0a0b" : "#fbfbfa" }).catch(() => {});
    }
  };
  new MutationObserver(applyStatusBar).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  media.addEventListener("change", applyStatusBar);
  applyStatusBar();
}

// ---------- boot ---------------------------------------------------------------

await import("./app.js");

// Cold-start deep link: the launch URL isn't always delivered to appUrlOpen
// listeners registered after startup, so ask for it explicitly.
try {
  const launch = await App?.getLaunchUrl();
  if (launch?.url) handleAppUrl(launch.url);
} catch {}
