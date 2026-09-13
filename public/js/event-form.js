// The New Event form's "Add laps" section — the pure half, shared by the
// three clients as `EventFormSessions` (iOS Kit / Android :core, same names).
//
// The form stages sessions until "Create event": clips the import review
// handed back (`importSessionBody` in import/ui.js) and, optionally, one
// session typed by hand. Nothing is posted before the event exists — the
// event is created first, then each staged session is `POST
// /events/:id/sessions` in this order, so the logbook reads the way the form
// did. A hand entry with no parseable laps is dropped rather than posted as
// an empty session, and the created event's id is remembered by the caller
// so a session post that fails is retried against the same event rather than
// creating it twice.

import { fmtMs, parseLapList } from "./format.js";

// Every session to create for a new event, in posting order: the staged
// imports first, in the order they were staged, then the hand-typed one when
// it holds at least one lap. `hand` is `{ label, laps, notes }` as typed.
export function sessionsToCreate(staged, hand) {
  const out = [...staged];
  const laps = parseLapList(hand?.laps ?? "");
  if (laps.length) {
    out.push({
      label: (hand.label ?? "").trim() || null,
      notes: (hand.notes ?? "").trim() || null,
      laps,
    });
  }
  return out;
}

// "9 laps · best 2:01.24" — one staged session's line on the form.
export function stagedSummary(body) {
  const laps = body.laps ?? [];
  const n = laps.length;
  const best = n ? Math.min(...laps) : null;
  return `${n} lap${n === 1 ? "" : "s"}${best != null ? ` · best ${fmtMs(best)}` : ""}`;
}
