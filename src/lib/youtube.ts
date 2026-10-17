// Publish a best-lap video to YouTube (NS-46,
// docs/specs/native/NS-46-youtube-upload.md): the pure half behind
// routes/youtube.ts and the queue consumer in youtube/step.ts — the draft's
// words, the metadata rules, the resumable upload's range arithmetic, the
// Pacific-midnight reset, token encryption and the feature flag. Kept pure so
// it is unit-tested rather than inspected.

import type { Env } from "../types";

const MiB = 1024 * 1024;

// One chunk per queue message. YouTube requires every chunk but the last to be
// a multiple of 256 KiB; a 150 MB clip goes up in five.
export const YT_CHUNK_BYTES = 32 * MiB;
export const YT_CHUNK_MULTIPLE = 256 * 1024;
// The project's quota is shared, so one driver can't be allowed to spend it.
export const MAX_DAILY_UPLOADS_PER_USER = 10;
// A resumable session YouTube has forgotten (~a week) restarts from byte 0 at
// most this many times; each restart costs quota again.
export const MAX_RESTARTS = 2;
// How long a queue step holds its row. Longer than a 32 MiB chunk takes on any
// connection a Worker has, and short enough that a step that died mid-way is
// picked up again soon.
export const LEASE_MS = 5 * 60 * 1000;
// The native connect ticket's life.
export const TICKET_TTL_MS = 5 * 60 * 1000;
// Refresh the access token when it expires within this.
export const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
// The 30-day rule (YouTube API Services developer policies): API data we keep
// is re-checked or deleted within 30 days. The cron runs daily, so it re-checks
// at 25 to stay inside 30 with days to spare — and deletes a revoked
// connection at 25 for the same reason.
export const RECHECK_AFTER_MS = 25 * 24 * 60 * 60 * 1000;
// Cloudflare Queues delays a message by at most 12 hours.
export const MAX_QUEUE_DELAY_S = 12 * 60 * 60;
// Transport/5xx backoff: doubling from 30 s to an hour.
export const RETRY_BASE_S = 30;
export const RETRY_MAX_S = 60 * 60;

export const YT_SCOPE_UPLOAD = "https://www.googleapis.com/auth/youtube.upload";
export const YT_SCOPES = ["openid", "email", YT_SCOPE_UPLOAD];
// Autos & Vehicles.
export const YT_CATEGORY_ID = "2";

export const PRIVACY_VALUES = ["private", "unlisted", "public"] as const;
export type Privacy = (typeof PRIVACY_VALUES)[number];
export const DEFAULT_PRIVACY: Privacy = "unlisted";

export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5000;

export const ATTRIBUTION = "Logged with Track Evolution — https://trackevolution.app";

// The words the lap page shows. One place, so the routes, the step and the
// cron can't say the same thing three ways.
export const TEXT = {
  disconnected: "YouTube was disconnected.",
  revoked: "YouTube access was removed. Reconnect in Settings.",
  waitingQuota: "Waiting for YouTube — uploads continue tomorrow.",
  deadLetter: "YouTube didn't accept the upload. Try again.",
  stalled: "The upload to YouTube stopped. Try again.",
  restarts: "YouTube kept losing the upload. Try again.",
  sourceGone: "This video has been deleted.",
  generic: "YouTube didn't accept the upload. Try again.",
} as const;

// ---------- the draft ----------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-06-14" → "14 June 2026". Words in English, so the server needs no
// locale; null for anything that isn't a date.
export function dateWords(iso: string | null | undefined): string | null {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

// m:ss.fff — three decimals always, which is how a lap time reads in a title.
export function lapTimeText(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}

// m:ss, floored — the form YouTube turns into a link in a description.
export function offsetText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const chars = (s: string) => [...s];
// Cut to `n` characters (code points, which is what YouTube counts), with an
// ellipsis when anything went.
function cut(s: string, n: number): string {
  const c = chars(s);
  if (c.length <= n) return s;
  if (n <= 0) return "";
  return c.slice(0, n - 1).join("").trimEnd() + "…";
}

export type DraftInput = {
  track: string;
  lapTimeMs: number;
  sessionLabel?: string | null;
  sessionNumber: number;
  date?: string | null;
  car?: string | null;
  lapOffsetMs?: number | null;
};

// `<track> · <m:ss.fff>[ · <car>]`, within TITLE_MAX_CHARS: the track is cut
// first (it is the longest and the least informative part — the lap time is
// the point), then the car. `<` and `>` are dropped from the pieces, since the
// sanitizer would refuse the draft the server itself wrote.
export function defaultTitle(input: Pick<DraftInput, "track" | "lapTimeMs" | "car">): string {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const time = lapTimeText(input.lapTimeMs);
  let track = clean(input.track) || "Best lap";
  let car = clean(input.car);
  const sep = " · ";
  const len = () => chars(track).length + sep.length + chars(time).length + (car ? sep.length + chars(car).length : 0);
  if (len() > TITLE_MAX_CHARS) {
    const room = TITLE_MAX_CHARS - (len() - chars(track).length);
    track = cut(track, Math.max(room, 12));
  }
  if (len() > TITLE_MAX_CHARS && car) {
    const room = TITLE_MAX_CHARS - (len() - chars(car).length);
    car = room >= 4 ? cut(car, room) : "";
  }
  // A track that still doesn't fit (a car-less title is never this long, but
  // the guard is cheap).
  if (len() > TITLE_MAX_CHARS) track = cut(track, TITLE_MAX_CHARS - (len() - chars(track).length));
  return [track, time, car].filter(Boolean).join(sep);
}

export function defaultDescription(input: DraftInput): string {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const session = clean(input.sessionLabel) || `Session ${input.sessionNumber}`;
  const track = clean(input.track);
  const date = dateWords(input.date);
  const where = [track && `at ${track}`, date].filter(Boolean).join(", ");
  const lines = [`Best lap of ${session}${where ? ` ${where}` : ""}.`];
  if (input.lapOffsetMs != null && input.lapOffsetMs > 0) lines.push(`Lap starts at ${offsetText(input.lapOffsetMs)}.`);
  return `${lines.join("\n")}\n\n${ATTRIBUTION}`;
}

export function defaultVideoMetadata(input: DraftInput): { title: string; description: string; privacy: Privacy } {
  return { title: defaultTitle(input), description: defaultDescription(input), privacy: DEFAULT_PRIVACY };
}

// What else goes to YouTube with a video, fixed rather than offered. No
// location, ever: no recordingDetails, and NS-45's cut already stripped the
// file's location atoms.
export function videoResource(meta: VideoMetadata, tags: { track?: string | null; car?: string | null }) {
  const extra = [tags.track, tags.car]
    .map((t) => (t ?? "").replace(/[<>,"]/g, "").trim())
    .filter((t) => t && chars(t).length <= 100);
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      categoryId: YT_CATEGORY_ID,
      tags: [...new Set(["track day", "HPDE", ...extra])],
    },
    status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
  };
}

// ---------- the sanitizer ------------------------------------------------------

export type VideoMetadata = { title: string; description: string; privacy: Privacy };

// The driver's title, description and visibility, or the rule they broke.
// `<` and `>` are refused rather than stripped: YouTube rejects them, and
// silently editing the driver's text would be worse than saying so.
export function sanitizeVideoMetadata(body: unknown): { meta: VideoMetadata } | { error: string } {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!o) return { error: "title, description and privacy are required" };
  if (typeof o.title !== "string") return { error: "title is required" };
  const title = o.title.trim();
  if (!title) return { error: "title is required" };
  if (chars(title).length > TITLE_MAX_CHARS) return { error: `title must be at most ${TITLE_MAX_CHARS} characters` };
  if (/[\u0000-\u001f\u007f]/.test(title)) return { error: "title must be one line" };
  const description = o.description == null ? "" : o.description;
  if (typeof description !== "string") return { error: "description must be text" };
  if (new TextEncoder().encode(description).length > DESCRIPTION_MAX_BYTES)
    return { error: `description must be at most ${DESCRIPTION_MAX_BYTES} bytes` };
  if (/[<>]/.test(title) || /[<>]/.test(description)) return { error: "title and description can't contain < or >" };
  if (!PRIVACY_VALUES.includes(o.privacy as Privacy)) return { error: "privacy must be private, unlisted or public" };
  return { meta: { title, description, privacy: o.privacy as Privacy } };
}

// ---------- the resumable upload -----------------------------------------------

// Content-Range for `length` bytes from `start` of a `total`-byte file.
export function contentRange(start: number, length: number, total: number): string {
  return `bytes ${start}-${start + length - 1}/${total}`;
}

// The empty PUT that asks a session how much it has.
export const statusRange = (total: number) => `bytes */${total}`;

// The last byte YouTube has, from a 308's `Range: bytes=0-N`, or -1 when it
// has none (no header: nothing received yet). Only a range starting at 0 is
// meaningful; anything else is treated as nothing, which re-sends from 0
// rather than skipping bytes.
export function parseResumeRange(header: string | null | undefined): number {
  const m = header ? /^bytes=0-(\d+)$/.exec(header.trim()) : null;
  return m ? Number(m[1]) : -1;
}

// The next chunk's length from `offset`. Every chunk but the last is
// `chunkBytes`, which must be a multiple of 256 KiB.
export function chunkLength(offset: number, total: number, chunkBytes = YT_CHUNK_BYTES): number {
  return Math.max(0, Math.min(chunkBytes, total - offset));
}

// The transport backoff for a message's nth attempt (1-based).
export function retryDelaySeconds(attempt: number): number {
  return Math.min(RETRY_MAX_S, RETRY_BASE_S * 2 ** Math.max(0, attempt - 1));
}

// ---------- Pacific time ---------------------------------------------------------

const PACIFIC = "America/Los_Angeles";
const pacificParts = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function wall(ms: number) {
  const p = Object.fromEntries(pacificParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

// Pacific wall time minus UTC, in ms, at `ms` (−7 h or −8 h).
function pacificOffsetMs(ms: number): number {
  const w = wall(ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

// The Pacific calendar day, "YYYY-MM-DD" — the key the project budget counts
// under, since YouTube's quota resets at midnight Pacific.
export function pacificDay(ms: number): string {
  const w = wall(ms);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

// Seconds from `ms` to the next midnight Pacific, at least 1. Computed from
// the offset *at* that midnight, so the 23- and 25-hour days are right.
export function secondsToPacificMidnight(ms: number): number {
  const w = wall(ms);
  const midnightWall = Date.UTC(w.y, w.mo - 1, w.d + 1);
  let at = midnightWall - pacificOffsetMs(midnightWall);
  at = midnightWall - pacificOffsetMs(at);
  return Math.max(1, Math.ceil((at - ms) / 1000));
}

// ---------- secrets at rest ------------------------------------------------------

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const fromB64 = (s: string) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error("YOUTUBE_TOKEN_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// AES-GCM with a random 96-bit IV per value, as `iv.ciphertext` in base64url.
// Encryption rather than hashing (the rule every other credential here
// follows) because these are sent back to Google.
export async function encryptSecret(keyB64: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), new TextEncoder().encode(plaintext))
  );
  return `${b64url(iv)}.${b64url(ct)}`;
}

// The plaintext, or a throw for anything not encrypted under this key —
// tampered, truncated or from another key.
export async function decryptSecret(keyB64: string, sealed: string): Promise<string> {
  const [iv, ct, extra] = sealed.split(".");
  if (!iv || !ct || extra !== undefined) throw new Error("malformed secret");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await aesKey(keyB64), fromB64url(ct));
  return new TextDecoder().decode(pt);
}

// ---------- YouTube's errors in our words ------------------------------------------

// YouTube's error reasons that end an upload, said the way the lap page says
// things. A reason that means "wait" (quota) or "reconnect" is handled by the
// step before it gets here; an unknown reason gets the generic sentence.
const ERROR_TEXT: Record<string, string> = {
  invalidTitle: "YouTube didn't accept the title. Edit it and try again.",
  invalidDescription: "YouTube didn't accept the description. Edit it and try again.",
  invalidTags: "YouTube didn't accept the video's tags. Try again.",
  invalidCategoryId: "YouTube didn't accept the upload. Try again.",
  youtubeSignupRequired: "This Google account has no YouTube channel yet. Create one on YouTube, then try again.",
  forbidden: "This YouTube channel can't upload videos right now.",
  accountSuspended: "This YouTube channel can't upload videos right now.",
  channelSuspended: "This YouTube channel can't upload videos right now.",
  insufficientPermissions: TEXT.revoked,
  authError: TEXT.revoked,
  uploadLimitExceeded: "This YouTube channel has reached its upload limit for today. It continues tomorrow.",
  quotaExceeded: TEXT.waitingQuota,
  mediaBodyRequired: TEXT.generic,
  invalidVideoMetadata: "YouTube didn't accept the title or description. Edit them and try again.",
};

export function youtubeErrorText(reason: string | null | undefined): string {
  return (reason && ERROR_TEXT[reason]) || TEXT.generic;
}

// The first `reason` in a Google API error body ({ error: { errors: [{ reason
// }] } }), or its status string, or null.
export function googleErrorReason(body: unknown): string | null {
  const err = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
  if (!err || typeof err !== "object") return typeof err === "string" ? err : null;
  const r = err.errors?.find((e) => typeof e?.reason === "string")?.reason;
  return typeof r === "string" ? r : typeof err.status === "string" ? err.status : null;
}

// Reasons that mean "the project or the channel is out of uploads for today".
export const QUOTA_REASONS = new Set(["quotaExceeded", "uploadLimitExceeded", "dailyLimitExceeded"]);

// ---------- the feature flag -----------------------------------------------------

// The three secrets and the queue, and — while YOUTUBE_ALLOWLIST is set — an
// email on it. `user.youtube.available` on GET /me is this, and it is the one
// switch every client reads.
export function youtubeConfigured(
  env: Pick<Env, "YOUTUBE_CLIENT_ID" | "YOUTUBE_CLIENT_SECRET" | "YOUTUBE_TOKEN_KEY" | "YOUTUBE_QUEUE">
): boolean {
  return !!(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_TOKEN_KEY && env.YOUTUBE_QUEUE);
}

export function youtubeAvailable(
  env: Pick<Env, "YOUTUBE_CLIENT_ID" | "YOUTUBE_CLIENT_SECRET" | "YOUTUBE_TOKEN_KEY" | "YOUTUBE_QUEUE" | "YOUTUBE_ALLOWLIST">,
  email: string | null | undefined
): boolean {
  if (!youtubeConfigured(env)) return false;
  const list = (env.YOUTUBE_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return true;
  return !!email && list.includes(email.trim().toLowerCase());
}

// The project budget (YOUTUBE_DAILY_BUDGET, uploads per Pacific day), or null
// for none.
export function dailyBudget(env: Pick<Env, "YOUTUBE_DAILY_BUDGET">): number | null {
  const n = Number(env.YOUTUBE_DAILY_BUDGET);
  return env.YOUTUBE_DAILY_BUDGET != null && env.YOUTUBE_DAILY_BUDGET !== "" && Number.isInteger(n) && n >= 0 ? n : null;
}

// ---------- the lap page's view of an upload ----------------------------------------

export type UploadRow = {
  status: "queued" | "uploading" | "done" | "failed";
  privacy: Privacy;
  video_id: string | null;
  bytes_sent: number;
  error: string | null;
};

export const videoUrl = (videoId: string) => `https://youtu.be/${videoId}`;

// GET /clips/:id/youtube: what the lap page draws. `progress` is 0…1 of the
// clip's bytes YouTube has acknowledged; `url` only once done.
export function uploadView(row: UploadRow, sizeBytes: number) {
  const progress = row.status === "done" ? 1 : sizeBytes > 0 ? Math.min(1, row.bytes_sent / sizeBytes) : 0;
  return {
    status: row.status,
    progress,
    privacy: row.privacy,
    url: row.status === "done" && row.video_id ? videoUrl(row.video_id) : null,
    error: row.error,
  };
}

// The event detail's `clip.youtube`.
export function clipYouTube(row: Pick<UploadRow, "status" | "privacy" | "video_id">) {
  return {
    status: row.status,
    video_id: row.status === "done" ? row.video_id : null,
    url: row.status === "done" && row.video_id ? videoUrl(row.video_id) : null,
    privacy: row.privacy,
  };
}
