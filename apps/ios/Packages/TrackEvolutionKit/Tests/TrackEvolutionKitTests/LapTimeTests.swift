import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/format.test.js`, ported with the code so the two
/// implementations can't drift.
struct LapTimeTests {
    @Test func fmtMsFormatsNilAsAnEmDash() {
        #expect(LapTime.fmtMs(nil as Int?) == "—")
        #expect(LapTime.fmtMs(nil as Double?) == "—")
    }

    @Test func fmtMsFormatsClockTimeWithTrailingZerosTrimmed() {
        #expect(LapTime.fmtMs(121_240) == "2:01.24")
        #expect(LapTime.fmtMs(121_000) == "2:01.0")
        #expect(LapTime.fmtMs(121_500) == "2:01.5")
        #expect(LapTime.fmtMs(59_999) == "0:59.999")
        #expect(LapTime.fmtMs(60_000) == "1:00.0")
    }

    @Test func fmtMsRoundsFractionalMilliseconds() {
        #expect(LapTime.fmtMs(121_239.6) == "2:01.24")
    }

    @Test func parseTimeParsesClockTime() {
        #expect(LapTime.parseTime("2:01.24") == 121_240)
        #expect(LapTime.parseTime("2:01") == 121_000)
        #expect(LapTime.parseTime("0:59.999") == 59_999)
    }

    @Test func parseTimeParsesBareSeconds() {
        #expect(LapTime.parseTime("121.24") == 121_240)
        #expect(LapTime.parseTime("95") == 95_000)
    }

    @Test func parseTimeAcceptsACommaDecimalSeparator() {
        #expect(LapTime.parseTime("2:01,5") == 121_500)
        #expect(LapTime.parseTime("95,25") == 95_250)
    }

    @Test func parseTimeTrimsWhitespace() {
        #expect(LapTime.parseTime("  1:05.5 ") == 65_500)
    }

    @Test func parseTimeReturnsNilForUnparseableInput() {
        #expect(LapTime.parseTime("") == nil)
        #expect(LapTime.parseTime(nil) == nil)
        #expect(LapTime.parseTime("abc") == nil)
        #expect(LapTime.parseTime("1:2:3") == nil)
        #expect(LapTime.parseTime("1:234") == nil, "seconds are at most 2 digits")
    }

    @Test func parseTimeRoundTripsFmtMsOutput() {
        for ms in [59_999, 60_000, 95_250, 121_240, 754_321] {
            #expect(LapTime.parseTime(LapTime.fmtMs(ms)) == ms)
        }
    }

    @Test func parseLapListSplitsOnCommasSemicolonsAndWhitespace() {
        #expect(
            LapTime.parseLapList("2:03.55\n2:01.24, 2:02.61; 2:00")
                == [123_550, 121_240, 122_610, 120_000]
        )
    }

    @Test func parseLapListDropsUnparseableAndNonPositiveEntries() {
        #expect(LapTime.parseLapList("junk 0 2:01.24") == [121_240])
        #expect(LapTime.parseLapList("") == [])
        #expect(LapTime.parseLapList(nil) == [])
    }

    @Test func fmtConsistencyFormatsACoefficientOfVariation() {
        #expect(LapTime.fmtConsistency(0.0123) == "1.2%")
        #expect(LapTime.fmtConsistency(nil) == "—")
    }

    @Test func fmtDeltaSignsAndTrimsSeconds() {
        #expect(LapTime.fmtDelta(1_240) == "+1.24s")
        #expect(LapTime.fmtDelta(-800) == "-0.8s")
        #expect(LapTime.fmtDelta(0) == "0s")
        #expect(LapTime.fmtDelta(20_000) == "+20s")
        #expect(LapTime.fmtDelta(nil) == "—")
    }
}
