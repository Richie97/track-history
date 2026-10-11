import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/lap-stats.test.js`, ported with the code they cover.
struct LapStatsTests {
    @Test
    func cleanLapsDropsLapsSlowerThanTheCutoff() {
        // best 100s -> cutoff 107s; the 130s out-lap goes
        #expect(LapStats.cleanLaps([130_000, 100_000, 105_000, 106_900]) == [100_000, 105_000, 106_900])
    }

    @Test
    func cleanLapsHandlesEmptyInput() {
        #expect(LapStats.cleanLaps([]).isEmpty)
    }

    @Test
    func bestNAvgAveragesTheBestNLaps() {
        #expect(
            LapStats.bestNAvg([125_000, 121_000, 123_000, 129_000], 3)
                == Double(121_000 + 123_000 + 125_000) / 3
        )
    }

    @Test
    func bestNAvgIsNilBelowNLaps() {
        #expect(LapStats.bestNAvg([121_000, 122_000], 3) == nil)
    }

    @Test
    func paceSlopeIsPositiveWhenLapsGetSlower() {
        // +500ms per lap, exactly
        let slope = LapStats.paceSlope([120_000, 120_500, 121_000, 121_500, 122_000])
        #expect(slope != nil)
        #expect(abs((slope ?? 0) - 500) < 1e-6)
    }

    @Test
    func paceSlopeIsNegativeWhenStillImproving() {
        let slope = LapStats.paceSlope([122_000, 121_500, 121_000, 120_500, 120_000])
        #expect(slope != nil)
        #expect(abs((slope ?? 0) + 500) < 1e-6)
    }

    @Test
    func paceSlopeIgnoresOutLapsBeyondTheCutoff() {
        // The 140s out-lap would swamp the trend; clean laps are flat.
        let slope = LapStats.paceSlope([140_000, 120_000, 120_000, 120_000, 120_000])
        #expect(slope != nil)
        #expect(abs(slope ?? 1) < 1e-6)
    }

    @Test
    func paceSlopeIsNilBelowFourCleanLaps() {
        #expect(LapStats.paceSlope([120_000, 121_000, 122_000]) == nil)
        #expect(LapStats.paceSlope([]) == nil)
    }

    @Test
    func warmupFindsTheFirstLapWithinOnePercentOfTheBest() {
        // best 120s -> threshold 121.2s; lap 3 is the first under it
        #expect(LapStats.warmupLapCount([130_000, 124_000, 121_000, 120_000]) == 3)
    }

    @Test
    func warmupIsOneWhenOnPaceImmediately() {
        #expect(LapStats.warmupLapCount([120_000, 120_500, 121_000]) == 1)
    }

    @Test
    func warmupIsNilBelowTwoLaps() {
        #expect(LapStats.warmupLapCount([120_000]) == nil)
        #expect(LapStats.warmupLapCount([]) == nil)
    }

    // MARK: eventConsistency (NS-42)

    private func cv(_ xs: [Int]) -> Double {
        let m = Double(xs.reduce(0, +)) / Double(xs.count)
        let v = xs.reduce(0.0) { $0 + (Double($1) - m) * (Double($1) - m) } / Double(xs.count)
        return v.squareRoot() / m
    }

    @Test
    func eventConsistencyIsTheCVOfTheCleanLaps() throws {
        let c = try #require(LapStats.eventConsistency([[160_000, 122_000, 121_000, 123_000, 150_000]]))
        #expect(abs(c - cv([122_000, 121_000, 123_000])) < 1e-12)
    }

    @Test
    func eventConsistencyJudgesEachSessionAgainstItsOwnBest() throws {
        let c = try #require(LapStats.eventConsistency([[120_000, 121_000], [132_000, 133_000]]))
        #expect(abs(c - cv([120_000, 121_000, 132_000, 133_000])) < 1e-12)
    }

    @Test
    func eventConsistencyKeepsALapExactlyAt107Percent() {
        #expect(LapStats.eventConsistency([[100_000, 107_000, 100_000]]) != nil)
    }

    @Test
    func eventConsistencyIsNilUnderThreeCleanLaps() {
        #expect(LapStats.eventConsistency([[100_000, 110_000, 120_000]]) == nil)
        #expect(LapStats.eventConsistency([[100_000], [100_000]]) == nil)
        #expect(LapStats.eventConsistency([]) == nil)
    }

    @Test
    func eventConsistencyIsZeroForIdenticalLaps() {
        #expect(LapStats.eventConsistency([[120_000, 120_000, 120_000]]) == 0)
    }

    /// `contracts/logic/consistency.json` — the web implementation's output.
    @Test
    func eventConsistencyMatchesTheJavaScriptImplementation() throws {
        let url = RepoRoot.path("contracts/logic/consistency.json")
        let fixture = try JSONDecoder().decode(ConsistencyFixture.self, from: try Data(contentsOf: url))
        #expect(fixture.CLEAN_FACTOR == LapStats.CLEAN_FACTOR)
        #expect(fixture.MIN_CONSISTENCY_LAPS == LapStats.MIN_CONSISTENCY_LAPS)
        for c in fixture.cases {
            #expect(c.sessions.map { LapStats.cleanLaps($0) } == c.clean, "\(c.name)")
            let got = LapStats.eventConsistency(c.sessions)
            switch (got, c.consistency) {
            case (nil, nil): break
            case let (g?, w?): #expect(abs(g - w) < 1e-12, "\(c.name)")
            default: Issue.record("\(c.name): got \(String(describing: got)), want \(String(describing: c.consistency))")
            }
        }
    }
}

private struct ConsistencyFixture: Decodable {
    struct Case: Decodable {
        let name: String
        let sessions: [[Int]]
        let clean: [[Int]]
        let consistency: Double?
    }
    let CLEAN_FACTOR: Double
    let MIN_CONSISTENCY_LAPS: Int
    let cases: [Case]
}
