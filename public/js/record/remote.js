// Remote-start event attachment for the live lap recorder — the reference
// implementation both native ports are pinned against, not code the web app
// loads (the recorder is native-only; nothing under public/ imports this).
// A remote "start recording" (CarPlay, Android Auto, the dashboard button)
// happens with nobody looking at the phone, so the rule has to pick an event
// without asking: attach to the event happening today when the logbook has
// one, and otherwise record with no event — an unattached recording is
// offered to the first event whose record screen it's opened from, so the
// event can be created after the session, at review time.
//
// contracts/logic/remote-attach.json is generated from pickRecordingEvent
// (contracts/logic.mjs) and is what pins RemoteRecording in
// apps/ios/Packages/TrackEvolutionKit and apps/android's :core — change the
// behavior here and both ports' fixtures change with it.

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
