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
/// ``CORNER_MIN_G`` *in one direction*, merged across a short dip (a double
/// apex is one corner, not two) and dropped when too short to be anything but a
/// kerb strike. It is the primitive ``Balance`` hangs off, and it is its own
/// type because anything per-corner — entry speed, minimum speed, brake release
/// — segments the same way.
///
/// Direction is the point. `latG` is stored as a magnitude, and through a
/// left-right transition a magnitude dips for a grid point or two and comes
/// straight back — so read alone it fuses linked corners: at VIR the whole
/// Climbing Esses were one "corner", Roller Coaster through Hog Pen another,
/// nine in a lap of eighteen. The sign comes from a channel that has one — yaw,
/// else steering (``lateralSigns(_:)``) — and a change of direction always
/// ends a corner, whatever the gap. A lap with neither channel (a GPS-only
/// import) has no direction to read and segments by magnitude alone, as every
/// lap did before.
///
/// Corners are numbered from the start/finish line in distance order and
/// labelled T1…Tn. Those are the app's numbers at this threshold, not the
/// circuit's official turn numbers: a fast kink may or may not clear
/// ``CORNER_MIN_G``, two apexes in the same direction count once, and a bend
/// the start/finish line cuts through is counted on both sides of it. Every
/// surface that shows one says as much.
///
/// ``sessionCorners(_:minG:mergeGap:minPoints:)`` segments every lap together
/// on the shared distance grid rather than any one lap's, so the corner list is
/// one list for the session — the same T4 on every lap, whichever laps are
/// highlighted — and a lap that took a corner a little wider still lands in the
/// same window. A grid point is cornering when *any* lap is loaded there, in
/// the direction most of the loaded laps agree on. The grid is what makes that
/// legitimate: laps are aligned by driven distance from the start/finish line,
/// so the same k is the same place on track to within the line taken.
public enum Corners {
    /// Sustained `|latG|` at or above this is a corner. Display semantics, not
    /// physics — like `Limits.WHEELSPIN_PCT` and `Grip.MIN_LOAD_G`, tune against
    /// real footage. 0.35 G is well above the noise on a straight and well below
    /// the lightest real corner on a road-tyred car.
    public static let CORNER_MIN_G: Double = 0.35

    /// Two cornering runs *in the same direction* separated by at most this
    /// many below-threshold grid points are one corner: a double apex, not two
    /// corners. 2 points = 40 m at the 20 m grid.
    public static let CORNER_MERGE_GAP_POINTS = 2

    /// A run shorter than this is a kerb strike or a bump, not a corner.
    /// 3 points = 60 m at the 20 m grid.
    public static let MIN_CORNER_POINTS = 3

    /// True when the lap stored the channel this type reads.
    public static func hasCornerData(_ entry: LapChannels?) -> Bool {
        entry?.latG != nil
    }

    /// Which way the car is turning at each grid point of one lap: 1 or -1,
    /// from yaw, else steering; nil when the lap stored neither. Which of the
    /// two is "left" is the recorder's business and nothing here depends on it
    /// — only on the sign changing when the direction does.
    public static func lateralSigns(_ entry: LapChannels?) -> [Int]? {
        guard let entry, let latG = entry.latG, let src = entry.yaw ?? entry.steering else { return nil }
        return latG.indices.map { k in k < src.count && src[k] < 0 ? -1 : 1 }
    }

    /// The cornering direction at each grid point: 0 below `minG`, else the
    /// sign from `signs` — or 1 throughout without it, which is the
    /// magnitude-only reading. A magnitude stored with a sign is still a
    /// magnitude — `pdr.js` stores `abs(lateral acceleration)`, so `latG`'s own
    /// sign is never a direction.
    public static func cornerDirs(
        _ latG: [Double]?,
        _ signs: [Int]? = nil,
        _ minG: Double = CORNER_MIN_G
    ) -> [Int] {
        guard let latG else { return [] }
        return latG.enumerated().map { k, g in
            guard abs(g) >= minG else { return 0 }
            guard let signs, k < signs.count else { return 1 }
            return signs[k]
        }
    }

    /// Directions reduced to corners: inclusive runs. A run is a stretch of one
    /// non-zero direction; two runs merge across a gap of at most `mergeGap`
    /// clear points only when they turn the same way, and runs shorter than
    /// `minPoints` are dropped.
    public static func cornersFromDirs(
        _ dirs: [Int],
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS
    ) -> [Limits.Run] {
        var runs: [(dir: Int, k0: Int, k1: Int)] = []
        for (k, dir) in dirs.enumerated() where dir != 0 {
            // The last run is the last of either direction, so an opposite run
            // in between has already taken its place and nothing merges across
            // it.
            if let prev = runs.last, prev.dir == dir, k - prev.k1 - 1 <= mergeGap {
                runs[runs.count - 1].k1 = k
            } else {
                runs.append((dir: dir, k0: k, k1: k))
            }
        }
        return runs.filter { $0.k1 - $0.k0 + 1 >= minPoints }.map { Limits.Run(k0: $0.k0, k1: $0.k1) }
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
        /// How many laps were loaded in the corner's direction somewhere inside
        /// the window. 0 on a single lap's corners, which have no session to
        /// count over.
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
        let runs = cornersFromDirs(
            cornerDirs(latG, lateralSigns(entry), minG), mergeGap: mergeGap, minPoints: minPoints
        )
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

    /// Every lap's cornering directions in one convention. Two laps of one
    /// session share a recorder, but a comparison can put laps from two
    /// recorders on one grid and their yaw need not agree on which way is
    /// positive — so each lap is checked against the first wherever both are
    /// loaded, and flipped when it disagrees more than it agrees. Measured, not
    /// assumed, as ``Balance`` does for steering against yaw. When any lap has
    /// no direction at all, none is used: half a session cut by direction and
    /// half not would be two corner lists laid over each other.
    ///
    /// Laps without `latG` contribute an empty array.
    public static func sessionDirs(_ laps: [LapChannels], _ minG: Double = CORNER_MIN_G) -> [[Int]] {
        let signs = laps.map { lateralSigns($0) }
        if signs.contains(where: { $0 == nil }) {
            return laps.map { cornerDirs($0.latG, nil, minG) }
        }
        let dirs = laps.enumerated().map { i, l in cornerDirs(l.latG, signs[i], minG) }
        guard let ref = dirs.first else { return dirs }
        return dirs.enumerated().map { i, d in
            guard i > 0 else { return d }
            var agree = 0
            for k in 0..<min(d.count, ref.count) { agree += d[k] * ref[k] }
            return agree < 0 ? d.map { -$0 } : d
        }
    }

    /// The session's corners on the shared grid, from every lap's directions
    /// together — a point is cornering when any lap is loaded there, in the
    /// direction more of the loaded laps turn (on a tie, the earliest loaded
    /// lap's). See the type's documentation. Empty when no lap stored `latG`.
    public static func sessionCorners(
        _ channels: SessionChannels?,
        minG: Double = CORNER_MIN_G,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS
    ) -> [Corner] {
        let laps = (channels?.laps ?? []).filter { $0.latG != nil }
        guard !laps.isEmpty else { return [] }
        let n = laps.map { $0.latG?.count ?? 0 }.max() ?? 0
        let dirs = sessionDirs(laps, minG)
        let voted: [Int] = (0..<n).map { k in
            var sum = 0
            var first = 0
            for d in dirs {
                let v = k < d.count ? d[k] : 0
                sum += v
                if first == 0 { first = v }
            }
            return sum > 0 ? 1 : (sum < 0 ? -1 : first)
        }
        return cornersFromDirs(voted, mergeGap: mergeGap, minPoints: minPoints).enumerated().map { i, r in
            let dir = voted[r.k0]
            var peakG: Double = 0
            var peakK = r.k0
            var count = 0
            for (li, lap) in laps.enumerated() {
                let peak = peakIn(lap.latG ?? [], r)
                if peak.g > peakG {
                    peakG = peak.g
                    peakK = peak.k
                }
                let d = dirs[li]
                var k = r.k0
                while k <= r.k1 {
                    if k < d.count && d[k] == dir {
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
