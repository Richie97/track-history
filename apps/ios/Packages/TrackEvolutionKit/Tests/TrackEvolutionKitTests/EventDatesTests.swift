import Foundation
import Testing

@testable import TrackEvolutionKit

/// The date helpers, pinned against fixed instants — the two clocks (`todayISO` in
/// UTC, `daysUntil` local) are the part that can silently drift.
struct EventDatesTests {
    /// A calendar fixed to UTC, so a countdown assertion doesn't depend on where
    /// the test runs.
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return c
    }

    private func instant(_ iso: String) -> Date {
        let parts = EventDates.ymd(String(iso.prefix(10)))!
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d
        components.hour = Int(iso.dropFirst(11).prefix(2)) ?? 12
        return utc.date(from: components)!
    }

    @Test
    func todayIsTheUTCDate() {
        #expect(EventDates.todayISO(now: instant("2026-07-30T23")) == "2026-07-30")
    }

    @Test
    func upcomingIsStrictlyAfterToday() {
        let now = instant("2026-07-30T12")
        #expect(EventDates.isUpcoming("2026-07-31", now: now))
        // An event that starts today is *not* upcoming — the web app shows it in
        // recent events and offers to log sessions.
        #expect(!EventDates.isUpcoming("2026-07-30", now: now))
        #expect(!EventDates.isUpcoming("2026-07-29", now: now))
    }

    @Test
    func daysUntilCountsCalendarDays() {
        let now = instant("2026-07-30T12")
        #expect(EventDates.daysUntil("2026-08-02", now: now, calendar: utc) == 3)
        #expect(EventDates.daysUntil("2026-07-30", now: now, calendar: utc) == 0)
        #expect(EventDates.daysUntil("2026-07-28", now: now, calendar: utc) == -2)
    }

    @Test
    func countdownWording() {
        let now = instant("2026-07-30T12")
        #expect(EventDates.fmtCountdown("2026-07-30", now: now, calendar: utc) == "Today")
        #expect(EventDates.fmtCountdown("2026-07-31", now: now, calendar: utc) == "Tomorrow")
        #expect(EventDates.fmtCountdown("2026-08-04", now: now, calendar: utc) == "In 5 days")
        // Already run: the web app's `dd <= 0` collapses the past into "Today".
        #expect(EventDates.fmtCountdown("2026-07-01", now: now, calendar: utc) == "Today")
    }

    @Test
    func eventDayWalksForwardAcrossMonthEnd() {
        #expect(EventDates.eventDayISO("2026-07-30", day: 1) == "2026-07-30")
        #expect(EventDates.eventDayISO("2026-07-30", day: 3) == "2026-08-01")
        #expect(EventDates.eventDayISO("2026-12-31", day: 2) == "2027-01-01")
    }

    @Test
    func fmtDateRendersTheDateItWasGiven() {
        // The bug this guards: a date built at UTC midnight and formatted in a
        // western time zone renders as the day before.
        #expect(EventDates.fmtDate("2026-07-30").contains("30"))
        #expect(EventDates.fmtDate("2026-07-30").contains("2026"))
        #expect(EventDates.fmtDate(nil) == "—")
        #expect(EventDates.fmtDate("not a date") == "—")
    }

    /// A picked date has to survive the round trip to the day the picker showed.
    /// The bug this catches: formatting in UTC, where 10pm in New York is already
    /// tomorrow, so every evening's new event lands on the wrong day.
    @Test
    func pickedDatesRoundTripInTheUsersOwnCalendar() throws {
        var newYork = Calendar(identifier: .gregorian)
        newYork.timeZone = TimeZone(identifier: "America/New_York")!

        let evening = try #require(EventDates.date(fromISO: "2026-07-30", calendar: newYork))
            .addingTimeInterval(22 * 3600)
        #expect(EventDates.isoString(from: evening, calendar: newYork) == "2026-07-30")
        // …and UTC really has rolled over by then, which is the trap.
        #expect(EventDates.todayISO(now: evening) == "2026-07-31")

        let midnight = try #require(EventDates.date(fromISO: "2026-07-30", calendar: newYork))
        #expect(EventDates.isoString(from: midnight, calendar: newYork) == "2026-07-30")
    }

    @Test
    func malformedDatesAreRejectedRatherThanGuessed() {
        #expect(EventDates.ymd("2026-7-30") != nil)
        #expect(EventDates.ymd("26-07-30") == nil)
        #expect(EventDates.ymd("2026-13-01") == nil)
        #expect(EventDates.ymd("2026-07-30T10:00:00Z") == nil)
        #expect(EventDates.daysUntil("") == nil)
    }
}
