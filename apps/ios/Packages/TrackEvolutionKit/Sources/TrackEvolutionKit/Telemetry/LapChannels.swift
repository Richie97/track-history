import Foundation

/// Per-lap channel data for imported telemetry sessions: each lap's speed (and,
/// for PDR, RPM, lateral G, throttle, brake and steering angle) resampled onto a
/// uniform driven-distance grid, so laps overlay corner-for-corner in the
/// channel graphs regardless of lap time.
///
/// A port of `public/js/import/channels.js` — same function names, same
/// constants — with its test cases (`test/unit/channels.test.js` →
/// `LapChannelsTests`). Built at import time because telemetry files never leave
/// the device, so anything to graph later has to be derived here and stored with
/// the session.
///
/// The stored shape is `SessionChannels`, validated server-side by
/// `sanitizeChannels` in `src/lib/validate.ts` — keep the two in sync. NS-23
/// already draws this; without it a clip imported on the phone would yield a
/// visibly poorer session than the same clip imported at a desk.
public enum TelemetryChannels {
    /// Grid spacing: ~100–600 points for real laps.
    public static let D_STEP_M: Double = 20
    /// Guards degenerate "laps" (also capped server-side).
    public static let MAX_LAP_POINTS = 700
    /// Mirror `sanitizeChannels`' budget (`src/lib/validate.ts`): rather than have
    /// the server reject a whole session over its optional graph data, an
    /// outsized session (marathon enduro) simply stores no channels.
    public static let MAX_LAPS = 80
    public static let MAX_TOTAL_VALUES = 120000

    /// Every gridded channel a lap entry can carry, with its rounding factor
    /// (decimal places worth keeping in the stored JSON). `CHANNEL_NAMES` in
    /// the JS.
    ///
    /// Order is load-bearing twice over. It is the stored/render order, so the
    /// six original channels keep their positions and an existing session's
    /// graphs are unchanged. And it is *priority* order: when a session
    /// overruns `MAX_TOTAL_VALUES` the tail is dropped until it fits, so a
    /// driver loses boost before losing speed. Anything new is appended.
    public static let CHANNEL_NAMES: [(String, Double)] = [
        ("speed", 10),
        ("rpm", 1),
        ("latG", 1000),
        ("throttle", 10),
        ("brake", 10),
        ("steering", 10),
        ("longG", 1000),
        ("yaw", 10),
        ("gear", 1),
        ("wheelSlip", 10),
        ("boost", 10),
        ("flags", 1),
    ]

    /// Two of those are states, not measurements, and the default sampler —
    /// the interpolated value at the grid point — is wrong for both.
    /// `flags` is a bitfield at ~45 Hz whose events are narrower than the 20 m
    /// spacing, so it is sampled as the OR of everything in the window (which
    /// is `max` for independent bits). `gear` is an enum at ~6.6 Hz;
    /// interpolating 3 and 4 yields 3.5, a gear no car has, so the last value
    /// at or before the point is held.
    public static let WINDOW_MAX = ["flags"]
    public static let STEP_HOLD = ["gear"]

    /// How a slow channel is reduced to one number per lap.
    public enum Reduce: Sendable {
        /// Largest value inside the lap's own window.
        case max
        /// Smallest value inside the lap's own window.
        case min
        /// The value as the lap finished — what you want for a tyre pressure
        /// or a fuel level, and not what you want for an oil temperature.
        case end
    }

    /// Slow channels (0.5-1.4 Hz) reduced to one value per lap, with how to
    /// reduce them and the rounding factor. `SCALAR_NAMES` in the JS.
    public static let SCALAR_NAMES: [(String, Reduce, Double)] = [
        ("oilC", .max, 10),
        ("oilKpa", .min, 1),
        ("coolantC", .max, 10),
        ("transC", .max, 10),
        ("fuelPct", .end, 10),
        ("battV", .min, 10),
        ("tyreKpaLF", .end, 1),
        ("tyreKpaRF", .end, 1),
        ("tyreKpaLR", .end, 1),
        ("tyreKpaRR", .end, 1),
        ("tyreCLF", .max, 10),
        ("tyreCRF", .max, 10),
        ("tyreCLR", .max, 10),
        ("tyreCRR", .max, 10),
    ]

    /// Session-level numbers, carried through to the stored blob's `meta`.
    public static let META_NAMES: [(String, Double)] = [
        ("ambientC", 10),
        ("intakeC", 10),
        ("elevationM", 1),
        ("odometerKm", 1),
    ]

    /// Index of the last sample at or before `t`, or -1. `arr` is sorted by t.
    static func holdIndex(_ arr: [ChannelPoint], _ t: Double) -> Int {
        var lo = 0
        var hi = arr.count - 1
        var best = -1
        while lo <= hi {
            let m = (lo + hi) >> 1
            if arr[m].t <= t {
                best = m
                lo = m + 1
            } else {
                hi = m - 1
            }
        }
        return best
    }

    /// Last value at or before `t` (the first sample's value before the series
    /// starts) — the sampler for enum channels.
    static func holdAt(_ arr: [ChannelPoint], _ t: Double) -> Double {
        let i = holdIndex(arr, t)
        return arr[i < 0 ? 0 : i].v
    }

    /// Largest value in [t0, t1], falling back to the held value when the
    /// window contains no sample — the sampler for flag channels.
    static func maxIn(_ arr: [ChannelPoint], _ t0: Double, _ t1: Double) -> Double {
        var m = -Double.infinity
        var i = Swift.max(0, holdIndex(arr, t0))
        while i < arr.count, arr[i].t <= t1 {
            if arr[i].t >= t0, arr[i].v > m { m = arr[i].v }
            i += 1
        }
        return m == -Double.infinity ? holdAt(arr, t1) : m
    }

    /// Where a lap's channel arrays are cut from: cumulative distance, plus
    /// whichever value channels the source recorded.
    public struct ChannelData: Sendable {
        /// `[{t, v: metres}]` cumulative.
        public var dist: [ChannelPoint]
        /// Speed km/h, latG/longG in G, throttle/brake/wheelSlip in %,
        /// steering/yaw in degrees, boost in kPa, gear 0-8, flags a bitfield.
        public var series: ParsedTelemetry.CarChannels
        /// The slow series, keyed by `SCALAR_NAMES`.
        public var scalars: [String: [ChannelPoint]]
        /// Session-level numbers, stored as the blob's `meta`.
        public var meta: ParsedTelemetry.SessionMeta?

        public init(
            dist: [ChannelPoint], series: ParsedTelemetry.CarChannels,
            scalars: [String: [ChannelPoint]] = [:], meta: ParsedTelemetry.SessionMeta? = nil
        ) {
            self.dist = dist
            self.series = series
            self.scalars = scalars
            self.meta = meta
        }
    }

    /// Cumulative driven distance from a projected trace (`Geo.projectTrace`).
    public static func distFromTrace(_ projected: [Geo.Projected]) -> [ChannelPoint] {
        var out: [ChannelPoint] = []
        out.reserveCapacity(projected.count)
        var d = 0.0
        for i in 0..<projected.count {
            if i > 0 {
                d += hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y)
            }
            out.append(ChannelPoint(t: projected[i].t, v: d))
        }
        return out
    }

    /// Channel sources for a GPS-only import (GoPro, a beacon-less PDR via the
    /// line picker, a phone recording): distance integrated from the projected
    /// trace, speed from the source's own fixes (m/s) when present.
    public static func traceChannelData(_ gps: [Geo.Point], _ projected: [Geo.Projected]) -> ChannelData {
        let withV = gps.filter { $0.v?.isFinite == true }
        return ChannelData(
            dist: distFromTrace(projected),
            series: ParsedTelemetry.CarChannels(
                speed: Double(withV.count) >= Double(gps.count) * 0.8
                    ? withV.map { ChannelPoint(t: $0.t, v: ($0.v ?? 0) * 3.6) }
                    : nil
            )
        )
    }

    /// Channel sources for any parsed import: PDR uses its odometer + car
    /// channels (works with or without GPS, falling back to GPS distance when a
    /// file lacks the odometer); everything else needs a GPS trace.
    public static func channelDataFor(_ parsed: ParsedTelemetry) -> ChannelData? {
        func fromTrace() -> ChannelData? {
            guard let gps = parsed.gps, gps.count >= 10 else { return nil }
            return traceChannelData(gps, Geo.projectTrace(gps))
        }
        if parsed.kind != .pdr { return fromTrace() }
        let car = parsed.carChannels
        let scalars = parsed.lapScalarChannels.filter { !$0.value.isEmpty }
        let meta = parsed.sessionMeta
        if let odo = parsed.channels?.odoPts, odo.count >= 10 {
            return ChannelData(dist: odo, series: car, scalars: scalars, meta: meta)
        }
        guard let base = fromTrace() else { return nil }
        // `{...base.series, ...car}`: a present car channel wins, an absent one
        // leaves the trace-derived value in place.
        var merged = base.series
        for (name, _) in CHANNEL_NAMES where car[name] != nil { merged[name] = car[name] }
        return ChannelData(dist: base.dist, series: merged, scalars: scalars, meta: meta)
    }

    /// Compute and attach `lapChannels` to a parsed import. Called after parsing
    /// and again whenever laps change (line pick, batch anchoring). Laps without
    /// `startT`/`endT` windows contribute nothing.
    @discardableResult
    public static func attachLapChannels(_ parsed: inout ParsedTelemetry) -> ParsedTelemetry {
        let data = parsed.laps.isEmpty ? nil : channelDataFor(parsed)
        parsed.lapChannels = data.flatMap {
            buildLapChannels(
                parsed.laps, $0.dist, $0.series, D_STEP_M, scalars: $0.scalars, meta: $0.meta
            )
        }
        return parsed
    }

    /// Cut per-lap channel arrays on the distance grid.
    ///
    /// Laps without a `startT`/`endT` window (hand-entered times) are skipped;
    /// returns nil when nothing survives, so callers can store the absence as-is.
    ///   - `laps`: the parsed laps
    ///   - `dist`: `[{t, v: metres}]` cumulative, on the same clock as the series
    ///   - `chans`: the `CHANNEL_NAMES` channels in display units
    ///   - `scalars`: the `SCALAR_NAMES` series, reduced to one value per lap
    ///   - `meta`: session-level numbers, stored as the blob's `meta`
    public static func buildLapChannels(
        _ laps: [ParsedLap],
        _ dist: [ChannelPoint],
        _ chans: ParsedTelemetry.CarChannels,
        _ dStepM: Double = D_STEP_M,
        scalars: [String: [ChannelPoint]] = [:],
        meta: ParsedTelemetry.SessionMeta? = nil
    ) -> SessionChannels? {
        if laps.isEmpty || dist.count < 10 { return nil }
        let distS = series(dist)
        // Each channel keeps its own sampler: interpolated by default, held for
        // enums, OR-ed across the window for flags.
        struct Chan {
            var name: String
            var f: Double
            var first: ChannelPoint
            var last: ChannelPoint
            var sample: (Double, Double) -> Double
        }
        let chanS: [Chan] = CHANNEL_NAMES.compactMap { name, f in
            guard let pts = chans[name], pts.count >= 10 else { return nil }
            let s = series(pts)
            let sample: (Double, Double) -> Double =
                WINDOW_MAX.contains(name)
                ? { t, tNext in maxIn(pts, t, tNext) }
                : STEP_HOLD.contains(name) ? { t, _ in holdAt(pts, t) } : { t, _ in s.at(t) }
            return Chan(name: name, f: f, first: s.first, last: s.last, sample: sample)
        }
        struct Scalar {
            var name: String
            var pts: [ChannelPoint]
            var reduce: Reduce
            var f: Double
            var s: Series
        }
        let scalarS: [Scalar] = SCALAR_NAMES.compactMap { name, reduce, f in
            guard let pts = scalars[name], pts.count >= 2 else { return nil }
            return Scalar(name: name, pts: pts, reduce: reduce, f: f, s: series(pts))
        }

        var out: [LapChannels] = []
        for i in 0..<laps.count {
            let lap = laps[i]
            guard let startT = lap.startT, let endT = lap.endT, endT > startT else { continue }
            let d0 = distS.at(startT)
            let d1 = distS.at(endT)
            // `Math.floor` on a NaN is NaN in JS and a trap in Swift, so a
            // degenerate window is dropped here rather than crashing the import.
            let steps = ((d1 - d0) / dStepM).rounded(.down)
            guard steps.isFinite, steps >= 0, steps < Double(MAX_LAP_POINTS) else { continue }
            let n = Int(steps) + 1
            if n < 10 || n > MAX_LAP_POINTS { continue }
            var entry = LapChannels(n: lap.lapNumber ?? (i + 1), timeMs: lap.timeMs)
            // Grid points as times, computed once and shared by every channel;
            // the last point's window closes at the lap's end.
            let ts = (0..<n).map { distS.timeAt(d0 + Double($0) * dStepM) }
            func tNext(_ k: Int) -> Double { k + 1 < n ? ts[k + 1] : endT }
            var any = false
            for c in chanS {
                if startT < c.first.t - 5 || endT > c.last.t + 5 { continue }
                entry[channel: c.name] = (0..<n).map { k in
                    JSMath.round(c.sample(ts[k], tNext(k)), c.f)
                }
                any = true
            }
            // Synthesized speed (from the distance slope) fills in when no source
            // speed channel exists — the graph is too useful to drop for that.
            if entry.speed == nil {
                entry.speed = (0..<n).map { k in
                    JSMath.round(Swift.max(0, distS.rate(ts[k])) * 3.6, 10)
                }
                any = true
            }
            for c in scalarS {
                if let v = reduceScalar(c.pts, c.s, c.reduce, startT, endT) {
                    entry[scalar: c.name] = JSMath.round(v, c.f)
                }
            }
            if any { out.append(entry) }
        }
        if out.isEmpty || out.count > MAX_LAPS { return nil }
        guard trimToBudget(&out) else { return nil }
        return SessionChannels(v: 1, dStepM: dStepM, meta: cleanMeta(meta), laps: out)
    }

    /// One number for one lap, by the channel's own rule. `max`/`min` run over
    /// the samples inside the lap; a lap short enough to contain none of them (a
    /// 0.5 Hz channel and a very fast lap) falls back to the interpolated value
    /// at the finish, which is also what `end` always uses.
    static func reduceScalar(
        _ pts: [ChannelPoint], _ s: Series, _ reduce: Reduce, _ startT: Double, _ endT: Double
    ) -> Double? {
        if reduce != .end {
            var best: Double?
            var i = Swift.max(0, holdIndex(pts, startT))
            while i < pts.count, pts[i].t <= endT {
                defer { i += 1 }
                if pts[i].t < startT { continue }
                let v = pts[i].v
                if best == nil || (reduce == .max ? v > best! : v < best!) { best = v }
            }
            if let best { return best }
        }
        if endT < s.first.t - 5 || startT > s.last.t + 5 { return nil }
        return s.at(endT)
    }

    /// Bring a session under `MAX_TOTAL_VALUES` by dropping whole channels from
    /// the tail of `CHANNEL_NAMES` — the lowest-priority ones — rather than
    /// storing nothing at all. Returns false only when even speed alone doesn't
    /// fit, which is the marathon-enduro case the cap exists for.
    static func trimToBudget(_ out: inout [LapChannels]) -> Bool {
        func total() -> Int {
            out.reduce(0) { sum, e in
                sum + CHANNEL_NAMES.reduce(0) { $0 + (e[channel: $1.0]?.count ?? 0) }
            }
        }
        var i = CHANNEL_NAMES.count - 1
        while i > 0, total() > MAX_TOTAL_VALUES {
            let name = CHANNEL_NAMES[i].0
            for j in out.indices { out[j][channel: name] = nil }
            i -= 1
        }
        return total() <= MAX_TOTAL_VALUES
    }

    /// Session numbers, rounded, with absent ones left out entirely; nil when
    /// the source had none, so the stored blob simply carries no `meta`.
    static func cleanMeta(_ meta: ParsedTelemetry.SessionMeta?) -> ChannelMeta? {
        guard let meta else { return nil }
        let source = ChannelMeta(
            ambientC: meta.ambientC, intakeC: meta.intakeC,
            elevationM: meta.elevationM, odometerKm: meta.odometerKm
        )
        var out = ChannelMeta()
        for (name, f) in META_NAMES {
            if let v = source[name], v.isFinite { out[name] = JSMath.round(v, f) }
        }
        return out.isEmpty ? nil : out
    }
}
