import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/health.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/health.json`.
struct HealthTests {
    /// A lap with everything inside its lines, one exactly on them, and one past
    /// every one of them — the three cases the shading has to tell apart.
    private let cool = LapChannels(
        n: 1, timeMs: 118_000, boost: [12, 88, 141.5],
        oilC: 104, oilKpa: 340, coolantC: 96, transC: 88, fuelPct: 62, battV: 13.8,
        tyreKpaLF: 214, tyreKpaRF: 210, tyreKpaLR: 206, tyreKpaRR: 205,
        tyreCLF: 78, tyreCRF: 71, tyreCLR: 66, tyreCRR: 64
    )
    private let hot = LapChannels(
        n: 2, timeMs: 119_900,
        oilC: 134, oilKpa: 110, coolantC: 122, transC: 128, fuelPct: 41, battV: 12.2,
        tyreKpaLF: 244, tyreKpaRF: 236, tyreKpaLR: 225, tyreKpaRR: 221,
        tyreCLF: 108, tyreCRF: 92, tyreCLR: 77, tyreCRR: 75
    )
    /// Hand-entered: no health figure at all.
    private let bare = LapChannels(n: 3, timeMs: 121_000, speed: [80, 90, 100])

    private var channels: SessionChannels {
        SessionChannels(v: 1, dStepM: 20, laps: [cool, hot, bare])
    }

    // MARK: - lapValue / hasHealthData

    @Test func readsTheStoredScalarAndDerivesOnlyBoost() {
        #expect(Health.lapValue(cool, "oilC") == 104)
        #expect(Health.lapValue(cool, "tyreCRR") == 64)
        // The one derivation: the peak of the gridded trace.
        #expect(Health.lapValue(cool, "boost") == 141.5)
        #expect(Health.lapValue(hot, "boost") == nil)
        #expect(Health.lapValue(bare, "oilC") == nil)
        #expect(Health.lapValue(nil, "oilC") == nil)
    }

    @Test func knowsWhichLapsHaveAnythingToShow() {
        #expect(Health.hasHealthData(cool))
        #expect(!Health.hasHealthData(bare))
        #expect(Health.healthLaps(channels).map(\.chIdx) == [0, 1])
        #expect(Health.healthLaps(nil).isEmpty)
    }

    // MARK: - healthStatus

    @Test func shadesBothBoundsInclusivelyAndReadsAFloorDownward() {
        let oil = try! #require(Health.defFor("oilC"))
        #expect(Health.healthStatus(oil, 119.9) == .ok)
        #expect(Health.healthStatus(oil, 120) == .low) // the watch line counts
        #expect(Health.healthStatus(oil, 130) == .due) // and so does the over line
        // A floor column: the hazard is below the lines, not above them.
        let pressure = try! #require(Health.defFor("oilKpa"))
        #expect(Health.healthStatus(pressure, 200.1) == .ok)
        #expect(Health.healthStatus(pressure, 200) == .low)
        #expect(Health.healthStatus(pressure, 120) == .due)
        // A column with no line has no status, however hot it reads.
        #expect(Health.healthStatus(Health.defFor("tyreCLF"), 300) == nil)
        #expect(Health.healthStatus(nil, 1) == nil)
    }

    // MARK: - sessionHealth

    @Test func takesTheWorstCasePerColumnByThatColumnsOwnRule() throws {
        let sh = try #require(Health.sessionHealth(channels))
        #expect(sh.laps.map(\.chIdx) == [0, 1])
        let oil = try #require(sh.columns.first { $0.key == "oilC" })
        #expect(oil.extreme.v == 134) // a peak column takes the maximum
        #expect(oil.status == .due)
        let pressure = try #require(sh.columns.first { $0.key == "oilKpa" })
        #expect(pressure.extreme.v == 110) // a floor column takes the minimum
        #expect(pressure.status == .due)
        // The boost column exists only because one lap stored the trace.
        #expect(sh.columns.contains { $0.key == "boost" })
        #expect(sh.columns.first { $0.key == "boost" }?.series.count == 1)
        #expect(Health.sessionHealth(SessionChannels(v: 1, dStepM: 20, laps: [bare])) == nil)
        #expect(Health.sessionHealth(nil) == nil)
    }

    // MARK: - tyreSpread

    @Test func needsAllFourCornersForASpread() throws {
        let spread = try #require(Health.tyreSpread(cool))
        #expect(spread.front == 78 - 71)
        #expect(spread.rear == 66 - 64)
        #expect(spread.axle == (78.0 + 71) / 2 - (66.0 + 64) / 2)
        // Three corners and a guess is not a spread.
        var partial = cool
        partial.tyreCRR = nil
        #expect(Health.tyreSpread(partial) == nil)
        // The same reduction over the pressures.
        let pressures = try #require(Health.tyreSpread(cool, "tyreKpa"))
        #expect(pressures.front == 214 - 210)
        #expect(Health.sessionSpread(channels).map(\.chIdx) == [0, 1])
    }

    // MARK: - fuelBurn

    @Test func takesTheMedianDropAndSkipsARefuel() throws {
        let laps = [80.0, 68, 57, 95, 84].enumerated().map { i, pct in
            LapChannels(n: i + 1, timeMs: 118_000, fuelPct: pct)
        }
        let fuel = try #require(Health.fuelBurn(SessionChannels(v: 1, dStepM: 20, laps: laps)))
        // Drops of 12, 11 and 11 — the increase at the refuel is skipped, not
        // counted as a negative drop.
        #expect(fuel.drops == 3)
        #expect(fuel.perLapPct == 11)
        #expect(fuel.lastPct == 84)
        #expect(fuel.lapsRemaining == 7)
        // One drop is one lap's noise.
        let two = [50.0, 42].enumerated().map { i, pct in
            LapChannels(n: i + 1, timeMs: 118_000, fuelPct: pct)
        }
        #expect(Health.fuelBurn(SessionChannels(v: 1, dStepM: 20, laps: two)) == nil)
        #expect(Health.fuelBurn(channels) == nil) // only one drop here
    }

    // MARK: - hot pressures and the loop's arithmetic

    @Test func takesTheHighestEndOfLapReadingPerCorner() throws {
        let hotP = try #require(Health.hotPressures(channels))
        #expect(hotP["LF"]?.peakKpa == 244)
        #expect(hotP["LF"]?.peakChIdx == 1)
        #expect(hotP["RR"]?.peakKpa == 221)
        #expect(Health.hotPressures(SessionChannels(v: 1, dStepM: 20, laps: [bare])) == nil)
    }

    @Test func suggestsAColdPressureOnTheSheetsOwnStep() throws {
        // Grew 5 psi, wants to land 2 psi lower: start 2 psi lower.
        let s = try #require(Health.suggestCold(31, 36, 34))
        #expect(s.suggestedPsi == 29)
        #expect(s.deltaPsi == -2)
        // Rounded to the sheet's half-psi step.
        #expect(try #require(Health.suggestCold(31.4, 36.9, 34)).suggestedPsi == 28.5)
        // A tyre that didn't grow enough wants more cold pressure, not less.
        #expect(try #require(Health.suggestCold(30, 30, 34)).deltaPsi == 4)
        #expect(Health.suggestCold(nil, 36, 34) == nil)
        #expect(Health.suggestCold(31, 36, nil) == nil)
        #expect(Health.roundPsi(34.26) == 34.5)
    }

    // MARK: - units

    @Test func convertsForDisplayWithoutTouchingTheStoredValue() {
        let oil = Health.defFor("oilC")!
        #expect(Health.displayValue(oil, 100, .metric).text == "100 °C")
        #expect(Health.displayValue(oil, 100, .us).text == "212 °F")
        let pressure = Health.defFor("tyreKpaLF")!
        #expect(Health.displayValue(pressure, 100, .us).text == "14.5 psi")
        // A delta scales but does not offset: +10 °C is +18 °F, not 50.
        #expect(Health.displayDelta(oil, 10, .us).text == "+18 °F")
        #expect(Health.displayDelta(oil, 10, .metric).text == "+10 °C")
    }

    // MARK: - healthSummary

    @Test func namesEveryFigurePastItsLineWorstFirst() {
        let line = Health.healthSummary(channels, .metric)
        #expect(line == "car: oil temp 134 °C, coolant 122 °C, transmission 128 °C, oil pressure 110 kPa, battery 12.2 V")
        // Nothing past a line and no fuel figure: no sentence at all.
        #expect(Health.healthSummary(SessionChannels(v: 1, dStepM: 20, laps: [cool]), .metric) == nil)
        #expect(Health.healthSummary(SessionChannels(v: 1, dStepM: 20, laps: [bare]), .metric) == nil)
    }

    @Test func countsTheFuelLeftInLaps() {
        let laps = [30.0, 20, 10].enumerated().map { i, pct in
            LapChannels(n: i + 1, timeMs: 118_000, fuelPct: pct)
        }
        // Singular, because "1 laps of fuel" is how a port announces itself.
        #expect(
            Health.healthSummary(SessionChannels(v: 1, dStepM: 20, laps: laps), .metric)
                == "car: ≈1 lap of fuel at this rate"
        )
    }

    // MARK: - the cross-language fixture

    private struct HealthFixture: Decodable {
        struct Input: Decodable {
            let channels: SessionChannels
            let fuelChannels: SessionChannels
            let oneDropChannels: SessionChannels
            let lastLapChannels: SessionChannels
            let defs: [Health.Def]
            let groups: [[String]]
            let corners: [[String]]
            let statusProbes: [ProbeValue]
            let psiProbes: [Double]
            let suggestProbes: [[Double?]]
        }
        struct Expected: Decodable {
            let lapValues: [LapValueRow]
            let boostPeak: Double
            let noBoost: Double?
            let hasData: [Bool]
            let healthLaps: [Int]
            let series: [Health.SeriesPoint]
            let statuses: [Health.Status?]
            let session: SessionFixture
            let spreadFull: Health.Spread
            let spreadPressures: Health.Spread
            let spreadPartial: Health.Spread?
            let sessionSpread: [Health.LapSpread]
            let fuel: Health.FuelBurn
            let fuelOneDrop: Health.FuelBurn?
            let hot: [String: Health.HotPressure]
            let noHot: [String: Health.HotPressure]?
            let roundPsi: [Double]
            let suggestions: [Health.ColdSuggestion?]
            let displayMetric: [Health.Display]
            let displayUs: [Health.Display]
            let deltaMetric: [Health.DisplayDelta]
            let deltaUs: [Health.DisplayDelta]
            let summaryMetric: String
            let summaryUs: String
            let summaryFuelOnly: String
            let summaryOneLap: String
            let summaryQuiet: String?
            let summaryNoData: String?
            let noData: SessionFixture?
        }
        struct SessionFixture: Decodable {
            let laps: [RowFixture]
            let columns: [ColumnFixture]
        }
        struct RowFixture: Decodable {
            let chIdx: Int
            let values: [String: Double]
        }
        struct ColumnFixture: Decodable {
            let key: String
            let series: [Health.SeriesPoint]
            let extreme: Health.SeriesPoint
            let status: Health.Status?
        }
        /// `["oilC", 120]` — a key and a value.
        struct ProbeValue: Decodable {
            let key: String
            let value: Double

            init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                key = try c.decode(String.self)
                value = try c.decode(Double.self)
            }
        }
        /// `["oilC", 104, null]` — a key and the value on each of two laps.
        struct LapValueRow: Decodable {
            let key: String
            let full: Double?
            let partial: Double?

            init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                key = try c.decode(String.self)
                full = try c.decodeIfPresent(Double.self)
                partial = try c.decodeIfPresent(Double.self)
            }
        }
        let input: Input
        let expected: Expected
    }

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port: the wording exactly, the doubles to 1e-9.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/health.json")
        let fixture = try JSONDecoder().decode(HealthFixture.self, from: try Data(contentsOf: url))
        let input = fixture.input
        let want = fixture.expected

        // The columns themselves: a port that drops one or reorders them fails
        // here rather than on a screen.
        #expect(Health.HEALTH_DEFS == input.defs)
        #expect(Health.HEALTH_GROUPS.map { [$0.key, $0.label] } == input.groups)
        #expect(Health.TYRE_CORNERS.map { [$0.corner, $0.key] } == input.corners)

        let full = input.channels.laps[0]
        let partial = input.channels.laps[3]
        for row in want.lapValues {
            #expect(Health.lapValue(full, row.key) == row.full, "lapValue \(row.key) on the full lap")
            #expect(Health.lapValue(partial, row.key) == row.partial, "lapValue \(row.key) on the partial lap")
        }
        #expect(Health.lapValue(full, "boost") == want.boostPeak)
        #expect(Health.lapValue(input.channels.laps[2], "boost") == want.noBoost)
        #expect(input.channels.laps.map { Health.hasHealthData($0) } == want.hasData)
        #expect(Health.healthLaps(input.channels).map(\.chIdx) == want.healthLaps)
        #expect(Health.scalarSeries(input.channels, "oilC") == want.series)

        #expect(
            input.statusProbes.map { Health.healthStatus(Health.defFor($0.key), $0.value) } == want.statuses
        )

        let session = try #require(Health.sessionHealth(input.channels))
        #expect(session.columns.map(\.key) == want.session.columns.map(\.key))
        for (i, col) in session.columns.enumerated() {
            let w = want.session.columns[i]
            #expect(col.status == w.status, "column \(col.key) status")
            #expect(col.extreme == w.extreme, "column \(col.key) extreme")
            #expect(col.series == w.series, "column \(col.key) series")
        }
        #expect(session.laps.map(\.chIdx) == want.session.laps.map(\.chIdx))
        for (i, row) in session.laps.enumerated() {
            #expect(row.values == want.session.laps[i].values, "lap \(row.chIdx) values")
        }
        #expect(want.noData == nil)
        #expect(Health.sessionHealth(SessionChannels(v: 1, dStepM: 20, laps: [input.channels.laps[4]])) == nil)

        #expect(Health.tyreSpread(full) == want.spreadFull)
        #expect(Health.tyreSpread(full, "tyreKpa") == want.spreadPressures)
        #expect(Health.tyreSpread(partial) == nil && want.spreadPartial == nil)
        #expect(Health.sessionSpread(input.channels) == want.sessionSpread)

        #expect(Health.fuelBurn(input.fuelChannels) == want.fuel)
        #expect(Health.fuelBurn(input.oneDropChannels) == nil && want.fuelOneDrop == nil)

        let hotP = try #require(Health.hotPressures(input.channels))
        #expect(hotP == want.hot)
        #expect(want.noHot == nil)

        #expect(input.psiProbes.map(Health.roundPsi) == want.roundPsi)
        for (i, probe) in input.suggestProbes.enumerated() {
            #expect(Health.suggestCold(probe[0], probe[1], probe[2]) == want.suggestions[i], "suggestion \(i)")
        }

        for (i, def) in Health.HEALTH_DEFS.enumerated() {
            #expect(Health.displayValue(def, 100, .metric) == want.displayMetric[i], "\(def.key) metric")
            #expect(Health.displayValue(def, 100, .us) == want.displayUs[i], "\(def.key) us")
        }
        let tyreC = try #require(Health.defFor("tyreCLF"))
        let tyreKpa = try #require(Health.defFor("tyreKpaLF"))
        #expect(Health.displayDelta(tyreC, 10, .metric) == want.deltaMetric[0])
        #expect(Health.displayDelta(tyreKpa, 13.8, .metric) == want.deltaMetric[1])
        #expect(Health.displayDelta(tyreC, 10, .us) == want.deltaUs[0])
        #expect(Health.displayDelta(tyreKpa, 13.8, .us) == want.deltaUs[1])

        #expect(Health.healthSummary(input.channels, .metric) == want.summaryMetric)
        #expect(Health.healthSummary(input.channels, .us) == want.summaryUs)
        #expect(Health.healthSummary(input.fuelChannels, .metric) == want.summaryFuelOnly)
        #expect(Health.healthSummary(input.lastLapChannels, .metric) == want.summaryOneLap)
        #expect(want.summaryQuiet == nil && want.summaryNoData == nil)
    }
}
