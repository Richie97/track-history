import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/lap-axis.test.js` that cover the pure half, ported
/// with the code, plus the cross-language pin against
/// `contracts/logic/lap-axis.json` — every row, numbers to 1e-9 and strings
/// exactly, and the panel's tab table.
struct LapAxisTests {
    // Two laps on a 20 m grid: B is slower through the middle and a grid point
    // shorter, so the two axes put them in different places.
    private static let A = LapChannels(
        n: 1, timeMs: 10_000,
        speed: [100, 120, 140, 140, 120, 100, 110, 130, 150, 160, 160, 150],
        throttle: [50, 80, 100, 100, 60, 20, 60, 90, 100, 100, 100, 90],
        gear: [3, 3, 4, 4, 3, 3, 3, 4, 4, 4, 4, 4]
    )
    private static let B = LapChannels(
        n: 2, timeMs: 11_000,
        speed: [95, 110, 120, 120, 100, 90, 100, 120, 140, 150, 150],
        throttle: [40, 70, 90, 90, 50, 10, 50, 80, 95, 100, 100],
        gear: [3, 3, 4, 4, 3, 3, 3, 4, 4, 4, 4]
    )

    private func close(_ a: Double?, _ b: Double?, _ eps: Double = 1e-9) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return abs(a - b) <= eps
    }

    // MARK: - Panel tabs

    @Test func isThreeTabsTracesFirst() {
        #expect(ChannelGraphs.TABS.map(\.key) == ["traces", "grip", "car"])
        #expect(ChannelGraphs.TABS[0].label == "Traces")
    }

    @Test func putsTheDeltaSpeedAndEveryInputOnTraces() {
        for k in ["delta", "speed", "throttle", "brake", "steering", "rpm"] {
            #expect(ChannelGraphs.TAB_OF[k] == "traces")
        }
        #expect(ChannelGraphs.TAB_OF["latG"] == "grip")
        #expect(ChannelGraphs.TAB_OF["yaw"] == "grip")
    }

    // MARK: - lapAxisSeries

    @Test func isKTimesTheGridStepOnDistance() {
        #expect(LapAxis.lapAxisSeries(Self.A, 20, .distance) == [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220])
    }

    @Test func isTheLapsOwnElapsedTimeOnTimeEndingOnTheTimedLap() {
        let xs = LapAxis.lapAxisSeries(Self.A, 20, .time)
        #expect(xs == ChannelGraphs.lapTimeSeries(Self.A.speed!, 20, Self.A.timeMs))
        #expect(close(xs?.last, 10))
    }

    @Test func hasNothingForALapWithNoSpeedOnTimeButAGridOnDistance() {
        let noSpeed = LapChannels(n: 3, timeMs: 9_000, throttle: [1, 2, 3])
        #expect(LapAxis.lapAxisSeries(noSpeed, 20, .time) == nil)
        #expect(LapAxis.lapAxisSeries(noSpeed, 20, .distance) == [0, 20, 40])
        #expect(LapAxis.lapAxisSeries(LapChannels(n: 4, timeMs: 1), 20, .distance) == nil)
        #expect(LapAxis.lapAxisSeries(nil, 20, .distance) == nil)
    }

    // MARK: - axisExtent / gridAtAxis / axisAtGrid

    @Test func isTheLongestLapOnEitherAxis() {
        #expect(LapAxis.axisExtent([Self.A, Self.B], 20, .distance) == 220)
        #expect(close(LapAxis.axisExtent([Self.A, Self.B], 20, .time), 11))
        #expect(LapAxis.axisExtent([], 20, .time) == 0)
    }

    @Test func findsAFractionalGridIndexAndNothingOffTheLap() {
        let xs = LapAxis.lapAxisSeries(Self.A, 20, .distance)
        #expect(close(LapAxis.gridAtAxis(xs, 50), 2.5))
        #expect(LapAxis.gridAtAxis(xs, 0) == 0)
        #expect(LapAxis.gridAtAxis(xs, 220) == 11)
        #expect(LapAxis.gridAtAxis(xs, 221) == nil)
        #expect(LapAxis.gridAtAxis(xs, -1) == nil)
        #expect(LapAxis.gridAtAxis(nil, 5) == nil)
    }

    @Test func roundTrips() {
        let xs = LapAxis.lapAxisSeries(Self.A, 20, .time)
        #expect(close(LapAxis.axisAtGrid(xs, LapAxis.gridAtAxis(xs, 4.2)), 4.2))
        #expect(LapAxis.axisAtGrid(xs, -3) == 0)
        #expect(LapAxis.axisAtGrid(xs, 99) == xs?.last)
    }

    // MARK: - axisPlaces

    @Test func putsBothLapsAtTheSameIndexOnDistance() {
        let p = LapAxis.axisPlaces([Self.A, Self.B], 20, .distance, 100, [0, 1])
        #expect(p.map(\.chIdx) == [0, 1])
        #expect(close(p[0].k, 5))
        #expect(close(p[1].k, 5))
        #expect(close(p[0].frac, 5.0 / 11))
        #expect(close(p[1].frac, 5.0 / 10))
    }

    @Test func leavesTheSlowerLapBehindOnTime() {
        let p = LapAxis.axisPlaces([Self.A, Self.B], 20, .time, 5, [0, 1])
        #expect(p[1].k < p[0].k)
    }

    @Test func dropsALapTheValueIsPastInTheCallersOrder() {
        let p = LapAxis.axisPlaces([Self.A, Self.B], 20, .distance, 210, [1, 0])
        #expect(p.map(\.chIdx) == [0])
    }

    // MARK: - Time ticks and words

    @Test func stepsSoALapGetsAtMostSixTicks() {
        #expect(LapAxis.timeAxisTicks(10).map(\.s) == [0, 2, 4, 6, 8, 10])
        #expect(LapAxis.timeAxisTicks(125).map(\.label) == ["0:00", "0:30", "1:00", "1:30", "2:00"])
        #expect(LapAxis.timeAxisTicks(0).isEmpty)
    }

    @Test func saysMinutesAndSeconds() {
        #expect(LapAxis.fmtAxisSeconds(65) == "1:05")
        #expect(LapAxis.fmtAxisValue(83.46, .time, .imperial) == "1:23.5")
        #expect(LapAxis.fmtAxisValue(59.96, .time, .imperial) == "1:00.0")
        #expect(LapAxis.fmtAxisValue(1234.4, .distance, .metric) == "1.2 km")
        #expect(LapAxis.fmtAxisValue(nil, .time, .metric) == "—")
    }

    @Test func defaultsToDistance() {
        #expect(LapAxis.AXIS_MODES.map(\.rawValue) == ["distance", "time"])
        #expect(LapAxis.DEFAULT_AXIS == .distance)
        #expect(LapAxis.axisWord(.time) == "time")
        #expect(LapAxis.axisWord(.distance) == "distance")
    }

    // MARK: - The contract

    @Test func matchesEveryRowOfTheFixture() throws {
        let fx = try JSONDecoder().decode(
            Fixture.self, from: Data(contentsOf: RepoRoot.path("contracts/logic/lap-axis.json"))
        )
        let c = fx.constants
        #expect(c.axisModes == LapAxis.AXIS_MODES.map(\.rawValue))
        #expect(c.defaultAxis == LapAxis.DEFAULT_AXIS.rawValue)
        #expect(c.timeTickSteps == LapAxis.TIME_TICK_STEPS)
        #expect(c.timeTickTarget == LapAxis.TIME_TICK_TARGET)
        #expect(c.tabs.map(\.key) == ChannelGraphs.TABS.map(\.key))
        #expect(c.tabs.map(\.label) == ChannelGraphs.TABS.map(\.label))
        #expect(c.tabOf == ChannelGraphs.TAB_OF)

        let laps = fx.input.laps
        let dStep = fx.input.dStepM
        let mode = { (s: String) throws -> LapAxis.Mode in try #require(LapAxis.Mode(rawValue: s)) }

        for row in fx.expected.lapAxisSeries {
            let xs = LapAxis.lapAxisSeries(laps[row.lap], dStep, try mode(row.mode))
            #expect((xs == nil) == (row.xs == nil), "lapAxisSeries lap \(row.lap) \(row.mode)")
            if let xs, let want = row.xs {
                #expect(xs.count == want.count)
                for (a, b) in zip(xs, want) { #expect(close(a, b), "lapAxisSeries lap \(row.lap) \(row.mode)") }
            }
        }
        for row in fx.expected.axisExtent {
            #expect(close(LapAxis.axisExtent(laps, dStep, try mode(row.mode)), row.x1), "axisExtent \(row.mode)")
        }
        for row in fx.expected.gridAtAxis {
            let xs = LapAxis.lapAxisSeries(laps[row.lap], dStep, try mode(row.mode))
            #expect(close(LapAxis.gridAtAxis(xs, row.x), row.k), "gridAtAxis lap \(row.lap) \(row.mode) \(row.x)")
        }
        for row in fx.expected.axisAtGrid {
            let xs = LapAxis.lapAxisSeries(laps[row.lap], dStep, try mode(row.mode))
            #expect(close(LapAxis.axisAtGrid(xs, row.k), row.x), "axisAtGrid lap \(row.lap) \(row.mode) \(row.k)")
        }
        for row in fx.expected.axisPlaces {
            let got = LapAxis.axisPlaces(laps, dStep, try mode(row.mode), row.x, row.lit)
            #expect(got.map(\.chIdx) == row.places.map(\.chIdx), "axisPlaces \(row.mode) \(row.x) \(row.lit)")
            for (a, b) in zip(got, row.places) {
                #expect(close(a.k, b.k) && close(a.frac, b.frac), "axisPlaces \(row.mode) \(row.x) \(row.lit)")
            }
        }
        for row in fx.expected.timeAxisTicks {
            let got = LapAxis.timeAxisTicks(row.x1)
            #expect(got.map(\.s) == row.ticks.map(\.s), "timeAxisTicks \(row.x1)")
            #expect(got.map(\.label) == row.ticks.map(\.label), "timeAxisTicks \(row.x1)")
        }
        for row in fx.expected.fmtAxisSeconds {
            #expect(LapAxis.fmtAxisSeconds(row.s) == row.text, "fmtAxisSeconds \(row.s)")
        }
        for row in fx.expected.fmtAxisValue {
            let units = try #require(UnitSystem(rawValue: row.units))
            #expect(LapAxis.fmtAxisValue(row.x, try mode(row.mode), units) == row.text, "fmtAxisValue \(String(describing: row.x))")
        }
    }

    private struct Fixture: Decodable {
        struct Tab: Decodable { var key, label: String }
        struct Constants: Decodable {
            var axisModes: [String]
            var defaultAxis: String
            var timeTickSteps: [Double]
            var timeTickTarget: Int
            var tabs: [Tab]
            var tabOf: [String: String]
        }
        struct Input: Decodable {
            var dStepM: Double
            var laps: [LapChannels]
        }
        struct SeriesRow: Decodable { var lap: Int; var mode: String; var xs: [Double]? }
        struct ExtentRow: Decodable { var mode: String; var x1: Double }
        struct GridRow: Decodable { var lap: Int; var mode: String; var x: Double; var k: Double? }
        struct AxisRow: Decodable { var lap: Int; var mode: String; var k: Double; var x: Double? }
        struct PlaceOut: Decodable { var chIdx: Int; var k, frac: Double }
        struct PlacesRow: Decodable { var mode: String; var x: Double; var lit: [Int]; var places: [PlaceOut] }
        struct Tick: Decodable { var s: Double; var label: String }
        struct TicksRow: Decodable { var x1: Double; var ticks: [Tick] }
        struct SecondsRow: Decodable { var s: Double; var text: String }
        struct ValueRow: Decodable { var x: Double?; var mode, units, text: String }
        struct Expected: Decodable {
            var lapAxisSeries: [SeriesRow]
            var axisExtent: [ExtentRow]
            var gridAtAxis: [GridRow]
            var axisAtGrid: [AxisRow]
            var axisPlaces: [PlacesRow]
            var timeAxisTicks: [TicksRow]
            var fmtAxisSeconds: [SecondsRow]
            var fmtAxisValue: [ValueRow]
        }
        var constants: Constants
        var input: Input
        var expected: Expected
    }
}
