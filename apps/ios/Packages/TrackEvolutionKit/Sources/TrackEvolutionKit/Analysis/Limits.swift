import Foundation

/// Where the car is at its limit (#188) — the port of `public/js/limits.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`LimitsTests`), and the output is
/// pinned against the web implementation by `contracts/logic/limits.json`.
///
/// Two of a PDR import's stored channels answer a question that is spatial
/// rather than temporal. `wheelSlip` is (driven − non-driven) wheelspeed as a
/// percent — positive under wheelspin, negative under lockup — and `flags`
/// packs ABS (bit 0), traction control (bit 1) and stability control (bit 2),
/// OR-ed across each 20 m grid window so a half-second ABS event isn't missed
/// between samples. Nobody wants a line chart of either; what a driver wants is
/// *where* the car let go, which is a handful of specific places on the track —
/// so this reduces both channels to runs of grid points per kind, and places
/// those runs on the stored best-lap trace by matching driven distance.
///
/// Colour is by kind, not severity: a corner where traction control cuts is a
/// throttle problem, one where ABS cuts is a braking problem, and the driver
/// needs to know which. And the read-out reports rather than scolds — "ABS
/// active" is a fact; "you're braking too hard" is a guess. A session whose
/// systems never fired says "no interventions": TC/VSC read zero all day with
/// the systems switched off, which is normal on track, and "off" and "never
/// needed" are indistinguishable.
public enum Limits {
    /// Display semantics, not physics: slip above this is wheelspin, below the
    /// negative one is lockup. Tune against real footage.
    public static let WHEELSPIN_PCT: Double = 2
    public static let LOCKUP_PCT: Double = -2

    public static let FLAG_ABS = 1
    public static let FLAG_TC = 2
    public static let FLAG_VSC = 4

    /// Runs of one kind separated by at most this many clear grid points are one
    /// place — an ABS pulse train across a braking zone is one braking zone, not
    /// four. 2 points = 40 m at the 20 m grid.
    public static let MERGE_GAP_POINTS = 2

    /// Which colour a kind draws in. Braking-side events (ABS, lockup) share one
    /// hue, power-side (traction control, wheelspin) another, stability its own.
    public enum Side: String, Sendable {
        case brake
        case power
        case stability
    }

    /// The second encoding beside colour, so the two events of one side are
    /// never colour-alone.
    public enum Shape: String, Sendable {
        case circle
        case triangle
        case diamond
    }

    /// One kind of limit event. `channel` is the chart whose trace the kind's
    /// bands shade.
    public struct Kind: Equatable, Sendable {
        public var key: String
        public var label: String
        public var side: Side
        public var shape: Shape
        public var filled: Bool
        public var channel: ChannelGraphs.Channel
    }

    /// The kinds, in render and report order.
    public static let LIMIT_KINDS: [Kind] = [
        Kind(key: "abs", label: "ABS", side: .brake, shape: .circle, filled: true, channel: .brake),
        Kind(key: "lockup", label: "Lockup", side: .brake, shape: .circle, filled: false, channel: .brake),
        Kind(key: "tc", label: "Traction control", side: .power, shape: .triangle, filled: true, channel: .throttle),
        Kind(key: "wheelspin", label: "Wheelspin", side: .power, shape: .triangle, filled: false, channel: .throttle),
        Kind(key: "vsc", label: "Stability control", side: .stability, shape: .diamond, filled: true, channel: .steering),
    ]

    public static func kindDef(_ key: String) -> Kind? {
        LIMIT_KINDS.first { $0.key == key }
    }

    /// True when the lap stored something this module can read.
    public static func hasLimitData(_ entry: LapChannels) -> Bool {
        entry.flags != nil || entry.wheelSlip != nil
    }

    /// Whether `kind` is active at grid point k of a lap; nil when the lap
    /// doesn't carry the channel the kind reads.
    public static func limitAt(_ entry: LapChannels, _ kind: String, _ k: Int) -> Bool? {
        switch kind {
        case "abs", "tc", "vsc":
            guard let f = entry.flags, k < f.count else { return nil }
            let bit = kind == "abs" ? FLAG_ABS : kind == "tc" ? FLAG_TC : FLAG_VSC
            return (jsInt32(f[k]) & bit) != 0
        case "wheelspin", "lockup":
            guard let s = entry.wheelSlip, k < s.count else { return nil }
            return kind == "wheelspin" ? s[k] > WHEELSPIN_PCT : s[k] < LOCKUP_PCT
        default:
            return nil
        }
    }

    /// JavaScript's ToInt32, which is what `&` does to a number before masking.
    private static func jsInt32(_ value: Double) -> Int {
        guard value.isFinite else { return 0 }
        let truncated = value.rounded(.towardZero)
        let wrapped = truncated.truncatingRemainder(dividingBy: 4_294_967_296)
        return Int(Int32(truncatingIfNeeded: Int64(wrapped)))
    }

    /// An inclusive run of grid points.
    public struct Run: Equatable, Sendable, Decodable {
        public var k0: Int
        public var k1: Int

        public init(k0: Int, k1: Int) {
            self.k0 = k0
            self.k1 = k1
        }
    }

    /// Runs of true in a boolean series, merged across gaps of at most
    /// `mergeGap` false points.
    public static func booleanRuns(_ series: [Bool], _ mergeGap: Int = MERGE_GAP_POINTS) -> [Run] {
        var out: [Run] = []
        var k0 = -1
        for k in 0...series.count {
            let on = k < series.count && series[k]
            if on {
                if k0 < 0 { k0 = k }
            } else if k0 >= 0 {
                // Merge with the previous run when the gap between them is short.
                if let prev = out.last, k0 - prev.k1 - 1 <= mergeGap {
                    out[out.count - 1].k1 = k - 1
                } else {
                    out.append(Run(k0: k0, k1: k - 1))
                }
                k0 = -1
            }
        }
        return out
    }

    /// One limit event: an inclusive run of grid points of a single kind.
    public struct LimitRun: Equatable, Sendable, Decodable {
        public var kind: String
        public var k0: Int
        public var k1: Int

        public init(kind: String, k0: Int, k1: Int) {
            self.kind = kind
            self.k0 = k0
            self.k1 = k1
        }
    }

    /// Every limit event in one stored lap, in `LIMIT_KINDS` order then by
    /// distance. Kinds whose channel the lap lacks contribute nothing.
    public static func limitRuns(_ entry: LapChannels, _ mergeGap: Int = MERGE_GAP_POINTS) -> [LimitRun] {
        var out: [LimitRun] = []
        for kind in LIMIT_KINDS {
            let n = kind.key == "wheelspin" || kind.key == "lockup"
                ? entry.wheelSlip?.count ?? 0
                : entry.flags?.count ?? 0
            guard n > 0 else { continue }
            let series = (0..<n).map { limitAt(entry, kind.key, $0) == true }
            for run in booleanRuns(series, mergeGap) {
                out.append(LimitRun(kind: kind.key, k0: run.k0, k1: run.k1))
            }
        }
        return out
    }

    /// The kinds active at grid point k of a lap, as labels — the read-out
    /// suffix.
    public static func activeLimitLabels(_ entry: LapChannels, _ k: Int) -> [String] {
        LIMIT_KINDS.filter { limitAt(entry, $0.key, k) == true }.map(\.label)
    }

    /// One kind's tally across a session. `places` is the number of distinct
    /// stretches of track where *any* lap hit that kind (the union across laps,
    /// merged like a single lap's runs), `laps` how many laps did.
    public struct KindTally: Equatable, Sendable, Decodable {
        public var kind: String
        public var places: Int
        public var laps: Int

        public init(kind: String, places: Int, laps: Int) {
            self.kind = kind
            self.places = places
            self.laps = laps
        }
    }

    /// A session's limit events reduced per kind, for every kind the session
    /// could read.
    public struct SessionLimits: Equatable, Sendable, Decodable {
        public var kinds: [KindTally]
        public var hasFlags: Bool
        public var hasSlip: Bool

        public init(kinds: [KindTally], hasFlags: Bool, hasSlip: Bool) {
            self.kinds = kinds
            self.hasFlags = hasFlags
            self.hasSlip = hasSlip
        }
    }

    /// nil when no lap stored flags or slip.
    public static func sessionLimits(_ channels: SessionChannels, _ mergeGap: Int = MERGE_GAP_POINTS) -> SessionLimits? {
        let laps = channels.laps.filter(hasLimitData)
        guard !laps.isEmpty else { return nil }
        let hasFlags = laps.contains { $0.flags != nil }
        let hasSlip = laps.contains { $0.wheelSlip != nil }
        var kinds: [KindTally] = []
        for kind in LIMIT_KINDS {
            let isSlip = kind.key == "wheelspin" || kind.key == "lockup"
            guard isSlip ? hasSlip : hasFlags else { continue }
            let n = laps.map { isSlip ? $0.wheelSlip?.count ?? 0 : $0.flags?.count ?? 0 }.max() ?? 0
            var union = [Bool](repeating: false, count: n)
            var lapCount = 0
            for l in laps {
                var hit = false
                for k in 0..<n where limitAt(l, kind.key, k) == true {
                    union[k] = true
                    hit = true
                }
                if hit { lapCount += 1 }
            }
            kinds.append(KindTally(kind: kind.key, places: booleanRuns(union, mergeGap).count, laps: lapCount))
        }
        return SessionLimits(kinds: kinds, hasFlags: hasFlags, hasSlip: hasSlip)
    }

    /// One line for the session stats: "ABS in 3 places, wheelspin in 2 places"
    /// — or "no interventions" when the systems never fired and the wheels never
    /// slipped. nil when the session stored neither channel.
    public static func limitSummary(_ channels: SessionChannels) -> String? {
        guard let sl = sessionLimits(channels) else { return nil }
        let parts = sl.kinds
            .filter { $0.places > 0 }
            .map { "\(sentenceLabel($0.kind)) in \($0.places) place\($0.places == 1 ? "" : "s")" }
        return parts.isEmpty ? "no interventions" : parts.joined(separator: ", ")
    }

    /// A kind's label as it reads mid-sentence: acronyms keep their case.
    public static func sentenceLabel(_ kind: String) -> String {
        guard let label = kindDef(kind)?.label else { return kind }
        return label == label.uppercased() ? label : label.lowercased()
    }

    /// A limit run placed on the stored trace.
    public struct Marker: Equatable, Sendable, Decodable {
        public var kind: String
        public var k0: Int
        public var k1: Int
        /// Index into the trace the run's mid-point lands on.
        public var idx: Int

        public init(kind: String, k0: Int, k1: Int, idx: Int) {
            self.kind = kind
            self.k0 = k0
            self.k1 = k1
            self.idx = idx
        }
    }

    /// Place one lap's limit runs on a stored trace (the best lap's racing line,
    /// time-sampled) by driven distance: each run's mid-point is taken as a
    /// fraction of the lap's grid length and looked up along the trace's
    /// cumulative length. The trace is the best lap only, so callers pass the
    /// best lap's channel entry — matching another lap's runs onto it would put
    /// marks where that lap never was.
    public static func limitMarkers(_ entry: LapChannels, _ dStepM: Double, _ trace: [TracePoint]?) -> [Marker] {
        guard let trace, trace.count >= 2 else { return [] }
        let runs = limitRuns(entry)
        guard !runs.isEmpty else { return [] }
        let n = max(entry.speed?.count ?? 0, max(entry.flags?.count ?? 0, entry.wheelSlip?.count ?? 0))
        let lapLen = Double(n - 1) * dStepM
        guard lapLen > 0 else { return [] }
        var cum = [Double](repeating: 0, count: trace.count)
        for i in 1..<trace.count {
            cum[i] = cum[i - 1] + hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y)
        }
        let total = cum[trace.count - 1]
        guard total > 0 else { return [] }
        return runs.map { r in
            let target = min(1, (Double(r.k0 + r.k1) / 2 * dStepM) / lapLen) * total
            var idx = 0
            while idx < trace.count - 1 && cum[idx] < target { idx += 1 }
            return Marker(kind: r.kind, k0: r.k0, k1: r.k1, idx: idx)
        }
    }
}
