// Remote controls for the live lap recorder — the JS side of the CarPlay
// integration. The native shell forwards a CarPlay "Start recording" tap to
// platform.recorderRemote.start(), which has to work with nobody looking at
// the phone: it attaches to the event happening today when the logbook has
// one, and otherwise records anyway with no event — recording is entirely
// on-device, so a dead paddock connection or an expired session must never
// block it. An unattached recording is surfaced by the dashboard banner and
// adopted by the first event whose record screen it's opened from
// (js/record/ui.js), so the event can be created after the session, at review
// time. State flows the other way through platform.onRecorderState (emitted
// by ui.js), so the car screen mirrors whatever the phone does.

import { platform } from "../platform.js";
import { api } from "../api.js";
import { activeEventId, isRecording, recorderAvailable, startRecording, stopRecording } from "./ui.js";

// Local calendar date as YYYY-MM-DD — track time is phone time.
export function localTodayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Date-only day arithmetic in UTC so DST transitions can't skip or repeat a
// calendar day.
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The event a remote "start recording" attaches to: one whose day range
// (start_date for `days` days) covers today. Never guesses beyond that — a
// recording that lands in last month's event is worse than one that waits,
// unattached, for its event to be created at review time. Ties (overlapping
// events) go to the one that started most recently.
export function pickRecordingEvent(events, todayIso) {
  const covering = (events ?? []).filter((e) => {
    if (!e?.start_date) return false;
    const days = Math.max(1, Number(e.days) || 1);
    return e.start_date <= todayIso && todayIso <= addDays(e.start_date, days - 1);
  });
  covering.sort((a, b) => (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0));
  return covering[0] ?? null;
}

export function initRemoteRecorder() {
  if (!recorderAvailable()) return;
  platform.recorderRemote = {
    async start() {
      if (isRecording()) return { ok: true, eventId: activeEventId() };
      // Best effort only: signed out, offline, or no event today all still
      // record — the GPS trace is the irreplaceable part, the event isn't.
      let event = null;
      try {
        event = pickRecordingEvent(await api("/events"), localTodayIso());
      } catch {}
      await startRecording(event?.id ?? null, event?.track_name ?? null);
      if (!isRecording()) return { ok: false, reason: "gps" };
      // Land the phone UI where the recording is reachable when next opened:
      // the event's live record screen, or the dashboard (whose banner offers
      // an unattached recording for adoption).
      if (typeof location !== "undefined") location.hash = event ? `#/event/${event.id}/record` : "#/";
      return { ok: true, eventId: event?.id ?? null };
    },
    async stop() {
      await stopRecording();
      return { ok: true };
    },
  };
}
