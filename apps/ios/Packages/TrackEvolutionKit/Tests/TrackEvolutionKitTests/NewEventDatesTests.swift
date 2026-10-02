import Testing

@testable import TrackEvolutionKit

/// *Save to a new event* dates the form from the sessions it hands over —
/// the same cases as Android's `NewEventDatesTest`.
struct NewEventDatesTests {
    @Test func aSingleDayRecordingIsAOneDayEvent() {
        #expect(NewEventDates.span(["2026-06-20"]) == .init(startDate: "2026-06-20", days: 1))
    }

    @Test func clipsOnSeveralDaysSpanFromTheEarliestToTheLatest() {
        #expect(
            NewEventDates.span(["2026-06-21", "2026-06-20", "2026-06-22", "2026-06-21"])
                == .init(startDate: "2026-06-20", days: 3)
        )
    }

    @Test func aSpanAcrossAMonthEndCountsCalendarDays() {
        #expect(NewEventDates.span(["2026-03-31", "2026-04-01"]) == .init(startDate: "2026-03-31", days: 2))
    }

    @Test func undatedSessionsAreIgnoredAndNoneLeavesTheDefaults() {
        #expect(NewEventDates.span([nil, "2026-06-20", nil]) == .init(startDate: "2026-06-20", days: 1))
        #expect(NewEventDates.span([nil, nil]) == nil)
        #expect(NewEventDates.span([]) == nil)
        #expect(NewEventDates.span(["not a date", "2026-02-31"]) == nil)
    }
}
