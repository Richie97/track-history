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

// Track conditions for an event: cleared, or one of the known values.
export const CONDITIONS = ["dry", "damp", "wet", "mixed"] as const;
export type Conditions = (typeof CONDITIONS)[number];
export const isValidConditions = (v: unknown): v is Conditions | null | undefined =>
  v == null || (typeof v === "string" && (CONDITIONS as readonly string[]).includes(v));

// Ambient temperature in °F: cleared, or a plausible whole number.
export const isValidTemp = (v: unknown): v is number | null | undefined =>
  v == null || (typeof v === "number" && Number.isInteger(v) && v >= -40 && v <= 150);

// A best-lap GPS trace: array of [x, y, v] points (local meters + speed).
// null clears it; a valid array is rounded to keep the stored JSON small.
// Returns undefined when the input isn't a plausible trace.
export function sanitizeTrace(v: unknown): [number, number, number][] | null | undefined {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length < 10 || v.length > 600) return undefined;
  const pts: [number, number, number][] = [];
  for (const raw of v) {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return undefined;
    const [x, y, speed] = raw as unknown[];
    if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1e6) return undefined;
    if (typeof y !== "number" || !Number.isFinite(y) || Math.abs(y) > 1e6) return undefined;
    const sv = speed == null ? 0 : speed;
    if (typeof sv !== "number" || !Number.isFinite(sv) || Math.abs(sv) > 1e6) return undefined;
    pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(sv * 100) / 100]);
  }
  return pts;
}

export type ChecklistItem = { text: string; done: boolean };

// Normalize a prep checklist: null clears it, a valid array is trimmed and
// coerced to {text, done}. Returns undefined when the input isn't a checklist.
export function sanitizeChecklist(v: unknown): ChecklistItem[] | null | undefined {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 100) return undefined;
  const items: ChecklistItem[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const text = String((raw as Record<string, unknown>).text ?? "").trim();
    if (!text || text.length > 200) return undefined;
    items.push({ text, done: Boolean((raw as Record<string, unknown>).done) });
  }
  return items;
}
