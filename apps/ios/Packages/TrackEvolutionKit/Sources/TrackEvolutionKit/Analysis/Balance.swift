import Foundation

/// Rotation — understeer or oversteer (#189) — the port of the pure half of
/// `public/js/balance.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`BalanceTests`), and the output is
/// pinned against the web implementation by `contracts/logic/balance.json`.
/// Only the maths crosses over: the SVG scatter, the HTML table and the hover
/// wiring are the web's, and `BalanceScatter` draws the phone's version.
///
/// A PDR import stores `yaw` (yaw rate, °/s, signed) and `steering`
/// (steering-wheel angle, °, signed) per lap on the driven-distance grid. Alone
/// the yaw trace is another squiggle. Against the steering trace it is a
/// balance diagnosis: in a neutral car the rotation follows the steering; when
/// the driver adds steering and the car does not rotate to match, the front is
/// washing out — understeer; when the car rotates more than the steering asked
/// for, the rear is coming round — oversteer. Amateurs nearly always believe
/// they are oversteering when they are understeering, because understeer feels
/// like nothing happening, and this view exists to settle that argument with
/// the car's own numbers.
///
/// The rigorous version is the bicycle model: expected yaw rate = v·δ/L, with δ
/// the *road-wheel* angle (steering-wheel angle ÷ steering ratio) and L the
/// wheelbase. Neither the ratio nor the wheelbase is stored, and the ratio is
/// non-linear with lock on some cars, so v1 is deliberately **relative**: the
/// session's own median yaw-per-degree-per-metre-per-second over every
/// cornering sample is taken as this car's typical response
/// (``referenceGain(_:sign:)``, which absorbs 1/(L·ratio)), and each corner is
/// read against it. The consequence is stated wherever the figures are shown: a
/// car that pushes in every corner reads neutral in every corner. What the view
/// does find is the corner that behaves differently from the rest — which is
/// the one worth taking to the setup sheet.
///
/// Two data facts shape everything here, and this port inherits both. The sign
/// conventions of `yaw` and `steering` are the recorder's, not ours, and
/// nothing guarantees they agree — so the alignment is *measured* per session
/// (``yawSign(_:)``, the sign of Σ steering·yaw over the cornering samples)
/// rather than assumed. And the 20 m grid smooths transients: yaw builds a beat
/// after the steering goes on at entry and decays a beat after it comes off at
/// exit, so single samples scatter around the line and only the sum over a
/// whole corner is a reading. The read-out therefore works per corner, never
/// per sample, and the scatter is there to show the shape.
public enum Balance {
    /// Below this steering-wheel angle the yaw-per-degree ratio is noise divided
    /// by noise; such samples plot but never count. Display semantics, tune
    /// against real footage.
    public static let MIN_STEER_DEG: Double = 10

    /// Below this speed the car is in the pits or the paddock, not cornering.
    public static let MIN_SPEED_KPH: Double = 30

    /// A corner whose rotation sits within this much of the reference reads
    /// neutral; beyond ``SLIGHT_PCT`` the word drops its "slight".
    public static let NEUTRAL_PCT: Double = 8
    public static let SLIGHT_PCT: Double = 20

    private static let KPH_TO_MPS = 1.0 / 3.6

    /// True when the lap stored the three channels the diagnosis reads.
    public static func hasBalanceData(_ entry: LapChannels?) -> Bool {
        guard let entry else { return false }
        return entry.yaw != nil && entry.steering != nil && entry.speed != nil
    }

    /// One readable lap of a session, keeping its channel index.
    public struct BalanceLap: Equatable, Sendable {
        public var chIdx: Int
        public var entry: LapChannels
    }

    /// The laps of a session that can be read.
    public static func balanceLaps(_ channels: SessionChannels?) -> [BalanceLap] {
        (channels?.laps ?? []).enumerated().compactMap { chIdx, entry in
            hasBalanceData(entry) ? BalanceLap(chIdx: chIdx, entry: entry) : nil
        }
    }

    /// The grid points a lap covers with all three channels.
    private static func usableLength(_ entry: LapChannels) -> Int {
        guard let yaw = entry.yaw, let steering = entry.steering, let speed = entry.speed else { return 0 }
        return min(yaw.count, steering.count, speed.count)
    }

    /// Whether grid point k of a lap counts toward a reading: enough steering to
    /// divide by, and moving.
    public static func usableAt(_ entry: LapChannels?, _ k: Int) -> Bool {
        guard let entry, hasBalanceData(entry), k >= 0, k < usableLength(entry) else { return false }
        return abs(entry.steering![k]) >= MIN_STEER_DEG && entry.speed![k] >= MIN_SPEED_KPH
    }

    /// Which way the recorder's yaw runs relative to its steering: +1 when a
    /// positive steering angle produces a positive yaw rate, -1 when the two
    /// conventions oppose. Measured over every usable sample of every readable
    /// lap; +1 when there is nothing to measure. See the type's documentation.
    public static func yawSign(_ channels: SessionChannels?) -> Double {
        var sum: Double = 0
        for lap in balanceLaps(channels) {
            let n = usableLength(lap.entry)
            for k in 0..<n where usableAt(lap.entry, k) {
                sum += lap.entry.steering![k] * lap.entry.yaw![k]
            }
        }
        return sum < 0 ? -1 : 1
    }

    /// One sample's yaw gain: aligned yaw rate per degree of steering per metre
    /// per second — the bicycle model's 1/(L·ratio), in 1/m. nil when the sample
    /// is not usable.
    public static func yawGain(_ entry: LapChannels?, _ k: Int, _ sign: Double = 1) -> Double? {
        guard let entry, usableAt(entry, k) else { return nil }
        return (entry.yaw![k] * sign) / (entry.speed![k] * KPH_TO_MPS * entry.steering![k])
    }

    /// The median of a list, or nil for an empty one.
    public static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let s = values.sorted()
        let mid = s.count / 2
        return s.count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }

    /// This car's typical response today: the median yaw gain over every usable
    /// sample of every readable lap. nil when there is none.
    public static func referenceGain(_ channels: SessionChannels?, sign: Double? = nil) -> Double? {
        let s = sign ?? yawSign(channels)
        var gains: [Double] = []
        for lap in balanceLaps(channels) {
            let n = usableLength(lap.entry)
            for k in 0..<n {
                if let g = yawGain(lap.entry, k, s) { gains.append(g) }
            }
        }
        return median(gains)
    }

    /// One scatter point: `steer` the steering angle as stored, `rot` the
    /// aligned yaw rate ÷ speed (°/m — the curvature the car actually took) and
    /// `speed` in km/h. `usable` is false for a sample that plots but doesn't
    /// count toward a reading.
    public struct Point: Equatable, Sendable, Decodable {
        public var k: Int
        public var steer: Double
        public var rot: Double
        public var speed: Double
        public var usable: Bool

        public init(k: Int, steer: Double, rot: Double, speed: Double, usable: Bool) {
            self.k = k
            self.steer = steer
            self.rot = rot
            self.speed = speed
            self.usable = usable
        }
    }

    /// One lap as scatter points — one per grid sample carrying all three
    /// channels. A stationary sample has no rotation per metre and is skipped.
    public static func balancePoints(_ entry: LapChannels?, _ sign: Double = 1) -> [Point] {
        guard let entry, hasBalanceData(entry) else { return [] }
        var out: [Point] = []
        for k in 0..<usableLength(entry) {
            let v = entry.speed![k] * KPH_TO_MPS
            guard v > 0 else { continue }
            out.append(
                Point(
                    k: k, steer: entry.steering![k], rot: (entry.yaw![k] * sign) / v,
                    speed: entry.speed![k], usable: usableAt(entry, k)
                )
            )
        }
        return out
    }

    /// How one lap took one corner: the sum over its usable samples of the
    /// rotation the steering asked for (`expected`, |refGain·v·δ|) and the
    /// rotation the car delivered projected onto it (`actual`), their `ratio`,
    /// and `pct` = (ratio − 1)·100 — negative is understeer. Sums rather than a
    /// mean of per-sample ratios, so a barely-steering sample can't blow the
    /// reading up.
    public struct Reading: Equatable, Sendable, Decodable {
        public var expected: Double
        public var actual: Double
        public var samples: Int
        public var ratio: Double
        public var pct: Double

        public init(expected: Double, actual: Double, samples: Int) {
            self.expected = expected
            self.actual = actual
            self.samples = samples
            ratio = actual / expected
            pct = (actual / expected - 1) * 100
        }
    }

    /// nil when the corner holds no usable sample of this lap, the reference
    /// isn't positive, or the lap can't be read.
    public static func cornerBalance(
        _ entry: LapChannels?, _ corner: Corners.Corner, _ refGain: Double, _ sign: Double = 1
    ) -> Reading? {
        guard let entry, hasBalanceData(entry), refGain > 0 else { return nil }
        var expected: Double = 0, actual: Double = 0, samples = 0
        let n = usableLength(entry)
        var k = corner.k0
        while k <= corner.k1 && k < n {
            defer { k += 1 }
            guard usableAt(entry, k) else { continue }
            let e = refGain * entry.speed![k] * KPH_TO_MPS * entry.steering![k]
            expected += abs(e)
            // JavaScript's Math.sign: 0 for a zero expectation, which contributes
            // nothing rather than flipping the projection.
            actual += entry.yaw![k] * sign * (e > 0 ? 1 : (e < 0 ? -1 : 0))
            samples += 1
        }
        guard samples > 0, expected > 0 else { return nil }
        return Reading(expected: expected, actual: actual, samples: samples)
    }

    /// The word for a reading. Negative pct is the front washing out.
    public static func balanceLabel(_ pct: Double) -> String {
        let a = abs(pct)
        if a < NEUTRAL_PCT { return "neutral" }
        let word = pct < 0 ? "understeer" : "oversteer"
        return a < SLIGHT_PCT ? "slight \(word)" : word
    }

    /// The word with its magnitude: "understeer 14%", "slight oversteer 9%",
    /// "neutral".
    public static func fmtBalance(_ pct: Double) -> String {
        let label = balanceLabel(pct)
        return label == "neutral" ? label : "\(label) \(Int(abs(pct).rounded()))%"
    }

    /// One corner's row in the read-out: the corner, one reading per readable
    /// lap in channel order, and the same sums pooled across every readable lap.
    public struct CornerBalance: Equatable, Sendable {
        public var corner: Corners.Corner
        public var laps: [LapReading]
        public var all: Reading
    }

    /// One lap's reading of one corner.
    public struct LapReading: Equatable, Sendable, Decodable {
        public var chIdx: Int
        public var expected: Double
        public var actual: Double
        public var samples: Int
        public var ratio: Double
        public var pct: Double
    }

    /// A session reduced for the read-out.
    public struct SessionBalance: Equatable, Sendable {
        public var sign: Double
        public var refGain: Double
        public var corners: [CornerBalance]
    }

    /// nil when no lap stored the three channels, no lap stored `latG` to find
    /// corners in, or the reference can't be established.
    public static func sessionBalance(_ channels: SessionChannels?) -> SessionBalance? {
        let laps = balanceLaps(channels)
        guard !laps.isEmpty else { return nil }
        let corners = Corners.sessionCorners(channels)
        guard !corners.isEmpty else { return nil }
        let sign = yawSign(channels)
        guard let refGain = referenceGain(channels, sign: sign), refGain > 0 else { return nil }
        var rows: [CornerBalance] = []
        for c in corners {
            var perLap: [LapReading] = []
            var expected: Double = 0, actual: Double = 0, samples = 0
            for lap in laps {
                guard let cb = cornerBalance(lap.entry, c, refGain, sign) else { continue }
                perLap.append(
                    LapReading(
                        chIdx: lap.chIdx, expected: cb.expected, actual: cb.actual,
                        samples: cb.samples, ratio: cb.ratio, pct: cb.pct
                    )
                )
                expected += cb.expected
                actual += cb.actual
                samples += cb.samples
            }
            guard !perLap.isEmpty else { continue }
            rows.append(
                CornerBalance(
                    corner: c, laps: perLap,
                    all: Reading(expected: expected, actual: actual, samples: samples)
                )
            )
        }
        return rows.isEmpty ? nil : SessionBalance(sign: sign, refGain: refGain, corners: rows)
    }

    /// Corners named when there are a few, counted when there are many —
    /// "T1, T4" reads; "T1, T3, T5, T7, T9, T11" doesn't.
    private static let MAX_NAMED_CORNERS = 3

    private static func namedOrCounted(_ corners: [CornerBalance]) -> String {
        if corners.count <= MAX_NAMED_CORNERS {
            return corners.map { Corners.cornerLabel($0.corner) }.joined(separator: ", ")
        }
        return "\(corners.count) corners"
    }

    /// One line for the session stats: "understeer in T1, T4 and oversteer in
    /// T10", one half when only one side shows, "balance neutral" when every
    /// corner reads neutral against the reference. nil when the session can't be
    /// read. Pooled across laps, like the rest of the stats line.
    public static func balanceSummary(_ channels: SessionChannels?) -> String? {
        guard let sb = sessionBalance(channels) else { return nil }
        let us = sb.corners.filter { $0.all.pct <= -NEUTRAL_PCT }
        let os = sb.corners.filter { $0.all.pct >= NEUTRAL_PCT }
        var parts: [String] = []
        if !us.isEmpty { parts.append("understeer in \(namedOrCounted(us))") }
        if !os.isEmpty { parts.append("oversteer in \(namedOrCounted(os))") }
        return parts.isEmpty ? "balance neutral" : parts.joined(separator: " and ")
    }

    // MARK: - Steering ratio and understeer gradient, measured (#223)
    //
    // The port of `steeringFit` and its companions in `public/js/balance.js` —
    // read that file's header for the physics. The bicycle model's steady-state
    // yaw rate is r = v·δ/(L·(1 + K·v²)) with δ = steering_deg / ratio, so the
    // per-sample gain is 1/(ratio·L·(1 + K·v²)): at low speed the ratio falls
    // out given the wheelbase, and the way the gain falls with speed is the
    // understeer gradient K. The textbook fit is 1/gain against v²; solved here
    // as v·δ = A·(yaw·sign) + B·(v²·yaw·sign), which is the same two unknowns
    // with nothing divided by yaw — on the 20 m grid yaw passes through zero
    // while the wheel is already turned, and one such sample would set a line
    // fitted in 1/gain. The operation order is the JS's, which is what lets the
    // fixture pin the doubles.

    /// Fewer usable samples than this and the fit is a guess.
    public static let MIN_FIT_SAMPLES = 20

    /// A session driven at one speed has no slope to fit.
    public static let MIN_SPEED_SPREAD_KPH: Double = 40

    /// Below this share of the steering input explained, the car doesn't fit
    /// one ratio and the measured line says so.
    public static let MIN_FIT_R2: Double = 0.8

    /// A typed ratio within this much of the measured one "matches".
    public static let RATIO_AGREE_PCT: Double = 10

    /// One session's fit: the low-speed yaw gain (1/m), the understeer gradient
    /// in the (1 + K·v²) form with v in m/s (s²/m²), the usable sample count and
    /// the uncentred r² of the steering input the model explains, in [0, 1].
    public struct Fit: Equatable, Sendable, Codable {
        public var gain0: Double
        public var K: Double
        public var samples: Int
        public var r2: Double

        public init(gain0: Double, K: Double, samples: Int, r2: Double) {
            self.gain0 = gain0
            self.K = K
            self.samples = samples
            self.r2 = r2
        }
    }

    /// nil under ``MIN_FIT_SAMPLES``, under ``MIN_SPEED_SPREAD_KPH`` of speed
    /// spread, or when the normal equations are singular or give a non-positive
    /// intercept.
    public static func steeringFit(_ channels: SessionChannels?) -> Fit? {
        let sign = yawSign(channels)
        var s11 = 0.0, s12 = 0.0, s22 = 0.0, t1 = 0.0, t2 = 0.0, szz = 0.0
        var n = 0
        var vMin = Double.infinity, vMax = -Double.infinity
        for lap in balanceLaps(channels) {
            let entry = lap.entry
            for k in 0..<usableLength(entry) where usableAt(entry, k) {
                let kph = entry.speed![k]
                let v = kph * KPH_TO_MPS
                let u1 = entry.yaw![k] * sign
                let u2 = v * v * u1
                let z = v * entry.steering![k]
                s11 += u1 * u1
                s12 += u1 * u2
                s22 += u2 * u2
                t1 += u1 * z
                t2 += u2 * z
                szz += z * z
                n += 1
                if kph < vMin { vMin = kph }
                if kph > vMax { vMax = kph }
            }
        }
        if n < MIN_FIT_SAMPLES || vMax - vMin < MIN_SPEED_SPREAD_KPH { return nil }
        let det = s11 * s22 - s12 * s12
        guard det > 0 else { return nil }
        let A = (t1 * s22 - t2 * s12) / det
        let B = (t2 * s11 - t1 * s12) / det
        guard A > 0 else { return nil }
        let ssRes = szz - 2 * (A * t1 + B * t2) + (A * A * s11 + 2 * A * B * s12 + B * B * s22)
        let r2 = szz > 0 ? min(1, max(0, 1 - ssRes / szz)) : 0
        return Fit(gain0: 1 / A, K: B / A, samples: n, r2: r2)
    }

    /// Several sessions pooled into one ratio: the median of 1/(gain₀·L) across
    /// the sessions that fit, their count, and the median r².
    public struct RatioEstimate: Equatable, Sendable, Codable {
        public var ratio: Double
        public var sessions: Int
        public var r2: Double

        public init(ratio: Double, sessions: Int, r2: Double) {
            self.ratio = ratio
            self.sessions = sessions
            self.r2 = r2
        }
    }

    /// nil without a wheelbase — there is nothing to compute — or without a fit;
    /// nils in `fits` are skipped, so one damp session doesn't set the number.
    public static func estimateSteeringRatio(_ fits: [Fit?], wheelbaseMm: Int?) -> RatioEstimate? {
        guard let wheelbaseMm, wheelbaseMm > 0 else { return nil }
        let L = Double(wheelbaseMm) / 1000
        let usable = fits.compactMap { $0 }.filter { $0.gain0 > 0 }
        guard !usable.isEmpty,
              let ratio = median(usable.map { 1 / ($0.gain0 * L) }),
              let r2 = median(usable.map(\.r2))
        else { return nil }
        return RatioEstimate(ratio: ratio, sessions: usable.count, r2: r2)
    }

    /// A ratio as the form shows it: two decimals, trailing zeros dropped —
    /// "16.25", "15.7", "12". `String(Number(ratio.toFixed(2)))` in the JS.
    public static func fmtSteeringRatio(_ ratio: Double) -> String {
        let fixed = Units.toFixed(ratio, 2)
        guard fixed.contains(".") else { return fixed }
        var trimmed = fixed
        while trimmed.hasSuffix("0") { trimmed.removeLast() }
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        return trimmed
    }

    /// The value "Use this" writes into the field: the measured ratio to the
    /// field's own two decimals.
    public static func measuredRatioValue(_ estimate: RatioEstimate) -> Double {
        (estimate.ratio * 100).rounded(.toNearestOrAwayFromZero) / 100
    }

    /// Whether a typed ratio agrees with the measured one, within ``RATIO_AGREE_PCT``.
    public static func ratioAgrees(_ estimate: RatioEstimate, _ typed: Double?) -> Bool {
        guard let typed else { return false }
        return (abs(typed - estimate.ratio) / estimate.ratio) * 100 <= RATIO_AGREE_PCT
    }

    /// The one line under the steering-ratio field: "Measured from 6 sessions:
    /// 15.8:1", with "— matches" or "— your 12:1 is well off this; check the
    /// units" when the field holds a number, and a caveat when the sessions
    /// don't fit one ratio. nil when nothing can be measured yet — the line is
    /// then absent, not "not enough data".
    public static func measuredRatioLine(_ estimate: RatioEstimate?, typed: Double?) -> String? {
        guard let estimate else { return nil }
        let n = estimate.sessions
        var line = "Measured from \(n) session\(n == 1 ? "" : "s"): \(Units.toFixed(estimate.ratio, 1)):1"
        if estimate.r2 < MIN_FIT_R2 { line += " (varies with speed — a single ratio is approximate)" }
        if let typed {
            line += ratioAgrees(estimate, typed)
                ? " — matches"
                : " — your \(fmtSteeringRatio(typed)):1 is well off this; check the units"
        }
        return line
    }
}
