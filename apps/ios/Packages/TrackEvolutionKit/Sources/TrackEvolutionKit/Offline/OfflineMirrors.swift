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
/// | `recomputeDetail` | `recomputeDetail` in `offline.js` | `withComputed` in `src/lib/stats.ts` (+ `eventHours` in `src/lib/wear.ts`) |
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
    /// - `consistency` is the coefficient of variation, and **nil below 3 laps** —
    ///   not zero. Two laps say nothing about consistency.
    /// - `hours` is the manual override when set, else `max(days × 2h, logged lap
    ///   time)`, rounded to 1dp. It is never nil.
    public static func recomputeDetail(_ detail: inout EventDetail) {
        let laps = detail.sessions.flatMap { $0.laps.map(\.timeMs) }

        detail.event.lapCount = laps.count
        detail.event.sessionCount = detail.sessions.count
        detail.event.lapBestMs = laps.min()
        detail.event.bestMs = [detail.event.bestTimeMs, detail.event.lapBestMs].compactMap { $0 }.min()

        if laps.count >= 3 {
            let n = Double(laps.count)
            let mean = laps.reduce(0.0) { $0 + Double($1) } / n
            let meanOfSquares = laps.reduce(0.0) { $0 + Double($1) * Double($1) } / n
            let variance = max(0, meanOfSquares - mean * mean)
            detail.event.consistency = variance.squareRoot() / mean
        } else {
            detail.event.consistency = nil
        }

        // `eventHours`: the override wins; otherwise the greater of the 2h-per-day
        // estimate and the time actually spent on track.
        let lapHours = laps.reduce(0.0) { $0 + Double($1) } / 3_600_000
        let hours: Double
        if let override = detail.event.trackHours, override > 0 {
            hours = override
        } else {
            hours = max(detail.event.days * 2, lapHours)
        }
        detail.event.hours = JSMath.round(hours, 10)
    }

    /// The list-shaped row for an event, which is its detail minus the nested
    /// sessions and setups — what `/events` returns.
    public static func listRow(from detail: EventDetail) -> Event {
        detail.event
    }
}
