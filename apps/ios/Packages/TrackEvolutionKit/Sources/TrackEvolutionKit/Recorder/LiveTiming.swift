import Foundation

/// Live lap timing for the in-app GPS recorder: lap counts, lap times and a
/// predictive delta while the car is still on track — before the review
/// screen's line picker has ever run.
///
/// A direct port of `public/js/record/live-timing.js`. **Function names,
/// constant names and constant values are deliberately identical to the
/// JavaScript original** so the implementations diff by eye, and every derived
/// value is pinned against the web implementation by
/// `contracts/logic/live-timing.json` — a gate anchored one fix later, or a
/// delta interpolated differently, shows the driver a different number at
/// 130 mph. Fix a genuine bug in the JavaScript first.
///
/// The recorder doesn't know the start/finish line during a session, so live
/// timing anchors its own gate at the first fix at track pace — in practice
/// the pit exit, which is on the racing line, so the car re-crosses it every
/// lap. Times shown live are therefore "unofficial": the saved laps still
/// come from the review line pick.
///
/// Feed every fix the recording *accepted* (`RecorderCore.addFix` returned
/// true), in order. Recovery after a process death is a replay:
/// `LiveTiming.fromFixes`.
public struct LiveTiming: Sendable {
    /// Track pace: the gate anchors at the first fix at/above this (m/s).
    public static let ARM_MPS: Double = 15
    /// Gate half-width in meters, same as the review line picker's default.
    public static let GATE_HALF_WIDTH_M: Double = 20
    /// Same lap-plausibility window as `lapsFromCrossings`.
    public static let MIN_LAP_S: Double = 30
    public static let MAX_LAP_S: Double = 3600
    /// Crossings closer than this are GPS jitter, as in `gateCrossings`.
    public static let MIN_CROSS_GAP_S: Double = 5
    /// The anchor fix must be at least this far (m) from the previous fix.
    public static let MIN_HEADING_M: Double = 2

    /// The anchored timing gate, in the session's local meter frame.
    public struct Gate: Hashable, Sendable {
        public var hx: Double
        public var hy: Double
        public var x1: Double
        public var y1: Double
        public var x2: Double
        public var y2: Double
    }

    /// The record screen's live-timing readout. A nil `currentLapS` means the
    /// car hasn't hit track pace yet.
    public struct Display: Hashable, Sendable {
        public var lapCount: Int
        public var currentLapS: Double?
        public var lastLapMs: Int?
        public var bestLapMs: Int?
        public var deltaS: Double?
    }

    private struct Origin: Sendable {
        var lat: Double
        var lon: Double
        var kx: Double
        var ky: Double
    }

    private struct Projected: Sendable {
        var t: Double
        var x: Double
        var y: Double
    }

    /// A lap's samples: cumulative meters + seconds since its lap start.
    private struct LapSamples: Sendable {
        var dist: [Double] = []
        var time: [Double] = []
        var d: Double = 0
    }

    private var origin: Origin?
    private var prev: Projected?
    private var lastCrossT: Double?
    private var lapStartT: Double?
    private var best: LapSamples?
    private var cur: LapSamples?

    public private(set) var gate: Gate?
    /// Completed, plausible laps.
    public private(set) var lapCount: Int = 0
    public private(set) var lastLapMs: Int?
    public private(set) var bestLapMs: Int?
    /// Current predictive delta in seconds (positive = slower), or nil.
    public private(set) var deltaS: Double?

    public init() {}

    /// Replay a whole recording's fix list — same result as feeding one at a time.
    public static func fromFixes(_ fixes: [Recording.Fix]) -> LiveTiming {
        var lt = LiveTiming()
        for f in fixes { lt.addTimingFix(f) }
        return lt
    }

    private mutating func project(_ f: Recording.Fix) -> Projected {
        let o: Origin
        if let existing = origin {
            o = existing
        } else {
            o = Origin(lat: f.lat, lon: f.lon, kx: 111320 * cos(f.lat * .pi / 180), ky: 110540)
            origin = o
        }
        return Projected(t: f.t, x: (f.lon - o.lon) * o.kx, y: (f.lat - o.lat) * o.ky)
    }

    /// Where (in time) the segment a→b crosses the gate, or nil. Direction-
    /// filtered by the gate heading — the same rule as `gateCrossings`.
    private func crossingT(_ gate: Gate, _ a: Projected, _ b: Projected) -> Double? {
        let dx = b.x - a.x
        let dy = b.y - a.y
        if dx * gate.hx + dy * gate.hy <= 0 { return nil }
        let gx = gate.x2 - gate.x1
        let gy = gate.y2 - gate.y1
        let denom = dx * gy - dy * gx
        if denom == 0 { return nil }
        let wx = gate.x1 - a.x
        let wy = gate.y1 - a.y
        let s = (wx * gy - wy * gx) / denom
        let u = (wx * dy - wy * dx) / denom
        if s < 0 || s > 1 || u < 0 || u > 1 { return nil }
        return a.t + s * (b.t - a.t)
    }

    /// Time at `d` meters into the best lap, linearly interpolated; nil
    /// outside its sampled range.
    private func bestTimeAt(_ best: LapSamples, _ d: Double) -> Double? {
        let dist = best.dist
        let time = best.time
        guard let first = dist.first, let last = dist.last, d >= first, d <= last else { return nil }
        var lo = 0
        var hi = dist.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if dist[mid] <= d { lo = mid } else { hi = mid }
        }
        let span = dist[hi] - dist[lo]
        let f = span > 0 ? (d - dist[lo]) / span : 0
        return time[lo] + f * (time[hi] - time[lo])
    }

    /// Feed one accepted fix. Call in fix order — `addFix` drops out-of-order fixes.
    public mutating func addTimingFix(_ f: Recording.Fix) {
        let p = project(f)
        let prevP = prev
        prev = p
        guard let prevP else { return }

        // Anchor the gate at the first track-pace fix with a usable heading.
        guard let g = gate else {
            if let v = f.v, v >= Self.ARM_MPS {
                let hx = p.x - prevP.x
                let hy = p.y - prevP.y
                let len = (hx * hx + hy * hy).squareRoot()
                if len >= Self.MIN_HEADING_M {
                    let ux = hx / len
                    let uy = hy / len
                    gate = Gate(
                        hx: ux,
                        hy: uy,
                        x1: p.x + uy * Self.GATE_HALF_WIDTH_M,
                        y1: p.y - ux * Self.GATE_HALF_WIDTH_M,
                        x2: p.x - uy * Self.GATE_HALF_WIDTH_M,
                        y2: p.y + ux * Self.GATE_HALF_WIDTH_M
                    )
                    // Timing starts here, explicitly: the anchor fix sits exactly
                    // on the gate, so whether the next segment registers a
                    // crossing would be floating-point luck otherwise. Lap 1 is
                    // the out lap from this point around to it again.
                    lastCrossT = p.t
                    lapStartT = p.t
                    cur = LapSamples()
                }
            }
            return
        }

        // Advance the running lap by this segment.
        if cur != nil, let startT = lapStartT {
            let dx = p.x - prevP.x
            let dy = p.y - prevP.y
            cur!.d += (dx * dx + dy * dy).squareRoot()
            cur!.dist.append(cur!.d)
            cur!.time.append(p.t - startT)
            if let b = best, let ref = bestTimeAt(b, cur!.d) {
                deltaS = (p.t - startT) - ref
            } else {
                deltaS = nil
            }
        }

        guard let tc = crossingT(g, prevP, p) else { return }
        if let lastT = lastCrossT, tc - lastT < Self.MIN_CROSS_GAP_S { return }
        lastCrossT = tc

        if let startT = lapStartT {
            let lapS = tc - startT
            if lapS >= Self.MIN_LAP_S, lapS <= Self.MAX_LAP_S, let lapMs = JSMath.roundToInt(lapS * 1000) {
                lapCount += 1
                lastLapMs = lapMs
                if bestLapMs == nil || lapMs < bestLapMs! {
                    bestLapMs = lapMs
                    best = cur
                }
            }
            // Out of the plausible window (a pit stop, a red flag): not a lap,
            // but the crossing still starts a fresh one.
        }
        lapStartT = tc
        cur = LapSamples()
        deltaS = nil
    }

    /// What a record screen shows. `nowS` is the recording clock (same axis as fix `t`).
    public func display(nowS: Double) -> Display {
        Display(
            lapCount: lapCount,
            currentLapS: lapStartT.map { max(0, nowS - $0) },
            lastLapMs: lastLapMs,
            bestLapMs: bestLapMs,
            deltaS: deltaS
        )
    }
}
