import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/corners.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/corners.json`.
struct CornersTests {
    /// 24 grid points: a real corner at k 2–5, a chicane at k 9–13 with a
    /// one-point dip in the middle, a kerb strike at k 17 and a straight
    /// everywhere else — the straights three points long, so the merge gap (two)
    /// leaves them apart.
    private let latG: [Double] = [
        0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0, 0, 0.7, 0.8, 0.2, 0.9, 0.7, 0.1, 0, 0, 1.4, 0, 0, 0.1, 0, 0, 0,
    ]

    private var lap: LapChannels {
        LapChannels(n: 1, timeMs: 90_000, speed: Array(repeating: 100, count: 24), latG: latG)
    }

    // MARK: - cornerMask / hasCornerData

    @Test func marksSustainedLateralLoadAndTreatsAStoredSignAsAMagnitude() {
        #expect(Corners.cornerMask([0, 0.34, 0.35, -0.9]) == [false, false, true, true])
        #expect(Corners.cornerMask(nil) == [])
        #expect(Corners.hasCornerData(lap))
        #expect(!Corners.hasCornerData(LapChannels(n: 1, timeMs: 0, speed: [1])))
        #expect(Corners.CORNER_MIN_G == 0.35)
    }

    // MARK: - cornersFromMask

    @Test func mergesAcrossAShortDipAndDropsARunTooShortToBeACorner() {
        let mask = Corners.cornerMask(latG)
        // The chicane's dip at k 11 is one clear point, so it merges; the kerb
        // strike at k 17 is one point, so it drops.
        #expect(Corners.cornersFromMask(mask) == [Limits.Run(k0: 2, k1: 5), Limits.Run(k0: 9, k1: 13)])
        #expect(Corners.CORNER_MERGE_GAP_POINTS == 2)
        #expect(Corners.MIN_CORNER_POINTS == 3)
    }

    @Test func takesItsThresholdsAsOptions() {
        let mask = Corners.cornerMask(latG)
        #expect(Corners.cornersFromMask(mask, mergeGap: 0) == [Limits.Run(k0: 2, k1: 5)])
        #expect(
            Corners.cornersFromMask(mask, mergeGap: 0, minPoints: 2)
                == [Limits.Run(k0: 2, k1: 5), Limits.Run(k0: 9, k1: 10), Limits.Run(k0: 12, k1: 13)]
        )
        #expect(Corners.cornersFromMask(mask, minPoints: 1).count == 3) // the strike counts
    }

    // MARK: - lapCorners

    @Test func numbersTheCornersFromTheStartFinishLineAndFindsEachPeak() {
        let cs = Corners.lapCorners(lap)
        #expect(cs.map { [$0.n, $0.k0, $0.k1] } == [[1, 2, 5], [2, 9, 13]])
        #expect(abs(cs[0].peakG - 1.0) < 1e-9)
        #expect(cs[0].peakK == 4)
        #expect(abs(cs[1].peakG - 0.9) < 1e-9)
        #expect(cs[1].peakK == 12)
        #expect(Corners.cornerLabel(cs[1]) == "T2")
    }

    @Test func isEmptyWithoutALateralGChannel() {
        #expect(Corners.lapCorners(LapChannels(n: 1, timeMs: 0, speed: [1, 2, 3])).isEmpty)
        #expect(Corners.lapCorners(nil).isEmpty)
    }

    // MARK: - sessionCorners

    @Test func segmentsWhereTheLapsAgreeSoTheListIsOneListForTheSession() {
        // The second lap takes the first corner wider (load starts a point
        // earlier) and never loads the tyre through the chicane. Two laps need
        // only one to agree, so this is still the union — the quorum has
        // nothing to arbitrate until there are three.
        let wide = LapChannels(
            n: 2, timeMs: 91_000, speed: Array(repeating: 100, count: 24),
            latG: latG.enumerated().map { k, g in k == 1 ? 0.4 : (k >= 9 && k <= 13 ? 0.1 : g) }
        )
        let cs = Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [lap, wide]))
        #expect(cs.map { [$0.n, $0.k0, $0.k1, $0.laps] } == [[1, 1, 5, 2], [2, 9, 13, 1]])
        #expect(abs(cs[0].peakG - 1.0) < 1e-9) // the highest any lap saw
    }

    /// Two corners with a three-point straight between them — one point more
    /// than the merge gap, so they stay apart — and a lap that stays loaded
    /// across it. Under the union this used to take, that one lap chained the
    /// pair into a single corner; this is the VIR failure in miniature.
    private static let bridgeLatG: [Double] =
        [0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0, 0.1, 0.7, 0.9, 0.8, 0.5, 0.1, 0, 0]
    private var bridgeClean: LapChannels { LapChannels(n: 1, timeMs: 90_000, latG: Self.bridgeLatG) }
    private var bridging: LapChannels {
        LapChannels(
            n: 2, timeMs: 91_000,
            latG: Self.bridgeLatG.enumerated().map { k, g in (k >= 6 && k <= 8) ? 0.5 : g }
        )
    }

    @Test func keepsNeighbouringCornersApartWhenOnlyAMinorityOfLapsBridgesThem() {
        // Correct for that lap on its own, and exactly what must not become the
        // session's reading.
        #expect(Corners.lapCorners(bridging).map { [$0.k0, $0.k1] } == [[2, 12]])
        let cs = Corners.sessionCorners(
            SessionChannels(v: 1, dStepM: 20, laps: [bridgeClean, bridgeClean, bridging])
        )
        #expect(cs.map { [$0.n, $0.k0, $0.k1, $0.laps] } == [[1, 2, 5, 3], [2, 9, 12, 3]])
    }

    @Test func stillMergesWhenMostLapsAgreeTheGapIsLoaded() {
        let cs = Corners.sessionCorners(
            SessionChannels(v: 1, dStepM: 20, laps: [bridgeClean, bridging, bridging])
        )
        #expect(cs.map { [$0.k0, $0.k1] } == [[2, 12]])
    }

    @Test func degradesToAnyLapBelowTwoLapsSoASingleLapSessionStillSegments() {
        #expect([1, 2, 3, 7].map { Corners.lapQuorum($0) } == [1, 1, 2, 4])
        let cs = Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [bridging]))
        #expect(cs.map { [$0.k0, $0.k1] } == [[2, 12]])
        #expect(Corners.CORNER_LAP_QUORUM == 0.5)
    }

    @Test func ignoresLapsWithoutLateralGAndIsEmptyWhenNoneHasIt() {
        let bare = LapChannels(n: 9, timeMs: 0, speed: [1])
        #expect(Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [bare, lap])).count == 2)
        #expect(Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [bare])).isEmpty)
        #expect(Corners.sessionCorners(nil).isEmpty)
    }

    // MARK: - cornerAt

    @Test func findsTheCornerAGridPointSitsIn() {
        let cs = Corners.lapCorners(lap)
        #expect(Corners.cornerAt(cs, 3) == cs[0])
        #expect(Corners.cornerAt(cs, 11) == cs[1]) // the dip inside the chicane is still the chicane
        #expect(Corners.cornerAt(cs, 7) == nil)
        #expect(Corners.cornerAt([], 3) == nil)
    }

    // MARK: - the cross-language fixture

    private struct CornersFixture: Decodable {
        struct Input: Decodable {
            let channels: SessionChannels
            let mask: [Double]
            let bridgeChannels: SessionChannels
            let bridgeMajorityChannels: SessionChannels
        }
        struct Expected: Decodable {
            let mask: [Bool]
            let runs: [Limits.Run]
            let tightRuns: [Limits.Run]
            let shortRuns: [Limits.Run]
            let strikeRuns: [Limits.Run]
            let lapA: [Corners.Corner]
            let session: [Corners.Corner]
            let labels: [String]
            let at: [Int?]
            let noData: [Corners.Corner]
            let bridge: [Corners.Corner]
            let bridgeMajority: [Corners.Corner]
            let bridgeLapAlone: [Corners.Corner]
            let quorum: [Int]
        }
        let input: Input
        let expected: Expected
    }

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port: the windows exactly, the peaks to 1e-9.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/corners.json")
        let fixture = try JSONDecoder().decode(CornersFixture.self, from: try Data(contentsOf: url))
        let channels = fixture.input.channels
        let latG = try #require(channels.laps[0].latG)

        #expect(Corners.cornerMask(fixture.input.mask) == fixture.expected.mask)
        #expect(Corners.cornersFromMask(Corners.cornerMask(latG)) == fixture.expected.runs)
        #expect(Corners.cornersFromMask(Corners.cornerMask(latG), mergeGap: 0) == fixture.expected.tightRuns)
        #expect(
            Corners.cornersFromMask(Corners.cornerMask(latG), mergeGap: 0, minPoints: 2)
                == fixture.expected.shortRuns
        )
        #expect(Corners.cornersFromMask(Corners.cornerMask(latG), minPoints: 1) == fixture.expected.strikeRuns)

        expectSame(Corners.lapCorners(channels.laps[0]), fixture.expected.lapA, "lapCorners")
        let session = Corners.sessionCorners(channels)
        expectSame(session, fixture.expected.session, "sessionCorners")
        #expect(session.map(Corners.cornerLabel) == fixture.expected.labels)
        #expect([3, 11, 7, 99].map { Corners.cornerAt(session, $0)?.n } == fixture.expected.at)
        #expect(
            Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[2]])).isEmpty
        )
        #expect(fixture.expected.noData.isEmpty)
        // The quorum, not a union: one lap of three staying loaded across a
        // short straight must not chain the corners either side of it, while
        // two of three must. A port that ORs the masks passes everything above
        // and fails exactly here.
        expectSame(Corners.sessionCorners(fixture.input.bridgeChannels), fixture.expected.bridge, "bridge")
        expectSame(
            Corners.sessionCorners(fixture.input.bridgeMajorityChannels),
            fixture.expected.bridgeMajority,
            "bridgeMajority"
        )
        expectSame(
            Corners.lapCorners(fixture.input.bridgeChannels.laps[2]),
            fixture.expected.bridgeLapAlone,
            "bridgeLapAlone"
        )
        #expect([1, 2, 3, 7].map { Corners.lapQuorum($0) } == fixture.expected.quorum)
    }

    private func expectSame(_ got: [Corners.Corner], _ want: [Corners.Corner], _ label: String) {
        #expect(got.count == want.count, "\(label) count")
        for (i, w) in want.enumerated() where i < got.count {
            #expect(got[i].n == w.n, "\(label) [\(i)] n")
            #expect(got[i].k0 == w.k0, "\(label) [\(i)] k0")
            #expect(got[i].k1 == w.k1, "\(label) [\(i)] k1")
            #expect(got[i].peakK == w.peakK, "\(label) [\(i)] peakK")
            #expect(got[i].laps == w.laps, "\(label) [\(i)] laps")
            #expect(abs(got[i].peakG - w.peakG) < 1e-9, "\(label) [\(i)] peakG")
        }
    }
}
