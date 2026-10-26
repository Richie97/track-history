// Best-lap video clips (NS-45): the arithmetic and the URL signature behind
// routes/clips.ts, kept pure so they are unit-tested rather than inspected.
//
// A clip goes up in parts through the Worker over the R2 binding: 150 MB is
// over the zone's 100 MB request-body cap, and R2 requires every part but the
// last to be the same size. It comes back down through a short-lived signed
// URL rather than the API, because AVPlayer, ExoPlayer, <video>, AirPlay and a
// cast receiver all play a plain URL and only some of them can be made to send
// a bearer header.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// Every part but the last. Well under the 100 MB body cap, and far over R2's
// 5 MiB multipart floor.
export const CLIP_PART_BYTES = 50 * MiB;
// Per user: every ready clip plus the declared size of every uploading one.
// About 500 laps at ~100 MB — sixty-odd sessions saved lap by lap (NS-50).
export const CLIP_QUOTA_BYTES = 50 * GiB;
// One clip. A passthrough cut of a lap keeps the source's bitrate, so this is
// generous; it exists to refuse a body that is not a lap at all.
export const MAX_CLIP_BYTES = GiB;
// A lap longer than this gets no clip (public/js/import/clip.js MAX_CLIP_S).
export const MAX_CLIP_S = 600;
// How long a signed URL plays for. A leaked URL is good for this long, for one
// clip; a revoked coach's URL keeps playing for at most this long.
export const CLIP_URL_TTL_S = 60 * 60;
// An uploading row this old is abandoned: the cron deletes it, and its
// tombstone aborts the multipart upload on the next run.
export const STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;
// Tombstones drained per cron run.
export const SWEEP_BATCH = 500;

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / CLIP_PART_BYTES));
}

// The exact byte count part `n` (1-based) must carry, or null when there is no
// such part.
export function partSize(size: number, n: number): number | null {
  const parts = partCount(size);
  if (!Number.isInteger(n) || n < 1 || n > parts) return null;
  return n < parts ? CLIP_PART_BYTES : size - CLIP_PART_BYTES * (parts - 1);
}

// One user's objects share a prefix.
export function clipKey(userId: number, clipId: number): string {
  return `clips/${userId}/${clipId}.mp4`;
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

// HMAC-SHA256 over "<id>.<exp>", exp in unix seconds.
export function signClip(secret: string, clipId: number, exp: number): Promise<string> {
  return hmacHex(secret, `${clipId}.${exp}`);
}

// The playable URL and when it stops playing (ms, like every other timestamp
// the API answers).
export async function signClipUrl(
  secret: string,
  origin: string,
  clipId: number,
  nowMs: number,
  { download = false }: { download?: boolean } = {}
): Promise<{ url: string; expires_at: number }> {
  const exp = Math.floor(nowMs / 1000) + CLIP_URL_TTL_S;
  const sig = await signClip(secret, clipId, exp);
  const url = `${origin}/clips/${clipId}.mp4?exp=${exp}&sig=${sig}${download ? "&dl=1" : ""}`;
  return { url, expires_at: exp * 1000 };
}

// Constant-time over the hex digests, so a timing difference can't walk a
// forged signature towards the real one.
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyClipUrl(
  secret: string,
  clipId: number,
  exp: string | null | undefined,
  sig: string | null | undefined,
  nowMs: number
): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expS = Number(exp);
  if (expS * 1000 <= nowMs) return false;
  return equalHex(await signClip(secret, clipId, expS), sig);
}

// "virginia-international-raceway-full-2026-05-01-lap-7.mp4": what a download
// is saved as. The track name carries its layout, so the slug keeps it.
export function clipFilename(trackName: string | null | undefined, date: string | null | undefined, lap: number): string {
  const slug = (trackName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date : "";
  return [slug || "lap", day, `lap-${lap}`].filter(Boolean).join("-") + ".mp4";
}

// Body validation for POST /sessions/:id/clip. A positive whole number in
// range, or the reason it isn't. `lap_num` (NS-50) is optional — a shipped
// client keys on the time alone — and null when absent.
export function validateClipCreate(
  body: unknown
):
  | { error: string }
  | { time_ms: number; lap_num: number | null; size_bytes: number; duration_ms: number; lap_offset_ms: number } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  if (!int(b.time_ms) || (b.time_ms as number) <= 0) return { error: "invalid time_ms" };
  if (!int(b.size_bytes) || (b.size_bytes as number) <= 0) return { error: "invalid size_bytes" };
  if ((b.size_bytes as number) > MAX_CLIP_BYTES) return { error: "clip too large" };
  if (!int(b.duration_ms) || (b.duration_ms as number) <= 0) return { error: "invalid duration_ms" };
  // The clip is the lap plus a few seconds' padding, so its own length may run
  // past MAX_CLIP_S by that much; the lap inside it may not.
  if ((b.duration_ms as number) > (MAX_CLIP_S + 30) * 1000) return { error: "clip too long" };
  if ((b.time_ms as number) > MAX_CLIP_S * 1000) return { error: "clip too long" };
  if (!int(b.lap_offset_ms) || (b.lap_offset_ms as number) < 0 || (b.lap_offset_ms as number) >= (b.duration_ms as number))
    return { error: "invalid lap_offset_ms" };
  if (b.lap_num != null && (!int(b.lap_num) || (b.lap_num as number) <= 0)) return { error: "invalid lap_num" };
  return {
    time_ms: b.time_ms as number,
    lap_num: (b.lap_num as number | null | undefined) ?? null,
    size_bytes: b.size_bytes as number,
    duration_ms: b.duration_ms as number,
    lap_offset_ms: b.lap_offset_ms as number,
  };
}
