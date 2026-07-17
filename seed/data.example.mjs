// Example seed data. To seed your own history instead, create
// seed/data.personal.mjs (gitignored) with the same exported shape.

export const USER_EMAIL = "you@example.com"; // must match the Google account that should claim this data
export const USER_NAME = "Example Driver";

export const TRACKS = ["Virginia International Raceway (Full)", "Road Atlanta"];

// [start_date, days, club, group, track, best|null, notes|null, sessionBests[]]
export const EVENTS = [
  ["2025-04-12", 2, "Example Club", "Intermediate", "Virginia International Raceway (Full)", "2:15.4", "First weekend of the season.",
    ["2:19.80", "2:17.31", "2:15.4"]],
  ["2025-06-21", 2, "Example Club", "Intermediate", "Virginia International Raceway (Full)", "2:12.9", null,
    ["2:14.55", "2:12.9"]],
  ["2025-08-09", 1, "Chin", "Blue", "Road Atlanta", "1:48.2", "Hot. Traffic all day.", []],
];

// Optional: full lap-by-lap data for one event (from a lap timer).
export const RAW_EVENT_DATE = null;
export const RAW_SESSIONS = [];
