import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/grip.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/grip.json`.
struct GripTests {
    /// Eight grid points each. The "cross" lap brakes in a straight line, turns,
    /// then accelerates — the two axes are never used together. The "circle" lap
    /// trails the brake in (k1, k2) and feeds the power out (k4–k6), all while
    /// cornering, and steers left throughout so its samples mirror to −x.
    private let cross = LapChannels(
        n: 1, timeMs: 90_000, speed: Array(repeating: 120, count: 8),
        latG: [0, 0, 0, 1.2, 1.2, 0, 0, 0],
        longG: [0, -1, -1, 0, 0, 0.5, 0.5, 0]
    )
    private let circle = LapChannels(
        n: 2, timeMs: 88_000, speed: Array(repeating: 120, count: 8),
        latG: [0, 0.6, 0.9, 1.1, 1.0, 0.8, 0.4, 0],
        steering: [0, -10, -12, -14, -12, -8, -3, 0],
        longG: [0, -0.9, -0.6, 0, 0.3, 0.5, 0.6, 0]
    )

    private var channels: SessionChannels {
        SessionChannels(v: 1, dStepM: 20, laps: [cross, circle])
    }

    // MARK: - hasGripData / gripLaps

    @Test func needsBothChannels() {
        #expect(Grip.hasGripData(cross))
        #expect(!Grip.hasGripData(LapChannels(n: 1, timeMs: 0, latG: [1, 2])))
        #expect(!Grip.hasGripData(LapChannels(n: 1, timeMs: 0, longG: [1, 2])))
        #expect(Grip.gripLaps(channels).map(\.chIdx) == [0, 1])
        // a lap without both is left out, and the indexes stay channel indexes
        let mixed = SessionChannels(
            v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1]), circle]
        )
        #expect(Grip.gripLaps(mixed).map(\.chIdx) == [1])
    }

    // MARK: - latSign

    @Test func takesTheSideFromTheSteeringTrace() {
        #expect(Grip.latSign(circle, 1) == -1)
        #expect(Grip.latSign(circle, 0) == 1) // straight: sign doesn't matter, latG ~ 0
        #expect(Grip.latSign(cross, 3) == 1) // no steering stored
        #expect(Grip.latSign(circle, 99) == 1) // past the end of the trace
    }

    // MARK: - gripPoints

    @Test func signsLateralBySteeringAndKeepsLongitudinalAsStored() {
        let pts = Grip.gripPoints(circle)
        #expect(pts.count == 8)
        #expect(pts[1].lat == -0.6) // steering negative -> left
        #expect(pts[1].long == -0.9) // braking stays negative
        #expect(abs(pts[1].g - hypot(0.6, 0.9)) < 1e-12)
        #expect(pts[1].k == 1)
        #expect(Grip.gripPoints(cross)[3].lat == 1.2) // no steering: right side
    }

    @Test func plotsOnlyTheSamplesBothChannelsCover() {
        let ragged = LapChannels(n: 1, timeMs: 0, latG: [1, 1, 1], longG: [0, 0])
        #expect(Grip.gripPoints(ragged).count == 2)
        #expect(Grip.gripPoints(LapChannels(n: 1, timeMs: 0, speed: [1, 2])).isEmpty)
    }

    @Test func aMagnitudeStoredWithASignIsStillAMagnitude() {
        // pdr.js stores abs(lateral acceleration); a negative would be a bug in a
        // source, and it must not flip a sample to the other side of the plot.
        let odd = LapChannels(n: 1, timeMs: 0, latG: [-1.1], longG: [0])
        #expect(Grip.gripPoints(odd)[0].lat == 1.1)
    }

    // MARK: - gripShares

    @Test func scoresTheCrossAtZeroOnBothQuadrants() throws {
        let sh = try #require(Grip.gripShares(cross))
        #expect(sh.loaded == 6) // the two zero samples are the tyre doing nothing
        #expect(sh.trailBrake == 0)
        #expect(sh.powerDown == 0)
        #expect(sh.trailPct == 0)
        #expect(sh.powerPct == 0)
    }

    @Test func scoresTheFilledCircleOnBoth() throws {
        let sh = try #require(Grip.gripShares(circle))
        #expect(sh.samples == 8)
        #expect(sh.loaded == 6)
        #expect(sh.trailBrake == 2)
        #expect(sh.powerDown == 3)
        #expect(abs(sh.trailPct - 2.0 / 6 * 100) < 1e-9)
        #expect(abs(sh.powerPct - 3.0 / 6 * 100) < 1e-9)
    }

    @Test func needsBothAxesPastTheThresholdToCountAsCombined() throws {
        let under = LapChannels(
            n: 1, timeMs: 0,
            latG: [1, Grip.COMBINED_MIN_G - 0.01, 1],
            longG: [-(Grip.COMBINED_MIN_G - 0.01), -1, -Grip.COMBINED_MIN_G]
        )
        #expect(try #require(Grip.gripShares(under)).trailBrake == 1) // only the third sample
    }

    @Test func isNilForALapThatNeverLoadsTheTyre() throws {
        #expect(Grip.gripShares(LapChannels(n: 1, timeMs: 0, latG: [0, 0.1], longG: [0, -0.1])) == nil)
        #expect(Grip.gripShares(LapChannels(n: 1, timeMs: 0, speed: [1])) == nil)
        // exactly at the threshold counts as loaded
        let atThreshold = LapChannels(n: 1, timeMs: 0, latG: [Grip.MIN_LOAD_G], longG: [0])
        #expect(try #require(Grip.gripShares(atThreshold)).loaded == 1)
    }

    // MARK: - peakCombinedG

    @Test func isAPercentileSoOneKerbStrikeDoesNotSetTheEnvelope() {
        var latG = Array(repeating: 1.0, count: 100)
        latG[42] = 3 // the strike
        let spike = SessionChannels(
            v: 1, dStepM: 20,
            laps: [LapChannels(n: 1, timeMs: 0, latG: latG, longG: Array(repeating: 0, count: 100))]
        )
        #expect(Grip.peakCombinedG(spike) == 1)
        #expect(Grip.PEAK_PERCENTILE == 0.99)
        // and the max is still reachable when asked for
        #expect(Grip.peakCombinedG(spike, 1) == 3)
    }

    @Test func poolsEveryPlottableLapAndIsNilWithoutOne() throws {
        #expect(try #require(Grip.peakCombinedG(channels)) > 1)
        let none = SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1, 2])])
        #expect(Grip.peakCombinedG(none) == nil)
    }

    // MARK: - sessionGrip

    @Test func keepsARowPerLapAndPoolsTheSession() throws {
        let sg = try #require(Grip.sessionGrip(channels))
        #expect(sg.laps.map(\.chIdx) == [0, 1])
        #expect(abs(sg.maxG - 1.2) < 1e-12) // the max, unlike the arc
        #expect(sg.all.loaded == 12)
        #expect(sg.all.trailBrake == 2)
        #expect(sg.all.powerDown == 3)
        #expect(abs(sg.all.trailPct - 2.0 / 12 * 100) < 1e-9)
    }

    @Test func isNilWhenNoLapStoredBothChannels() {
        let none = SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1, 2])])
        #expect(Grip.sessionGrip(none) == nil)
    }

    // MARK: - the cross-language fixture

    private struct GripFixture: Decodable {
        struct Input: Decodable {
            let channels: SessionChannels
            let edgeLap: LapChannels
            let spikeChannels: SessionChannels
        }

        struct Expected: Decodable {
            let latSignA: [Double]
            let latSignB: [Double]
            let points: [[Grip.Point]]
            let shares: [Grip.Shares?]
            let edgeShares: Grip.Shares
            let session: Grip.SessionGrip
            let peak: Double
            let spikePeak: Double
            let spikeMax: Double
            let noData: Grip.SessionGrip?
        }

        let input: Input
        let expected: Expected
    }

    /// Counts are exact; the doubles that come out of `hypot` are compared to
    /// 1e-9, since the last ulp is a platform's libm rather than this logic.
    private func expectSame(_ got: Grip.Shares?, _ want: Grip.Shares?, _ label: String) {
        guard let got, let want else {
            #expect(got == nil && want == nil, "\(label): one side is nil")
            return
        }
        #expect(got.samples == want.samples, "\(label) samples")
        #expect(got.loaded == want.loaded, "\(label) loaded")
        #expect(got.trailBrake == want.trailBrake, "\(label) trailBrake")
        #expect(got.powerDown == want.powerDown, "\(label) powerDown")
        #expect(abs(got.trailPct - want.trailPct) < 1e-9, "\(label) trailPct")
        #expect(abs(got.powerPct - want.powerPct) < 1e-9, "\(label) powerPct")
    }

    @Test func matchesTheWebImplementation() throws {
        let url = RepoRoot.path("contracts/logic/grip.json")
        let fixture = try JSONDecoder().decode(GripFixture.self, from: try Data(contentsOf: url))
        let channels = fixture.input.channels
        let lapA = channels.laps[0]
        let lapB = channels.laps[1]

        #expect([0, 3, 13, 99].map { Grip.latSign(lapA, $0) } == fixture.expected.latSignA)
        #expect([0, 4, 13].map { Grip.latSign(lapB, $0) } == fixture.expected.latSignB)

        for (lapIdx, want) in fixture.expected.points.enumerated() {
            let got = Grip.gripPoints(channels.laps[lapIdx])
            #expect(got.count == want.count, "lap \(lapIdx) point count")
            for (i, w) in want.enumerated() where i < got.count {
                #expect(got[i].k == w.k, "lap \(lapIdx) point \(i) k")
                #expect(abs(got[i].lat - w.lat) < 1e-9, "lap \(lapIdx) point \(i) lat")
                #expect(abs(got[i].long - w.long) < 1e-9, "lap \(lapIdx) point \(i) long")
                #expect(abs(got[i].g - w.g) < 1e-9, "lap \(lapIdx) point \(i) g")
            }
        }

        for (lapIdx, want) in fixture.expected.shares.enumerated() {
            expectSame(Grip.gripShares(channels.laps[lapIdx]), want, "lap \(lapIdx) shares")
        }
        expectSame(Grip.gripShares(fixture.input.edgeLap), fixture.expected.edgeShares, "edge lap")

        let session = try #require(Grip.sessionGrip(channels))
        #expect(session.laps.map(\.chIdx) == fixture.expected.session.laps.map(\.chIdx))
        for (i, want) in fixture.expected.session.laps.enumerated() {
            #expect(session.laps[i].trailBrake == want.trailBrake, "session lap \(i) trailBrake")
            #expect(session.laps[i].powerDown == want.powerDown, "session lap \(i) powerDown")
            #expect(abs(session.laps[i].trailPct - want.trailPct) < 1e-9, "session lap \(i) trailPct")
        }
        expectSame(session.all, fixture.expected.session.all, "session pooled")
        #expect(abs(session.maxG - fixture.expected.session.maxG) < 1e-9)
        #expect(abs(try #require(session.peakG) - fixture.expected.peak) < 1e-9)

        // The percentile is the point: at 0.99 the kerb strike is outside the
        // envelope, at 1 it sets it.
        let spike = fixture.input.spikeChannels
        #expect(abs(try #require(Grip.peakCombinedG(spike)) - fixture.expected.spikePeak) < 1e-9)
        #expect(abs(try #require(Grip.peakCombinedG(spike, 1)) - fixture.expected.spikeMax) < 1e-9)

        #expect(fixture.expected.noData == nil)
        #expect(Grip.sessionGrip(SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[2]])) == nil)
    }
}
