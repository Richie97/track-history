// Input validation shared across routes — pure, unit-testable.

// 3-32 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export const isValidSlug = (slug: string) => SLUG_RE.test(slug);

// Keep only finite, positive lap times and round to whole milliseconds.
export function sanitizeLaps(laps: unknown): number[] {
  if (!Array.isArray(laps)) return [];
  return laps
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0)
    .map((ms) => Math.round(ms));
}

// A goal is either cleared (null/undefined) or a positive finite number of ms.
export const isValidGoal = (g: unknown): g is number | null | undefined =>
  g == null || (typeof g === "number" && Number.isFinite(g) && g > 0);
