// Year-in-review computation over computed event rows — pure, unit-testable.
// Events are the /api/events shape: { track_id, track_name, track_config,
// start_date (yyyy-mm-dd), days, best_ms, lap_count, ... } in any order.

export const eventYear = (e) => Number(e.start_date.slice(0, 4));

// Distinct years that have events, newest first.
export function yearsAvailable(events) {
  return [...new Set(events.map(eventYear))].sort((a, b) => b - a);
}

// Summarize one year. Returns null when the year has no events.
export function yearReview(events, year) {
  const inYear = events.filter((e) => eventYear(e) === year);
  if (!inYear.length) return null;
  const before = events.filter((e) => eventYear(e) < year);

  const trackIds = new Set(inYear.map((e) => e.track_id));
  const priorTrackIds = new Set(before.map((e) => e.track_id));

  // Per-track: best this year vs best before — positive gain = seconds found.
  const gains = [];
  for (const id of trackIds) {
    const yearBests = inYear.filter((e) => e.track_id === id && e.best_ms != null).map((e) => e.best_ms);
    if (!yearBests.length) continue;
    const sample = inYear.find((e) => e.track_id === id);
    const priorBests = before.filter((e) => e.track_id === id && e.best_ms != null).map((e) => e.best_ms);
    const bestThisYear = Math.min(...yearBests);
    const bestBefore = priorBests.length ? Math.min(...priorBests) : null;
    gains.push({
      track_id: id,
      track_name: sample.track_name,
      track_config: sample.track_config ?? "",
      best_this_year: bestThisYear,
      best_before: bestBefore,
      // null when there's no prior baseline (first year at this track)
      gain_ms: bestBefore != null ? bestBefore - bestThisYear : null,
    });
  }
  gains.sort((a, b) => (b.gain_ms ?? -Infinity) - (a.gain_ms ?? -Infinity));

  return {
    year,
    events: inYear.length,
    days: inYear.reduce((s, e) => s + (e.days ?? 0), 0),
    laps: inYear.reduce((s, e) => s + (e.lap_count ?? 0), 0),
    tracks_visited: trackIds.size,
    new_tracks: [...trackIds]
      .filter((id) => !priorTrackIds.has(id))
      .map((id) => inYear.find((e) => e.track_id === id))
      .map((e) => ({ track_id: e.track_id, track_name: e.track_name, track_config: e.track_config ?? "" })),
    gains,
  };
}
