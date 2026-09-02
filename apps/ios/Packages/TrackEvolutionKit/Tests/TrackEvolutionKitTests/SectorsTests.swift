import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/sectors.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/sectors.json`.
struct SectorsTests {
    private func lap(_ n: Int, _ timeMs: Int, speed: [Double]?, rpm: [Double]? = nil) -> LapChannels {
        LapChannels(n: n, timeMs: timeMs, speed: speed, rpm: rpm)
    }

    /// One speed for the first half of the distance, double that for the second.
    private let slowThenFast: [Double] = Array(repeating: 60, count: 31) + Array(repeating: 120, count: 30)
    private let fastThenSlow: [Double] = Array(repeating: 120, count: 31) + Array(repeating: 60, count: 30)
    private let constant: [Double] = Array(repeating: 90, count: 61)

    // MARK: - sectorTimes

    @Test func splitsAConstantSpeedLapIntoEqualSectorsThatSumToTheLapTime() {
        let s = Sectors.sectorTimes(lap(1, 90_000, speed: constant), 20)
        #expect(s?.count == Sectors.SECTOR_COUNT)
        #expect(s?.reduce(0, +) == 90_000)
        #expect(s == [30_000, 30_000, 30_000])
    }

    @Test func putsMoreTimeInTheSectorsWhereTheCarWasSlower() throws {
        let s = try #require(Sectors.sectorTimes(lap(1, 90_000, speed: slowThenFast), 20))
        #expect(s[0] > s[2])
        #expect(s.reduce(0, +) == 90_000)
        // S1 is all slow, S3 all fast at double the speed: S1 is twice S3.
        #expect(abs(Double(s[0]) / Double(s[2]) - 2) < 0.05)
    }

    @Test func lastSectorAbsorbsTheRoundingResidual() {
        #expect(Sectors.sectorTimes(lap(1, 90_001, speed: constant), 20)?.reduce(0, +) == 90_001)
    }

    @Test func usesTheIntegratedDurationWithoutATimedLap() {
        // 60 cells of 20 m at 72 km/h = 20 m/s: 1 s per cell, 60 s total.
        #expect(Sectors.sectorTimes(Array(repeating: 72, count: 61), nil, 20)?.reduce(0, +) == 60_000)
    }

    @Test func honoursADifferentSectorCount() {
        #expect(Sectors.sectorTimes(lap(1, 90_000, speed: constant), 20, 1) == [90_000])
        #expect(Sectors.sectorTimes(lap(1, 90_000, speed: constant), 20, 6)?.count == 6)
    }

    @Test func returnsNilForLapsWithoutAUsableSpeedSeries() {
        #expect(Sectors.sectorTimes(lap(1, 90_000, speed: nil, rpm: Array(repeating: 5000, count: 61)), 20) == nil)
        #expect(Sectors.sectorTimes(lap(1, 90_000, speed: [90]), 20) == nil)
        #expect(Sectors.sectorTimes(lap(1, 90_000, speed: constant), 20, 0) == nil)
    }

    // MARK: - sessionSectors

    private var channels: SessionChannels {
        SessionChannels(
            v: 1, dStepM: 20,
            laps: [
                lap(1, 90_000, speed: slowThenFast), // slow start
                lap(2, 90_000, speed: fastThenSlow), // slow finish
                lap(3, 95_000, speed: nil, rpm: Array(repeating: 5000, count: 61)), // no speed: left out
                lap(4, 89_500, speed: constant), // actual best, even sectors
            ]
        )
    }

    @Test func takesTheBestOfEachSectorAcrossLaps() throws {
        let sec = try #require(Sectors.sessionSectors(channels))
        #expect(sec.n == 3)
        #expect(sec.laps.map(\.chIdx) == [0, 1, 3])
        #expect(sec.bestSectorLap[0] == 1) // fast start owns S1
        #expect(sec.bestSectorLap[2] == 0) // fast finish owns S3
        #expect(sec.theoreticalBestMs == sec.bestSectors.reduce(0, +))
        #expect(sec.bestLapIdx == 3)
        #expect(sec.bestLapMs == 89_500)
        #expect(sec.gapMs == 89_500 - sec.theoreticalBestMs)
        #expect(sec.theoreticalBestMs < sec.bestLapMs)
    }

    @Test func zeroGapWhenTheBestLapOwnsEveryBestSector() throws {
        let one = SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[3], channels.laps[2]])
        let sec = try #require(Sectors.sessionSectors(one))
        #expect(sec.laps.count == 1)
        #expect(sec.gapMs == 0)
        #expect(sec.theoreticalBestMs == 89_500)
    }

    @Test func keepsTheEarlierLapOnATiedSector() throws {
        let tied = SessionChannels(v: 1, dStepM: 20, laps: [lap(1, 90_000, speed: constant), lap(2, 90_000, speed: constant)])
        let sec = try #require(Sectors.sessionSectors(tied))
        #expect(sec.bestSectorLap == [0, 0, 0])
    }

    @Test func nilWhenNoLapCanBeSplit() {
        #expect(Sectors.sessionSectors(SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[2]])) == nil)
        #expect(Sectors.sessionSectors(SessionChannels(v: 1, dStepM: 20, laps: [])) == nil)
    }

    // MARK: - Cross-language pin

    /// The JS implementation's own output for a shared input has to come back out
    /// of this port integer for integer.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/sectors.json")
        let fixture = try JSONDecoder().decode(SectorsFixture.self, from: try Data(contentsOf: url))
        let channels = fixture.input.channels
        let n = fixture.input.n

        #expect(Sectors.sessionSectors(channels, n) == fixture.expected.session)

        let ref = channels.laps[0]
        #expect(Sectors.sectorTimes(ref, channels.dStepM, fixture.input.microsectorN) == fixture.expected.refMicrosectors)
        #expect(Sectors.sectorTimes(ref, channels.dStepM, 1) == fixture.expected.refSingleSector)
        #expect(Sectors.sectorTimes(ref.speed, nil, channels.dStepM, n) == fixture.expected.untimedSectors)
        #expect(Sectors.sectorTimes(channels.laps[3], channels.dStepM, n) == fixture.expected.noSpeed)
    }
}

/// `contracts/logic/sectors.json` — reference output captured from
/// `public/js/sectors.js`. The input decodes straight into `SessionChannels`
/// because the fixture's laps are stored entries in the wire shape.
struct SectorsFixture: Decodable {
    struct Input: Decodable {
        var channels: SessionChannels
        var n: Int
        var microsectorN: Int
    }

    struct Expected: Decodable {
        var session: Sectors.SessionSplits
        var refMicrosectors: [Int]
        var refSingleSector: [Int]
        var untimedSectors: [Int]
        var noSpeed: [Int]?
    }

    var input: Input
    var expected: Expected
}
