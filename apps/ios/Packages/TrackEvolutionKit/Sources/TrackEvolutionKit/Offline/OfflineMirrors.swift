import Foundation

/// Server behaviors reimplemented client-side, so an offline read looks like a
/// server read.
///
/// **This file is a mirror, and mirrors rot.** Each function below duplicates
/// logic that already exists twice — once on the server, once in
/// `public/js/offline.js`. That makes three copies of two behaviors, which is the
/// highest-risk debt in the native programme. They live together here, named after
/// their JS counterparts, with the server source called out, so that when one
/// changes there is one obvious place to change the others:
///
/// | here | web mirror | server truth |
/// |---|---|---|
/// | `cleanLaps` | `cleanLaps` in `offline.js` | `sanitizeLaps` in `src/lib/validate.ts` |
/// | `recomputeDetail` | `recomputeDetail` in `offline.js` | `withComputed` in `src/lib/stats.ts` (+ `eventHours` in `src/lib/wear.ts`, `eventCostCents` in `src/lib/costs.ts`) |
/// | consistency, via `LapStats.eventConsistency` | `eventConsistency` in `lap-stats.js` | the `clean_*` aggregates in `src/db.ts` + `withComputed` |
///
/// `cleanLaps` here is **not** `LapStats.cleanLaps`: this one validates lap
/// times on the way in, that one is the 107% filter consistency uses (NS-42).
///
/// If you find a divergence from the server, fix the server-matching behavior and
/// say so — the web app probably has the same bug.
public enum OfflineMirrors {
    /// Lap times as the server would store them: rounded to whole milliseconds,
    /// non-finite and non-positive dropped.
    ///
    /// Mirror of `sanitizeLaps`. `JSMath.round` rather than Swift's `rounded()`
    /// because the web mirror rounds the JavaScript way and the two must agree on
    /// the same input.
    public static func cleanLaps(_ laps: [Double]) -> [Int] {
        laps.compactMap { value in
            guard value.isFinite else { return nil }
            let rounded = JSMath.round(value, 1)
            guard rounded.isFinite, rounded > 0, let int = JSMath.roundToInt(rounded) else { return nil }
            return int
        }
    }

    /// Recompute an event's aggregates and derived stats from its sessions, the way
    /// the server does when it answers.
    ///
    /// Mirror of `withComputed`. The rules that matter, and that a naive
    /// implementation gets wrong:
    ///
    /// - `bestMs` is `MIN(manual best, best logged lap)`, and nil when there is
    ///   neither.
    /// - `consistency` is the coefficient of variation of the **clean** laps —
    ///   within 107% of their own session's best (NS-42) — and **nil below 3 of
    ///   them**, not zero. `lapCount` and `hours` still count every lap.
    /// - `hours` is the manual override when set, else (3+ laps) the logged lap time, else `days × 1h15m` —
    ///   time)`, rounded to 1dp. It is never nil.
    /// - `costCents` is the sum of the entered cost line items, and **nil when
    ///   none was entered** — not zero, so an uncosted day never reads as a free
    ///   one (#147).
    public static func recomputeDetail(_ detail: inout EventDetail) {
        let laps = detail.sessions.flatMap { $0.laps.map(\.timeMs) }

        detail.event.lapCount = laps.count
        detail.event.sessionCount = detail.sessions.count
        detail.event.lapBestMs = laps.min()
        detail.event.bestMs = [detail.event.bestTimeMs, detail.event.lapBestMs].compactMap { $0 }.min()

        detail.event.consistency = LapStats.eventConsistency(detail.sessions.map { $0.laps.map(\.timeMs) })

        // `eventHours`: the override wins; otherwise 3+ logged laps are the time
        // actually spent on track, and anything sparser is the 1h15m-per-day estimate.
        let lapHours = laps.reduce(0.0) { $0 + Double($1) } / 3_600_000
        let hours: Double
        if let override = detail.event.trackHours, override > 0 {
            hours = override
        } else if laps.count >= 3 {
            hours = lapHours
        } else {
            hours = detail.event.days * Garage.HOURS_PER_DAY
        }
        detail.event.hours = JSMath.round(hours, 10)

        // `eventCostCents`: the entered line items summed, nil when there are none.
        detail.event.costCents = Costs.eventCostCents(
            detail.event.costEntryCents, detail.event.costFuelCents,
            detail.event.costTravelCents, detail.event.costMiscCents
        )
    }

    /// The list-shaped row for an event, which is its detail minus the nested
    /// sessions and setups — what `/events` returns.
    public static func listRow(from detail: EventDetail) -> Event {
        detail.event
    }
}
