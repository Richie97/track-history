// Share one event or one session (NS-48): what a link anyone can open shows.
//
// A shared item is read as its owner — through the ordinary GET /events/:id,
// so ownership, `withComputed` and `stripProFields` at the *owner's* tier are
// the API's own — and then narrowed here. The narrowing starts from a coach's
// view of the event (lib/coaching.ts), which is already an allow-list that
// copies the lap data and sends notes, the checklist, the cost line items and
// the setup sheets as null / [], and goes one step further, because a link
// can travel anywhere and a coach is someone the driver chose:
//
//   - the garage linkage goes too (`vehicle_id`, `track_hours`) — the car's
//     *name* stays, as on the logbook share page, but not the way into it;
//   - a best-lap video is offered only while the owner has Pro, the tier its
//     URL is signed under, so a free owner's link shows no locked player;
//   - a *session* share carries its own session alone, and the event header's
//     figures are that session's: its best, its lap count, its consistency —
//     never a time from a session that wasn't shared.
//
// Pure, so the rule is unit-tested rather than inspected.

import { eventConsistency } from "../../public/js/lap-stats.js";
import { coachEventDetail } from "./coaching";

type Json = Record<string, any>;

export type ShareKind = "event" | "session";

// The path segment each kind lives under: /share/e/<token>, /share/s/<token>.
// One letter on purpose — a logbook slug is at least three characters
// (isValidSlug), so neither can ever be someone's /share/<slug>.
export const SHARE_KIND_PREFIX: Record<ShareKind, string> = { event: "e", session: "s" };
export const shareKindFor = (prefix: string): ShareKind | null =>
  prefix === "e" ? "event" : prefix === "s" ? "session" : null;

// 16 random bytes, base64url without padding: 22 characters.
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/;
export function shareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const sharePath = (kind: ShareKind, token: string) => `/share/${SHARE_KIND_PREFIX[kind]}/${token}`;

// GET /events/:id's body, as the owner reads it, to what the link shows.
// `sessionId` null is the whole event. Null when a session share's session is
// no longer in the event (the cascade normally removes the share first).
export function sharedEvent(detail: unknown, sessionId: number | null, ownerEntitled: boolean): Json | null {
  const out = coachEventDetail(detail) as Json;
  out.vehicle_id = null;
  out.track_hours = null;
  if (!ownerEntitled) {
    for (const s of out.sessions) for (const l of s.laps) if (Object.hasOwn(l, "clip")) l.clip = null;
  }
  if (sessionId == null) return out;

  const session = (out.sessions as Json[]).find((s) => s.id === sessionId);
  if (!session) return null;
  out.sessions = [session];
  const times = (session.laps as Json[]).map((l) => l.time_ms as number);
  const best = times.length ? Math.min(...times) : null;
  // The event's typed best time is the day's, not this session's.
  out.best_time_ms = null;
  out.best_ms = best;
  out.lap_best_ms = best;
  out.lap_count = times.length;
  out.session_count = 1;
  out.consistency = eventConsistency([times]);
  // A session's own weather, which is what its chip shows; the day's range
  // could include a session that wasn't shared.
  out.ambient_lo_c = session.ambient_c ?? null;
  out.ambient_hi_c = session.ambient_c ?? null;
  out.elevation_m = session.elevation_m ?? null;
  return out;
}

// For the link preview (the share page's OG description): "Sat, Oct 4, 2026 ·
// best 2:01.24 · 18 laps · 3 sessions".
export function sharedSummary(e: Json, fmtMs: (ms: number) => string): string {
  const date = new Date(`${e.start_date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const bits = [date];
  if (e.best_ms != null) bits.push(`best ${fmtMs(e.best_ms)}`);
  if (e.lap_count) bits.push(`${e.lap_count} lap${e.lap_count === 1 ? "" : "s"}`);
  if (e.session_count > 1) bits.push(`${e.session_count} sessions`);
  return bits.join(" · ");
}
