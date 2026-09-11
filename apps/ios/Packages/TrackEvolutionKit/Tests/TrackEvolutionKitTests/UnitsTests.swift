import Foundation
import Testing

@testable import TrackEvolutionKit

/// `test/unit/units.test.js` ported with the code, plus the "wear units" cases
/// from `test/unit/garage.test.js` for the two garage helpers that live here. The
/// JS cache tests (`currentUnits` / `cacheUnits`) have no counterpart: the iOS
/// port has no cache, the account is the only source.
struct UnitsTests {
    @Test func offersExactlyImperialAndMetricDefaultingToWhatTheAppAlwaysShowed() {
        #expect(Units.UNIT_SYSTEMS.map(\.id) == [.imperial, .metric])
        #expect(Units.DEFAULT_UNITS == .imperial)
        #expect(UnitSystem(rawValue: "metric") == .metric)
        #expect(UnitSystem(rawValue: "Metric") == nil)
    }

    /// The five constants the screens used to spell out by hand — `2.236936`,
    /// `1/1.609344`, `0.621371` — all collapse onto these two.
    @Test func theSpeedConstantsAreTheOnesTheScreensUsedToHardcode() {
        #expect(abs(Units.MPS_TO_MPH - 2.236936) < 1e-6)
        #expect(abs(Units.KPH_TO_MPH - 1 / 1.609344) < 1e-6)
    }

    // MARK: - Speed (stored km/h)

    @Test func convertsToMphOrLeavesKphAlone() {
        #expect(Units.speedUnit(.imperial) == "mph")
        #expect(Units.speedUnit(.metric) == "km/h")
        #expect(Units.fmtSpeedKph(194.5, .imperial) == "121 mph")
        #expect(Units.fmtSpeedKph(194.5, .metric) == "195 km/h")
        #expect(Units.fmtSpeedKph(100, .metric, dp: 1) == "100.0 km/h")
    }

    @Test func agreesWithItselfBetweenTheKphAndMpsPaths() {
        // 30 m/s = 108 km/h; both routes to mph must land on the same number.
        #expect(Units.jsInt(Units.convSpeedMps(30, .imperial)) == Units.jsInt(108 * 0.621371))
        #expect(abs(Units.convSpeedMps(30, .metric) - 108) < 1e-9)
    }

    // MARK: - Distance (stored metres)

    @Test func formatsMetricAxisTicksAsBefore() {
        #expect(Units.fmtDist(0, .metric) == "0 m")
        #expect(Units.fmtDist(940, .metric) == "940 m")
        #expect(Units.fmtDist(2000, .metric) == "2 km")
        #expect(Units.fmtDist(2400, .metric) == "2.4 km")
    }

    @Test func usesFeetUnderAQuarterMileAndMilesAboveOpeningTheAxisInMiles() {
        #expect(Units.fmtDist(0, .imperial) == "0 mi")
        #expect(Units.fmtDist(100, .imperial) == "328 ft")
        #expect(Units.fmtDist(0.25 * 1609.344, .imperial) == "0.25 mi")
        #expect(Units.fmtDist(0.5 * 1609.344, .imperial) == "0.5 mi")
        #expect(Units.fmtDist(1609.344, .imperial) == "1 mi")
        #expect(Units.fmtDist(4000, .imperial) == "2.49 mi")
    }

    @Test func formatsGPSAccuracy() {
        #expect(Units.fmtAccuracy(4.2, .metric) == "±4 m")
        #expect(Units.fmtAccuracy(4.2, .imperial) == "±14 ft")
    }

    // MARK: - Temperature (stored whole °F)

    @Test func showsFahrenheitAsIsAndCelsiusRounded() {
        #expect(Units.fmtTemp(72, .imperial) == "72°F")
        #expect(Units.fmtTemp(72, .metric) == "22°C")
        #expect(Units.fmtTemp(32, .metric) == "0°C")
        #expect(Units.fmtTemp(nil, .metric) == "")
        #expect(Units.tempToDisplay(nil, .metric) == nil)
    }

    @Test func storesFormInputAsWholeFahrenheitAndRoundTripsWholeDegreesStably() {
        #expect(Units.tempToStored(72, .imperial) == 72)
        #expect(Units.tempToStored(72.4, .imperial) == 72)
        #expect(Units.tempToStored(22, .metric) == 72)
        #expect(Units.tempToStored(nil, .metric) == nil)
        // Every whole °C from -40 to 65 survives a save-and-edit cycle unchanged:
        // the stored °F is rounded, so a metric user must never watch their own
        // entry drift by a degree on the next edit.
        for c in -40...65 {
            #expect(Units.tempToDisplay(Units.tempToStored(Double(c), .metric), .metric) == c, "\(c) °C")
        }
    }

    @Test func boundsTheInputToWhatTheServerAccepts() throws {
        let f = Units.tempInputSpec(.imperial)
        let c = Units.tempInputSpec(.metric)
        #expect([f.min, f.max] == [-40, 150])
        #expect(f.placeholder == 72)
        #expect(c.placeholder == 22)
        // The °C bounds convert to inside isValidTemp's -40…150 °F window.
        #expect(try #require(Units.tempToStored(Double(c.min), .metric)) >= -40)
        #expect(try #require(Units.tempToStored(Double(c.max), .metric)) <= 150)
    }

    // MARK: - Garage ("wear units" in test/unit/garage.test.js)

    @Test func suggestsTreadDepthIn32ndsOnlyForImperialUsers() {
        #expect(Units.wearLimitHint(.tires, .imperial) == "3 (32nds)")
        #expect(Units.wearLimitHint(.tires, .metric) == "3 (mm)")
        #expect(Units.wearLimitHint(.padsFront, .metric) == "3 (mm)")
        #expect(Units.wearLimitHint(.oil, .metric) == nil)
        #expect(Units.defaultMeasurementUnit(.tires, .imperial) == "32nds")
        #expect(Units.defaultMeasurementUnit(.tires, .metric) == "mm")
        #expect(Units.defaultMeasurementUnit(.padsRear, .imperial) == "mm")
    }
}
