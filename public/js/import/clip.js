// Best-lap video clips (NS-45, docs/specs/native/NS-45-best-lap-clips.md):
// which lap of an imported video gets saved, the window cut around it, and what
// the import review's *Save best-lap video* row says.
//
// The rule the iOS Kit and Android :core ports are pinned to, through
// contracts/logic/lap-clips.json, generated from it — and, since NS-47, the
// web's own: the import review offers the clip from it and mp4cut.js cuts the
// window it names.
//
// Times are seconds on the telemetry clock (a lap's startT/endT), which the
// spec takes to be the file's media timeline: the telemetry track is muxed into
// the same MP4. The window here is the *requested* cut; a passthrough cut
// starts at the keyframe before it, so the native cutter reports the lap's real
// offset inside the clip it made.

import { canSaveLapVideo } from "../entitlement.js";

// Seconds kept before the lap starts and after it ends, clamped to the file.
// The tail is the longer of the two: a lap's endT can sit a beat early of the
// car crossing the line on video, and a clip that stops on the line looks cut
// off.
export const PRE_ROLL_S = 3;
export const POST_ROLL_S = 4;
// Seconds of run-up a player shows before the line: it opens this far ahead of
// lap_offset_ms rather than on the lap's first frame, so the crossing is seen.
export const PLAYBACK_LEAD_S = 2;
// A lap longer than this gets no clip (inclusive: exactly 600 s still does).
export const MAX_CLIP_S = 600;

// The parsers whose source is a video file. A phone recording ("live"), a
// .vbo and a Track Precision .csv have no video to cut.
export const VIDEO_KINDS = Object.freeze(["pdr", "gopro"]);

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// The padded window around one lap, clamped to [0, durationS], or null when the
// lap has no usable window: no startT/endT, one outside the file, or a lap
// longer than MAX_CLIP_S. `lapOffsetS` is where the lap starts inside the
// window.
export function clipWindow(lap, durationS) {
  if (!lap || !finite(lap.startT) || !finite(lap.endT) || !finite(durationS)) return null;
  const { startT, endT } = lap;
  if (startT < 0 || endT <= startT || endT > durationS) return null;
  if (endT - startT > MAX_CLIP_S) return null;
  const startS = Math.max(0, startT - PRE_ROLL_S);
  const endS = Math.min(durationS, endT + POST_ROLL_S);
  return { startS, endS, lapOffsetS: startT - startS };
}

// Where a player opens a clip, in ms: PLAYBACK_LEAD_S ahead of the lap's
// start inside it, never before the clip's own start.
export function playbackStartMs(lapOffsetMs) {
  const offset = Number.isFinite(lapOffsetMs) ? Math.round(lapOffsetMs) : 0;
  return Math.max(0, offset - PLAYBACK_LEAD_S * 1000);
}

// The lap to save from one parsed video, as { lap, index } into parsed.laps, or
// null. The best lap that has a usable window; a tie on time goes to the lower
// lap number (the earlier index), which is also the lap the server attaches the
// clip to (POST /sessions/:id/clip keys on the time, lowest lap_num first). An
// `estimated` lap — a PDR recording's recovered laps — still counts: an
// estimated boundary is still a boundary, and the padding absorbs the error.
export function clipCandidate(parsed) {
  if (!parsed || !VIDEO_KINDS.includes(parsed.kind) || !Array.isArray(parsed.laps)) return null;
  let best = null;
  parsed.laps.forEach((lap, index) => {
    if (!lap || !finite(lap.timeMs) || !clipWindow(lap, parsed.durationS)) return;
    if (!best || lap.timeMs < best.lap.timeMs) best = { lap, index };
  });
  return best;
}

// Roughly how big the cut will be: the file's average bitrate over the window.
// A passthrough cut keeps the source's bitrate, so this is close; it is what
// the row's "about N MB" and the quota check use. null when there's nothing to
// estimate from.
export function estimateClipBytes(lap, fileBytes, durationS) {
  const w = clipWindow(lap, durationS);
  if (!w || !finite(fileBytes) || fileBytes <= 0 || durationS <= 0) return null;
  return Math.round((fileBytes / durationS) * (w.endS - w.startS));
}

// Which state the review row is in, over the review's items — each
// `{ parsed, include, fileBytes }`, the shape of a review item on every client
// plus the source file's size:
//   "none"   no included item has a clip candidate — the row isn't drawn
//   "locked" a free account: drawn as the Pro offer, never hidden
//   "full"   the candidates' estimates would take storage over the quota
//   "on"     offered (the switch itself starts on, every review)
// `clips` is user.clips from GET /api/me — { used_bytes, quota_bytes,
// coach_count } — and may be missing from a cached /me older than the field,
// in which case nothing is known to be full.
export function clipOffer(items, entitlement, clips) {
  const candidates = (items ?? [])
    .filter((it) => it && it.include)
    .map((it) => ({ it, c: clipCandidate(it.parsed) }))
    .filter((x) => x.c);
  if (!candidates.length) return "none";
  if (!canSaveLapVideo(entitlement)) return "locked";
  if (clips && finite(clips.used_bytes) && finite(clips.quota_bytes)) {
    const adding = candidates.reduce(
      (sum, { it, c }) => sum + (estimateClipBytes(c.lap, it.fileBytes, it.parsed.durationS) ?? 0),
      0
    );
    if (clips.used_bytes + adding > clips.quota_bytes) return "full";
  }
  return "on";
}

// The row's second sentence: who else will see the video. One sentence for
// any number of coaches — naming them is the Coaching page's job, and a count
// in a switch's subtitle reads as a warning.
export function clipOfferNote(clips) {
  return clips && clips.coach_count >= 1 ? "Your coaches can watch it too." : "";
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// "150 MB", "3.2 GB", "20 GB": binary units, as the quota is set, with GB to
// one decimal and a whole number left whole. Pinned for the ports, whose
// fixed-decimal formatting rounds differently from toFixed on a binary tie.
export function fmtClipBytes(bytes) {
  if (!finite(bytes) || bytes <= 0) return "0 MB";
  const mb = Math.max(1, Math.round(bytes / MiB));
  if (mb < 1024) return `${mb} MB`;
  const gb = (bytes / GiB).toFixed(1);
  return `${gb.endsWith(".0") ? gb.slice(0, -2) : gb} GB`;
}

// The row's first sentence, with the size estimate when there is one.
export function clipOfferText(estimateBytes) {
  const size = finite(estimateBytes) && estimateBytes > 0 ? `, about ${fmtClipBytes(estimateBytes)} each` : "";
  return `A clip of each session's fastest lap${size}. Uploads on Wi-Fi.`;
}

// The web's first sentence (NS-47): the same offer, but a browser uploads from
// the open tab rather than on Wi-Fi in the background. Web-only, so it isn't in
// the lap-clips.json fixture.
export function clipOfferTextWeb(estimateBytes) {
  const size = finite(estimateBytes) && estimateBytes > 0 ? `, about ${fmtClipBytes(estimateBytes)} each` : "";
  return `A clip of each session's fastest lap${size}. Uploads from this tab — keep it open until it's done.`;
}

// What the row says, switched off and disabled, once storage is full.
export function clipFullText(clips) {
  const quota = clips && finite(clips.quota_bytes) ? ` (${fmtClipBytes(clips.quota_bytes)})` : "";
  return `Your lap video storage is full${quota}. Delete old clips from a lap's page.`;
}

// Settings' storage line: "Lap videos: 3.2 GB of 20 GB".
export function clipStorageLine(clips) {
  if (!clips || !finite(clips.quota_bytes)) return null;
  return `Lap videos: ${fmtClipBytes(clips.used_bytes)} of ${fmtClipBytes(clips.quota_bytes)}`;
}
