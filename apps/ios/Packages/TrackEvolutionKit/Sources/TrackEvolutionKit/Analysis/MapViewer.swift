import Foundation

/// The racing line on a real map (NS-53 ticket 2): the viewer's pure half.
///
/// The port of the pure exports of `public/js/map-viewer.js` under the same
/// names — what the viewer offers, the sentence that explains a missing map
/// type, the ramp colours, and a tap's hit test and read-out — so the three
/// clients say and draw the same thing. The map itself is MapKit, in the app
/// target (`TrackMapScreen`); this module knows nothing about it.
///
/// Three rules shape the viewer, as on the web: nothing loads from Apple until
/// it is opened; **the line never depends on the map** (no anchor, no
/// connection — each leaves it on the drawn line with one sentence); and the
/// device's own position is never asked for or shown.
public enum MapViewer {
    public enum MapType: String, CaseIterable, Hashable, Sendable {
        case satellite
        case standard
        case line

        /// `MAP_TYPE_LABELS`.
        public var label: String {
            switch self {
            case .satellite: "Satellite"
            case .standard: "Map"
            case .line: "Line"
            }
        }
    }

    public static let MAP_TYPES: [MapType] = [.satellite, .standard, .line]
    public static let DEFAULT_MAP_TYPE: MapType = .satellite
    /// The `UserDefaults` key the choice is remembered under (the web's
    /// `th-map-type` in localStorage).
    public static let MAP_TYPE_KEY = "mapType"

    /// How close a tap has to land to the line to read it, in screen points.
    public static let TAP_RADIUS_PX: Double = 24
    public static let SPEED_BUCKETS = 16
    public static let FIT_PADDING_PX: Double = 48
    /// How far one accessibility step moves the read-out along the lap.
    public static let STEP_FRAC = 0.05

    public static let NOTE_NO_ANCHOR =
        "This session was saved before its position was kept, so there is no map to lay it on yet. "
        + "Import or record another session at this track and it will borrow that one's place."
    public static let NOTE_NOT_SET_UP = "Map imagery isn't available here, so this is the line on its own."
    public static let NOTE_OFFLINE = "Map imagery needs a connection."
    public static let NOTE_APPROX = "Position estimated from another session here."

    public struct Plan: Hashable, Sendable {
        public var types: [MapType]
        public var note: String?

        public init(types: [MapType], note: String?) {
            self.types = types
            self.note = note
        }
    }

    /// What the viewer can offer: the map types that work and the sentence
    /// that explains a missing one. On iOS `mapsOn` is always true (MapKit is
    /// the platform's); `loadFailed` is MapKit failing to load the map —
    /// offline with nothing cached.
    public static func viewerPlan(geo: TraceGeo?, mapsOn: Bool = true, loadFailed: Bool = false) -> Plan {
        guard let geo else { return Plan(types: [.line], note: NOTE_NO_ANCHOR) }
        if !mapsOn { return Plan(types: [.line], note: NOTE_NOT_SET_UP) }
        if loadFailed { return Plan(types: [.line], note: NOTE_OFFLINE) }
        return Plan(types: MAP_TYPES, note: geo.approx == true ? NOTE_APPROX : nil)
    }

    /// The type to open on: the remembered one when the plan still offers it.
    public static func startType(_ plan: Plan, _ remembered: MapType?) -> MapType {
        if let remembered, plan.types.contains(remembered) { return remembered }
        return plan.types[0]
    }

    /// The remembered type, read leniently: anything unknown is the default.
    public static func mapType(fromStored raw: String?) -> MapType {
        raw.flatMap(MapType.init(rawValue:)) ?? DEFAULT_MAP_TYPE
    }

    // MARK: - Colour

    public struct RGB: Hashable, Sendable {
        public var r: Int
        public var g: Int
        public var b: Int

        public init(r: Int, g: Int, b: Int) {
            self.r = r
            self.g = g
            self.b = b
        }

        /// `#rrggbb` or `#rgb`, whitespace tolerated, as the JS's `hex2rgb`.
        public init?(hex: String) {
            var s = hex.trimmingCharacters(in: .whitespaces)
            if s.hasPrefix("#") { s.removeFirst() }
            if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
            guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
            self.init(r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff)
        }
    }

    /// A speed bucket's colour on the slow → fast ramp, at the bucket's
    /// midpoint, as the drawn track map colours a segment.
    public static func rampColor(_ bucket: Int, _ buckets: Int, _ slow: RGB, _ fast: RGB) -> RGB {
        let t = (Double(bucket) + 0.5) / Double(buckets)
        func mix(_ a: Int, _ b: Int) -> Int { Int(JSMath.round(Double(a) + Double(b - a) * t, 1)) }
        return RGB(r: mix(slow.r, fast.r), g: mix(slow.g, fast.g), b: mix(slow.b, fast.b))
    }

    /// The fraction along the ramp a bucket's colour sits at — for a renderer
    /// that interpolates between the two tokens itself.
    public static func rampFraction(_ bucket: Int, _ buckets: Int) -> Double {
        (Double(bucket) + 0.5) / Double(buckets)
    }

    // MARK: - Geometry

    /// A coordinate back into the trace's metres — `projectTrace`, for one point.
    public static func traceMetres(_ lat: Double, _ lon: Double, _ geo: TraceGeo) -> (x: Double, y: Double) {
        ((lon - geo.lon) * Geo.KX(geo.lat), (lat - geo.lat) * Geo.KY)
    }

    /// The direction of travel at a trace point, degrees clockwise from north.
    public static func headingDeg(_ trace: [TracePoint], _ idx: Int) -> Double {
        let a = trace[max(0, idx - 1)]
        let b = trace[min(trace.count - 1, idx + 1)]
        let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    /// A tap at (lat, lon) with the map showing `metresPerPx`: the place on the
    /// line it reads, or nil when it landed too far off it.
    public static func tapHit(
        _ trace: [TracePoint], _ geo: TraceGeo, _ lat: Double, _ lon: Double, _ metresPerPx: Double
    ) -> Geo.TraceHit? {
        let p = traceMetres(lat, lon, geo)
        return Geo.nearestOnTrace(trace, p.x, p.y, maxM: TAP_RADIUS_PX * metresPerPx)
    }

    /// The point `alongM` metres down the line, in the trace's metres — the
    /// point on the line, not the nearer fix.
    public static func pointAlong(_ trace: [TracePoint], _ alongM: Double) -> (x: Double, y: Double) {
        var cum = 0.0
        if trace.count > 1 {
            for i in 0..<(trace.count - 1) {
                let len = hypot(trace[i + 1].x - trace[i].x, trace[i + 1].y - trace[i].y)
                if cum + len >= alongM && len > 0 {
                    let t = (alongM - cum) / len
                    return (trace[i].x + (trace[i + 1].x - trace[i].x) * t, trace[i].y + (trace[i + 1].y - trace[i].y) * t)
                }
                cum += len
            }
        }
        let last = trace[trace.count - 1]
        return (last.x, last.y)
    }

    /// The hit `frac` of the way round the line, for the read-out's
    /// adjustable action (5 % a step) — the same hit a tap on that point gives.
    public static func hitAtFraction(_ trace: [TracePoint], _ frac: Double) -> Geo.TraceHit? {
        guard trace.count >= 2 else { return nil }
        var total = 0.0
        for i in 1..<trace.count { total += hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y) }
        guard total > 0 else { return nil }
        let p = pointAlong(trace, max(0, min(1, frac)) * total)
        return Geo.nearestOnTrace(trace, p.x, p.y)
    }

    // MARK: - The read-out

    public struct Place: Hashable, Sendable {
        /// Speed in stored km/h, or nil without a channel entry.
        public var kph: Double?
        public var distM: Double

        public init(kph: Double?, distM: Double) {
            self.kph = kph
            self.distM = distM
        }
    }

    /// The lap's own channel reading at a fraction of its distance: speed in
    /// stored km/h and metres from the line. The trace's third value is not
    /// used — its unit depends on the source — so with no channel entry the
    /// read-out is the distance along the drawn line alone.
    public static func placeAt(_ hit: Geo.TraceHit, speed: [Double]?, dStepM: Double?) -> Place {
        guard let speed, speed.count >= 2, let dStepM, dStepM > 0 else {
            return Place(kph: nil, distM: hit.alongM)
        }
        let k = hit.frac * Double(speed.count - 1)
        let i = min(speed.count - 2, Int(floor(k)))
        let f = k - Double(i)
        return Place(kph: speed[i] + (speed[i + 1] - speed[i]) * f, distM: k * dStepM)
    }

    public static func readoutText(_ place: Place, _ units: UnitSystem) -> String {
        let dist = Units.fmtDist(JSMath.round(place.distM, 1), units)
        guard let kph = place.kph else { return dist }
        return "\(Units.fmtSpeedKph(kph, units)) · \(dist)"
    }
}
