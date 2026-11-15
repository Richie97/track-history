import Foundation

// MARK: - Where a trace lies on Earth (NS-53)

/// A stored trace is local metres from the origin `projectTrace` was given, and
/// that origin is saved beside it as the session's `trace_geo`. These are the
/// pure half of drawing the line on a real map: the anchor a save sends, the
/// way back to degrees, and what a map view needs to fit, hit-test and colour
/// the line.
///
/// The port of the NS-53 half of `public/js/import/geo.js` under the same
/// names, pinned by `contracts/logic/geo-anchor.json` (`GeoAnchorTests`).
extension Geo {
    /// `projectTrace`'s constants. **The inverse must use the same two
    /// numbers** — they are approximations, but the projection is then its own
    /// exact inverse. Substituting a "more correct" figure moves the far end of
    /// a 5 km lap by metres and fails no test that does not pin it.
    public static let KY: Double = 110_540
    public static func KX(_ lat: Double) -> Double { 111_320 * cos(lat * .pi / 180) }

    /// The anchor to save with a trace: the origin its points were projected
    /// from — `gps[0]` unless `projectTrace` was handed another. nil for
    /// anything that isn't a real coordinate ((0, 0) is a GPS with no fix), so
    /// a save sends null rather than a place the line never was.
    public static func traceOrigin(_ gps: [Point]?, origin: Origin? = nil) -> TraceGeo? {
        let o = origin ?? gps?.first.map { Origin(lat: $0.lat, lon: $0.lon) }
        guard let o, o.lat.isFinite, o.lon.isFinite else { return nil }
        if abs(o.lat) > 85 || abs(o.lon) > 180 { return nil }
        if abs(o.lat) < 0.01 && abs(o.lon) < 0.01 { return nil }
        return TraceGeo(lat: JSMath.round(o.lat, 1e7), lon: JSMath.round(o.lon, 1e7))
    }

    /// One point of a trace back in degrees.
    public struct GeoPoint: Hashable, Sendable {
        public var lat: Double
        public var lon: Double
        public var v: Double

        public init(lat: Double, lon: Double, v: Double) {
            self.lat = lat
            self.lon = lon
            self.v = v
        }
    }

    /// A stored `[x, y, v]` trace back to degrees.
    public static func unprojectTrace(_ trace: [TracePoint], _ geo: TraceGeo) -> [GeoPoint] {
        let kx = KX(geo.lat)
        return trace.map { GeoPoint(lat: geo.lat + $0.y / KY, lon: geo.lon + $0.x / kx, v: $0.v) }
    }

    public struct GeoBounds: Hashable, Sendable {
        public var south: Double
        public var west: Double
        public var north: Double
        public var east: Double
    }

    /// The trace's bounding box in degrees — what a map's first camera fits.
    public static func traceGeoBounds(_ trace: [TracePoint], _ geo: TraceGeo) -> GeoBounds? {
        guard !trace.isEmpty else { return nil }
        var x0 = Double.infinity, x1 = -Double.infinity, y0 = Double.infinity, y1 = -Double.infinity
        for p in trace {
            if p.x < x0 { x0 = p.x }
            if p.x > x1 { x1 = p.x }
            if p.y < y0 { y0 = p.y }
            if p.y > y1 { y1 = p.y }
        }
        let kx = KX(geo.lat)
        return GeoBounds(south: geo.lat + y0 / KY, west: geo.lon + x0 / kx, north: geo.lat + y1 / KY, east: geo.lon + x1 / kx)
    }

    /// A tap's hit on the line.
    public struct TraceHit: Hashable, Sendable {
        /// The nearer end of the segment hit.
        public var idx: Int
        /// `alongM` over the trace's length (cumulative chord length).
        public var frac: Double
        /// Driven distance to the nearest point.
        public var alongM: Double
        /// How far the tap was from the line.
        public var offM: Double

        public init(idx: Int, frac: Double, alongM: Double, offM: Double) {
            self.idx = idx
            self.frac = frac
            self.alongM = alongM
            self.offM = offM
        }
    }

    /// The point on the line nearest (x, y), all in the trace's metres — a
    /// tap's hit test. By distance driven, not by index: a trace is denser
    /// where the car was slower. nil when nothing is within `maxM`. Ties keep
    /// the earlier segment.
    public static func nearestOnTrace(
        _ trace: [TracePoint], _ x: Double, _ y: Double, maxM: Double = .infinity
    ) -> TraceHit? {
        guard trace.count >= 2 else { return nil }
        var best: (idx: Int, alongM: Double, offM: Double)?
        var cum = 0.0
        for i in 0..<(trace.count - 1) {
            let ax = trace[i].x, ay = trace[i].y
            let dx = trace[i + 1].x - ax, dy = trace[i + 1].y - ay
            let len = hypot(dx, dy)
            let t = len > 0 ? max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (len * len))) : 0
            let offM = hypot(x - (ax + dx * t), y - (ay + dy * t))
            if best == nil || offM < best!.offM {
                best = (t < 0.5 ? i : i + 1, cum + len * t, offM)
            }
            cum += len
        }
        guard cum > 0, let best, best.offM <= maxM else { return nil }
        return TraceHit(idx: best.idx, frac: best.alongM / cum, alongM: best.alongM, offM: best.offM)
    }

    /// A run of one speed colour: point indexes inclusive, `bucket` 0 (slowest)
    /// … buckets − 1.
    public struct SpeedRun: Hashable, Sendable, Codable {
        public var from: Int
        public var to: Int
        public var bucket: Int

        public init(from: Int, to: Int, bucket: Int) {
            self.from = from
            self.to = to
            self.bucket = bucket
        }
    }

    /// The line cut into runs of one speed colour. Speed is normalised over the
    /// trace's own range, as the drawn track map does, and a segment takes the
    /// bucket of the point it starts at — so every client colours the same
    /// metres the same.
    public static func speedRuns(_ trace: [TracePoint], buckets: Int = 16) -> [SpeedRun] {
        guard trace.count >= 2 else { return [] }
        var vMin = Double.infinity, vMax = -Double.infinity
        for p in trace {
            if p.v < vMin { vMin = p.v }
            if p.v > vMax { vMax = p.v }
        }
        func bucketAt(_ i: Int) -> Int {
            guard vMax > vMin else { return buckets / 2 }
            return min(buckets - 1, Int(floor((trace[i].v - vMin) / (vMax - vMin) * Double(buckets))))
        }
        var runs: [SpeedRun] = []
        for i in 0..<(trace.count - 1) {
            let bucket = bucketAt(i)
            if let last = runs.last, last.bucket == bucket {
                runs[runs.count - 1].to = i + 1
            } else {
                runs.append(SpeedRun(from: i, to: i + 1, bucket: bucket))
            }
        }
        return runs
    }
}
