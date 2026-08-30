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

    /// Every channel a lap entry can carry, with its rounding factor (decimal
    /// places worth keeping in the stored JSON). `CHANNEL_NAMES` in the JS.
    public static let CHANNEL_NAMES: [(String, Double)] = [
        ("speed", 10),
        ("rpm", 1),
        ("latG", 1000),
        ("throttle", 10),
        ("brake", 10),
        ("steering", 10),
    ]

    /// Where a lap's channel arrays are cut from: cumulative distance, plus
    /// whichever value channels the source recorded.
    public struct ChannelData: Sendable {
        /// `[{t, v: metres}]` cumulative.
        public var dist: [ChannelPoint]
        /// Speed km/h, latG in G, throttle/brake in %, steering in degrees.
        public var series: ParsedTelemetry.CarChannels

        public init(dist: [ChannelPoint], series: ParsedTelemetry.CarChannels) {
            self.dist = dist
            self.series = series
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
        if let odo = parsed.channels?.odoPts, odo.count >= 10 {
            return ChannelData(dist: odo, series: car)
        }
        guard let base = fromTrace() else { return nil }
        // `{...base.series, ...car}`: a present car channel wins, an absent one
        // leaves the trace-derived value in place.
        return ChannelData(
            dist: base.dist,
            series: ParsedTelemetry.CarChannels(
                speed: car.speed ?? base.series.speed,
                rpm: car.rpm ?? base.series.rpm,
                latG: car.latG ?? base.series.latG,
                throttle: car.throttle ?? base.series.throttle,
                brake: car.brake ?? base.series.brake,
                steering: car.steering ?? base.series.steering
            )
        )
    }

    /// Compute and attach `lapChannels` to a parsed import. Called after parsing
    /// and again whenever laps change (line pick, batch anchoring). Laps without
    /// `startT`/`endT` windows contribute nothing.
    @discardableResult
    public static func attachLapChannels(_ parsed: inout ParsedTelemetry) -> ParsedTelemetry {
        let data = parsed.laps.isEmpty ? nil : channelDataFor(parsed)
        parsed.lapChannels = data.flatMap { buildLapChannels(parsed.laps, $0.dist, $0.series) }
        return parsed
    }

    /// Cut per-lap channel arrays on the distance grid.
    ///
    /// Laps without a `startT`/`endT` window (hand-entered times) are skipped;
    /// returns nil when nothing survives, so callers can store the absence as-is.
    ///   - `laps`: the parsed laps
    ///   - `dist`: `[{t, v: metres}]` cumulative, on the same clock as the series
    ///   - `chans`: speed km/h, latG in G, throttle/brake %, steering deg
    public static func buildLapChannels(
        _ laps: [ParsedLap],
        _ dist: [ChannelPoint],
        _ chans: ParsedTelemetry.CarChannels,
        _ dStepM: Double = D_STEP_M
    ) -> SessionChannels? {
        if laps.isEmpty || dist.count < 10 { return nil }
        let distS = series(dist)
        // `chans[name]` in the JS.
        func channelPoints(_ name: String) -> [ChannelPoint]? {
            switch name {
            case "speed": chans.speed
            case "rpm": chans.rpm
            case "latG": chans.latG
            case "throttle": chans.throttle
            case "brake": chans.brake
            case "steering": chans.steering
            default: nil
            }
        }
        // Names, order and rounding factors are the JS's `CHANNEL_NAMES`.
        let named: [(String, [ChannelPoint], Double)] = CHANNEL_NAMES.map {
            ($0.0, channelPoints($0.0) ?? [], $0.1)
        }.filter { $0.1.count >= 10 }
        let chanS = named.map { ($0.0, series($0.1), $0.2) }

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
            var any = false
            for (name, s, f) in chanS {
                let t0 = s.first.t
                let t1 = s.last.t
                if startT < t0 - 5 || endT > t1 + 5 { continue }
                let values = (0..<n).map { k in
                    JSMath.round(s.at(distS.timeAt(d0 + Double(k) * dStepM)), f)
                }
                switch name {
                case "speed": entry.speed = values
                case "rpm": entry.rpm = values
                case "latG": entry.latG = values
                case "throttle": entry.throttle = values
                case "brake": entry.brake = values
                default: entry.steering = values
                }
                any = true
            }
            // Synthesized speed (from the distance slope) fills in when no source
            // speed channel exists — the graph is too useful to drop for that.
            if entry.speed == nil {
                entry.speed = (0..<n).map { k in
                    JSMath.round(
                        Swift.max(0, distS.rate(distS.timeAt(d0 + Double(k) * dStepM))) * 3.6, 10
                    )
                }
                any = true
            }
            if any { out.append(entry) }
        }
        if out.isEmpty || out.count > MAX_LAPS { return nil }
        let totalValues = out.reduce(0) {
            $0 + ($1.speed?.count ?? 0) + ($1.rpm?.count ?? 0) + ($1.latG?.count ?? 0)
                + ($1.throttle?.count ?? 0) + ($1.brake?.count ?? 0) + ($1.steering?.count ?? 0)
        }
        return totalValues <= MAX_TOTAL_VALUES
            ? SessionChannels(v: 1, dStepM: dStepM, laps: out)
            : nil
    }
}
