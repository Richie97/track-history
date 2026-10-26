import Foundation

/// Video-synced lap analysis (NS-51) — the port of `public/js/video-sync.js`,
/// the pure half of the lap stage.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`VideoSyncTests`), and the output is
/// pinned against the web implementation by `contracts/logic/video-sync.json`.
///
/// One driven distance — a fractional index `k` on a lap's 20 m channel grid —
/// is the playhead. This turns a video's clock into it and back, keeps a second
/// lap's video in step with the first, and words where the car is.
///
/// Nothing here is stored. A lap's elapsed time at each grid point is derived
/// from its speed trace by ``ChannelGraphs/lapTimeSeries(_:_:_:)`` (the delta
/// chart's own curve: exact at both ends, scaled to the timed lap, drifting a
/// little in between), and a clip's `lap_offset_ms` says where the lap starts
/// inside the video. ``makeSide(_:_:_:_:t:)`` takes the time curve as an
/// optional argument so a stored series can replace the derived one without
/// changing a caller.
///
/// Two signs are A/B-relative whichever side is the master: `deltaS` is A − B
/// (positive: A slower) and `gapM` is B's distance ahead of A (positive: B
/// ahead), so the words stay "B ahead 26 m" after a swap.
public enum VideoSync {
    /// The two ways a compare keeps two videos together: `place` holds both cars
    /// at the same distance (the slower lap's video runs faster to keep up),
    /// `time` at the same elapsed time from the line (one car pulls ahead).
    public enum SyncMode: String, Sendable, Hashable, Codable, CaseIterable {
        case place, time
    }

    public static let SYNC_MODES: [SyncMode] = [.place, .time]
    public static let DEFAULT_SYNC_MODE: SyncMode = .place
    /// A follower more than this far from where it should be is re-seeked.
    public static let RESYNC_MS: Double = 150
    /// The follower's playback rate in `place` mode stays inside these.
    public static let FOLLOW_RATE_MIN: Double = 0.5
    public static let FOLLOW_RATE_MAX: Double = 2
    /// A brake reading at or above this is "braking" in the scrubber's words —
    /// compare-laps.js' `BRAKING_PCT`, which the head-to-head counts by.
    public static let BRAKING_WORD_PCT: Double = 10

    /// `A` is the lap the view was opened for (or the first pick), `B` the
    /// reference or the second pick.
    public enum SideKey: String, Sendable, Hashable, Codable {
        case A, B
    }

    /// Where a lap sits inside its clip, in ms. `durationMs` nil when unknown.
    public struct Clip: Sendable, Hashable {
        public var lapOffsetMs: Double
        public var durationMs: Double?

        public init(lapOffsetMs: Double, durationMs: Double?) {
            self.lapOffsetMs = lapOffsetMs
            self.durationMs = durationMs
        }
    }

    /// One side of the stage: a lap's stored channel entry, its grid spacing,
    /// its time curve and its clip (nil — replay).
    public struct Side: Sendable, Hashable {
        public var key: SideKey
        public var entry: LapChannels
        public var dStepM: Double
        public var t: [Double]
        public var clip: Clip?
    }

    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        Swift.max(lo, Swift.min(hi, v))
    }

    /// The fractional grid index where `t[k] == e`, by binary search and linear
    /// interpolation, clamped to `[0, t.count − 1]`. `t` is strictly
    /// increasing: `lapTimeSeries` floors the speed at `DELTA_MIN_KPH`, so no
    /// cell takes no time.
    public static func gridAtElapsed(_ t: [Double], _ e: Double) -> Double {
        let last = t.count - 1
        // `!(e > t[0])` in the JS: a NaN lands on the line too.
        if last <= 0 || !(e > t[0]) { return 0 }
        if e >= t[last] { return Double(last) }
        var lo = 0
        var hi = last
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1
            if t[mid] <= e { lo = mid } else { hi = mid }
        }
        return Double(lo) + (e - t[lo]) / (t[hi] - t[lo])
    }

    /// A series at fractional index k, linearly interpolated, k clamped to the
    /// series. nil for a missing or empty series.
    public static func valueAt(_ series: [Double]?, _ k: Double) -> Double? {
        guard let series, !series.isEmpty else { return nil }
        let last = series.count - 1
        let kk = clamp(k.isFinite ? k : 0, 0, Double(last))
        let i0 = Int(kk.rounded(.down))
        if i0 >= last { return series[last] }
        return series[i0] + (series[i0 + 1] - series[i0]) * (kk - Double(i0))
    }

    /// One side of the stage, or nil when the entry carries no speed trace to
    /// integrate. A clip without a finite offset is dropped (the side replays).
    public static func makeSide(
        _ key: SideKey, _ entry: LapChannels, _ dStepM: Double, _ clip: Clip?, t: [Double]? = nil
    ) -> Side? {
        guard let speed = entry.speed, speed.count >= 2 else { return nil }
        let curve = t ?? ChannelGraphs.lapTimeSeries(speed, dStepM, entry.timeMs)
        var kept: Clip?
        if let clip, clip.lapOffsetMs.isFinite {
            kept = Clip(lapOffsetMs: clip.lapOffsetMs, durationMs: clip.durationMs.flatMap { $0.isFinite ? $0 : nil })
        }
        return Side(key: key, entry: entry, dStepM: dStepM, t: curve, clip: kept)
    }

    /// The side's lap length in seconds — the time curve's end, which is the
    /// timed lap when it had one.
    private static func lapS(_ side: Side) -> Double { side.t.last ?? 0 }
    private static func offsetMs(_ side: Side) -> Double { side.clip?.lapOffsetMs ?? 0 }

    /// A clip time → where it is on one side.
    public struct ClipAt: Sendable, Hashable {
        /// The lap's elapsed seconds, negative before the line.
        public var e: Double
        /// The grid index there, clamped to the lap.
        public var k: Double
        public var inLap: Bool
    }

    /// A clip time (ms) → `{ e, k, inLap }` for one side.
    public static func sideAtClipTime(_ side: Side, _ clipMs: Double) -> ClipAt {
        let e = (clipMs - offsetMs(side)) / 1000
        return ClipAt(e: e, k: gridAtElapsed(side.t, e), inLap: e >= 0 && e <= lapS(side))
    }

    /// k → the clip time (ms) to seek that side to.
    public static func clipTimeAtGrid(_ side: Side, _ k: Double) -> Double {
        offsetMs(side) + 1000 * (valueAt(side.t, k) ?? 0)
    }

    /// The scrubber's range in the master's lap time, seconds: the lap with
    /// `PLAYBACK_LEAD_S` of run-up either side.
    public static func scrubRange(_ side: Side) -> (min: Double, max: Double) {
        (-LapClips.PLAYBACK_LEAD_S, lapS(side) + LapClips.PLAYBACK_LEAD_S)
    }

    /// Whether two sides are matched by lap fraction rather than grid index:
    /// their driven lengths differ by more than the compare's warning threshold.
    public static func matchByFraction(_ a: Side?, _ b: Side?) -> Bool {
        guard let a, let b else { return false }
        let la = Double(a.t.count - 1) * a.dStepM
        let lb = Double(b.t.count - 1) * b.dStepM
        let longest = Swift.max(la, lb)
        return longest > 0 && abs(la - lb) / longest > CompareLaps.LENGTH_MISMATCH_WARN
    }

    /// k on `from`'s grid → the same place on `to`'s grid.
    private static func mapGrid(_ from: Side, _ to: Side, _ k: Double, _ byFraction: Bool) -> Double {
        let nTo = Double(to.t.count - 1)
        if !byFraction { return clamp(k, 0, nTo) }
        let nFrom = Double(from.t.count - 1)
        return nFrom > 0 ? clamp((k * nTo) / nFrom, 0, nTo) : 0
    }

    /// What the car is doing at a playhead.
    public struct Readings: Sendable, Hashable {
        public var speedKph: Double?
        public var throttle: Double?
        public var brake: Double?
        public var gear: Double?
    }

    /// The stored readings at k, nearest sample for the gear (a state, not a
    /// measurement — gear 3.5 means nothing).
    private static func readings(_ entry: LapChannels, _ k: Double) -> Readings {
        var gear: Double?
        if let g = entry.gear, !g.isEmpty {
            let i = Int(clamp(Double(JSMath.roundToInt(k) ?? 0), 0, Double(g.count - 1)))
            gear = g[i].isFinite ? g[i] : nil
        }
        return Readings(
            speedKph: valueAt(entry.speed, k), throttle: valueAt(entry.throttle, k),
            brake: valueAt(entry.brake, k), gear: gear
        )
    }

    /// One side's place at a playhead.
    public struct SideState: Sendable, Hashable {
        public var e: Double
        public var k: Double
        public var distM: Double
        public var inLap: Bool
        /// The clip time this moment is at, nil on a side with no clip.
        public var clipMs: Double?
        /// Whether the side's video holds this moment: a cut that started late,
        /// or a playhead out in the other lap's run-up, leaves it on replay.
        public var inClip: Bool
        public var now: Readings
    }

    private static func sideState(_ side: Side, _ e: Double, _ k: Double) -> SideState {
        let clipMs = side.clip.map { $0.lapOffsetMs + 1000 * e }
        let dur = side.clip?.durationMs
        var inClip = false
        if let clipMs { inClip = clipMs >= 0 && (dur == nil || clipMs <= dur!) }
        return SideState(
            e: e, k: k, distM: k * side.dStepM, inLap: e >= 0 && e <= lapS(side),
            clipMs: clipMs, inClip: inClip, now: readings(side.entry, k)
        )
    }

    /// The stage's one or two sides; `b` nil for a one-sided stage.
    public struct Sides: Sendable, Hashable {
        public var a: Side
        public var b: Side?

        public init(a: Side, b: Side?) {
            self.a = a
            self.b = b
        }
    }

    /// The whole view at one moment.
    public struct Playhead: Sendable, Hashable {
        public var mode: SyncMode
        public var masterKey: SideKey
        public var inLap: Bool
        public var byFraction: Bool
        public var a: SideState
        public var b: SideState?
        /// A's time minus B's at A's place (positive: A slower); nil out of the
        /// lap or one-sided.
        public var deltaS: Double?
        /// In `time` mode B's distance ahead of A in metres (positive: B ahead);
        /// nil in `place` mode, out of the lap or one-sided.
        public var gapM: Double?
    }

    /// The whole view at the master's elapsed time `eMaster` (seconds from its
    /// line).
    ///
    /// In the lap: `place` puts the other side at the master's distance, `time`
    /// at its elapsed time. Out of the lap both sides keep the master's distance
    /// from the line in time — the same run-up before it, the same roll-out
    /// after — so two cars cross it together in `place` mode.
    public static func playheadAt(
        _ sides: Sides, _ masterKey: SideKey, _ eMaster: Double, _ mode: SyncMode = DEFAULT_SYNC_MODE
    ) -> Playhead {
        let a = sides.a
        let b = sides.b
        let masterIsA = !(masterKey == .B && b != nil)
        let master = masterIsA ? a : b!
        let other: Side? = masterIsA ? b : a
        let byFraction = matchByFraction(a, b)
        let lapM = lapS(master)
        let inLap = eMaster >= 0 && eMaster <= lapM
        let kM = gridAtElapsed(master.t, eMaster)
        let mState = sideState(master, eMaster, kM)

        var oState: SideState?
        if let other {
            let eO: Double
            let kO: Double
            if mode == .time {
                eO = eMaster
                kO = gridAtElapsed(other.t, eO)
            } else if !inLap {
                eO = eMaster < 0 ? eMaster : lapS(other) + (eMaster - lapM)
                kO = gridAtElapsed(other.t, eO)
            } else {
                kO = mapGrid(master, other, kM, byFraction)
                eO = valueAt(other.t, kO) ?? 0
            }
            oState = sideState(other, eO, kO)
        }

        let aState = masterIsA ? mState : oState!
        let bState = masterIsA ? oState : mState
        var deltaS: Double?
        var gapM: Double?
        if let b, let bState, inLap {
            let kB = mapGrid(a, b, aState.k, byFraction)
            deltaS = (valueAt(a.t, aState.k) ?? 0) - (valueAt(b.t, kB) ?? 0)
            if mode == .time {
                let kBonA = mapGrid(b, a, bState.k, byFraction)
                gapM = (kBonA - aState.k) * a.dStepM
            }
        }
        return Playhead(
            mode: mode, masterKey: masterIsA ? .A : .B, inLap: inLap, byFraction: byFraction,
            a: aState, b: bState, deltaS: deltaS, gapM: gapM
        )
    }

    /// The follower's playback rate in `place` mode at the master's grid index
    /// k: the master's speed over the follower's at the same place, so the
    /// follower's video covers the same metres in the master's seconds. Floored
    /// at `DELTA_MIN_KPH` like the time curve, and clamped.
    public static func followRate(_ sides: Sides, _ masterKey: SideKey, _ k: Double) -> Double {
        guard let b = sides.b else { return 1 }
        let a = sides.a
        let master = masterKey == .B ? b : a
        let other = masterKey == .B ? a : b
        guard let vM = valueAt(master.entry.speed, k),
              let vO = valueAt(other.entry.speed, mapGrid(master, other, k, matchByFraction(a, b)))
        else { return 1 }
        let floor = ChannelGraphs.DELTA_MIN_KPH
        return clamp(Swift.max(floor, vM) / Swift.max(floor, vO), FOLLOW_RATE_MIN, FOLLOW_RATE_MAX)
    }

    /// Whether a follower `actualMs` into its clip is far enough from `targetMs`
    /// to re-seek: strictly more than `RESYNC_MS`.
    public static func needsResync(_ targetMs: Double, _ actualMs: Double) -> Bool {
        abs(targetMs - actualMs) > RESYNC_MS
    }

    /// The JS minus sign, U+2212 — a hyphen reads as a dash in a number.
    private static let MINUS = "\u{2212}"

    /// The stage's clock: "0:36.0", "2:19.8", "−0:01.5" — tenths, rounded.
    public static func fmtStageTime(_ s: Double?) -> String {
        guard let s, s.isFinite else { return "—" }
        let tenths = JSMath.roundToInt(abs(s) * 10) ?? 0
        let m = tenths / 600
        let sec = Double(tenths % 600) / 10
        let body = "\(m):\(sec < 10 ? "0" : "")\(Units.toFixed(sec, 1))"
        return s < 0 && tenths > 0 ? "\(MINUS)\(body)" : body
    }

    /// A signed delta in seconds: "+0.31 s", "−0.12 s", "0.00 s".
    public static func fmtDeltaS(_ d: Double?) -> String? {
        guard let d, d.isFinite else { return nil }
        let v = JSMath.roundToInt(abs(d) * 100) ?? 0
        if v == 0 { return "0.00 s" }
        return "\(d > 0 ? "+" : MINUS)\(Units.toFixed(Double(v) / 100, 2)) s"
    }

    /// "B ahead 26 m" / "A ahead 85 ft" / "Level".
    public static func fmtGap(_ gapM: Double?, _ units: UnitSystem) -> String? {
        guard let gapM, gapM.isFinite else { return nil }
        let metric = Units.isMetric(units)
        let v = JSMath.roundToInt(abs(gapM) * (metric ? 1 : Units.FT_PER_M)) ?? 0
        if v == 0 { return "Level" }
        return "\(gapM > 0 ? "B" : "A") ahead \(v) \(metric ? "m" : "ft")"
    }

    /// Where k sits among the corners: "in T2", "after T4", "before T1", or nil
    /// when the lap has no corners to place it by.
    public static func cornerPlace(_ corners: [Corners.Corner]?, _ k: Double) -> String? {
        guard let corners, !corners.isEmpty else { return nil }
        if let inside = corners.first(where: { k >= Double($0.k0) && k <= Double($0.k1) }) {
            return "in \(Corners.cornerLabel(inside))"
        }
        var prev: Corners.Corner?
        for c in corners where Double(c.k1) < k { prev = c }
        if let prev { return "after \(Corners.cornerLabel(prev))" }
        return "before \(Corners.cornerLabel(corners[0]))"
    }

    /// The words for a playhead.
    public struct Text: Sendable, Hashable {
        /// The now-strip's first line: "1.50 km · in T2", or "Before the line".
        public var place: String
        /// The scrubber's spoken value — "0:41.2, 2.84 km, in T11, 82 mph,
        /// braking 64 %, +0.31 s" — whose clock is the master's.
        public var value: String
        /// The now-strip's last: "+0.31 s", or in `time` mode "B ahead 26 m";
        /// nil with nothing to compare.
        public var delta: String?
    }

    /// The words for the playhead, read from side A.
    public static func playheadText(_ state: Playhead, _ corners: [Corners.Corner]?, _ units: UnitSystem) -> Text {
        let a = state.a
        let master = state.masterKey == .B ? (state.b ?? a) : a
        let clock = fmtStageTime(master.e)
        if !state.inLap {
            let place = master.e < 0 ? "Before the line" : "After the line"
            return Text(place: place, value: "\(clock), \(place)", delta: nil)
        }
        let dist = Units.fmtDist(Double(JSMath.roundToInt(a.distM) ?? 0), units)
        let whereText = cornerPlace(corners, a.k)
        let place = whereText.map { "\(dist) · \($0)" } ?? dist
        let delta = state.mode == .time ? fmtGap(state.gapM, units) : fmtDeltaS(state.deltaS)
        var parts = [clock, dist]
        if let whereText { parts.append(whereText) }
        if let v = a.now.speedKph { parts.append(Units.fmtSpeedKph(v, units)) }
        if let brake = a.now.brake, brake >= BRAKING_WORD_PCT {
            parts.append("braking \(JSMath.roundToInt(brake) ?? 0) %")
        } else if let throttle = a.now.throttle {
            parts.append("throttle \(JSMath.roundToInt(throttle) ?? 0) %")
        }
        if let delta { parts.append(delta) }
        return Text(place: place, value: parts.joined(separator: ", "), delta: delta)
    }

    /// One screen-reader stop along the scrubber.
    public struct Stop: Sendable, Hashable {
        public var label: String
        /// The lap's elapsed seconds at the corner's start.
        public var e: Double
    }

    /// The screen reader's stops along the scrubber: each corner's start, `e`
    /// the lap's elapsed seconds there on time curve `t`.
    public static func cornerStops(_ corners: [Corners.Corner]?, _ t: [Double]) -> [Stop] {
        (corners ?? []).map { Stop(label: Corners.cornerLabel($0), e: valueAt(t, Double($0.k0)) ?? 0) }
    }

    /// The single-lap stage's reference lap: the session best, or the next-best
    /// when this lap is the best, or nil when no other lap has channels.
    /// `matched` is `matchLapsToChannels`' rows; returns one of them. Ties go to
    /// the earlier lap.
    public static func referenceLap(_ matched: [ChannelGraphs.LapMatch], _ chIdx: Int) -> ChannelGraphs.LapMatch? {
        let rows = matched.filter { $0.chIdx >= 0 && $0.chIdx != chIdx }
        guard !rows.isEmpty else { return nil }
        let fastest: ([ChannelGraphs.LapMatch]) -> ChannelGraphs.LapMatch = { list in
            list.dropFirst().reduce(list[0]) { m, r in r.lap.timeMs < m.lap.timeMs ? r : m }
        }
        let best = fastest(matched.filter { $0.chIdx >= 0 })
        if best.chIdx != chIdx { return best }
        return fastest(rows)
    }

    /// Which of a session panel's lit laps the stage shows, as channel indexes:
    /// A the lap the view was opened for if it is lit, else the most recently
    /// lit; B the fastest other lit lap (ties to the earlier index), or nil.
    /// `lit` is the panel's slot order (oldest first), `laps` the channel
    /// entries. nil when nothing is lit.
    public static func stageSides(_ lit: [Int], _ laps: [LapChannels], _ openedChIdx: Int?) -> (a: Int, b: Int?)? {
        guard let newest = lit.last else { return nil }
        let a = openedChIdx.flatMap { lit.contains($0) ? $0 : nil } ?? newest
        var b: Int?
        for i in lit where i != a && laps.indices.contains(i) {
            if let cur = b {
                let ti = laps[i].timeMs, tb = laps[cur].timeMs
                if ti < tb || (ti == tb && i < cur) { b = i }
            } else {
                b = i
            }
        }
        return (a, b)
    }
}
