// Share with a coach (NS-38): the words the Coaching page and a coach's
// Students list say about a grant. Pure and dateless in the way ported logic
// here is — anything that needs a calendar date takes the client's own
// formatter — so contracts/logic/coaching.json can pin the iOS and Android
// ports to it.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A student row's one line: how much there is to read, and when they were
// last out. `fmtDate` turns the ISO date into the client's own wording.
export function studentLine(student, fmtDate) {
  if (!student?.event_count) return "No track days yet";
  const count = plural(student.event_count, "event");
  return student.last_event_date ? `${count} · last out ${fmtDate(student.last_event_date)}` : count;
}

// When a coach last read the logbook, for the student's list of coaches. The
// server touches it at most once an hour, so nothing finer is said.
export function lastViewedText(lastViewedAt, now) {
  if (lastViewedAt == null) return "hasn't looked yet";
  const ago = Math.max(0, now - lastViewedAt);
  if (ago < HOUR_MS) return "viewed in the last hour";
  if (ago < DAY_MS) return `viewed ${plural(Math.floor(ago / HOUR_MS), "hour")} ago`;
  if (ago < 14 * DAY_MS) return `viewed ${plural(Math.floor(ago / DAY_MS), "day")} ago`;
  if (ago < 60 * DAY_MS) return `viewed ${plural(Math.floor(ago / (7 * DAY_MS)), "week")} ago`;
  return "not viewed for over two months";
}

// An open invite's remaining life. Days round rather than floor, so a link
// minted a second ago reads "7 days", not "6".
export function inviteExpiryText(expiresAt, now) {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  if (left < HOUR_MS) return "expires within the hour";
  if (left < DAY_MS) return `expires in ${plural(Math.floor(left / HOUR_MS), "hour")}`;
  return `expires in ${plural(Math.round(left / DAY_MS), "day")}`;
}
