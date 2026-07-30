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
}
