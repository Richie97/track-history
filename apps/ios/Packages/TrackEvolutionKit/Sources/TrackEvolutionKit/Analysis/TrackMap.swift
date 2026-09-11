import Foundation

/// The stored racing line, as a place you can point at.
///
/// The port of `public/js/trackmap.js`'s pure half, under the same name. The
/// drawing is per platform — `TrackMapView` on iOS, `TrackMap` on Android — and
/// this is the one piece of it that is a *fact* rather than a rendering: given a
/// fraction of the way round a lap, which stored trace point is that?
///
/// It exists because of the friction circle and the balance scatter. Both hand
/// over a sample as a fraction of the lap, and the answer to "which corner is
/// this dot" is a point on the map (NS-34 ticket 3).
///
/// Not to be confused with `TraceMap` on Android, which is the *line picker's*
/// geometry — fit, hit-test and the y-flip. This is the racing line's own
/// arc-length, and nothing else.
public enum TrackMap {

    /// The index of the trace point `frac` of the way round the lap, by
    /// **cumulative chord length**.
    ///
    /// Walking the *index* instead would be wrong by whole corners on any real
    /// lap: a trace is denser where the car was slower, so a quarter of the
    /// samples is nowhere near a quarter of the distance. `contracts/logic/trackmap.json`
    /// pins exactly that difference.
    ///
    /// `frac` is clamped to 0…1. Nil — rather than 0 — when there is nothing to
    /// point at: fewer than two points, or a trace that never moved. A caller
    /// that got 0 for a stationary trace would ring the start line and imply the
    /// dot belonged there.
    public static func traceIndexAtFraction(_ points: [TracePoint], _ frac: Double) -> Int? {
        guard points.count >= 2 else { return nil }
        var cum = [Double](repeating: 0, count: points.count)
        for i in 1..<points.count {
            cum[i] = cum[i - 1] + hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        }
        let total = cum[points.count - 1]
        guard total > 0 else { return nil }
        let target = max(0, min(1, frac)) * total
        var idx = 0
        while idx < points.count - 1 && cum[idx] < target { idx += 1 }
        return idx
    }
}
