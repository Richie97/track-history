// Where the AI Coach's provider keys live on the web (#319): in this tab's
// memory, and — only when the driver ticks "Remember on this device" — in
// IndexedDB in this browser. Never on our servers: a key is sent with each
// AI Coach request (X-TE-AI-Key) and the Worker neither stores nor logs it.
//
// One key per provider, and one provider active — the one the AI Coach uses.
// Every storage read and write is wrapped: a browser that refuses IndexedDB
// (private windows, blocked site data) just keeps keys for the tab.
// clearAiKeys() runs on sign-out, beside the offline cache.

const DB_NAME = "te-ai";
const STORE = "kv";
const STATE_KEY = "coach";
const PROVIDER_IDS = ["anthropic", "openai"];

function idbBackend() {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => run("readonly", (s) => s.get(STATE_KEY)),
    set: (value) => run("readwrite", (s) => s.put(value, STATE_KEY)),
    clear: () => run("readwrite", (s) => s.clear()),
  };
}

let backend; // undefined: not resolved yet; null: none (memory only)
// Tests (and nothing else) swap the store.
export function setAiKeyBackend(b) {
  backend = b;
  loaded = false;
  mem = { active: null, keys: {} };
}
const store = () => {
  if (backend === undefined) backend = typeof indexedDB === "undefined" ? null : idbBackend();
  return backend;
};

// { active, keys: { [provider]: { key, model, models, remembered } } }
let mem = { active: null, keys: {} };
let loaded = false;

const cleanEntry = (e) =>
  e && typeof e.key === "string" && e.key
    ? {
        key: e.key,
        model: typeof e.model === "string" ? e.model : null,
        defaultModel: typeof e.defaultModel === "string" ? e.defaultModel : null,
        models: Array.isArray(e.models) ? e.models.filter((m) => m && typeof m.id === "string") : [],
        remembered: Boolean(e.remembered),
      }
    : null;

// Reads what this browser remembered, once per page. Safe to call anywhere.
export async function loadAiKeys() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await store()?.get();
    if (!saved || typeof saved !== "object") return;
    for (const id of PROVIDER_IDS) {
      const entry = cleanEntry(saved.keys?.[id]);
      // A key typed this tab wins over what was remembered.
      if (entry && !mem.keys[id]) mem.keys[id] = { ...entry, remembered: true };
    }
    if (!mem.active && PROVIDER_IDS.includes(saved.active)) mem.active = saved.active;
  } catch {
    // no storage: keys last for the tab
  }
}

async function persist() {
  const remembered = Object.fromEntries(Object.entries(mem.keys).filter(([, e]) => e.remembered));
  try {
    if (Object.keys(remembered).length) await store()?.set({ active: mem.active, keys: remembered });
    else await store()?.clear();
    return true;
  } catch {
    return false;
  }
}

// The provider the AI Coach uses: the chosen one if it has a key, else
// whichever does.
const activeId = () => (mem.active && mem.keys[mem.active] ? mem.active : PROVIDER_IDS.find((id) => mem.keys[id]) ?? null);

// The server's scripted provider (`X-TE-AI-Provider: fake`), for the browser
// tests and the guide captures: on a local dev host only, and only once the
// page's localStorage carries `te-ai-fake`. The server refuses `fake` anywhere
// but a dev host under DEV_MODE, so this flag unlocks nothing in production.
const DEV_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const FAKE_PROVIDER_FLAG = "te-ai-fake";
function fakeProvider() {
  try {
    return DEV_HOSTS.includes(globalThis.location?.hostname) && globalThis.localStorage?.getItem(FAKE_PROVIDER_FLAG) === "1";
  } catch {
    return false;
  }
}

// What a request is sent with, or null when no key is set up.
export function aiCredential() {
  if (fakeProvider()) return { provider: "fake", key: "", model: null };
  const id = activeId();
  return id ? { provider: id, key: mem.keys[id].key, model: mem.keys[id].model } : null;
}

// "sk-ant-…x9Qf": enough to recognise a key by, never the key.
export const maskKey = (key) => (key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…");

// For Settings: each provider's state without its key.
export function aiKeyState() {
  const active = activeId();
  return PROVIDER_IDS.map((id) => {
    const e = mem.keys[id];
    return e
      ? { id, hasKey: true, active: id === active, masked: maskKey(e.key), model: e.model, defaultModel: e.defaultModel ?? null, models: e.models, remembered: e.remembered }
      : { id, hasKey: false, active: false, masked: null, model: null, defaultModel: null, models: [], remembered: false };
  });
}

// A verified key. Answers false when "remember" was asked for and the browser
// would not store it — the key still works for this tab.
export async function saveAiKey(provider, { key, models = [], defaultModel = null, model = null, remember = false }) {
  if (!PROVIDER_IDS.includes(provider) || !key) return false;
  mem.keys[provider] = { key, models, defaultModel, model, remembered: Boolean(remember) };
  if (!mem.active || !mem.keys[mem.active]) mem.active = provider;
  const stored = await persist();
  if (remember && !stored) mem.keys[provider].remembered = false;
  return stored || !remember;
}

export async function forgetAiKey(provider) {
  delete mem.keys[provider];
  if (mem.active === provider) mem.active = activeId();
  await persist();
}

export async function setAiActive(provider) {
  if (!mem.keys[provider]) return;
  mem.active = provider;
  await persist();
}

export async function setAiModel(provider, model) {
  if (!mem.keys[provider]) return;
  mem.keys[provider].model = String(model ?? "").trim() || null;
  await persist();
}

// Re-reads the models a provider's key can use, for the model field to
// complete from. `verify(provider, key)` is js/ai-coach.js's verifyCoachKey —
// passed in so the key never leaves this module except to that one call.
// Answers the fresh list, or null when it couldn't be read (the stored list
// stands: a provider that is down is no reason to empty the field's choices).
export async function refreshAiModels(provider, verify) {
  const entry = mem.keys[provider];
  if (!entry) return null;
  const res = await verify(provider, entry.key);
  // The key may have been forgotten or replaced while the request was out.
  if (!res?.ok || mem.keys[provider] !== entry) return null;
  entry.models = res.models;
  entry.defaultModel = res.default_model ?? entry.defaultModel ?? null;
  await persist();
  return entry.models;
}

// Sign-out: nothing of the previous driver's stays in the tab or the browser.
export async function clearAiKeys() {
  mem = { active: null, keys: {} };
  try {
    await store()?.clear();
  } catch {
    // nothing was stored, or storage is unavailable — either way it is gone
  }
}
