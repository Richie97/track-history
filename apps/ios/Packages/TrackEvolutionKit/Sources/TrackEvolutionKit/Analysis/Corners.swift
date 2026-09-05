import Foundation

/// Corner segmentation (#189) — the port of `public/js/corners.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`CornersTests`), and the output is
/// pinned against the web implementation by `contracts/logic/corners.json`.
///
/// `Sectors` cuts a lap by *distance* — three equal slices of the driven
/// length — which is the right cut for "where did the time go" and the wrong
/// one for "what was the car doing in the corner": a sector boundary lands
/// mid-corner as often as not. This cuts by *lateral load* instead: a corner is
/// a stretch of grid points where the stored `|latG|` stays at or above
/// ``CORNER_MIN_G``, merged across a short dip (a chicane's flick between two
/// apexes is one corner, not two) and dropped when too short to be anything but
/// a kerb strike. It is the primitive ``Balance`` hangs off, and it is its own
/// type because anything per-corner — entry speed, minimum speed, brake release
/// — segments the same way.
///
/// Corners are numbered from the start/finish line in distance order and
/// labelled T1…Tn. Those are the app's numbers at this threshold, not the
/// circuit's official turn numbers: a fast kink may or may not clear
/// ``CORNER_MIN_G``, and a double apex may count once or twice. Every surface
/// that shows one says as much.
///
/// ``sessionCorners(_:minG:mergeGap:minPoints:quorum:)`` segments where *most*
/// laps agree they were cornering rather than any one lap's mask, so the corner
/// list is one list for the session — the same T4 on every lap, whichever laps
/// are highlighted — and a lap that took a corner a little wider still lands in
/// the same window. The grid is what makes that legitimate: laps are aligned by
/// driven distance from the start/finish line, so the same k is the same place
/// on track to within the line taken. The quorum is what stops that alignment's
/// slack from chaining neighbouring corners together; see ``CORNER_LAP_QUORUM``.
public enum Corners {
    /// Sustained `|latG|` at or above this is a corner. Display semantics, not
    /// physics — like `Limits.WHEELSPIN_PCT` and `Grip.MIN_LOAD_G`, tune against
    /// real footage. 0.35 G is well above the noise on a straight and well below
    /// the lightest real corner on a road-tyred car.
    public static let CORNER_MIN_G: Double = 0.35

    /// Two cornering runs separated by at most this many below-threshold grid
    /// points are one corner: a chicane or a double apex, not two corners.
    /// 2 points = 40 m at the 20 m grid.
    public static let CORNER_MERGE_GAP_POINTS = 2

    /// A run shorter than this is a kerb strike or a bump, not a corner.
    /// 3 points = 60 m at the 20 m grid.
    public static let MIN_CORNER_POINTS = 3

    /// The share of readable laps that must be cornering at a grid point for
    /// ``sessionCorners(_:minG:mergeGap:minPoints:quorum:)`` to call it one —
    /// see the note there for why a union is the wrong combiner. Half is the
    /// mildest rule that removes the one-wide-lap smear: a corner every lap
    /// takes survives however scruffy one lap was, and a place only one lap
    /// loaded (a tank-slapper, a spin, an off) no longer widens the session's
    /// window. Below two laps it degrades to "any lap", which is the only
    /// answer available.
    public static let CORNER_LAP_QUORUM: Double = 0.5

    /// How many of `lapCount` laps must agree. At least one, so a single-lap
    /// session still segments.
    public static func lapQuorum(_ lapCount: Int, _ quorum: Double = CORNER_LAP_QUORUM) -> Int {
        max(1, Int((Double(lapCount) * quorum).rounded(.up)))
    }

    /// True when the lap stored the channel this type reads.
    public static func hasCornerData(_ entry: LapChannels?) -> Bool {
        entry?.latG != nil
    }

    /// The cornering mask of one lap: true at every grid point where `|latG|` is
    /// at or above `minG`. A magnitude stored with a sign is still a magnitude —
    /// `pdr.js` stores `abs(lateral acceleration)`, and a negative would be a
    /// source bug, not a left-hander.
    public static func cornerMask(_ latG: [Double]?, _ minG: Double = CORNER_MIN_G) -> [Bool] {
        guard let latG else { return [] }
        return latG.map { abs($0) >= minG }
    }

    /// A mask reduced to corners: inclusive runs, merged across gaps of at most
    /// `mergeGap` clear points, runs shorter than `minPoints` dropped.
    public static func cornersFromMask(
        _ mask: [Bool],
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS
    ) -> [Limits.Run] {
        Limits.booleanRuns(mask, mergeGap).filter { $0.k1 - $0.k0 + 1 >= minPoints }
    }

    /// One corner of one lap, numbered from the start/finish line.
    public struct Corner: Equatable, Sendable, Decodable {
        /// 1-based, in distance order — the number behind the T in the label.
        public var n: Int
        public var k0: Int
        public var k1: Int
        /// The highest `|latG|` seen inside the window, and where.
        public var peakG: Double
        public var peakK: Int
        /// How many laps cleared the threshold somewhere inside the window.
        /// 0 on a single lap's corners, which have no session to count over.
        public var laps: Int

        public init(n: Int, k0: Int, k1: Int, peakG: Double, peakK: Int, laps: Int = 0) {
            self.n = n
            self.k0 = k0
            self.k1 = k1
            self.peakG = peakG
            self.peakK = peakK
            self.laps = laps
        }

        enum CodingKeys: String, CodingKey {
            case n, k0, k1, peakG, peakK, laps
        }

        /// One lap's corners carry no lap count, so the fixture's `lapCorners`
        /// rows have no `laps` key and it decodes as 0 rather than failing.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            n = try c.decode(Int.self, forKey: .n)
            k0 = try c.decode(Int.self, forKey: .k0)
            k1 = try c.decode(Int.self, forKey: .k1)
            peakG = try c.decode(Double.self, forKey: .peakG)
            peakK = try c.decode(Int.self, forKey: .peakK)
            laps = try c.decodeIfPresent(Int.self, forKey: .laps) ?? 0
        }
    }

    /// One lap's corners, numbered from the start/finish line. Empty without a
    /// `latG` channel.
    public static func lapCorners(
        _ entry: LapChannels?,
        minG: Double = CORNER_MIN_G,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS
    ) -> [Corner] {
        guard let entry, let latG = entry.latG else { return [] }
        let runs = cornersFromMask(cornerMask(latG, minG), mergeGap: mergeGap, minPoints: minPoints)
        return runs.enumerated().map { i, r in
            let peak = peakIn(latG, r)
            return Corner(n: i + 1, k0: r.k0, k1: r.k1, peakG: peak.g, peakK: peak.k)
        }
    }

    private static func peakIn(_ latG: [Double], _ run: Limits.Run) -> (g: Double, k: Int) {
        var peakG: Double = 0
        var peakK = run.k0
        var k = run.k0
        while k <= run.k1 && k < latG.count {
            let g = abs(latG[k])
            if g > peakG {
                peakG = g
                peakK = k
            }
            k += 1
        }
        return (peakG, peakK)
    }

    /// The session's corners on the shared grid: where at least `quorum` of the
    /// readable laps agree they were cornering — see the type's documentation.
    /// Empty when no lap stored `latG`.
    ///
    /// A quorum and not a union, which is what this used to take. Laps are
    /// aligned by driven distance, but they differ in length by a percent or two
    /// (line choice, GPS drift), so OR-ing the masks widened every corner by the
    /// spread of the whole session. Once widened, neighbours fell inside
    /// `mergeGap` of one another and *chained*: on a 7-lap VIR session the
    /// Climbing Esses, the Snake and South Bend fused into one 1,200 m "corner",
    /// and the session reported six corners where every individual lap
    /// segmented eight to eleven. Requiring most laps to agree keeps the window
    /// at the corner rather than at its envelope, and leaves `mergeGap` free to
    /// do the job it is for. Genuinely continuous complexes stay single: VIR's
    /// esses hold load for 780 m on every lap and still read as one.
    public static func sessionCorners(
        _ channels: SessionChannels?,
        minG: Double = CORNER_MIN_G,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS,
        quorum: Double = CORNER_LAP_QUORUM
    ) -> [Corner] {
        let laps = (channels?.laps ?? []).filter { $0.latG != nil }
        guard !laps.isEmpty else { return [] }
        let n = laps.map { $0.latG?.count ?? 0 }.max() ?? 0
        let masks = laps.map { cornerMask($0.latG, minG) }
        var votes = [Int](repeating: 0, count: n)
        for m in masks {
            for k in 0..<m.count where m[k] { votes[k] += 1 }
        }
        let need = lapQuorum(laps.count, quorum)
        let agreed = votes.map { $0 >= need }
        return cornersFromMask(agreed, mergeGap: mergeGap, minPoints: minPoints).enumerated().map { i, r in
            var peakG: Double = 0
            var peakK = r.k0
            var count = 0
            for (li, lap) in laps.enumerated() {
                let peak = peakIn(lap.latG ?? [], r)
                if peak.g > peakG {
                    peakG = peak.g
                    peakK = peak.k
                }
                let m = masks[li]
                var k = r.k0
                while k <= r.k1 {
                    if k < m.count && m[k] {
                        count += 1
                        break
                    }
                    k += 1
                }
            }
            return Corner(n: i + 1, k0: r.k0, k1: r.k1, peakG: peakG, peakK: peakK, laps: count)
        }
    }

    /// The corner containing grid point k, or nil on a straight.
    public static func cornerAt(_ corners: [Corner], _ k: Int) -> Corner? {
        corners.first { k >= $0.k0 && k <= $0.k1 }
    }

    /// The label a corner is shown under. The app's numbering, not the
    /// circuit's — see the type's documentation.
    public static func cornerLabel(_ c: Corner) -> String { "T\(c.n)" }
}
