import Foundation

/// Gear ribbon and shift points (#187) — the port of `public/js/gears.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`GearsTests`), and the output is pinned
/// against the web implementation by `contracts/logic/gears.json` — this port
/// asserts against the reference, never against the Kotlin one.
///
/// A PDR import stores `gear` per lap on the driven-distance grid
/// (`LapChannels.buildLapChannels`) — 1–8, with 0 meaning clutch-in / no gear,
/// sampled by holding the last value because it is an enum, not a measurement.
/// Wrong gear in a corner is the most common correctable mistake an amateur
/// makes and it is invisible in a lap time; as a step change on the distance
/// axis it is instantly visible, and against a second lap it becomes a
/// sentence: "T5 in 3rd on the best lap, 4th on this one".
///
/// `gearSegments` cuts a lap into runs of one gear (the ribbon's blocks);
/// `lapShifts` finds where the gear steps and reads the rpm at the sample
/// *before* the step — mind the 20 m grid: a shift takes ~0.3 s, about one grid
/// point at speed, so the figure is a touch low and is labelled approximate;
/// `shiftPoints` reduces a session's upshifts to min / median / max rpm per
/// gear, which is what turns short-shifting and bouncing off the limiter into a
/// number each. `gearDisagreements` is the comparison rule.
public enum Gears {
    /// A run of differing gears shorter than this (3 points = 60 m at the 20 m
    /// grid) is a shift that landed on a different sample, not a different gear
    /// choice. Display semantics, not physics — tune against real footage.
    public static let MIN_DISAGREE_POINTS = 3

    /// An upshift more than this many rpm below the session's highest per-gear
    /// median is worth a sentence ("shifting earlier from 4th than from 2nd").
    public static let SHORT_SHIFT_RPM: Double = 500

    /// A gear whose latest upshift comes within this of the session's highest
    /// rpm sample was taken to the top of the rev range.
    public static let REV_LIMIT_MARGIN_RPM: Double = 100

    /// Fewer upshifts than this from one gear is not a pattern.
    public static let MIN_SHIFTS_FOR_NOTE = 2

    // MARK: - Formatting

    /// "3rd", "4th" … — gear 0 is "no gear".
    public static func ordinal(_ gear: Double) -> String {
        guard gear > 0 else { return "no gear" }
        let g = Int(gear)
        let s: String
        if g % 10 == 1 && g != 11 {
            s = "st"
        } else if g % 10 == 2 && g != 12 {
            s = "nd"
        } else if g % 10 == 3 && g != 13 {
            s = "rd"
        } else {
            s = "th"
        }
        return "\(g)\(s)"
    }

    /// Whole rpm with thousands separators, locale-independent so tests and the
    /// fixture are deterministic.
    public static func fmtRpm(_ value: Double) -> String {
        let rounded = JSMath.roundToInt(value) ?? 0
        let negative = rounded < 0
        var digits = String(abs(rounded))
        var out = ""
        while digits.count > 3 {
            let cut = digits.index(digits.endIndex, offsetBy: -3)
            out = "," + digits[cut...] + out
            digits = String(digits[..<cut])
        }
        return (negative ? "-" : "") + digits + out
    }

    // MARK: - Segments

    /// A run of one gear along a lap's grid, `k0...k1` inclusive grid indexes.
    public struct GearRun: Equatable, Sendable, Decodable {
        public var gear: Double
        public var k0: Int
        public var k1: Int

        public init(gear: Double, k0: Int, k1: Int) {
            self.gear = gear
            self.k0 = k0
            self.k1 = k1
        }
    }

    /// Runs of one gear along a lap's grid, in order and covering every point.
    /// Gear 0 runs are kept — the ribbon renders them as gaps, and the
    /// disagreement rule needs to know they are there.
    public static func gearSegments(_ gear: [Double]?) -> [GearRun] {
        guard let gear, !gear.isEmpty else { return [] }
        var out: [GearRun] = []
        var k0 = 0
        for k in 1...gear.count where k == gear.count || gear[k] != gear[k0] {
            out.append(GearRun(gear: gear[k0], k0: k0, k1: k - 1))
            k0 = k
        }
        return out
    }

    // MARK: - Shifts

    /// One gear change in a stored lap: `k` is the first grid point in the new
    /// gear, `rpm` the reading at the last point in the old gear (nil when the
    /// lap stored no rpm).
    public struct Shift: Equatable, Sendable, Decodable {
        public var k: Int
        public var from: Double
        public var to: Double
        public var up: Bool
        public var rpm: Double?

        public init(k: Int, from: Double, to: Double, up: Bool, rpm: Double?) {
            self.k = k
            self.from = from
            self.to = to
            self.up = up
            self.rpm = rpm
        }
    }

    /// Every gear change in one stored lap. A clutch-in stretch (gear 0) between
    /// two gears is skipped over, so 3 → 0 → 4 is one shift from 3rd to 4th,
    /// read at the last sample that was still in 3rd.
    public static func lapShifts(_ entry: LapChannels) -> [Shift] {
        guard let gear = entry.gear else { return [] }
        let rpm = entry.rpm
        var out: [Shift] = []
        var last: Double = 0
        var lastK = -1
        for k in 0..<gear.count {
            let g = gear[k]
            guard g > 0 else { continue }
            if last > 0 && g != last {
                let reading: Double? = {
                    guard let rpm, lastK >= 0, lastK < rpm.count, rpm[lastK].isFinite else { return nil }
                    return rpm[lastK]
                }()
                out.append(Shift(k: k, from: last, to: g, up: g > last, rpm: reading))
            }
            last = g
            lastK = k
        }
        return out
    }

    /// One gear's upshift rpm across a session.
    public struct GearShifts: Equatable, Sendable, Decodable {
        public var gear: Double
        public var count: Int
        public var minRpm: Double
        public var medianRpm: Int
        public var maxRpm: Double

        public init(gear: Double, count: Int, minRpm: Double, medianRpm: Int, maxRpm: Double) {
            self.gear = gear
            self.count = count
            self.minRpm = minRpm
            self.medianRpm = medianRpm
            self.maxRpm = maxRpm
        }
    }

    /// A session's upshifts reduced to rpm per gear. `maxRpm` is the highest rpm
    /// sample in any lap with gear data — the top of the rev range *seen today*,
    /// which is not the same claim as the car's limiter.
    public struct SessionShifts: Equatable, Sendable, Decodable {
        public var gears: [GearShifts]
        public var medianRpm: Int
        public var maxRpm: Double?

        public init(gears: [GearShifts], medianRpm: Int, maxRpm: Double?) {
            self.gears = gears
            self.medianRpm = medianRpm
            self.maxRpm = maxRpm
        }
    }

    private static func median(_ sorted: [Double]) -> Double {
        let m = sorted.count >> 1
        return sorted.count % 2 == 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
    }

    /// Only laps carrying both `gear` and `rpm` count; nil when none does or
    /// none of them upshifts. Rounded to whole rpm — the stored samples are, and
    /// a median of two is the only place a half can appear.
    public static func shiftPoints(_ channels: SessionChannels) -> SessionShifts? {
        // Insertion-ordered rather than a dictionary: the gears are sorted below
        // and a Double-keyed map would order by hash.
        var byGear: [(gear: Double, rpms: [Double])] = []
        var all: [Double] = []
        var maxRpm: Double?
        for l in channels.laps {
            guard l.gear != nil, let rpm = l.rpm else { continue }
            for v in rpm where v.isFinite && (maxRpm == nil || v > maxRpm!) { maxRpm = v }
            for s in lapShifts(l) {
                guard s.up, let r = s.rpm else { continue }
                all.append(r)
                if let i = byGear.firstIndex(where: { $0.gear == s.from }) {
                    byGear[i].rpms.append(r)
                } else {
                    byGear.append((gear: s.from, rpms: [r]))
                }
            }
        }
        guard !all.isEmpty else { return nil }
        let gears = byGear
            .sorted { $0.gear < $1.gear }
            .map { entry -> GearShifts in
                let sorted = entry.rpms.sorted()
                return GearShifts(
                    gear: entry.gear,
                    count: sorted.count,
                    minRpm: sorted[0],
                    medianRpm: JSMath.roundToInt(median(sorted)) ?? 0,
                    maxRpm: sorted[sorted.count - 1]
                )
            }
        return SessionShifts(gears: gears, medianRpm: JSMath.roundToInt(median(all.sorted())) ?? 0, maxRpm: maxRpm)
    }

    /// What the shift points say, as short factual sentences — facts about this
    /// session, never a verdict: "ABS active" is a fact, "you're braking too
    /// hard" is a guess (#188), and the same rule holds here. Two patterns are
    /// worth a line each: a gear taken to the top of the rev range seen today,
    /// and a gear shifted out of markedly earlier than the gear shifted latest.
    public static func shiftNotes(_ sp: SessionShifts?) -> [String] {
        guard let sp, !sp.gears.isEmpty else { return [] }
        var notes: [String] = []
        let counted = sp.gears.filter { $0.count >= MIN_SHIFTS_FOR_NOTE }
        guard !counted.isEmpty else { return notes }
        // First maximum wins a tie, matching the JS's strict `>`.
        var topIndex = 0
        for (i, g) in counted.enumerated() where g.medianRpm > counted[topIndex].medianRpm { topIndex = i }
        let top = counted[topIndex]
        if let sessionMax = sp.maxRpm {
            let atLimit = counted.filter { $0.maxRpm >= sessionMax - REV_LIMIT_MARGIN_RPM }
            if !atLimit.isEmpty {
                let which = atLimit.map { ordinal($0.gear) }.joined(separator: " and ")
                notes.append(
                    "Upshifts from \(which) run to the top of the rev range seen today (≈\(fmtRpm(sessionMax)) rpm)."
                )
            }
        }
        for (i, g) in counted.enumerated() where i != topIndex {
            let gap = Double(top.medianRpm - g.medianRpm)
            if gap >= SHORT_SHIFT_RPM {
                notes.append(
                    "Upshifts from \(ordinal(g.gear)) come ≈\(fmtRpm(gap)) rpm earlier than from \(ordinal(top.gear))."
                )
            }
        }
        return notes
    }

    // MARK: - Disagreements

    /// A stretch of grid where the highlighted laps sit in different gears.
    public struct Disagreement: Equatable, Sendable, Decodable {
        public var k0: Int
        public var k1: Int

        public init(k0: Int, k1: Int) {
            self.k0 = k0
            self.k1 = k1
        }
    }

    /// Grid runs where two or more laps sit in different gears, over one array
    /// per lap. A point counts only where at least two laps report a gear above
    /// 0 and those gears aren't all equal; runs shorter than `minRun` points are
    /// dropped (see `MIN_DISAGREE_POINTS`) — a shift landing a point later on
    /// one lap is not a different gear choice.
    public static func gearDisagreements(_ gears: [[Double]?], minRun: Int = MIN_DISAGREE_POINTS) -> [Disagreement] {
        let arrs = gears.compactMap { $0 }
        guard arrs.count >= 2 else { return [] }
        let n = arrs.map(\.count).max() ?? 0
        var out: [Disagreement] = []
        var k0 = -1
        for k in 0...n {
            var differs = false
            if k < n {
                var seen: Double = 0
                for a in arrs {
                    guard k < a.count else { continue }
                    let g = a[k]
                    guard g > 0 else { continue }
                    if seen != 0 && g != seen { differs = true }
                    seen = seen != 0 ? seen : g
                }
            }
            if differs {
                if k0 < 0 { k0 = k }
            } else if k0 >= 0 {
                if k - k0 >= minRun { out.append(Disagreement(k0: k0, k1: k - 1)) }
                k0 = -1
            }
        }
        return out
    }
}
