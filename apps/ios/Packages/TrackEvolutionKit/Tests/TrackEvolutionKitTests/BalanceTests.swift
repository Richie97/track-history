import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/balance.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/balance.json`.
struct BalanceTests {
    /// A car with yaw gain K: yaw = K · v · δ (v in m/s). Fifteen grid points at
    /// a constant 100 km/h: a right-hander at k 2–5, a left-hander at k 9–11,
    /// straight elsewhere (three clear points between them, so the segmenter's
    /// merge gap keeps them apart). The neutral lap answers the steering exactly
    /// in both corners; the pushing lap delivers only 75% of the rotation asked
    /// for in the left-hander.
    private let K = 0.03
    private let V = 100.0 / 3.6
    private let steering: [Double] = [0, 0, 20, 40, 40, 20, 0, 0, 0, -30, -30, -30, 0, 0, 0]
    private let latG: [Double] = [0, 0, 0.5, 0.9, 0.9, 0.5, 0, 0, 0, 0.8, 0.8, 0.8, 0, 0, 0]

    private func yaw(_ scaleAt: (Int) -> Double) -> [Double] {
        steering.enumerated().map { k, d in K * V * d * scaleAt(k) }
    }

    private var neutral: LapChannels {
        LapChannels(
            n: 1, timeMs: 90_000, speed: Array(repeating: 100, count: 15), latG: latG,
            steering: steering, yaw: yaw { _ in 1 }
        )
    }

    private var pushing: LapChannels {
        LapChannels(
            n: 2, timeMs: 91_000, speed: Array(repeating: 100, count: 15), latG: latG,
            steering: steering, yaw: yaw { $0 >= 9 ? 0.75 : 1 }
        )
    }

    private var channels: SessionChannels {
        SessionChannels(v: 1, dStepM: 20, laps: [neutral, pushing])
    }

    // MARK: - hasBalanceData / balanceLaps

    @Test func needsYawSteeringAndSpeed() {
        #expect(Balance.hasBalanceData(neutral))
        #expect(!Balance.hasBalanceData(LapChannels(n: 1, timeMs: 0, steering: [1], yaw: [1])))
        #expect(!Balance.hasBalanceData(LapChannels(n: 1, timeMs: 0, speed: [1], yaw: [1])))
        #expect(!Balance.hasBalanceData(nil))
        #expect(Balance.balanceLaps(channels).map(\.chIdx) == [0, 1])
        let mixed = SessionChannels(
            v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1]), pushing]
        )
        #expect(Balance.balanceLaps(mixed).map(\.chIdx) == [1])
        #expect(Balance.balanceLaps(nil).isEmpty)
    }

    // MARK: - usableAt

    @Test func countsASampleOnlyWithSteeringToDivideByAndTheCarMoving() {
        #expect(Balance.usableAt(neutral, 3))
        #expect(!Balance.usableAt(neutral, 0)) // straight
        var shy = neutral
        shy.steering = steering.map { _ in Balance.MIN_STEER_DEG - 0.1 }
        #expect(!Balance.usableAt(shy, 3))
        var slow = neutral
        slow.speed = Array(repeating: Balance.MIN_SPEED_KPH - 1, count: 15)
        #expect(!Balance.usableAt(slow, 3))
        #expect(!Balance.usableAt(neutral, 99))
        #expect(!Balance.usableAt(LapChannels(n: 1, timeMs: 0, yaw: [1]), 0))
    }

    // MARK: - yawSign

    @Test func theAlignmentIsMeasuredNotAssumed() {
        #expect(Balance.yawSign(channels) == 1)
        var flipped = neutral
        flipped.yaw = neutral.yaw?.map { -$0 }
        #expect(Balance.yawSign(SessionChannels(v: 1, dStepM: 20, laps: [flipped])) == -1)
        // nothing to measure
        #expect(
            Balance.yawSign(SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1])])) == 1
        )
    }

    // MARK: - yawGain / referenceGain / median

    @Test func recoversTheCarsGainFromAUsableSample() throws {
        #expect(abs(try #require(Balance.yawGain(neutral, 3)) - K) < 1e-9)
        // a left-hander gives the same gain
        #expect(abs(try #require(Balance.yawGain(neutral, 9)) - K) < 1e-9)
        #expect(abs(try #require(Balance.yawGain(pushing, 9)) - 0.75 * K) < 1e-9)
        #expect(Balance.yawGain(neutral, 0) == nil)
        // the alignment sign is applied before dividing
        var flipped = neutral
        flipped.yaw = neutral.yaw?.map { -$0 }
        #expect(abs(try #require(Balance.yawGain(flipped, 3, -1)) - K) < 1e-9)
    }

    @Test func takesTheMedianOverEveryUsableSampleOfEveryLap() throws {
        // 14 usable samples: 11 at K, 3 at 0.75 K — the median is the car, not
        // the corner.
        #expect(abs(try #require(Balance.referenceGain(channels)) - K) < 1e-9)
        #expect(
            Balance.referenceGain(SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1])]))
                == nil
        )
        #expect(Balance.median([3, 1, 2]) == 2)
        #expect(Balance.median([4, 1, 3, 2]) == 2.5)
        #expect(Balance.median([]) == nil)
    }

    // MARK: - balancePoints

    @Test func dividesTheSpeedOutSoANeutralCarIsOneLineThroughTheOrigin() {
        let pts = Balance.balancePoints(neutral)
        #expect(pts.count == 15)
        #expect(pts[3].steer == 40)
        #expect(abs(pts[3].rot - K * 40) < 1e-9) // yaw / v = K · δ
        #expect(pts[3].speed == 100)
        #expect(pts[3].usable)
        #expect(!pts[0].usable)
        // a faster lap through the same corner lands on the same line
        var fast = neutral
        fast.speed = Array(repeating: 200, count: 15)
        fast.yaw = steering.map { K * (200 / 3.6) * $0 }
        #expect(abs(Balance.balancePoints(fast)[3].rot - pts[3].rot) < 1e-9)
    }

    @Test func skipsAStationarySampleAndAppliesTheAlignmentSign() {
        var parked = neutral
        parked.speed = neutral.speed?.enumerated().map { k, v in k == 0 ? 0 : v }
        #expect(Balance.balancePoints(parked).count == 14)
        var flipped = neutral
        flipped.yaw = neutral.yaw?.map { -$0 }
        #expect(abs(Balance.balancePoints(flipped, -1)[3].rot - K * 40) < 1e-9)
        #expect(Balance.balancePoints(LapChannels(n: 1, timeMs: 0, speed: [1])).isEmpty)
    }

    // MARK: - cornerBalance

    @Test func readsACornerAsRotationDeliveredOverRotationAskedFor() throws {
        let corners = Corners.sessionCorners(channels)
        #expect(corners.map { [$0.k0, $0.k1] } == [[2, 5], [9, 11]])
        let n1 = try #require(Balance.cornerBalance(neutral, corners[0], K))
        #expect(n1.samples == 4)
        #expect(abs(n1.ratio - 1) < 1e-9)
        #expect(abs(n1.pct) < 1e-9)
        let p2 = try #require(Balance.cornerBalance(pushing, corners[1], K))
        #expect(abs(p2.ratio - 0.75) < 1e-9)
        #expect(abs(p2.pct + 25) < 1e-9)
        // a left-hander projects onto the steering's direction, so it reads the
        // same way round
        #expect(abs(try #require(Balance.cornerBalance(neutral, corners[1], K)).pct) < 1e-9)
    }

    @Test func isNilWithoutUsableSamplesAReferenceOrTheChannels() {
        let corners = Corners.sessionCorners(channels)
        let straight = Corners.Corner(n: 1, k0: 0, k1: 1, peakG: 0, peakK: 0)
        #expect(Balance.cornerBalance(neutral, straight, K) == nil)
        #expect(Balance.cornerBalance(neutral, corners[0], 0) == nil)
        #expect(Balance.cornerBalance(LapChannels(n: 1, timeMs: 0, speed: [1]), corners[0], K) == nil)
    }

    // MARK: - balanceLabel / fmtBalance

    @Test func namesTheReadingBySideAndSize() {
        #expect(Balance.balanceLabel(0) == "neutral")
        #expect(Balance.balanceLabel(Balance.NEUTRAL_PCT - 0.1) == "neutral")
        #expect(Balance.balanceLabel(-Balance.NEUTRAL_PCT) == "slight understeer")
        #expect(Balance.balanceLabel(Balance.SLIGHT_PCT - 0.1) == "slight oversteer")
        #expect(Balance.balanceLabel(-Balance.SLIGHT_PCT) == "understeer")
        #expect(Balance.balanceLabel(40) == "oversteer")
        #expect(Balance.fmtBalance(-25.4) == "understeer 25%")
        #expect(Balance.fmtBalance(12) == "slight oversteer 12%")
        #expect(Balance.fmtBalance(3) == "neutral")
    }

    // MARK: - sessionBalance

    @Test func readsEveryCornerForEveryReadableLapAndPoolsTheSession() throws {
        let sb = try #require(Balance.sessionBalance(channels))
        #expect(sb.sign == 1)
        #expect(abs(sb.refGain - K) < 1e-9)
        #expect(sb.corners.map(\.corner.n) == [1, 2])
        let t2 = sb.corners[1]
        #expect(t2.laps.map(\.chIdx) == [0, 1])
        #expect(abs(t2.laps[0].pct) < 1e-9)
        #expect(abs(t2.laps[1].pct + 25) < 1e-9)
        // pooled: (1 + 0.75) / 2 of the rotation asked for
        #expect(abs(t2.all.pct + 12.5) < 1e-9)
        #expect(t2.all.samples == 6)
    }

    @Test func isNilWithoutReadableLapsCornersOrAReference() {
        let bare = SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1])])
        #expect(Balance.sessionBalance(bare) == nil)
        var noLatG = neutral
        noLatG.latG = nil
        // nowhere to find corners
        #expect(Balance.sessionBalance(SessionChannels(v: 1, dStepM: 20, laps: [noLatG])) == nil)
        var still = neutral
        still.yaw = neutral.yaw?.map { _ in 0 }
        // no rotation at all
        #expect(Balance.sessionBalance(SessionChannels(v: 1, dStepM: 20, laps: [still])) == nil)
        #expect(Balance.sessionBalance(nil) == nil)
    }

    @Test func dropsACornerNoReadableLapSteeredThrough() throws {
        // Lateral load with the wheel straight — a banked straight, say — is a
        // corner to the segmenter but gives the diagnosis nothing to divide by.
        var banked = neutral
        banked.steering = steering.enumerated().map { k, d in k >= 9 ? 0 : d }
        let sb = try #require(Balance.sessionBalance(SessionChannels(v: 1, dStepM: 20, laps: [banked])))
        #expect(sb.corners.map(\.corner.n) == [1])
    }

    // MARK: - balanceSummary

    @Test func namesTheCornersThatSitOffTheReference() {
        #expect(Balance.balanceSummary(channels) == "understeer in T2")
        #expect(Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [neutral])) == "balance neutral")
        var loose = neutral
        loose.yaw = neutral.yaw?.enumerated().map { k, y in k >= 9 ? y * 1.3 : y }
        #expect(Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [loose])) == "oversteer in T2")
        let bare = SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1])])
        #expect(Balance.balanceSummary(bare) == nil)
    }

    @Test func countsRatherThanNamesOnceThereAreMoreThanThree() {
        // Eight corners, the odd ones pushing.
        var st: [Double] = [], lg: [Double] = [], yw: [Double] = []
        for c in 0..<8 {
            st.append(contentsOf: [0, 0, 30, 30, 30, 0])
            lg.append(contentsOf: [0, 0, 0.8, 0.8, 0.8, 0])
            let s = c % 2 == 1 ? 0.7 : 1.0
            yw.append(contentsOf: [0, 0, K * V * 30 * s, K * V * 30 * s, K * V * 30 * s, 0])
        }
        let many = LapChannels(
            n: 1, timeMs: 90_000, speed: Array(repeating: 100, count: st.count), latG: lg,
            steering: st, yaw: yw
        )
        // With four pushing and four neutral, the median sits between them and
        // both sides read off it — the relative reading, stated in the docs.
        #expect(
            Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [many]))
                == "understeer in 4 corners and oversteer in 4 corners"
        )
        let few = LapChannels(
            n: 1, timeMs: 90_000, speed: Array(repeating: 100, count: 36), latG: Array(lg[0..<36]),
            steering: Array(st[0..<36]), yaw: Array(yw[0..<36])
        )
        #expect(
            Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [few]))
                == "understeer in T2, T4, T6 and oversteer in T1, T3, T5"
        )
    }

    // MARK: - the cross-language fixture

    private struct BalanceFixture: Decodable {
        struct Input: Decodable {
            let channels: SessionChannels
            let flipped: SessionChannels
            let edgeLap: LapChannels
            let mixedLap: LapChannels
            let bankedLap: LapChannels
            let manyLap: LapChannels
            let fewLap: LapChannels
            let refGain: Double
            let pcts: [Double]
        }
        struct Expected: Decodable {
            let sign: Double
            let flippedSign: Double
            let flippedSummary: String
            let edgeUsable: [Bool]
            let edgePoints: [Balance.Point]
            let gainsAt: [Double?]
            let pushingGainsAt: [Double]
            let refGain: Double
            let medians: [Double?]
            let points: [[Balance.Point]]
            let corners: [Corners.Corner]
            let cornerReadings: [[Balance.Reading?]]
            let mixed: Balance.Reading
            let session: SessionFixture
            let banked: [Int]
            let labels: [String]
            let formatted: [String]
            let summary: String
            let neutralSummary: String
            let manySummary: String
            let fewSummary: String
            let noData: String?
            let noYaw: SessionFixture?
        }
        struct SessionFixture: Decodable {
            let sign: Double
            let refGain: Double
            let corners: [CornerFixture]
        }
        struct CornerFixture: Decodable {
            let n: Int
            let laps: [Balance.LapReading]
            let all: Balance.Reading
        }
        let input: Input
        let expected: Expected
    }

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port: the wording exactly, the doubles to 1e-9.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/balance.json")
        let fixture = try JSONDecoder().decode(BalanceFixture.self, from: try Data(contentsOf: url))
        let input = fixture.input
        let want = fixture.expected
        let refGain = input.refGain

        // The alignment: measured, and the flipped recorder reads the same car.
        #expect(Balance.yawSign(input.channels) == want.sign)
        #expect(Balance.yawSign(input.flipped) == want.flippedSign)
        #expect(Balance.balanceSummary(input.flipped) == want.flippedSummary)

        // Both usability bounds are inclusive, and the stationary sample leaves
        // the scatter rather than plotting at the origin.
        #expect((0..<want.edgeUsable.count).map { Balance.usableAt(input.edgeLap, $0) } == want.edgeUsable)
        expectSame(Balance.balancePoints(input.edgeLap), want.edgePoints, "edge points")

        let lapA = input.channels.laps[0]
        let lapB = input.channels.laps[1]
        for (i, k) in [0, 3, 9].enumerated() {
            let got = Balance.yawGain(lapA, k)
            if let w = want.gainsAt[i] {
                #expect(abs(try #require(got) - w) < 1e-9, "gain at \(k)")
            } else {
                #expect(got == nil, "gain at \(k)")
            }
        }
        for (i, k) in [3, 9].enumerated() {
            #expect(abs(try #require(Balance.yawGain(lapB, k)) - want.pushingGainsAt[i]) < 1e-9)
        }
        #expect(abs(try #require(Balance.referenceGain(input.channels)) - want.refGain) < 1e-9)
        #expect(Balance.median([3, 1, 2]) == want.medians[0])
        #expect(Balance.median([4, 1, 3, 2]) == want.medians[1])
        #expect(Balance.median([]) == nil && want.medians[2] == nil)

        expectSame(Balance.balancePoints(lapA), want.points[0], "lap A points")
        expectSame(Balance.balancePoints(lapB), want.points[1], "lap B points")

        let corners = Corners.sessionCorners(input.channels)
        #expect(corners.map(\.n) == want.corners.map(\.n))
        #expect(corners.map(\.k0) == want.corners.map(\.k0))
        #expect(corners.map(\.k1) == want.corners.map(\.k1))
        for (i, c) in corners.enumerated() {
            expectSame(Balance.cornerBalance(lapA, c, refGain), want.cornerReadings[i][0], "corner \(i) lap A")
            expectSame(Balance.cornerBalance(lapB, c, refGain), want.cornerReadings[i][1], "corner \(i) lap B")
        }

        // Summed, not averaged: a port that means the per-sample ratios reads
        // +100% here rather than +46%.
        let mixedCorner = Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [input.mixedLap]))[0]
        expectSame(Balance.cornerBalance(input.mixedLap, mixedCorner, refGain), want.mixed, "mixed corner")

        let session = try #require(Balance.sessionBalance(input.channels))
        #expect(session.sign == want.session.sign)
        #expect(abs(session.refGain - want.session.refGain) < 1e-9)
        #expect(session.corners.map(\.corner.n) == want.session.corners.map(\.n))
        for (i, row) in session.corners.enumerated() {
            let w = want.session.corners[i]
            #expect(row.laps.map(\.chIdx) == w.laps.map(\.chIdx), "session corner \(i) laps")
            for (j, lap) in row.laps.enumerated() {
                #expect(abs(lap.pct - w.laps[j].pct) < 1e-9, "session corner \(i) lap \(j) pct")
                #expect(lap.samples == w.laps[j].samples, "session corner \(i) lap \(j) samples")
            }
            #expect(abs(row.all.pct - w.all.pct) < 1e-9, "session corner \(i) pooled pct")
            #expect(row.all.samples == w.all.samples, "session corner \(i) pooled samples")
        }

        let banked = try #require(Balance.sessionBalance(SessionChannels(v: 1, dStepM: 20, laps: [input.bankedLap])))
        #expect(banked.corners.map(\.corner.n) == want.banked)

        #expect(input.pcts.map(Balance.balanceLabel) == want.labels)
        #expect(input.pcts.map(Balance.fmtBalance) == want.formatted)
        #expect(Balance.balanceSummary(input.channels) == want.summary)
        #expect(
            Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [lapA])) == want.neutralSummary
        )
        #expect(
            Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [input.manyLap])) == want.manySummary
        )
        #expect(
            Balance.balanceSummary(SessionChannels(v: 1, dStepM: 20, laps: [input.fewLap])) == want.fewSummary
        )
        #expect(want.noData == nil && want.noYaw == nil)
        // The third fixture lap has cornering force but no yaw.
        #expect(
            Balance.sessionBalance(SessionChannels(v: 1, dStepM: 20, laps: [input.channels.laps[2]])) == nil
        )
    }

    private func expectSame(_ got: [Balance.Point], _ want: [Balance.Point], _ label: String) {
        #expect(got.count == want.count, "\(label) count")
        for (i, w) in want.enumerated() where i < got.count {
            #expect(got[i].k == w.k, "\(label) [\(i)] k")
            #expect(got[i].usable == w.usable, "\(label) [\(i)] usable")
            #expect(abs(got[i].steer - w.steer) < 1e-9, "\(label) [\(i)] steer")
            #expect(abs(got[i].rot - w.rot) < 1e-9, "\(label) [\(i)] rot")
            #expect(abs(got[i].speed - w.speed) < 1e-9, "\(label) [\(i)] speed")
        }
    }

    private func expectSame(_ got: Balance.Reading?, _ want: Balance.Reading?, _ label: String) {
        guard let want else {
            #expect(got == nil, "\(label): expected no reading")
            return
        }
        guard let got else {
            Issue.record("\(label): expected a reading")
            return
        }
        #expect(got.samples == want.samples, "\(label) samples")
        #expect(abs(got.expected - want.expected) < 1e-9, "\(label) expected")
        #expect(abs(got.actual - want.actual) < 1e-9, "\(label) actual")
        #expect(abs(got.ratio - want.ratio) < 1e-9, "\(label) ratio")
        #expect(abs(got.pct - want.pct) < 1e-9, "\(label) pct")
    }
}
