// Live lap recorder UI + lifecycle. The recording itself is app-global module
// state (not view state): fixes keep arriving through the native
// background-geolocation watcher while the phone is locked or the user
// navigates elsewhere, and every ~10 s the recording is checkpointed via
// platform.prefSet so a killed app loses at most a few seconds. Stopping
// feeds the recording into the telemetry-import review panel
// (js/import/ui.js reviewResults) — same line picker, lap derivation, and
// session POST as a file import.
//
// Only available when the native shell provides platform.bgLocation; the
// feature is invisible on web.

import { platform } from "../platform.js";
import { esc } from "../format.js";
import { reviewResults } from "../import/ui.js";
import {
  addFix,
  createRecording,
  deserializeRecording,
  elapsedS,
  serializeRecording,
  shouldAutoStop,
  toParsed,
} from "./core.js";

const CHECKPOINT_KEY = "recording.pending";
const CHECKPOINT_EVERY_S = 10;

// Active recording state — survives view re-renders and navigation.
const active = {
  rec: null,
  label: null, // track/event name for external displays (CarPlay); not persisted
  lastFix: null, // {timeMs, lat, lon, speed, accuracy} as delivered
  error: null, // watcher error (permission denied, GPS off)
  lastCheckpointT: 0,
  onChange: null, // re-render hook while a record view is bound
};

// Mirror recorder transitions to the shell (platform.onRecorderState — the
// CarPlay scene on iOS). No-op on web and on shells without the hook.
function emitState() {
  platform.onRecorderState?.({
    recording: !!active.rec,
    eventId: active.rec?.eventId ?? null,
    eventLabel: active.rec ? active.label : null,
    startedAtMs: active.rec?.startedAtMs ?? null,
    error: active.error ? String(active.error?.message ?? active.error) : null,
  });
}

export function recorderAvailable() {
  return !!platform.bgLocation;
}

export function isRecording() {
  return !!active.rec;
}

export function activeEventId() {
  return active.rec?.eventId ?? null;
}

export async function pendingRecording() {
  return deserializeRecording(await platform.prefGet(CHECKPOINT_KEY));
}

async function checkpoint() {
  if (active.rec) await platform.prefSet(CHECKPOINT_KEY, serializeRecording(active.rec));
}

async function clearPending() {
  await platform.prefRemove(CHECKPOINT_KEY);
}

// Checkpointing and the forgot-to-stop check ride on fix delivery, not on
// setInterval — background timers throttle with the screen off, but the
// watcher callback keeps firing for every fix.
function onFix(fix) {
  if (!active.rec) return;
  active.lastFix = fix;
  addFix(active.rec, fix);
  const t = elapsedS(active.rec, fix.timeMs);
  if (t - active.lastCheckpointT >= CHECKPOINT_EVERY_S) {
    active.lastCheckpointT = t;
    checkpoint();
    if (shouldAutoStop(active.rec, fix.timeMs)) stopRecording();
  }
  active.onChange?.();
}

function onError(error) {
  active.error = error;
  stopRecording();
}

export async function startRecording(eventId, label = null) {
  if (active.rec || !platform.bgLocation) return;
  active.rec = createRecording(eventId, Date.now());
  active.label = label;
  active.lastFix = null;
  active.error = null;
  active.lastCheckpointT = 0;
  try {
    await platform.bgLocation.start(onFix, onError);
    await checkpoint();
  } catch (err) {
    active.rec = null;
    active.error = err;
  }
  active.onChange?.();
  emitState();
}

// Stop collecting. The recording stays checkpointed as "pending" until it is
// saved as a session or discarded — stopping never loses data.
export async function stopRecording() {
  const rec = active.rec;
  if (!rec) return null;
  active.rec = null;
  await platform.bgLocation?.stop();
  await platform.prefSet(CHECKPOINT_KEY, serializeRecording(rec));
  active.onChange?.();
  emitState();
  return rec;
}

export async function discardPending() {
  await clearPending();
}

// --- record view ---------------------------------------------------------------

const fmtClock = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

const recTimerStyle = "font-size:44px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1";

// Bind the record screen into #rec-panel/#rec-review of the current view.
// onSaved runs after the recording is stored as a session (navigate back to
// the event); the whole panel re-renders on recorder state changes.
export function bindRecorder(view, event, onSaved) {
  const panel = view.querySelector("#rec-panel");
  const reviewBox = view.querySelector("#rec-review");

  const finish = async () => {
    await clearPending();
    active.onChange = null;
    onSaved();
  };

  // The unsaved-recording card. Stays up while the review panel is open below
  // it, so cancelling the review never leaves a blank screen — the recording
  // is still reviewable or discardable.
  const pendingCard = (rec) => {
    const d = new Date(rec.startedAtMs);
    const mins = rec.fixes.length ? Math.round(rec.fixes[rec.fixes.length - 1][0] / 60) : 0;
    panel.innerHTML = `<div class="panel">
      <strong>Unsaved recording</strong>
      <p class="hint">Started ${esc(d.toLocaleString())} · ${mins} min of GPS data. Review it to pick the
      start/finish line and save the laps to this event, or discard it.</p>
      <div class="btn-row">
        <button class="btn primary" id="rec-resume">Review &amp; save</button>
        <button class="btn danger" id="rec-discard">Discard</button>
      </div>
    </div>`;
    panel.querySelector("#rec-resume").onclick = () => review(rec);
    panel.querySelector("#rec-discard").onclick = async () => {
      if (!confirm("Discard this recording and its GPS data?")) return;
      await clearPending();
      render();
    };
  };

  // Open the import review panel for a stopped/recovered recording.
  const review = (rec) => {
    const parsed = toParsed(rec);
    if (!parsed) {
      reviewBox.innerHTML = "";
      panel.innerHTML = `<div class="panel">
        <strong>Recording too short to time</strong>
        <p class="hint">This recording has less than a minute of movement, so there are no laps to derive.</p>
        <div class="btn-row">
          <button class="btn danger" id="rec-discard">Discard recording</button>
          <a class="btn ghost" href="#/event/${event.id}">Back to event</a>
        </div>
      </div>`;
      panel.querySelector("#rec-discard").onclick = async () => {
        await clearPending();
        render();
      };
      return;
    }
    pendingCard(rec);
    reviewResults(reviewBox, event, [{ file: "GPS recording", parsed }], finish);
  };

  async function render() {
    reviewBox.innerHTML = "";

    // A recording started without an event (CarPlay, before the event
    // existed) is adopted by the first event whose record screen it's opened
    // from — from here on it behaves like it was started here.
    if (active.rec && active.rec.eventId == null) {
      active.rec.eventId = event.id;
      active.label = event.track_name;
      await checkpoint();
      emitState();
    }

    // A recording started from a different event keeps running — point there
    // instead of showing a start button that would silently do nothing.
    if (active.rec && active.rec.eventId !== event.id) {
      panel.innerHTML = `<div class="panel">
        <strong>Already recording</strong>
        <p class="hint">A recording started from another event is still running.</p>
        <a class="btn primary" href="#/event/${esc(String(active.rec.eventId))}/record">Open that recording</a>
      </div>`;
      return;
    }

    if (active.rec) {
      const now = Date.now();
      const fixCount = active.rec.fixes.length;
      const acc = active.lastFix?.accuracy;
      const gpsLine = !fixCount
        ? `<span style="color:var(--text-muted)">Waiting for GPS…</span>`
        : `${fixCount.toLocaleString()} GPS fixes${acc != null ? ` · ±${Math.round(acc)} m` : ""}`;
      panel.innerHTML = `<div class="panel" style="text-align:center">
        <div class="hint" style="letter-spacing:.08em;text-transform:uppercase;color:var(--danger)">● Recording</div>
        <div id="rec-elapsed" style="${recTimerStyle};margin:10px 0 4px">${fmtClock(elapsedS(active.rec, now))}</div>
        <div class="hint" id="rec-gps">${gpsLine}</div>
        <p class="hint" style="margin-top:14px">You can lock the phone and stow it — recording continues in the background.
        Stop here when you're back in the paddock to pick the start/finish line and save your laps.</p>
        <div class="btn-row" style="justify-content:center">
          <button class="btn primary" id="rec-stop">Stop &amp; review laps</button>
        </div>
      </div>`;
      panel.querySelector("#rec-stop").onclick = async () => {
        const rec = await stopRecording();
        if (rec) review(rec);
      };
      // Tick the elapsed clock without re-rendering the panel; the interval
      // retires itself once this render is replaced or navigated away.
      const elapsed = panel.querySelector("#rec-elapsed");
      const iv = setInterval(() => {
        if (!elapsed.isConnected || !active.rec) return clearInterval(iv);
        elapsed.textContent = fmtClock(elapsedS(active.rec, Date.now()));
      }, 1000);
      return;
    }

    if (active.error) {
      const denied = active.error?.code === "NOT_AUTHORIZED";
      panel.innerHTML = `<div class="panel">
        <div class="error-banner">${esc(
          denied
            ? "Location permission is required to record laps."
            : `Recording stopped: ${active.error?.message ?? "location unavailable"}`
        )}</div>
        <div class="btn-row">
          ${denied ? `<button class="btn" id="rec-settings">Open location settings</button>` : ""}
          <button class="btn primary" id="rec-retry">Try again</button>
        </div>
      </div>`;
      panel.querySelector("#rec-settings")?.addEventListener("click", () => platform.bgLocation.openSettings());
      panel.querySelector("#rec-retry").onclick = () => {
        active.error = null;
        render();
      };
      return;
    }

    // Unsaved recording (stopped, or recovered after the app was killed).
    const pending = await pendingRecording();
    if (pending) {
      pendingCard(pending);
      return;
    }

    panel.innerHTML = `<div class="panel">
      <strong>Record this session's laps with your phone</strong>
      <p class="hint" style="margin:8px 0 0">Start before you head out — then lock the phone and put it away.
      GPS is recorded in the background${platform.os === "android" ? " (you'll see a notification while recording)" : ""}
      and laps are timed afterwards: stop the recording back in the paddock, tap the start/finish line on the
      track map, and every pass across it becomes a lap. Nothing is uploaded until you save.</p>
      <p class="hint">Phone GPS lap times are estimates (~±0.2–0.5 s) — plenty for spotting trends across a day.</p>
      <div class="btn-row">
        <button class="btn primary" id="rec-start">Start recording</button>
      </div>
    </div>`;
    panel.querySelector("#rec-start").onclick = async () => {
      panel.querySelector("#rec-start").disabled = true;
      await startRecording(event.id, event.track_name);
    };
  }

  // Re-render on recorder state changes while this view is mounted. The
  // recorder outlives the view; the hook is replaced on the next bind.
  active.onChange = () => {
    if (!panel.isConnected) {
      active.onChange = null;
      return;
    }
    // Fix-by-fix updates only touch the live counters; full re-renders are
    // for state transitions (start/stop/error/auto-stop).
    if (active.rec && panel.querySelector("#rec-gps")) {
      const acc = active.lastFix?.accuracy;
      panel.querySelector("#rec-gps").textContent = `${active.rec.fixes.length.toLocaleString()} GPS fixes${
        acc != null ? ` · ±${Math.round(acc)} m` : ""
      }`;
      return;
    }
    render();
  };

  render();
}
