// The demo logbook the promo is filmed in: a fictional driver's two seasons.
// Everything here is invented — the driver, the rivals, the coach, the days —
// except the circuits, which are real catalog tracks so the leaderboard and
// the car catalog light up the way they do for a real account.
//
// COTA weekends carry simulated telemetry (sim.mjs); `skill` is the driver's
// level that weekend, 0..1, and rising skill is why the progress chart falls.
// Other tracks are typed-in days: most drivers' older events look like that.

export const DRIVER = { email: "jordan.reyes@example.com", name: "Jordan Reyes" };
export const SHARE_SLUG = "jordan-reyes";

export const COTA = "Circuit of the Americas";

// Days from today, for the one event that has to stay upcoming.
export const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export const Z06_NAME = "2023 Corvette Z06";
export const MX5_NAME = "2019 Mazda MX-5 Miata";

export const VEHICLES = [
  {
    name: Z06_NAME,
    catalog: ["Chevrolet", "Corvette", "C8"],
    default: true,
    target_hot_psi: 34,
    notes: "Z07 package — carbon aero, Cup 2 R. Track alignment, SRF, Motorsport Hub pads.",
    parts: [
      {
        kind: "pads_front", name: "Carbotech XP20", installed_on: "2026-02-10", cost: 520, wear_limit: 3,
        notes: "18 mm new",
        measurements: [["2026-02-10", 18, "mm"], ["2026-04-27", 13.4, "mm"], ["2026-09-14", 7.5, "mm"]],
      },
      {
        kind: "pads_rear", name: "Carbotech XP12", installed_on: "2026-02-10", cost: 410, wear_limit: 3,
        measurements: [["2026-02-10", 16, "mm"], ["2026-09-14", 11.2, "mm"]],
      },
      {
        kind: "tires_front", name: "Michelin Pilot Sport Cup 2 R", size: "275/30ZR20", installed_on: "2026-04-20",
        cost: 1180, expected_hours: 11,
      },
      {
        kind: "tires_rear", name: "Michelin Pilot Sport Cup 2 R", size: "345/25ZR21", installed_on: "2026-04-20",
        cost: 1560, expected_hours: 9,
      },
      { kind: "brake_fluid", name: "Castrol SRF", installed_on: "2026-02-10", cost: 96, expected_hours: 14 },
      { kind: "oil", name: "Mobil 1 0W-40", installed_on: "2026-08-30", cost: 145, expected_hours: 8 },
      { kind: "rotors_front", name: "OEM carbon-ceramic", installed_on: "2025-02-15", expected_hours: 120 },
      // The street set, on the shelf since the Cup 2 Rs went on.
      {
        kind: "tires", name: "Michelin Pilot Sport 4S", size: "275/30ZR20 · 345/25ZR21", installed_on: "2025-02-15",
        cost: 1840, equipped: false, notes: "Street / rain set on the spare wheels",
      },
      // Retired lifecycles — they teach the expected-life defaults.
      { kind: "pads_front", name: "Hawk DTC-70", installed_on: "2025-02-15", retired_on: "2026-02-10", cost: 470 },
      {
        kind: "tires_front", name: "Michelin Pilot Sport Cup 2 R", size: "275/30ZR20", installed_on: "2025-02-15",
        retired_on: "2026-04-20", cost: 1120, notes: "Corded at the Feb weekend",
      },
    ],
  },
  {
    name: MX5_NAME,
    catalog: ["Mazda", "MX-5 Miata", "ND"],
    notes: "The momentum car. Coilovers, RS-3s, hard top.",
    parts: [
      { kind: "tires", name: "Hankook Ventus RS4", size: "205/50R16", installed_on: "2025-06-01", cost: 640, expected_hours: 16 },
      { kind: "pads_front", name: "Hawk HP+", installed_on: "2025-06-01", cost: 150 },
    ],
  },
];

// COTA weekends with telemetry. Each day runs `sessions` sessions of `laps`
// timed laps; `ambientC` is what the recorder logged (the conditions wash).
export const COTA_WEEKENDS = [
  {
    start: "2025-03-08", days: 2, club: "NASA Texas", group: "HPDE 2", skill: 0.12, ambientC: 18,
    notes: "First weekend at COTA. The climb to T1 is a wall.", odometerKm: 6120,
    costs: { entry: 595, fuel: 210, travel: 180 },
  },
  {
    start: "2025-05-17", days: 2, club: "Hooked on Driving", group: "Intermediate", skill: 0.27, ambientC: 29,
    notes: null, odometerKm: 7340, costs: { entry: 650, fuel: 230, travel: 160 },
  },
  {
    start: "2025-10-11", days: 2, club: "NASA Texas", group: "HPDE 3", skill: 0.41, ambientC: 24,
    notes: "Season closer — finally committed through the esses.", odometerKm: 9855,
    costs: { entry: 595, fuel: 240, travel: 175, misc: 60 },
  },
  {
    start: "2026-02-21", days: 2, club: "NASA Texas", group: "HPDE 3", skill: 0.5, ambientC: 13,
    notes: "Cold and grippy. New XP20s bedded Friday.", odometerKm: 11210,
    costs: { entry: 625, fuel: 235, travel: 190 },
  },
  {
    start: "2026-04-25", days: 2, club: "Chin Motorsports", group: "Advanced", skill: 0.6, ambientC: 26,
    notes: "Fresh Cup 2 Rs. Trail-braking into 12 is starting to click.", odometerKm: 12690,
    costs: { entry: 690, fuel: 250, travel: 210 },
  },
  {
    start: "2026-09-12", days: 2, club: "NASA Texas", group: "HPDE 4", skill: 0.71, ambientC: 33,
    notes: "PB weekend. Braked later into 12 and carried more through 16–18.", odometerKm: 14410,
    costs: { entry: 625, fuel: 260, travel: 195, misc: 40 },
  },
];

// Typed-in days elsewhere: [date, days, club, group, track, car, sessionBests[], notes, costs?]
export const OTHER_EVENTS = [
  ["2025-06-21", 2, "Hooked on Driving", "Intermediate", "Barber Motorsports Park", Z06_NAME,
    ["1:43.910", "1:42.772", "1:41.905", "1:41.338"], "Barber flows. Museum on Sunday.", { entry: 575, fuel: 190, travel: 540 }],
  ["2025-07-26", 1, "SCCA", "Track Night", "Laguna Seca (WeatherTech Raceway)", MX5_NAME,
    ["1:53.880", "1:52.405", "1:51.620"], "Miata day. Corkscrew: blind, then gone.", { entry: 295, travel: 880 }],
  ["2025-08-16", 1, "Chin Motorsports", "Intermediate", "Road Atlanta", Z06_NAME,
    ["1:39.804", "1:38.990", "1:38.214"], "Hot. Traffic all day.", { entry: 450, fuel: 160, travel: 420 }],
  ["2026-06-27", 2, "NASA Northeast", "HPDE 3", "Watkins Glen International", Z06_NAME,
    ["2:07.914", "2:06.402", "2:05.388"], "The boot is worth the drive.", { entry: 610, fuel: 230, travel: 760 }],
  ["2026-07-25", 2, "Chin Motorsports", "Advanced", "Road America", Z06_NAME,
    ["2:35.620", "2:33.117", "2:31.702"], "Four miles of full throttle.", { entry: 640, fuel: 280, travel: 690 }],
];

// The next weekend — the dashboard hero's countdown.
export const NEXT_EVENT = { daysAway: 24, days: 2, club: "NASA Texas", group: "HPDE 4" };

// Setup sheets on the COTA weekends (psi, degrees, clicks). `start` matches
// a weekend above.
export const SETUPS = [
  { start: "2025-03-08", day: 1, data: {
    tp_cold: { fl: 30, fr: 30, rl: 29, rr: 29 }, tp_hot: { fl: 35.5, fr: 36, rl: 34.5, rr: 35 },
    camber: { f: -2.2, r: -1.8 }, toe: { f: 0, r: 0.1 }, rebound: { f: 6, r: 6 }, compression: { f: 5, r: 5 },
    fuel: 16, notes: "Delivery alignment. Baseline." } },
  { start: "2025-05-17", day: 1, data: {
    tp_cold: { fl: 29.5, fr: 29.5, rl: 28.5, rr: 28.5 }, tp_hot: { fl: 35, fr: 35.5, rl: 34, rr: 34.5 },
    camber: { f: -2.8, r: -2.0 }, toe: { f: -0.05, r: 0.1 }, rebound: { f: 8, r: 6 }, compression: { f: 5, r: 5 },
    fuel: 16, notes: "Track alignment. Mid-corner push mostly gone." } },
  { start: "2025-10-11", day: 1, data: {
    tp_cold: { fl: 29.5, fr: 29.5, rl: 28.5, rr: 28.5 }, tp_hot: { fl: 34.5, fr: 35, rl: 33.5, rr: 34 },
    camber: { f: -3.2, r: -2.2 }, toe: { f: -0.05, r: 0.1 }, rebound: { f: 9, r: 7 }, compression: { f: 6, r: 5 },
    fuel: 15, notes: "More front camber for the esses." } },
  { start: "2026-02-21", day: 1, data: {
    tp_cold: { fl: 31, fr: 31, rl: 30, rr: 30 }, tp_hot: { fl: 34, fr: 34.5, rl: 33, rr: 33.5 },
    camber: { f: -3.2, r: -2.2 }, toe: { f: -0.05, r: 0.1 }, rebound: { f: 9, r: 7 }, compression: { f: 6, r: 5 },
    fuel: 15, notes: "Cold morning — started colds a pound up." } },
  { start: "2026-04-25", day: 1, data: {
    tp_cold: { fl: 29, fr: 29, rl: 28, rr: 28 }, tp_hot: { fl: 34, fr: 34.5, rl: 33, rr: 33.5 },
    camber: { f: -3.4, r: -2.4 }, toe: { f: -0.08, r: 0.12 }, rebound: { f: 10, r: 8 }, compression: { f: 6, r: 6 },
    fuel: 14, notes: "New Cup 2 Rs want lower hots than the old set." } },
  { start: "2026-09-12", day: 1, data: {
    tp_cold: { fl: 28.5, fr: 28.5, rl: 27.5, rr: 27.5 }, tp_hot: { fl: 33.5, fr: 34.5, rl: 32.5, rr: 33.5 },
    camber: { f: -3.4, r: -2.4 }, toe: { f: -0.08, r: 0.12 }, rebound: { f: 12, r: 9 }, compression: { f: 6, r: 6 },
    fuel: 14, notes: "Stiffer rebound for entry stability into 12." } },
  { start: "2026-09-12", day: 2, data: {
    tp_cold: { fl: 28.5, fr: 28, rl: 27.5, rr: 27 }, tp_hot: { fl: 33.5, fr: 34, rl: 32.5, rr: 33 },
    camber: { f: -3.4, r: -2.4 }, toe: { f: -0.08, r: 0.12 }, rebound: { f: 12, r: 9 }, compression: { f: 6, r: 6 },
    fuel: 14, notes: "Half a pound out of the right side. PB pace all afternoon." } },
];

// Opted-in rivals on the COTA leaderboard: [name, skill, date]. Invented
// people; each runs one session with telemetry, which is what ranks.
export const RIVALS = [
  ["Maya Chen", 0.93, "2026-08-22"],
  ["Dan Whitfield", 0.84, "2026-05-30"],
  ["Priya Natarajan", 0.78, "2026-09-12"],
  ["Marcus Bell", 0.66, "2026-04-25"],
  ["Sofia Alvarez", 0.58, "2026-06-13"],
  ["Tom Okafor", 0.5, "2026-03-28"],
  ["Hannah Lindqvist", 0.42, "2026-07-11"],
  ["Ben Carter", 0.33, "2026-02-21"],
  ["Leo Martins", 0.22, "2026-01-17"],
];

export const COACH = { name: "Chris Walker", email: "chris.walker@example.com" };

export const PROFILE = {
  occupation: "Structural engineer",
  first_track_year: 2023,
  experience: "Three seasons of HPDE, mostly at COTA. Solo in NASA HPDE 4 since September.",
  license: "NASA HPDE 4",
  instruction: "Coached at every NASA weekend so far; one day with a pro coach at COTA in April.",
  helmet: "Stilo ST5",
  helmet_rating: "SA2020",
  head_neck: "hans",
  suit: "Single-layer",
  gloves: true,
  shoes: true,
  goals: "Break 2:17 at COTA. Brake later and trail deeper into 12; more speed through 16–18.",
  for_instructor: "I tend to over-slow the entry to T1 and T11.",
};
