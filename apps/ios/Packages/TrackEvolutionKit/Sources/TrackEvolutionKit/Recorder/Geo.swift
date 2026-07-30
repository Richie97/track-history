import Foundation

/// GPS trace geometry: project lat/lon traces to local metres and derive lap
/// times from start/finish line crossings.
///
/// A port of `public/js/import/geo.js`, function for function and name for name,
/// so the two can be diffed by eye. Its test cases come with it
/// (`test/unit/geo.test.js` → `GeoTests`), plus a cross-language fixture
/// (`contracts/logic/geo-laps.json`) that pins Swift's lap times to the JS
/// implementation's to the millisecond.
///
/// This is the one piece of the telemetry-import code that *is* ported, because
/// it isn't really part of import: a live recording has no lap markers, so the
/// recorder times its laps by the user picking the start/finish line. See
/// `docs/specs/native/NS-13-ios-lap-geometry.md`.
///
/// Sign conventions don't matter (e.g. Racelogic's west-positive longitude):
/// everything here is relative geometry within one trace, so a self-consistent
/// source works unchanged. Do not add hemisphere "corrections".
public enum Geo {
    /// A raw fix in decimal degrees on the trace's own clock (seconds).
    public struct Point: Hashable, Sendable, Codable {
        public var t: Double
        public var lat: Double
        public var lon: Double
        /// Speed from the source, when it has one.
        public var v: Double?

        public init(t: Double, lat: Double, lon: Double, v: Double? = nil) {
            self.t = t
            self.lat = lat
            self.lon = lon
            self.v = v
        }
    }

    /// The projection origin — the frame two traces can share.
    public struct Origin: Hashable, Sendable {
        public var lat: Double
        public var lon: Double

        public init(lat: Double, lon: Double) {
            self.lat = lat
            self.lon = lon
        }
    }

    /// A fix in local metres.
    public struct Projected: Hashable, Sendable {
        public var t: Double
        public var x: Double
        public var y: Double
        public var v: Double?

        public init(t: Double, x: Double, y: Double, v: Double? = nil) {
            self.t = t
            self.x = x
            self.y = y
            self.v = v
        }
    }

    /// A start/finish line: the segment `(x1,y1)–(x2,y2)`, plus the direction of
    /// travel through it when there is one (`hx`/`hy` nil ⇒ both directions
    /// count).
    public struct Gate: Hashable, Sendable, Codable {
        public var x: Double
        public var y: Double
        public var hx: Double?
        public var hy: Double?
        public var x1: Double
        public var y1: Double
        public var x2: Double
        public var y2: Double
    }

    /// A lap timed from two gate crossings. `estimated` is user-visible — these
    /// render with a `~` prefix — so don't drop it.
    public struct DerivedLap: Hashable, Sendable, Codable {
        public var timeMs: Int
        public var estimated: Bool
        /// On the trace clock, so per-lap channel data can be cut from the same
        /// telemetry.
        public var startT: Double
        public var endT: Double
    }

    /// Thresholds for turning crossings into laps. Defaults match the JS.
    public struct Options: Hashable, Sendable {
        /// Crossings closer together than this are GPS jitter, not laps.
        public var minGapS: Double
        /// Below this a "lap" is a jitter double-count…
        public var minLapS: Double
        /// …and above it, a pit stop or a gap between sessions.
        public var maxLapS: Double

        public init(minGapS: Double = 5, minLapS: Double = 30, maxLapS: Double = 3600) {
            self.minGapS = minGapS
            self.minLapS = minLapS
            self.maxLapS = maxLapS
        }

        public static let `default` = Options()
    }

    // MARK: - Projection

    /// Equirectangular projection to metres relative to `origin` (the first point
    /// by default). Fine at track scale.
    public static func projectTrace(_ points: [Point], origin: Origin? = nil) -> [Projected] {
        guard let first = points.first else { return [] }
        let origin = origin ?? Origin(lat: first.lat, lon: first.lon)
        let kx = 111_320 * cos(origin.lat * .pi / 180)
        let ky = 110_540.0
        return points.map {
            Projected(t: $0.t, x: ($0.lon - origin.lon) * kx, y: ($0.lat - origin.lat) * ky, v: $0.v)
        }
    }

    // MARK: - Gates

    /// A gate through `trace[idx]`, perpendicular to the direction of travel
    /// there. nil when the local heading is degenerate (car not moving).
    ///
    /// The heading window widens 3 → 6 → 12 → 24 until the displacement exceeds
    /// 2 m. That widening is what makes picking a point in a slow corner work.
    public static func buildGate(_ trace: [Projected], idx: Int, halfWidth: Double = 20) -> Gate? {
        guard trace.indices.contains(idx) else { return nil }
        let p = trace[idx]
        var w = 3
        while w <= 24 {
            let a = trace[max(0, idx - w)]
            let b = trace[min(trace.count - 1, idx + w)]
            let hx = b.x - a.x
            let hy = b.y - a.y
            let len = (hx * hx + hy * hy).squareRoot()
            if len < 2 {
                w *= 2
                continue
            }
            let ux = hx / len
            let uy = hy / len
            // Unit perpendicular.
            let px = -uy
            let py = ux
            return Gate(
                x: p.x, y: p.y, hx: ux, hy: uy,
                x1: p.x - px * halfWidth, y1: p.y - py * halfWidth,
                x2: p.x + px * halfWidth, y2: p.y + py * halfWidth
            )
        }
        return nil
    }

    /// A gate from two explicit endpoints (e.g. a VBO `[laptiming]` start line).
    /// No heading, so crossings in either direction count.
    public static func gateFromSegment(
        _ p1: (x: Double, y: Double), _ p2: (x: Double, y: Double)
    ) -> Gate {
        Gate(
            x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, hx: nil, hy: nil,
            x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y
        )
    }

    // MARK: - Crossings and laps

    /// Times (seconds) at which the trace crosses the gate, **interpolated within
    /// the crossing segment** — that interpolation is why GPS-derived laps land
    /// within ~±0.1–0.3 s between 10–18 Hz fixes.
    public static func gateCrossings(
        _ trace: [Projected], gate: Gate, options: Options = .default
    ) -> [Double] {
        let gx = gate.x2 - gate.x1
        let gy = gate.y2 - gate.y1
        var out: [Double] = []
        guard trace.count > 1 else { return out }
        for i in 1..<trace.count {
            let a = trace[i - 1]
            let b = trace[i]
            let dx = b.x - a.x
            let dy = b.y - a.y
            // Only time crossings in the racing direction.
            if let hx = gate.hx, let hy = gate.hy, dx * hx + dy * hy <= 0 { continue }
            let denom = dx * gy - dy * gx
            if denom == 0 { continue }
            // a + s·(b−a) intersects gate.p1 + u·(p2−p1), with s and u in [0,1].
            let wx = gate.x1 - a.x
            let wy = gate.y1 - a.y
            let s = (wx * gy - wy * gx) / denom
            let u = (wx * dy - wy * dx) / denom
            if s < 0 || s > 1 || u < 0 || u > 1 { continue }
            let t = a.t + s * (b.t - a.t)
            if let last = out.last, t - last < options.minGapS { continue }
            out.append(t)
        }
        return out
    }

    /// Laps between consecutive crossings, dropping deltas outside
    /// `[minLapS, maxLapS]`.
    public static func lapsFromCrossings(
        _ crossings: [Double], options: Options = .default
    ) -> [DerivedLap] {
        var laps: [DerivedLap] = []
        guard crossings.count > 1 else { return laps }
        for i in 1..<crossings.count {
            let s = crossings[i] - crossings[i - 1]
            if s < options.minLapS || s > options.maxLapS { continue }
            laps.append(
                DerivedLap(
                    timeMs: Int((s * 1000).rounded()),
                    estimated: true,
                    startT: crossings[i - 1],
                    endT: crossings[i]
                )
            )
        }
        return laps
    }

    public static func deriveLaps(
        _ trace: [Projected], gate: Gate, options: Options = .default
    ) -> [DerivedLap] {
        lapsFromCrossings(gateCrossings(trace, gate: gate, options: options), options: options)
    }

    // MARK: - Best-lap trace

    /// Slice a projected trace to `[t0, t1]` and downsample to at most `max`
    /// points — the `[x, y, v]` polyline stored with the session and drawn as the
    /// speed-painted racing line. nil when the window holds too few points.
    ///
    /// Speed comes from the source when present, else from distance/time to the
    /// neighbouring fix; the renderer only uses it relatively, so units don't
    /// matter.
    public static func lapTrace(
        _ trace: [Projected], from t0: Double, to t1: Double, max: Int = 300
    ) -> [TracePoint]? {
        let pts = trace.filter { $0.t >= t0 && $0.t <= t1 }
        if pts.count < 10 { return nil }

        func speedAt(_ i: Int) -> Double {
            if let v = pts[i].v, v.isFinite { return v }
            let a = pts[Swift.max(0, i - 1)]
            let b = pts[Swift.min(pts.count - 1, i + 1)]
            let dt = b.t - a.t
            guard dt > 0 else { return 0 }
            let (dx, dy) = (b.x - a.x, b.y - a.y)
            return (dx * dx + dy * dy).squareRoot() / dt
        }
        func point(_ i: Int) -> TracePoint {
            TracePoint(
                x: (pts[i].x * 10).rounded() / 10,
                y: (pts[i].y * 10).rounded() / 10,
                v: (speedAt(i) * 100).rounded() / 100
            )
        }

        let step = Swift.max(1, Int((Double(pts.count) / Double(max)).rounded(.up)))
        var out: [TracePoint] = []
        for i in stride(from: 0, to: pts.count, by: step) {
            out.append(point(i))
        }
        // Always land on the final fix, even when the stride misses it.
        let lastIdx = pts.count - 1
        if lastIdx % step != 0 {
            out.append(point(lastIdx))
        }
        return out
    }

    /// The fastest valid lap's trace, from the same crossings that timed the laps.
    public static func bestLapTrace(
        _ trace: [Projected], gate: Gate, options: Options = .default
    ) -> [TracePoint]? {
        let crossings = gateCrossings(trace, gate: gate, options: options)
        var best: (s: Double, t0: Double, t1: Double)?
        guard crossings.count > 1 else { return nil }
        for i in 1..<crossings.count {
            let s = crossings[i] - crossings[i - 1]
            if s < options.minLapS || s > options.maxLapS { continue }
            if best == nil || s < best!.s { best = (s, crossings[i - 1], crossings[i]) }
        }
        guard let best else { return nil }
        return lapTrace(trace, from: best.t0, to: best.t1)
    }
}
