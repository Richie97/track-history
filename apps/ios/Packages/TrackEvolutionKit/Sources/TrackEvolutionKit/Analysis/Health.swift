import Foundation

/// Session health (#190) — the port of the pure half of `public/js/health.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`HealthTests`), and the output is
/// pinned against the web implementation by `contracts/logic/health.json`.
/// Only the maths crosses over: the cards, sparklines and per-lap table are
/// each platform's own, and `HealthStrip` draws the phone's.
///
/// Every PDR import stores fourteen numbers per lap that are not lap-time data
/// — peak oil / coolant / transmission temperature, minimum oil pressure, fuel
/// and the four tyre pressures as the lap ended, peak tyre temperature on each
/// corner, minimum battery voltage — plus a `boost` trace whose per-lap peak is
/// a heat-soak signal rather than a driving one. They answer "is the car okay,
/// and is it set up right", which is the other half of a track day, and they
/// fill the panel's Car tab.
///
/// Three rules shape everything here and this port inherits all of them.
///
/// **The reduction is the importer's, never re-derived.** A stored `oilC` is
/// the lap's peak, `oilKpa` its minimum, a tyre pressure the value as the lap
/// finished; ``HEALTH_DEFS`` restates each rule only so the view can *say* it
/// ("peak", "min", "at lap end"). Boost is the one figure not stored as a
/// scalar — it is a gridded trace — so its per-lap peak is derived here, and
/// that is the only derivation.
///
/// **Thresholds shade, they don't alarm.** Each figure with a line has a
/// `watch` level and an `over` level in the stored unit, and the two statuses
/// are the garage's own wear vocabulary — `low` (approaching) and `due` (past
/// the line) — so the strip reuses the part cards' colours rather than
/// inventing a second scale. Both bounds are inclusive, and a `low` column's
/// hazard is *below* its lines rather than above them: get that backwards and
/// the shading marks the wrong half of the session.
///
/// **Values stay in the stored units** (°C, kPa, V, %) throughout, with display
/// conversion a separate step (``displayValue(_:_:_:)``), so the fixture pins
/// numbers rather than a locale. The web shows °F and psi; the phones do too,
/// through ``Units/us``.
///
/// The **tyre-pressure loop** — the setup sheet's cold pressures and a
/// per-vehicle target turning the import's hot pressures into the cold pressure
/// to start from next time — is web-only, because the setup notebook is. What
/// ports is the arithmetic under it (``hotPressures(_:)``, ``suggestCold(_:_:_:)``)
/// and nothing that needs a sheet: `pressureLoop` has no counterpart here.
public enum Health {
    // MARK: - Columns

    /// How the importer reduced a channel to one number per lap.
    public enum Reduce: String, Sendable, Codable {
        /// The lap's peak.
        case max
        /// The lap's minimum.
        case min
        /// The value as the lap finished.
        case end
    }

    /// One column of the strip. `low` means the hazard is *below* the lines;
    /// `derived` means the figure is reduced here from a gridded trace rather
    /// than read from a stored scalar. Thresholds are in the stored unit.
    public struct Def: Sendable, Equatable, Decodable {
        public var key: String
        public var label: String
        public var group: String
        public var unit: String
        public var reduce: Reduce
        public var low: Bool
        public var watch: Double?
        public var over: Double?
        public var derived: Bool

        public init(
            key: String, label: String, group: String, unit: String, reduce: Reduce,
            low: Bool = false, watch: Double? = nil, over: Double? = nil, derived: Bool = false
        ) {
            self.key = key
            self.label = label
            self.group = group
            self.unit = unit
            self.reduce = reduce
            self.low = low
            self.watch = watch
            self.over = over
            self.derived = derived
        }

        /// The fixture omits `low` and `derived` where they are false, as the JS
        /// object literal does.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            label = try c.decode(String.self, forKey: .label)
            group = try c.decode(String.self, forKey: .group)
            unit = try c.decode(String.self, forKey: .unit)
            reduce = try c.decode(Reduce.self, forKey: .reduce)
            low = try c.decodeIfPresent(Bool.self, forKey: .low) ?? false
            watch = try c.decodeIfPresent(Double.self, forKey: .watch)
            over = try c.decodeIfPresent(Double.self, forKey: .over)
            derived = try c.decodeIfPresent(Bool.self, forKey: .derived) ?? false
        }

        enum CodingKeys: String, CodingKey {
            case key, label, group, unit, reduce, low, watch, over, derived
        }
    }

    /// The strip's groups, in display order.
    public static let HEALTH_GROUPS: [(key: String, label: String)] = [
        ("temps", "Temperatures"),
        ("pressures", "Pressures"),
        ("electrical", "Fuel & electrical"),
    ]

    /// The strip's columns, grouped, in display order.
    public static let HEALTH_DEFS: [Def] = [
        Def(key: "oilC", label: "Oil temp", group: "temps", unit: "°C", reduce: .max, watch: 120, over: 130),
        Def(key: "coolantC", label: "Coolant", group: "temps", unit: "°C", reduce: .max, watch: 110, over: 120),
        Def(key: "transC", label: "Transmission", group: "temps", unit: "°C", reduce: .max, watch: 110, over: 125),
        Def(key: "tyreCLF", label: "Tyre LF", group: "temps", unit: "°C", reduce: .max),
        Def(key: "tyreCRF", label: "Tyre RF", group: "temps", unit: "°C", reduce: .max),
        Def(key: "tyreCLR", label: "Tyre LR", group: "temps", unit: "°C", reduce: .max),
        Def(key: "tyreCRR", label: "Tyre RR", group: "temps", unit: "°C", reduce: .max),
        Def(
            key: "oilKpa", label: "Oil pressure", group: "pressures", unit: "kPa", reduce: .min,
            low: true, watch: 200, over: 120
        ),
        Def(key: "boost", label: "Boost", group: "pressures", unit: "kPa", reduce: .max, derived: true),
        Def(key: "tyreKpaLF", label: "Tyre LF", group: "pressures", unit: "kPa", reduce: .end),
        Def(key: "tyreKpaRF", label: "Tyre RF", group: "pressures", unit: "kPa", reduce: .end),
        Def(key: "tyreKpaLR", label: "Tyre LR", group: "pressures", unit: "kPa", reduce: .end),
        Def(key: "tyreKpaRR", label: "Tyre RR", group: "pressures", unit: "kPa", reduce: .end),
        Def(
            key: "fuelPct", label: "Fuel", group: "electrical", unit: "%", reduce: .end,
            low: true, watch: 20, over: 10
        ),
        Def(
            key: "battV", label: "Battery", group: "electrical", unit: "V", reduce: .min,
            low: true, watch: 13, over: 12.5
        ),
    ]

    /// The four corners in the order the strip and the setup sheet both use,
    /// with the sheet's key for each.
    public static let TYRE_CORNERS: [(corner: String, key: String)] = [
        ("LF", "fl"), ("RF", "fr"), ("LR", "rl"), ("RR", "rr"),
    ]

    public static let KPA_PER_PSI: Double = 6.894757
    public static func kpaToPsi(_ kpa: Double) -> Double { kpa / KPA_PER_PSI }
    public static func psiToKpa(_ psi: Double) -> Double { psi * KPA_PER_PSI }
    public static func cToF(_ c: Double) -> Double { c * 1.8 + 32 }

    /// Fewer than this many fuel drops and a burn rate is one lap's noise.
    public static let MIN_FUEL_DROPS = 2

    /// Cold-pressure suggestions land on the setup sheet's own step.
    public static let PSI_STEP: Double = 0.5

    /// A cross-corner spread worth shading, in stored units: 10 °C across an
    /// axle or between axles is a camber or balance question; 2 psi is a corner
    /// that has done more work than its neighbour.
    public static let SPREAD_WATCH_C: Double = 10
    public static let SPREAD_WATCH_KPA: Double = 2 * KPA_PER_PSI

    public static func defFor(_ key: String) -> Def? {
        HEALTH_DEFS.first { $0.key == key }
    }

    // MARK: - Reading a lap

    /// A lap's figure for one column: the stored scalar, or for the derived
    /// `boost` column the peak of the stored trace. nil when the lap has
    /// neither.
    public static func lapValue(_ entry: LapChannels?, _ key: String) -> Double? {
        guard let entry else { return nil }
        if defFor(key)?.derived == true {
            guard let arr = entry[channel: key], !arr.isEmpty else { return nil }
            var m = -Double.infinity
            for v in arr where v.isFinite && v > m { m = v }
            return m == -Double.infinity ? nil : m
        }
        guard let v = entry[scalar: key], v.isFinite else { return nil }
        return v
    }

    /// True when the lap carries at least one health figure. A session of
    /// hand-entered laps carries none, and the strip is then absent, not empty.
    public static func hasHealthData(_ entry: LapChannels?) -> Bool {
        HEALTH_DEFS.contains { lapValue(entry, $0.key) != nil }
    }

    /// One readable lap of a session, keeping its channel index.
    public struct HealthLap: Equatable, Sendable {
        public var chIdx: Int
        public var entry: LapChannels
    }

    /// The laps of a session with anything to show.
    public static func healthLaps(_ channels: SessionChannels?) -> [HealthLap] {
        (channels?.laps ?? []).enumerated().compactMap { chIdx, entry in
            hasHealthData(entry) ? HealthLap(chIdx: chIdx, entry: entry) : nil
        }
    }

    /// One lap's value of one column.
    public struct SeriesPoint: Equatable, Sendable, Decodable {
        public var chIdx: Int
        public var v: Double

        public init(chIdx: Int, v: Double) {
            self.chIdx = chIdx
            self.v = v
        }
    }

    /// One column across the session, for the laps that carry it, in lap order.
    public static func scalarSeries(_ channels: SessionChannels?, _ key: String) -> [SeriesPoint] {
        (channels?.laps ?? []).enumerated().compactMap { chIdx, entry in
            lapValue(entry, key).map { SeriesPoint(chIdx: chIdx, v: $0) }
        }
    }

    /// Shading for one value. Both bounds are inclusive; a `low` column reads
    /// downward.
    public enum Status: String, Sendable, Codable {
        case ok
        /// Approaching the line.
        case low
        /// Past it.
        case due
    }

    /// nil when the column has no line.
    public static func healthStatus(_ def: Def?, _ v: Double?) -> Status? {
        guard let def, let watch = def.watch, let over = def.over, let v else { return nil }
        if def.low { return v <= over ? .due : (v <= watch ? .low : .ok) }
        return v >= over ? .due : (v >= watch ? .low : .ok)
    }

    /// The session's figure for a column, by its own rule: the worst case
    /// across laps — the maximum for a peak or an end-of-lap reading, the
    /// minimum for a minimum.
    public static func sessionExtreme(_ reduce: Reduce, _ series: [SeriesPoint]) -> SeriesPoint? {
        guard var best = series.first else { return nil }
        for s in series {
            if reduce == .min ? s.v < best.v : s.v > best.v { best = s }
        }
        return best
    }

    /// One column of the reduced strip.
    public struct Column: Equatable, Sendable {
        public var key: String
        public var series: [SeriesPoint]
        public var extreme: SeriesPoint
        public var status: Status?
    }

    /// One lap's row of the strip's table.
    public struct Row: Equatable, Sendable {
        public var chIdx: Int
        public var values: [String: Double]
    }

    /// The whole strip, reduced.
    public struct SessionHealth: Equatable, Sendable {
        public var laps: [Row]
        public var columns: [Column]
    }

    /// nil when no lap carries anything.
    public static func sessionHealth(_ channels: SessionChannels?) -> SessionHealth? {
        let laps = healthLaps(channels)
        guard !laps.isEmpty else { return nil }
        var columns: [Column] = []
        for def in HEALTH_DEFS {
            let series = scalarSeries(channels, def.key)
            guard let extreme = sessionExtreme(def.reduce, series) else { continue }
            columns.append(
                Column(key: def.key, series: series, extreme: extreme, status: healthStatus(def, extreme.v))
            )
        }
        let rows = laps.map { lap -> Row in
            var values: [String: Double] = [:]
            for c in columns {
                if let v = lapValue(lap.entry, c.key) { values[c.key] = v }
            }
            return Row(chIdx: lap.chIdx, values: values)
        }
        return SessionHealth(laps: rows, columns: columns)
    }

    // MARK: - Cross-corner spread

    /// Left minus right on each axle, and front minus rear as the axle means.
    public struct Spread: Equatable, Sendable, Decodable {
        public var front: Double
        public var rear: Double
        public var axle: Double
    }

    /// Cross-corner spread for one lap and one kind of reading (`"tyreC"` or
    /// `"tyreKpa"`). nil unless all four corners are present — three corners and
    /// a guess is not a spread.
    public static func tyreSpread(_ entry: LapChannels?, _ kind: String = "tyreC") -> Spread? {
        var c: [String: Double] = [:]
        for (corner, _) in TYRE_CORNERS {
            guard let v = lapValue(entry, "\(kind)\(corner)") else { return nil }
            c[corner] = v
        }
        return Spread(
            front: c["LF"]! - c["RF"]!,
            rear: c["LR"]! - c["RR"]!,
            axle: (c["LF"]! + c["RF"]!) / 2 - (c["LR"]! + c["RR"]!) / 2
        )
    }

    /// One lap's spread, with its channel index.
    public struct LapSpread: Equatable, Sendable, Decodable {
        public var chIdx: Int
        public var front: Double
        public var rear: Double
        public var axle: Double
    }

    /// The spread per lap across the session.
    public static func sessionSpread(_ channels: SessionChannels?, _ kind: String = "tyreC") -> [LapSpread] {
        (channels?.laps ?? []).enumerated().compactMap { chIdx, entry in
            tyreSpread(entry, kind).map {
                LapSpread(chIdx: chIdx, front: $0.front, rear: $0.rear, axle: $0.axle)
            }
        }
    }

    // MARK: - Fuel

    /// The burn rate and what is left at it.
    public struct FuelBurn: Equatable, Sendable, Decodable {
        public var perLapPct: Double
        public var lastPct: Double
        public var lapsRemaining: Int
        public var drops: Int
    }

    /// Fuel burn from the per-lap fuel level: the median of the drops between
    /// consecutive fuel-carrying laps (an increase is a refuel or sensor slosh
    /// and is skipped), and the laps left at that rate. nil below
    /// ``MIN_FUEL_DROPS`` drops — one drop is one lap's noise.
    public static func fuelBurn(_ channels: SessionChannels?) -> FuelBurn? {
        let s = scalarSeries(channels, "fuelPct")
        var drops: [Double] = []
        for i in 1..<max(1, s.count) {
            let d = s[i - 1].v - s[i].v
            if d > 0 { drops.append(d) }
        }
        guard drops.count >= MIN_FUEL_DROPS else { return nil }
        drops.sort()
        let mid = drops.count / 2
        let perLapPct = drops.count % 2 == 1 ? drops[mid] : (drops[mid - 1] + drops[mid]) / 2
        let lastPct = s[s.count - 1].v
        return FuelBurn(
            perLapPct: perLapPct, lastPct: lastPct,
            lapsRemaining: Int((lastPct / perLapPct).rounded(.down)), drops: drops.count
        )
    }

    // MARK: - Hot pressures

    /// One corner's hot pressure, in kPa as stored.
    public struct HotPressure: Equatable, Sendable, Decodable {
        public var peakKpa: Double
        public var peakChIdx: Int
        public var lastKpa: Double
    }

    /// Hot tyre pressures for the session, per corner: the highest end-of-lap
    /// reading (the pressure the tyre reached) with the lap it came from, and
    /// the last lap's reading. nil when no lap stored any corner.
    public static func hotPressures(_ channels: SessionChannels?) -> [String: HotPressure]? {
        var out: [String: HotPressure] = [:]
        for (corner, _) in TYRE_CORNERS {
            let s = scalarSeries(channels, "tyreKpa\(corner)")
            guard let peak = sessionExtreme(.max, s), let last = s.last else { continue }
            out[corner] = HotPressure(peakKpa: peak.v, peakChIdx: peak.chIdx, lastKpa: last.v)
        }
        return out.isEmpty ? nil : out
    }

    /// Round to the setup sheet's own step.
    public static func roundPsi(_ psi: Double) -> Double {
        jsRound(psi / PSI_STEP) * PSI_STEP
    }

    /// JavaScript's `Math.round`: halves go *up*, not away from zero, so −0.25
    /// rounds to −0 rather than −0.5 — which is where Swift's
    /// `.toNearestOrAwayFromZero` differs.
    private static func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

    /// What ``suggestCold(_:_:_:)`` works out.
    public struct ColdSuggestion: Equatable, Sendable, Decodable {
        public var coldPsi: Double
        public var hotPsi: Double
        public var targetPsi: Double
        public var suggestedPsi: Double
        public var deltaPsi: Double
    }

    /// The one arithmetic the web's pressure loop rests on: a tyre that grew
    /// from `cold` to `hot` gains the same amount next time, so to land on
    /// `target` hot, start from cold minus the overshoot. Rounded to the
    /// sheet's step. nil unless all three are known.
    ///
    /// The loop *around* this — reading the day's setup sheet and writing the
    /// next day's — is web-only, because the setup notebook is.
    public static func suggestCold(_ coldPsi: Double?, _ hotPsi: Double?, _ targetPsi: Double?) -> ColdSuggestion? {
        guard let coldPsi, let hotPsi, let targetPsi else { return nil }
        let suggested = roundPsi(coldPsi - (hotPsi - targetPsi))
        return ColdSuggestion(
            coldPsi: coldPsi, hotPsi: hotPsi, targetPsi: targetPsi,
            suggestedPsi: suggested, deltaPsi: suggested - coldPsi
        )
    }

    // MARK: - Units

    /// Two unit systems: ``metric`` is the stored one, ``us`` is what every
    /// client shows, since the rest of the logbook is in °F, mph and psi.
    public enum Units: String, Sendable {
        case metric
        case us
    }

    private struct UnitSpec {
        let unit: String
        let conv: (Double) -> Double
        let dp: Int
    }

    private static func unitSpec(_ def: Def, _ units: Units) -> UnitSpec {
        switch (def.unit, units) {
        case ("°C", .us): UnitSpec(unit: "°F", conv: cToF, dp: 0)
        case ("°C", .metric): UnitSpec(unit: "°C", conv: { $0 }, dp: 0)
        case ("kPa", .us): UnitSpec(unit: "psi", conv: kpaToPsi, dp: 1)
        case ("kPa", .metric): UnitSpec(unit: "kPa", conv: { $0 }, dp: 0)
        case ("V", _): UnitSpec(unit: "V", conv: { $0 }, dp: 1)
        default: UnitSpec(unit: "%", conv: { $0 }, dp: 0)
        }
    }

    /// A value formatted the way JavaScript's `toFixed` does — half away from
    /// zero, where Swift's `String(format:)` rounds half to even. One in twenty
    /// readings lands on a tie, and the fixture would catch it.
    private static func fixed(_ value: Double, _ dp: Int) -> String {
        let scale = pow(10.0, Double(dp))
        let rounded = (value * scale).rounded(.toNearestOrAwayFromZero) / scale
        return String(format: "%.\(dp)f", rounded)
    }

    /// A stored value in the given unit system.
    public struct Display: Equatable, Sendable, Decodable {
        public var value: Double
        public var unit: String
        public var dp: Int
        public var text: String
    }

    public static func displayValue(_ def: Def, _ v: Double, _ units: Units = .metric) -> Display {
        let u = unitSpec(def, units)
        let value = u.conv(v)
        return Display(value: value, unit: u.unit, dp: u.dp, text: "\(fixed(value, u.dp)) \(u.unit)")
    }

    /// A delta (spread) in the given unit system, signed. Temperature deltas
    /// scale but don't offset — +10 °C is +18 °F, not 50.
    public struct DisplayDelta: Equatable, Sendable, Decodable {
        public var value: Double
        public var unit: String
        public var text: String
    }

    public static func displayDelta(_ def: Def, _ d: Double, _ units: Units = .metric) -> DisplayDelta {
        let u = unitSpec(def, units)
        let value = def.unit == "°C" ? d * (units == .us ? 1.8 : 1) : u.conv(d)
        let dp = def.unit == "°C" ? 0 : u.dp
        return DisplayDelta(
            value: value, unit: u.unit, text: "\(value > 0 ? "+" : "")\(fixed(value, dp)) \(u.unit)"
        )
    }

    // MARK: - Stats line

    /// The stats-line sentence: every column past its watch line, worst first,
    /// plus the fuel outlook when there is one. Factual, no scolding. nil when
    /// nothing is past a line and there is no fuel figure.
    public static func healthSummary(_ channels: SessionChannels?, _ units: Units = .metric) -> String? {
        guard let sh = sessionHealth(channels) else { return nil }
        var parts: [String] = []
        // A stable sort, as the JS's is: `due` first, otherwise column order.
        let flagged = sh.columns.filter { $0.status == .due || $0.status == .low }
        let ordered = flagged.filter { $0.status == .due } + flagged.filter { $0.status == .low }
        for c in ordered {
            guard let def = defFor(c.key) else { continue }
            parts.append("\(def.label.lowercased()) \(displayValue(def, c.extreme.v, units).text)")
        }
        if let fuel = fuelBurn(channels) {
            parts.append("≈\(fuel.lapsRemaining) lap\(fuel.lapsRemaining == 1 ? "" : "s") of fuel at this rate")
        }
        return parts.isEmpty ? nil : "car: \(parts.joined(separator: ", "))"
    }
}
