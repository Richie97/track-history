// Pure formatting/parsing helpers — no DOM access, unit-testable.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// ms -> "2:01.24" (trailing zeros trimmed, at least one decimal)
export function fmtMs(ms) {
  if (ms == null) return "—";
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  let frac = String(total % 1000).padStart(3, "0").replace(/0+$/, "");
  if (!frac) frac = "0";
  return `${m}:${String(s).padStart(2, "0")}.${frac}`;
}

// "2:01.24" | "121.24" | "2:01" -> ms (null if unparseable)
export function parseTime(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let m = /^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t);
  if (m) {
    const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
    return (Number(m[1]) * 60 + Number(m[2])) * 1000 + frac;
  }
  m = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(t);
  if (m) return Number(m[1]) * 1000 + (m[2] ? Number(m[2].padEnd(3, "0")) : 0);
  return null;
}

export function parseLapList(text) {
  return String(text ?? "")
    .split(/[\s,;]+/)
    .map(parseTime)
    .filter((ms) => ms != null && ms > 0);
}

export const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

export const fmtConsistency = (cv) => (cv == null ? "—" : `${(cv * 100).toFixed(1)}%`);
