// Example seed data. To seed your own history instead, create
// seed/data.personal.mjs (gitignored) with the same exported shape.
// (VEHICLES, SETUPS and DEFAULT_CAR are optional — older personal data files
// without them still generate.)

export const USER_EMAIL = "you@example.com"; // must match the Google account that should claim this data
export const USER_NAME = "Example Driver";

export const TRACKS = ["Virginia International Raceway (Full)", "Road Atlanta"];

// Applied to events that don't name a car of their own (9th tuple element).
export const DEFAULT_CAR = "2023 Corvette Z06";

// The garage: vehicles with their consumable parts. Part `key`s are only
// used below to reference parts from setup sheets.
export const VEHICLES = [
  {
    name: "2023 Corvette Z06",
    notes: "Z07 package, stock aero. Track alignment.",
    default: true,
    parts: [
      // Current consumables
      {
        key: "dtc70f", kind: "pads_front", name: "Hawk DTC-70", installed: "2026-01-15",
        cost: 429, wear_limit: 3, notes: "17 mm new",
        measurements: [
          ["2026-02-20", 16.5, "mm"],
          ["2026-04-22", 11.5, "mm"],
          ["2026-06-16", 6.4, "mm"],
        ],
      },
      {
        key: "dtc70r", kind: "pads_rear", name: "Hawk DTC-70", installed: "2026-01-15",
        cost: 379, wear_limit: 3, expected_hours: 24,
        measurements: [["2026-06-16", 9.5, "mm"]],
      },
      {
        key: "re71", kind: "tires", name: "RE-71RS 275/345", installed: "2026-01-15",
        cost: 1980, expected_hours: 20, notes: "Square-ish setup, shaved fronts",
      },
      {
        key: "srf", kind: "brake_fluid", name: "Castrol SRF", installed: "2025-11-30",
        cost: 89, expected_hours: 12,
      },
      {
        kind: "rotors_front", name: "OEM CCM", installed: "2025-03-20", expected_hours: 100,
      },
      // Retired lifecycles — these teach the expected-life defaults
      {
        key: "dtc60f", kind: "pads_front", name: "Hawk DTC-60", installed: "2025-03-20",
        retired: "2026-01-15", cost: 389,
      },
      {
        key: "ps4s", kind: "tires", name: "Michelin PS4S (OEM)", installed: "2025-03-20",
        retired: "2025-11-30", cost: 1650, notes: "Delivery take-offs, run to the cords",
      },
    ],
  },
  { name: "1999 Mazda Miata", notes: "Spec-ish backup car.", parts: [] },
];

// [start_date, days, club, group, track, best|null, notes|null, sessionBests[], car?]
export const EVENTS = [
  ["2025-04-12", 2, "NASA Mid-Atlantic", "HPDE3", "Virginia International Raceway (Full)", "2:15.4",
    "First weekend of the season.", ["2:19.80", "2:17.31", "2:15.4"]],
  ["2025-06-21", 2, "NASA Mid-Atlantic", "HPDE3", "Virginia International Raceway (Full)", "2:12.9", null,
    ["2:14.55", "2:12.9"]],
  ["2025-08-09", 1, "Chin", "Blue", "Road Atlanta", "1:48.2", "Hot. Traffic all day.", []],
  ["2025-09-13", 1, "SCCA", "Novice", "Road Atlanta", "1:59.5", "Miata day — momentum lessons.",
    ["1:59.5"], "1999 Mazda Miata"],
  ["2025-11-01", 2, "NASA Mid-Atlantic", "HPDE4", "Virginia International Raceway (Full)", "2:11.4",
    "Season closer — cold and grippy.", ["2:13.2", "2:11.4"]],
  ["2026-02-14", 2, "Chin", "Blue", "Road Atlanta", "1:45.9", "New pads + RE-71RS. Bedding day 1.",
    ["1:47.5", "1:45.9"]],
  ["2026-04-18", 2, "NASA Mid-Atlantic", "HPDE4", "Virginia International Raceway (Full)", "2:09.8", null,
    ["2:11.0", "2:09.8"]],
  ["2026-06-13", 2, "NASA Mid-Atlantic", "HPDE4", "Virginia International Raceway (Full)", "2:08.6",
    "Best weekend yet.", ["2:10.1", "2:09.0", "2:08.6"]],
  ["2026-08-08", 2, "NASA Mid-Atlantic", "HPDE4", "Virginia International Raceway (Full)", null, null, []],
];

// Per-event-day setup sheets. `event` matches an EVENTS start_date; part refs
// use the part keys above.
export const SETUPS = [
  {
    event: "2025-04-12", day: 1,
    data: {
      tp_cold: { fl: 31.5, fr: 31.5, rl: 30, rr: 30 }, tp_hot: { fl: 35.5, fr: 35.5, rl: 34, rr: 34 },
      camber: { f: -2.5, r: -2.0 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 8, r: 8 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 14,
      parts: { tires: "ps4s", pads_f: "dtc60f" },
      notes: "Baseline: delivery alignment, stock bar settings.",
    },
  },
  {
    event: "2025-04-12", day: 2,
    data: {
      tp_cold: { fl: 31, fr: 31, rl: 29.5, rr: 29.5 }, tp_hot: { fl: 35, fr: 35, rl: 33.5, rr: 33.5 },
      camber: { f: -2.5, r: -2.0 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 8, r: 8 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 14,
      parts: { tires: "ps4s", pads_f: "dtc60f" },
      notes: "Dropped colds 0.5 psi — hots were over target all day 1.",
    },
  },
  {
    event: "2025-06-21", day: 1,
    data: {
      tp_cold: { fl: 31, fr: 31, rl: 29.5, rr: 29.5 }, tp_hot: { fl: 35, fr: 35, rl: 33.5, rr: 33.5 },
      camber: { f: -3.2, r: -2.0 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 10, r: 8 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 14,
      parts: { tires: "ps4s", pads_f: "dtc60f" },
      notes: "More front camber + 2 clicks front rebound — mid-corner push mostly gone.",
    },
  },
  {
    event: "2025-11-01", day: 1,
    data: {
      tp_cold: { fl: 32, fr: 32, rl: 30.5, rr: 30.5 }, tp_hot: { fl: 35.5, fr: 35.5, rl: 34, rr: 34 },
      camber: { f: -3.2, r: -2.0 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 10, r: 8 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 14,
      parts: { tires: "ps4s", pads_f: "dtc60f" },
      notes: "Cold morning — started colds a pound up.",
    },
  },
  {
    event: "2026-02-14", day: 1,
    data: {
      tp_cold: { fl: 30, fr: 30, rl: 28.5, rr: 28.5 }, tp_hot: { fl: 34, fr: 34, rl: 32.5, rr: 32.5 },
      camber: { f: -3.2, r: -2.0 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 10, r: 8 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 14,
      parts: { tires: "re71", pads_f: "dtc70f", pads_r: "dtc70r" },
      notes: "New RE-71RS + DTC-70s. RE-71 wants lower hot targets than the PS4S.",
    },
  },
  {
    event: "2026-04-18", day: 1,
    data: {
      tp_cold: { fl: 30, fr: 30, rl: 28.5, rr: 28.5 }, tp_hot: { fl: 34, fr: 34, rl: 32.5, rr: 32.5 },
      camber: { f: -3.4, r: -2.2 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 10, r: 8 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 12,
      parts: { tires: "re71", pads_f: "dtc70f", pads_r: "dtc70r" },
      notes: "A little more camber all around for the stickier tire.",
    },
  },
  {
    event: "2026-06-13", day: 1,
    data: {
      tp_cold: { fl: 29.5, fr: 29.5, rl: 28, rr: 28 }, tp_hot: { fl: 33.5, fr: 33.5, rl: 32, rr: 32 },
      camber: { f: -3.4, r: -2.2 }, toe: { f: -0.05, r: 0.1 },
      rebound: { f: 12, r: 9 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 12,
      parts: { tires: "re71", pads_f: "dtc70f", pads_r: "dtc70r" },
      notes: "Chasing entry stability into T1 — stiffer rebound both ends.",
    },
  },
  {
    event: "2026-06-13", day: 2,
    data: {
      tp_cold: { fl: 29.5, fr: 29.5, rl: 28, rr: 28 }, tp_hot: { fl: 33.5, fr: 33.5, rl: 32, rr: 32 },
      camber: { f: -3.4, r: -2.2 }, toe: { f: -0.08, r: 0.12 },
      rebound: { f: 12, r: 9 }, compression: { f: 6, r: 6 }, sway: { f: 2, r: 2 }, fuel: 12,
      parts: { tires: "re71", pads_f: "dtc70f", pads_r: "dtc70r" },
      notes: "Touch more front toe-out — turn-in sharper. PB pace all afternoon.",
    },
  },
];

// Optional: full lap-by-lap data for one event (from a lap timer).
export const RAW_EVENT_DATE = null;
export const RAW_SESSIONS = [];
