import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/gears.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/gears.json`.
struct GearsTests {
    /// A lap in 2nd, up to 3rd, a clutch-in blip, 4th, then back down to 3rd.
    private let gearA: [Double] = [2, 2, 2, 3, 3, 3, 3, 0, 4, 4, 4, 4, 3, 3]
    /// rpm climbs before each upshift and drops after it.
    private let rpmA: [Double] = [5000, 6000, 7000, 4500, 5500, 6500, 7100, 7100, 4800, 5200, 5600, 6000, 6900, 5000]

    private func lap(_ n: Int, _ timeMs: Int = 90_000, gear: [Double]? = nil, rpm: [Double]? = nil, speed: [Double]? = nil) -> LapChannels {
        LapChannels(n: n, timeMs: timeMs, speed: speed, rpm: rpm, gear: gear)
    }

    // MARK: - ordinal / fmtRpm

    @Test func spellsGearsAsOrdinalsAndZeroAsNoGear() {
        #expect([0, 1, 2, 3, 4, 8].map { Gears.ordinal(Double($0)) } == ["no gear", "1st", "2nd", "3rd", "4th", "8th"])
    }

    @Test func groupsThousandsWithoutTouchingTheLocale() {
        #expect(Gears.fmtRpm(6400) == "6,400")
        #expect(Gears.fmtRpm(999.6) == "1,000")
        #expect(Gears.fmtRpm(12) == "12")
    }

    // MARK: - gearSegments

    @Test func cutsALapIntoRunsOfOneGearKeepingGearZeroRuns() {
        #expect(
            Gears.gearSegments(gearA) == [
                Gears.GearRun(gear: 2, k0: 0, k1: 2),
                Gears.GearRun(gear: 3, k0: 3, k1: 6),
                Gears.GearRun(gear: 0, k0: 7, k1: 7),
                Gears.GearRun(gear: 4, k0: 8, k1: 11),
                Gears.GearRun(gear: 3, k0: 12, k1: 13),
            ]
        )
    }

    @Test func segmentsAreEmptyForAMissingOrEmptySeries() {
        #expect(Gears.gearSegments(nil) == [])
        #expect(Gears.gearSegments([]) == [])
    }

    // MARK: - lapShifts

    @Test func reportsEachStepWithTheRpmAtTheLastSampleInTheOldGear() {
        #expect(
            Gears.lapShifts(lap(1, gear: gearA, rpm: rpmA)) == [
                Gears.Shift(k: 3, from: 2, to: 3, up: true, rpm: 7000),
                // Read at k=6, the last sample in 3rd, not the clutch-in blip.
                Gears.Shift(k: 8, from: 3, to: 4, up: true, rpm: 7100),
                Gears.Shift(k: 12, from: 4, to: 3, up: false, rpm: 6000),
            ]
        )
    }

    @Test func skipsAClutchInStretchRatherThanCountingItAsAGear() {
        #expect(Gears.lapShifts(lap(1, gear: [3, 0, 0, 3])) == [])
    }

    @Test func givesNilRpmWithoutAnRpmSeriesAndNothingWithoutAGearSeries() {
        #expect(Gears.lapShifts(lap(1, gear: [2, 3])) == [Gears.Shift(k: 1, from: 2, to: 3, up: true, rpm: nil)])
        #expect(Gears.lapShifts(lap(1, rpm: rpmA)) == [])
    }

    // MARK: - shiftPoints

    private var channels: SessionChannels {
        SessionChannels(
            v: 1, dStepM: 20,
            laps: [
                lap(1, 90_000, gear: gearA, rpm: rpmA),
                lap(2, 89_000, gear: gearA, rpm: rpmA.enumerated().map { k, v in k == 2 ? 6400 : k == 6 ? 7300 : v }),
                lap(3, 91_000, gear: gearA), // no rpm: not counted
                lap(4, 92_000, speed: [100, 100]), // no gear: not counted
            ]
        )
    }

    @Test func reducesUpshiftsToMinMedianMaxRpmPerGearDownshiftsExcluded() throws {
        let sp = try #require(Gears.shiftPoints(channels))
        #expect(
            sp.gears == [
                Gears.GearShifts(gear: 2, count: 2, minRpm: 6400, medianRpm: 6700, maxRpm: 7000),
                Gears.GearShifts(gear: 3, count: 2, minRpm: 7100, medianRpm: 7200, maxRpm: 7300),
            ]
        )
        #expect(sp.medianRpm == 7050)
        #expect(sp.maxRpm == 7300)
    }

    @Test func shiftPointsAreNilWhenNoLapCarriesGearAndRpmOrNothingUpshifts() {
        #expect(Gears.shiftPoints(SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[2], channels.laps[3]])) == nil)
        #expect(
            Gears.shiftPoints(
                SessionChannels(v: 1, dStepM: 20, laps: [lap(1, gear: [3, 3, 3], rpm: [5000, 5000, 5000])])
            ) == nil
        )
        #expect(Gears.shiftPoints(SessionChannels(v: 1, dStepM: 20, laps: [])) == nil)
    }

    // MARK: - shiftNotes

    @Test func namesTheGearsTakenToTheTopOfTheRevRangeAndTheOnesShiftedEarly() {
        let notes = Gears.shiftNotes(
            Gears.SessionShifts(
                gears: [
                    Gears.GearShifts(gear: 2, count: 3, minRpm: 6900, medianRpm: 7000, maxRpm: 7150),
                    Gears.GearShifts(gear: 3, count: 3, minRpm: 6800, medianRpm: 6950, maxRpm: 7100),
                    Gears.GearShifts(gear: 4, count: 2, minRpm: 6000, medianRpm: 6200, maxRpm: 6400),
                    // One shift: not a pattern.
                    Gears.GearShifts(gear: 5, count: 1, minRpm: 5000, medianRpm: 5000, maxRpm: 5000),
                ],
                medianRpm: 6900,
                maxRpm: 7200
            )
        )
        #expect(
            notes == [
                "Upshifts from 2nd and 3rd run to the top of the rev range seen today (≈7,200 rpm).",
                "Upshifts from 4th come ≈800 rpm earlier than from 2nd.",
            ]
        )
    }

    @Test func saysNothingWhenTheGearsAgreeAndNoneReachesTheLimit() {
        #expect(
            Gears.shiftNotes(
                Gears.SessionShifts(
                    gears: [
                        Gears.GearShifts(gear: 2, count: 3, minRpm: 6400, medianRpm: 6500, maxRpm: 6600),
                        Gears.GearShifts(gear: 3, count: 3, minRpm: 6300, medianRpm: 6400, maxRpm: 6500),
                    ],
                    medianRpm: 6450,
                    maxRpm: 7200
                )
            ) == []
        )
        #expect(Gears.shiftNotes(nil) == [])
    }

    // MARK: - gearDisagreements

    @Test func outlinesRunsWhereHighlightedLapsSitInDifferentGears() {
        let a: [Double] = [2, 2, 3, 3, 3, 3, 3, 3, 4, 4]
        // 4th where a is in 3rd for four points.
        let b: [Double] = [2, 2, 4, 4, 4, 4, 3, 3, 4, 4]
        #expect(Gears.gearDisagreements([a, b]) == [Gears.Disagreement(k0: 2, k1: 5)])
    }

    @Test func ignoresAShiftThatMerelyLandsASampleLaterAndGearZeroOnEitherLap() {
        let a: [Double] = [2, 2, 3, 3, 3, 3, 3]
        // One-point offset: a shift, not a choice.
        let b: [Double] = [2, 2, 2, 3, 3, 3, 3]
        #expect(Gears.gearDisagreements([a, b]) == [])
        // Clutch in where a is in 3rd: no disagreement.
        let c: [Double] = [2, 2, 0, 0, 0, 0, 3]
        #expect(Gears.gearDisagreements([a, c]) == [])
        #expect(Gears.MIN_DISAGREE_POINTS == 3)
    }

    @Test func needsTwoSeriesAndHonoursTheRunThreshold() {
        #expect(Gears.gearDisagreements([[2, 3]]) == [])
        #expect(
            Gears.gearDisagreements([[2, 3, 3], [2, 4, 4]], minRun: 1) == [Gears.Disagreement(k0: 1, k1: 2)]
        )
    }

    // MARK: - Cross-language pin

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port integer for integer and string for string.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/gears.json")
        let fixture = try JSONDecoder().decode(GearsFixture.self, from: try Data(contentsOf: url))
        let channels = fixture.input.channels

        #expect(channels.laps.map { Gears.gearSegments($0.gear) } == fixture.expected.segments)
        #expect(channels.laps.map { Gears.lapShifts($0) } == fixture.expected.shifts)

        let sp = Gears.shiftPoints(channels)
        #expect(sp == fixture.expected.shiftPoints)
        #expect(Gears.shiftNotes(sp) == fixture.expected.notes)
        #expect(
            Gears.shiftPoints(SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[2], channels.laps[3]]))
                == fixture.expected.noRpm
        )

        let a = channels.laps[0].gear
        let b = channels.laps[1].gear
        let c = channels.laps[2].gear
        #expect(Gears.gearDisagreements([a, b]) == fixture.expected.disagreementsAB)
        #expect(Gears.gearDisagreements([a, b, c]) == fixture.expected.disagreementsABC)
        #expect(Gears.gearDisagreements([[2, 2, 3, 3, 3], [2, 2, 2, 3, 3]]) == fixture.expected.offsetDefault)
        #expect(
            Gears.gearDisagreements([[2, 2, 3, 3, 3], [2, 2, 2, 3, 3]], minRun: 1) == fixture.expected.offsetMinRun1
        )
    }
}

/// `contracts/logic/gears.json` — reference output captured from
/// `public/js/gears.js`.
struct GearsFixture: Decodable {
    struct Input: Decodable {
        var channels: SessionChannels
    }

    struct Expected: Decodable {
        var segments: [[Gears.GearRun]]
        var shifts: [[Gears.Shift]]
        var shiftPoints: Gears.SessionShifts?
        var notes: [String]
        var noRpm: Gears.SessionShifts?
        var disagreementsAB: [Gears.Disagreement]
        var disagreementsABC: [Gears.Disagreement]
        var offsetDefault: [Gears.Disagreement]
        var offsetMinRun1: [Gears.Disagreement]
    }

    var input: Input
    var expected: Expected
}
