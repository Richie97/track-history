// Successful, JSON-serialized tool results. Keep these beside tools.ts and
// insights.ts: nullable means unavailable, optional means omitted from JSON.
// No validator ships with the Worker; API tests validate actual results with
// a JSON Schema implementation, including empty and partial-telemetry cases.
type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
export type ResultSchema = {
  type?: SchemaType;
  description?: string;
  properties?: Record<string, ResultSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ResultSchema;
  anyOf?: ResultSchema[];
  enum?: (string | null)[];
  const?: boolean;
};
export type OutputSchema = ResultSchema & { type: "object" };

const string: ResultSchema = { type: "string" };
const number: ResultSchema = { type: "number" };
const integer: ResultSchema = { type: "integer" };
const boolean: ResultSchema = { type: "boolean" };
const nullable = (schema: ResultSchema): ResultSchema => ({ anyOf: [schema, { type: "null" }] });
const array = (items: ResultSchema): ResultSchema => ({ type: "array", items });
const object = (properties: Record<string, ResultSchema>, optional: string[] = []): OutputSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const partial = (properties: Record<string, ResultSchema>) => object(properties, Object.keys(properties));
const described = (schema: ResultSchema, description: string): ResultSchema => ({ ...schema, description });
const textOrNull = nullable(string);
const numberOrNull = nullable(number);
const integerOrNull = nullable(integer);
const date = described(string, "Calendar date, YYYY-MM-DD.");
const ms = described(integer, "Lap time in integer milliseconds; lower is faster.");
const msOrNull = nullable(ms);
const formattedTime = described(textOrNull, "Display lap time formatted by the app, e.g. 1:43.5; null when no time is known.");
const cents = described(integer, "Whole cents.");
const centsOrNull = described(nullable(cents), "Whole cents; null means no cost was entered, not zero cost.");
const status = { enum: ["ok", "low", "due", null] } satisfies ResultSchema;
const trackIdentity = { track_id: integer, track_name: string };

const eventProperties = {
  event_id: integer, ...trackIdentity, start_date: date, days: number,
  car: textOrNull, vehicle_id: integerOrNull, club: textOrNull, run_group: textOrNull,
  conditions: textOrNull, temp_f: numberOrNull, ambient_lo_c: numberOrNull, ambient_hi_c: numberOrNull,
  best_ms: msOrNull, best: formattedTime, lap_count: integer, session_count: integer,
  consistency_cv_pct: described(numberOrNull, "Coefficient of variation of lap times as a percentage; unavailable below three laps."),
  on_track_hours: described(number, "On-track hours, entered or estimated."), cost_cents: centsOrNull,
};
const eventRow = object({ ...eventProperties, notes: textOrNull }, ["notes"]);
const lap = object({ lap_id: integer, lap_num: integer, time_ms: ms, time: formattedTime, has_telemetry: boolean });
const lapStats = nullable(object({
  lap_count: integer, best_ms: ms, best: formattedTime, best_lap_num: integer,
  best3_avg_ms: msOrNull, clean_lap_count: integer, clean_avg_ms: msOrNull,
  pace_slope_ms_per_lap: described(numberOrNull, "Lap-time trend in ms per lap; negative means getting faster."),
  warmup_laps: integerOrNull,
}));
const corners = partial({ fl: number, fr: number, rl: number, rr: number });
const axles = partial({ f: number, r: number });
const setup = partial({
  tp_cold: described(corners, "Cold tire pressures in psi."), tp_hot: described(corners, "Hot tire pressures in psi."),
  camber: described(axles, "Camber in degrees."), toe: described(axles, "Toe in the driver's recorded units (degrees or inches)."),
  caster: described(axles, "Caster in degrees."), rebound: axles, compression: axles, sway: axles,
  fuel: described(number, "Fuel at session start in US gallons."),
  tires_id: integer, tires_f_id: integer, tires_r_id: integer, pads_f_id: integer, pads_r_id: integer, notes: string,
});

const sectors = nullable(object({
  sector_count: integer, note: string,
  laps: array(object({ lap_num: integerOrNull, sectors_ms: array(number) })),
  best_sectors_ms: array(number), best_sector_lap_nums: array(integerOrNull),
  theoretical_best_ms: number, theoretical_best: formattedTime,
  best_lap_ms: ms, gap_to_theoretical_ms: number,
}));
const shifts = nullable(object({
  upshift_rpm_by_gear: array(object({ from_gear: integer, count: integer, min_rpm: number, median_rpm: number, max_rpm: number })),
  median_upshift_rpm: numberOrNull, max_rpm_seen: numberOrNull, notes: array(string),
}));
const limits = nullable(object({
  summary: textOrNull, kinds: array(object({ kind: string, places_on_track: integer, laps: integer })),
}));
const grip = nullable(object({
  note: string, peak_combined_g: numberOrNull, max_combined_g: numberOrNull,
  trail_brake_pct: numberOrNull, power_down_pct: numberOrNull,
  laps: array(object({ lap_num: integerOrNull, trail_brake_pct: numberOrNull, power_down_pct: numberOrNull })),
}));
const balance = nullable(object({
  summary: textOrNull, note: string,
  corners: array(object({ corner: string, pct: numberOrNull, reading: string })),
}));
const hotPressure = object({
  peakKpa: number, peakChIdx: described(integer, "Zero-based telemetry lap index, not the displayed lap number."), lastKpa: number,
});
const health = nullable(object({
  summary: textOrNull,
  columns: array(object({
    key: string, label: string, unit: string, rule: { enum: ["peak", "minimum", "at lap end"] },
    session_value: numberOrNull, status,
  })),
  fuel: nullable(object({ perLapPct: number, lastPct: number, lapsRemaining: integer, drops: integer })),
  hot_pressures_kpa: nullable(partial({ LF: hotPressure, RF: hotPressure, LR: hotPressure, RR: hotPressure })),
}));
const telemetry = nullable(object({
  grid_step_m: number, channels: array(string), laps_with_telemetry: integer,
  sectors, shifts, limits, grip,
  corners: nullable(array(object({ corner: string, start_m: number, end_m: number, peak_lat_g: numberOrNull }))),
  corner_note: string, balance, health,
}, ["corner_note"]));

const comparisonSide = object({
  label: string, lap_id: integer, lap_num: integer, time_ms: ms, time: formattedTime,
  sectors_ms: nullable(array(number)),
  top_speed_kph: numberOrNull, min_speed_kph: numberOrNull, avg_speed_kph: numberOrNull,
  max_rpm: numberOrNull, max_lat_g: numberOrNull, full_throttle_pct: numberOrNull, braking_pct: numberOrNull,
  event_id: integer, track_name: string, start_date: date,
});
const delta = described(integer, "B minus A in milliseconds; positive means B lost time to A.");
const channelSamples = (unit: string) => described(array(numberOrNull), `${unit}; aligned with distance_m. A null sample is unavailable.`);
const channels = partial({
  speed: channelSamples("km/h"), rpm: channelSamples("RPM"), latG: channelSamples("Lateral G magnitude"),
  throttle: channelSamples("Percent"), brake: channelSamples("Percent"), steering: channelSamples("Degrees"),
  longG: channelSamples("Longitudinal G; negative under braking"), yaw: channelSamples("Degrees per second"),
  gear: channelSamples("Gear number"), wheelSlip: channelSamples("Percent"), boost: channelSamples("kPa"),
  flags: channelSamples("Bit flags: ABS=1, traction control=2, stability control=4"), elapsed_s: channelSamples("Seconds, derived from speed"),
});
const garagePart = object({
  part_id: integer, kind: string, name: string, size: textOrNull, equipped: boolean,
  installed_on: date, retired_on: nullable(date), cost_cents: centsOrNull,
  expected_hours: numberOrNull, wear_limit: numberOrNull, notes: textOrNull,
  hours: numberOrNull, heat_cycles: numberOrNull, remaining_hours: numberOrNull,
  remaining: textOrNull, status,
  measurements: array(object({ on: date, value: number, unit: string })),
});

export const OUTPUT_SCHEMAS = {
  get_profile: object({
    name: textOrNull, units: { enum: ["imperial", "metric"] },
    totals: object({ events: integer, track_days: number }), leaderboard_opt_in: boolean, today: date,
  }),
  list_tracks: object({ tracks: array(object({
    track_id: integer, name: string, best_ms: msOrNull, best: formattedTime, goal_ms: msOrNull, goal: formattedTime,
    event_count: integer, track_days: number, last_date: nullable(date), notes: textOrNull, has_leaderboard: boolean,
  })) }),
  list_events: object({ total: integer, truncated: boolean, events: array(eventRow) }),
  get_event: object({
    ...eventProperties, notes: textOrNull,
    checklist: nullable(array(object({ text: string, done: boolean }))),
    costs_cents: object({ entry: centsOrNull, fuel: centsOrNull, travel: centsOrNull, misc: centsOrNull, total: centsOrNull }),
    setups: array(object({ day: integer, data: setup })), setup_units: string,
    sessions: array(object({
      session_id: integer, label: textOrNull, notes: textOrNull, ambient_c: numberOrNull, elevation_m: numberOrNull,
      telemetry_channels: array(string), lap_stats: lapStats, laps: array(lap),
    })),
  }),
  get_session_insights: object({
    event: object({ event_id: integer, track_name: string, start_date: date, car: textOrNull }),
    session_id: integer, label: textOrNull, notes: textOrNull,
    conditions: object({ ambient_c: numberOrNull, elevation_m: numberOrNull }),
    laps: array(lap), lap_stats: lapStats, telemetry,
  }),
  compare_laps: object({
    delta_convention: string, a: comparisonSide, b: comparisonSide, b_minus_a_ms: delta,
    by_corner: nullable(array(object({
      corner: string, start_m: number, end_m: number,
      a_min_speed_kph: numberOrNull, b_min_speed_kph: numberOrNull, b_minus_a_ms: delta,
    }))),
    by_tenth_of_lap: nullable(array(object({ start_m: number, end_m: number, b_minus_a_ms: delta }))),
    length_mismatch_pct: numberOrNull, warning: string, track_warning: string,
  }, ["warning", "track_warning"]),
  get_lap_telemetry: object({
    lap_id: integer, lap_num: integer, time_ms: ms, time: formattedTime,
    step_m: described(number, "Actual sample spacing in metres, rounded to a stored-grid multiple; may widen to bound the result."),
    step_note: string, distance_m: array(number), channels, missing: array(string),
  }, ["step_note"]),
  get_track_history: object({
    track: object({ track_id: integer, name: string, best_ms: msOrNull, best: formattedTime, goal_ms: msOrNull, notes: textOrNull }),
    visits: array(eventRow),
    fastest_laps: array(object({
      lap_id: integer, time_ms: ms, time: formattedTime, lap_num: integer,
      session_id: integer, session_label: textOrNull, event_id: integer, start_date: date, has_telemetry: boolean,
    })),
  }),
  get_setup_vs_lap_times: object({ setups: array(object({
    event_id: integer, day: integer, start_date: date, car: textOrNull, conditions: textOrNull,
    temp_f: numberOrNull, best_ms: msOrNull, consistency: described(numberOrNull, "Coefficient of variation as a fraction, not percent."),
    data: setup, best: formattedTime,
  })) }),
  get_garage: object({ vehicles: array(object({
    vehicle_id: integer, name: string, notes: textOrNull, is_default: boolean,
    on_track_hours: number, event_count: integer, track_days: number,
    event_cost_cents: cents, parts_cost_cents: cents, odometer_km: numberOrNull,
    target_hot_psi: numberOrNull, wheelbase_mm: numberOrNull, steering_ratio: numberOrNull, parts: array(garagePart),
  })) }),
  get_leaderboard: {
    ...object({
      available: boolean, note: string, you_opted_in: boolean,
      entries: array(object({ rank: integer, name: textOrNull, best_ms: ms, best: formattedTime, date, you: boolean })),
    }, ["note", "you_opted_in", "entries"]),
    anyOf: [
      { properties: { available: { const: false } }, required: ["note"] },
      { properties: { available: { const: true } }, required: ["you_opted_in", "entries"] },
    ],
  },
  get_season_summary: object({
    year: integer, years: array(integer), through: nullable(date), name: textOrNull,
    totals: object({ events: integer, track_days: number, tracks: integer, laps: integer, hours: number,
      miles: described(number, "Estimated track miles from logged lap counts and known or inferred track lengths."), miles_tracks_counted: integer }),
    most_driven: nullable(object({ ...trackIdentity, track_days: number, laps: integer, best_ms: msOrNull })),
    improvement: nullable(object({ ...trackIdentity, best_before: ms, best_this_year: ms, gain_ms: integer,
      baseline: { enum: ["prior_years", "first_event"] } })),
    fastest: nullable(object({ ...trackIdentity, best_ms: ms, event_id: integer, date })),
    new_tracks: array(object(trackIdentity)),
    hottest: nullable(object({ event_id: integer, track_name: string, date, temp_c: number })),
    pro: nullable(object({
      tire: nullable(object({ part_id: integer, vehicle_id: integer, vehicle_name: string, name: string, track_days: number, hours: number })),
      top_speed: nullable(object({ kph: number, ...trackIdentity, event_id: integer, date })),
    })),
  }),
} satisfies Record<string, OutputSchema>;
