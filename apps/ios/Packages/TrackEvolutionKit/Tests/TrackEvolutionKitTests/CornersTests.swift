import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/corners.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/corners.json`.
struct CornersTests {
    /// 24 grid points: a real corner at k 2–5, a double apex at k 9–13 with a
    /// one-point dip in the middle, a kerb strike at k 17 and a straight
    /// everywhere else — the straights three points long, so the merge gap (two)
    /// leaves them apart. No yaw and no steering: the magnitude-only reading.
    private let latG: [Double] = [
        0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0, 0, 0.7, 0.8, 0.2, 0.9, 0.7, 0.1, 0, 0, 1.4, 0, 0, 0.1, 0, 0, 0,
    ]

    private var lap: LapChannels {
        LapChannels(n: 1, timeMs: 90_000, speed: Array(repeating: 100, count: 24), latG: latG)
    }

    /// 21 grid points of esses: left at k 1–3, right at k 5–7 with one clear
    /// point between them, then a left double apex at k 11–13 and k 15–17. Read
    /// as a magnitude the first two are one corner; read with a direction they
    /// are two, and the double apex is still one.
    private let essG: [Double] = [
        0, 0.6, 0.8, 0.7, 0.2, 0.7, 0.9, 0.8, 0.1, 0, 0, 0.6, 0.7, 0.6, 0.1, 0.5, 0.6, 0.5, 0, 0, 0,
    ]
    private let essYaw: [Double] = [
        1, 5, 6, 5, 1, -5, -6, -5, -1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 1, 1, 1,
    ]

    private func essLap(n: Int = 1, latG: [Double]? = nil, yaw: [Double]? = nil, steering: [Double]? = nil)
        -> LapChannels
    {
        LapChannels(
            n: n, timeMs: 60_000, speed: Array(repeating: 100, count: 21), latG: latG ?? essG,
            steering: steering, yaw: yaw
        )
    }

    private var esses: LapChannels { essLap(yaw: essYaw) }

    /// Still loaded left through k 4 and k 5, where `esses` has let go or
    /// turned right.
    private var late: LapChannels {
        essLap(
            n: 3,
            latG: essG.enumerated().map { k, g in k == 4 || k == 5 ? 0.5 : g },
            yaw: essYaw.enumerated().map { k, v in k == 4 || k == 5 ? 3 : v }
        )
    }

    private func session(_ laps: LapChannels...) -> SessionChannels {
        SessionChannels(v: 1, dStepM: 20, laps: laps)
    }

    private func windows(_ cs: [Corners.Corner]) -> [[Int]] {
        cs.map { [$0.n, $0.k0, $0.k1] }
    }

    // MARK: - lateralSigns / hasCornerData

    @Test func readsTheDirectionFromYawElseSteeringAndHasNoneWithoutEither() {
        #expect(Corners.lateralSigns(LapChannels(n: 1, timeMs: 0, latG: [1, 1, 1], yaw: [2, -3, 0])) == [1, -1, 1])
        #expect(
            Corners.lateralSigns(LapChannels(n: 1, timeMs: 0, latG: [1, 1, 1], steering: [-40, 40, 40]))
                == [-1, 1, 1]
        )
        // yaw wins when a lap has both
        #expect(
            Corners.lateralSigns(
                LapChannels(n: 1, timeMs: 0, latG: [1, 1, 1], steering: [-40, -40, -40], yaw: [1, 1, 1])
            ) == [1, 1, 1]
        )
        #expect(Corners.lateralSigns(lap) == nil)
        #expect(Corners.lateralSigns(LapChannels(n: 1, timeMs: 0, yaw: [1, 2])) == nil)
        #expect(Corners.hasCornerData(lap))
        #expect(!Corners.hasCornerData(LapChannels(n: 1, timeMs: 0, speed: [1])))
    }

    // MARK: - cornerDirs

    @Test func marksSustainedLateralLoadAndTreatsAStoredSignAsAMagnitude() {
        #expect(Corners.cornerDirs([0, 0.34, 0.35, -0.9]) == [0, 0, 1, 1])
        #expect(Corners.cornerDirs([0, 0.34, 0.35, -0.9], [1, -1, -1, 1]) == [0, 0, -1, 1])
        #expect(Corners.cornerDirs(nil) == [])
        #expect(Corners.CORNER_MIN_G == 0.35)
    }

    // MARK: - cornersFromDirs

    @Test func mergesAcrossAShortDipAndDropsARunTooShortToBeACorner() {
        let dirs = Corners.cornerDirs(latG)
        // The double apex's dip at k 11 is one clear point, so it merges; the
        // kerb strike at k 17 is one point, so it drops.
        #expect(Corners.cornersFromDirs(dirs) == [Limits.Run(k0: 2, k1: 5), Limits.Run(k0: 9, k1: 13)])
        #expect(Corners.CORNER_MERGE_GAP_POINTS == 2)
        #expect(Corners.MIN_CORNER_POINTS == 3)
    }

    @Test func takesItsThresholdsAsOptions() {
        let dirs = Corners.cornerDirs(latG)
        #expect(Corners.cornersFromDirs(dirs, mergeGap: 0) == [Limits.Run(k0: 2, k1: 5)])
        #expect(
            Corners.cornersFromDirs(dirs, mergeGap: 0, minPoints: 2)
                == [Limits.Run(k0: 2, k1: 5), Limits.Run(k0: 9, k1: 10), Limits.Run(k0: 12, k1: 13)]
        )
        #expect(Corners.cornersFromDirs(dirs, minPoints: 1).count == 3) // the strike counts
    }

    @Test func neverMergesAcrossAChangeOfDirection() {
        #expect(
            Corners.cornersFromDirs([1, 1, 1, 0, -1, -1, -1])
                == [Limits.Run(k0: 0, k1: 2), Limits.Run(k0: 4, k1: 6)]
        )
        // no gap at all
        #expect(
            Corners.cornersFromDirs([1, 1, 1, -1, -1, -1])
                == [Limits.Run(k0: 0, k1: 2), Limits.Run(k0: 3, k1: 5)]
        )
        // An opposite flick between two same-direction runs keeps them apart
        // even though the gap between them is inside the merge distance.
        let flick = [1, 1, 1, -1, 1, 1, 1]
        #expect(
            Corners.cornersFromDirs(flick, minPoints: 1)
                == [Limits.Run(k0: 0, k1: 2), Limits.Run(k0: 3, k1: 3), Limits.Run(k0: 4, k1: 6)]
        )
        #expect(Corners.cornersFromDirs(flick) == [Limits.Run(k0: 0, k1: 2), Limits.Run(k0: 4, k1: 6)])
    }

    // MARK: - lapCorners

    @Test func numbersTheCornersFromTheStartFinishLineAndFindsEachPeak() {
        let cs = Corners.lapCorners(lap)
        #expect(windows(cs) == [[1, 2, 5], [2, 9, 13]])
        #expect(abs(cs[0].peakG - 1.0) < 1e-9)
        #expect(cs[0].peakK == 4)
        #expect(abs(cs[1].peakG - 0.9) < 1e-9)
        #expect(cs[1].peakK == 12)
        #expect(Corners.cornerLabel(cs[1]) == "T2")
    }

    @Test func cutsLinkedCornersApartWhereTheDirectionChanges() {
        // same direction either side of the dip: the double apex is still one
        let cut = [[1, 1, 3], [2, 5, 7], [3, 11, 17]]
        #expect(windows(Corners.lapCorners(esses)) == cut)
        // Which sign is "left" is the recorder's business: the cut is the same.
        #expect(windows(Corners.lapCorners(essLap(steering: essYaw.map { $0 * -3 }))) == cut)
        // Without a direction the esses are one corner, as they were.
        #expect(windows(Corners.lapCorners(essLap())) == [[1, 1, 7], [2, 11, 17]])
    }

    @Test func isEmptyWithoutALateralGChannel() {
        #expect(Corners.lapCorners(LapChannels(n: 1, timeMs: 0, speed: [1, 2, 3])).isEmpty)
        #expect(Corners.lapCorners(nil).isEmpty)
    }

    // MARK: - sessionDirs

    @Test func putsALapFromARecorderWithTheOppositeConventionTheSameWayRound() {
        let dirs = Corners.sessionDirs([esses, essLap(yaw: essYaw.map { -$0 })])
        #expect(dirs[0] == dirs[1])
        #expect(Array(dirs[0].prefix(8)) == [0, 1, 1, 1, 0, -1, -1, -1])
    }

    @Test func usesNoDirectionAtAllWhenAnyLapHasNone() {
        let dirs = Corners.sessionDirs([esses, essLap()])
        #expect(dirs[0] == dirs[1])
        #expect(Array(dirs[0].prefix(8)) == [0, 1, 1, 1, 0, 1, 1, 1])
    }

    // MARK: - sessionCorners

    @Test func segmentsEveryLapTogetherSoTheListIsOneListForTheSession() {
        // The second lap takes the first corner wider (load starts a point
        // earlier) and never loads the tire through the double apex.
        let wide = LapChannels(
            n: 2, timeMs: 91_000, speed: Array(repeating: 100, count: 24),
            latG: latG.enumerated().map { k, g in k == 1 ? 0.4 : (k >= 9 && k <= 13 ? 0.1 : g) }
        )
        let cs = Corners.sessionCorners(session(lap, wide))
        #expect(cs.map { [$0.n, $0.k0, $0.k1, $0.laps] } == [[1, 1, 5, 2], [2, 9, 13, 1]])
        #expect(abs(cs[0].peakG - 1.0) < 1e-9) // the highest any lap saw
    }

    @Test func keepsLinkedCornersApartAcrossLapsWhateverEachRecorderCallsLeft() {
        let cs = Corners.sessionCorners(session(esses, essLap(n: 2, yaw: essYaw.map { -$0 })))
        #expect(cs.map { [$0.n, $0.k0, $0.k1, $0.laps] } == [[1, 1, 3, 2], [2, 5, 7, 2], [3, 11, 17, 2]])
    }

    @Test func givesAContestedPointToTheDirectionMoreLapsTurnTheEarliestLapOnATie() {
        // Two against one at k 5: it stays in the right-hander. k 4 is loaded
        // by one lap only, so the left-hander reaches it.
        #expect(
            windows(Corners.sessionCorners(session(esses, essLap(n: 2, yaw: essYaw), late)))
                == [[1, 1, 4], [2, 5, 7], [3, 11, 17]]
        )
        // One against one at k 5: the earliest lap decides, either way round…
        #expect(windows(Corners.sessionCorners(session(esses, late)))[1] == [2, 5, 7])
        // …and what is left of the right-hander is then too short to be a corner.
        #expect(windows(Corners.sessionCorners(session(late, esses))) == [[1, 1, 5], [2, 11, 17]])
    }

    @Test func fallsBackToMagnitudeAloneWhenALapHasNoDirection() {
        #expect(windows(Corners.sessionCorners(session(esses, essLap(n: 2)))) == [[1, 1, 7], [2, 11, 17]])
    }

    @Test func ignoresLapsWithoutLateralGAndIsEmptyWhenNoneHasIt() {
        let bare = LapChannels(n: 9, timeMs: 0, speed: [1])
        #expect(Corners.sessionCorners(session(bare, lap)).count == 2)
        #expect(Corners.sessionCorners(session(bare)).isEmpty)
        #expect(Corners.sessionCorners(nil).isEmpty)
    }

    // MARK: - cornerAt

    @Test func findsTheCornerAGridPointSitsIn() {
        let cs = Corners.lapCorners(lap)
        #expect(Corners.cornerAt(cs, 3) == cs[0])
        #expect(Corners.cornerAt(cs, 11) == cs[1]) // the dip inside the double apex is still that corner
        #expect(Corners.cornerAt(cs, 7) == nil)
        #expect(Corners.cornerAt([], 3) == nil)
    }

    // MARK: - the cross-language fixture

    private struct CornersFixture: Decodable {
        struct Input: Decodable {
            let channels: SessionChannels
            let latG: [Double]
            let signs: [Int]
            let turns: [Int]
            let esses: [String: LapChannels]
        }
        struct Signs: Decodable {
            let a: [Int]?
            let steered: [Int]?
            let bare: [Int]?
        }
        struct Expected: Decodable {
            let dirs: [Int]
            let signedDirs: [Int]
            let runs: [Limits.Run]
            let tightRuns: [Limits.Run]
            let shortRuns: [Limits.Run]
            let strikeRuns: [Limits.Run]
            let turnRuns: [Limits.Run]
            let turnRunsAll: [Limits.Run]
            let signs: Signs
            let lapA: [Corners.Corner]
            let essLap: [Corners.Corner]
            let essSteered: [Corners.Corner]
            let essBare: [Corners.Corner]
            let session: [Corners.Corner]
            let labels: [String]
            let at: [Int?]
            let noData: [Corners.Corner]
            let flippedDirs: [[Int]]
            let bareDirs: [[Int]]
            let essFlipped: [Corners.Corner]
            let essVote: [Corners.Corner]
            let essTie: [Corners.Corner]
            let essTieLate: [Corners.Corner]
            let essMixed: [Corners.Corner]
        }
        let input: Input
        let expected: Expected
    }

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port: the windows exactly, the peaks to 1e-9.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/corners.json")
        let fixture = try JSONDecoder().decode(CornersFixture.self, from: try Data(contentsOf: url))
        let input = fixture.input
        let expected = fixture.expected
        let channels = input.channels
        let latG = try #require(channels.laps[0].latG)
        let a = try #require(input.esses["a"])
        let again = try #require(input.esses["again"])
        let flipped = try #require(input.esses["flipped"])
        let late = try #require(input.esses["late"])
        let steered = try #require(input.esses["steered"])
        let bare = try #require(input.esses["bare"])

        #expect(Corners.cornerDirs(input.latG) == expected.dirs)
        #expect(Corners.cornerDirs(input.latG, input.signs) == expected.signedDirs)
        let dirs = Corners.cornerDirs(latG)
        #expect(Corners.cornersFromDirs(dirs) == expected.runs)
        #expect(Corners.cornersFromDirs(dirs, mergeGap: 0) == expected.tightRuns)
        #expect(Corners.cornersFromDirs(dirs, mergeGap: 0, minPoints: 2) == expected.shortRuns)
        #expect(Corners.cornersFromDirs(dirs, minPoints: 1) == expected.strikeRuns)
        #expect(Corners.cornersFromDirs(input.turns) == expected.turnRuns)
        #expect(Corners.cornersFromDirs(input.turns, minPoints: 1) == expected.turnRunsAll)

        #expect(Corners.lateralSigns(a) == expected.signs.a)
        #expect(Corners.lateralSigns(steered) == expected.signs.steered)
        #expect(Corners.lateralSigns(bare) == expected.signs.bare)

        expectSame(Corners.lapCorners(channels.laps[0]), expected.lapA, "lapCorners")
        expectSame(Corners.lapCorners(a), expected.essLap, "essLap")
        expectSame(Corners.lapCorners(steered), expected.essSteered, "essSteered")
        expectSame(Corners.lapCorners(bare), expected.essBare, "essBare")

        let session = Corners.sessionCorners(channels)
        expectSame(session, expected.session, "sessionCorners")
        #expect(session.map(Corners.cornerLabel) == expected.labels)
        #expect([3, 11, 7, 99].map { Corners.cornerAt(session, $0)?.n } == expected.at)
        #expect(Corners.sessionCorners(self.session(channels.laps[2])).isEmpty)
        #expect(expected.noData.isEmpty)

        #expect(Corners.sessionDirs([a, flipped]) == expected.flippedDirs)
        #expect(Corners.sessionDirs([a, bare]) == expected.bareDirs)
        expectSame(Corners.sessionCorners(self.session(a, flipped)), expected.essFlipped, "essFlipped")
        expectSame(Corners.sessionCorners(self.session(a, again, late)), expected.essVote, "essVote")
        expectSame(Corners.sessionCorners(self.session(a, late)), expected.essTie, "essTie")
        expectSame(Corners.sessionCorners(self.session(late, a)), expected.essTieLate, "essTieLate")
        expectSame(Corners.sessionCorners(self.session(a, bare)), expected.essMixed, "essMixed")
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
