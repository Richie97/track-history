import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/record-remote.test.js`, ported with the code they cover,
/// plus the DST transition NS-19 asks for.
struct RemoteRecordingTests {
    /// The three fields the rule reads, exactly as the JS test expresses them.
    private struct Candidate: RemoteRecording.EventCandidate {
        let id: String
        let startDate: String
        var days: Double = 1
    }

    private func ev(_ id: String, _ startDate: String, _ days: Double = 1) -> Candidate {
        Candidate(id: id, startDate: startDate, days: days)
    }

    private func calendar(_ identifier: String) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: identifier)!
        return c
    }

    private func instant(_ iso: String, _ hour: Int, in zone: String) -> Date {
        let parts = EventDates.ymd(iso)!
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d
        components.hour = hour
        return calendar(zone).date(from: components)!
    }

    // MARK: - localTodayIso

    @Test
    func localTodayIsoFormatsTheLocalCalendarDate() {
        let zone = "America/New_York"
        #expect(
            RemoteRecording.localTodayIso(now: instant("2026-07-21", 9, in: zone), calendar: calendar(zone))
                == "2026-07-21"
        )
        #expect(
            RemoteRecording.localTodayIso(now: instant("2026-01-03", 23, in: zone), calendar: calendar(zone))
                == "2026-01-03"
        )
    }

    /// Track time is phone time. At 9pm in New York it is already tomorrow in UTC, and
    /// attaching to *tomorrow's* event would be exactly the misattachment this rule
    /// exists to avoid.
    @Test
    func localTodayIsoIsTheDriversDateNotUTC() {
        let evening = instant("2026-07-21", 21, in: "America/New_York")
        #expect(RemoteRecording.localTodayIso(now: evening, calendar: calendar("America/New_York")) == "2026-07-21")
        #expect(EventDates.todayISO(now: evening) == "2026-07-22", "UTC has rolled over; the driver hasn't")
    }

    // MARK: - pickRecordingEvent

    @Test
    func picksTheEventHappeningToday() {
        let events = [ev("a", "2026-07-25"), ev("b", "2026-07-21"), ev("c", "2026-07-01")]
        #expect(RemoteRecording.pickRecordingEvent(events, todayIso: "2026-07-21")?.id == "b")
    }

    @Test
    func coversMultiDayEventsThroughTheirLastDay() {
        let weekend = [ev("a", "2026-07-19", 3)]
        #expect(RemoteRecording.pickRecordingEvent(weekend, todayIso: "2026-07-19")?.id == "a")
        #expect(RemoteRecording.pickRecordingEvent(weekend, todayIso: "2026-07-21")?.id == "a")
        #expect(RemoteRecording.pickRecordingEvent(weekend, todayIso: "2026-07-22") == nil)
    }

    @Test
    func neverGuessesWhenNoEventCoversToday() {
        #expect(
            RemoteRecording.pickRecordingEvent(
                [ev("a", "2026-07-20"), ev("b", "2026-07-22")], todayIso: "2026-07-21"
            ) == nil
        )
        #expect(RemoteRecording.pickRecordingEvent([Candidate](), todayIso: "2026-07-21") == nil)
        #expect(RemoteRecording.pickRecordingEvent([Candidate]?.none, todayIso: "2026-07-21") == nil)
    }

    @Test
    func breaksOverlapsTowardTheMostRecentlyStartedEvent() {
        let events = [ev("long", "2026-07-18", 7), ev("today", "2026-07-21")]
        #expect(RemoteRecording.pickRecordingEvent(events, todayIso: "2026-07-21")?.id == "today")
        // …and independently of the order they arrive in.
        #expect(RemoteRecording.pickRecordingEvent(events.reversed(), todayIso: "2026-07-21")?.id == "today")
    }

    @Test
    func spansMonthEnds() {
        #expect(RemoteRecording.pickRecordingEvent([ev("m", "2026-07-31", 2)], todayIso: "2026-08-01")?.id == "m")
        #expect(RemoteRecording.pickRecordingEvent([ev("y", "2026-12-31", 2)], todayIso: "2027-01-01")?.id == "y")
    }

    /// `days` is a REAL column and the event form steps by 0.5.
    ///
    /// **A 1.5-day event covers only its start date.** That is the web app's behavior,
    /// not a choice made in the port: `addDays` passes `days - 1` to `Date.UTC`, which
    /// floors the fraction away. It is pinned here because the two clients must agree
    /// on which event a car-started recording lands in — a divergence would mean the
    /// phone and the head unit attaching the same drive to different events. Changing
    /// it is a change to `remote.js` first, with this test following.
    @Test
    func fractionalDaysTruncateJustAsTheyDoOnTheWeb() {
        let halfDay = [ev("h", "2026-07-19", 1.5)]
        #expect(RemoteRecording.pickRecordingEvent(halfDay, todayIso: "2026-07-19")?.id == "h")
        #expect(RemoteRecording.pickRecordingEvent(halfDay, todayIso: "2026-07-20") == nil)

        // 2.5 covers two days, for the same reason.
        let twoAndAHalf = [ev("t", "2026-07-19", 2.5)]
        #expect(RemoteRecording.pickRecordingEvent(twoAndAHalf, todayIso: "2026-07-20")?.id == "t")
        #expect(RemoteRecording.pickRecordingEvent(twoAndAHalf, todayIso: "2026-07-21") == nil)
    }

    @Test
    func treatsMissingOrInvalidDaysAsASingleDay() {
        // `Event.days` can't be absent in Swift, but it can be nonsense.
        #expect(RemoteRecording.pickRecordingEvent([ev("z", "2026-07-21", 0)], todayIso: "2026-07-21")?.id == "z")
        #expect(RemoteRecording.pickRecordingEvent([ev("z", "2026-07-21", 0)], todayIso: "2026-07-22") == nil)
        #expect(RemoteRecording.pickRecordingEvent([ev("n", "2026-07-21", -3)], todayIso: "2026-07-21")?.id == "n")
        #expect(RemoteRecording.pickRecordingEvent([ev("f", "2026-07-21", .nan)], todayIso: "2026-07-21")?.id == "f")
    }

    @Test
    func rejectsUnparseableStartDates() {
        #expect(RemoteRecording.pickRecordingEvent([ev("bad", "not-a-date")], todayIso: "2026-07-21") == nil)
        #expect(RemoteRecording.pickRecordingEvent([ev("empty", "")], todayIso: "2026-07-21") == nil)
    }

    /// The day arithmetic is done in UTC precisely so a DST transition can't skip or
    /// repeat a calendar day. A weekend spanning the spring-forward Sunday still ends
    /// on that Sunday — 23 local hours is still one day.
    @Test
    func dstTransitionsDoNotSkipOrRepeatADay() {
        // US spring forward 2026: Sunday 8 March. A Sat–Sun event must cover the 8th.
        let springForward = [ev("s", "2026-03-07", 2)]
        #expect(RemoteRecording.pickRecordingEvent(springForward, todayIso: "2026-03-08")?.id == "s")
        #expect(RemoteRecording.pickRecordingEvent(springForward, todayIso: "2026-03-09") == nil)

        // US fall back 2026: Sunday 1 November — 25 local hours, still one day.
        let fallBack = [ev("f", "2026-10-31", 2)]
        #expect(RemoteRecording.pickRecordingEvent(fallBack, todayIso: "2026-11-01")?.id == "f")
        #expect(RemoteRecording.pickRecordingEvent(fallBack, todayIso: "2026-11-02") == nil)

        // And a three-day weekend straddling it, counted from the far side.
        #expect(RemoteRecording.pickRecordingEvent([ev("l", "2026-03-06", 3)], todayIso: "2026-03-08")?.id == "l")
    }

    /// Agreement with the reference, not merely with my reading of it.
    ///
    /// `contracts/logic/remote-attach.json` is the output of the **web**
    /// `pickRecordingEvent`, captured by `npm run contracts:logic`. This asserts the
    /// port picks the same event in all 22 cases — so if `remote.js` changes, the
    /// regenerated fixture fails here and the port is fixed in the same change,
    /// rather than the phone and the head unit quietly disagreeing about which event
    /// a drive belongs to.
    @Test
    func matchesTheWebImplementationCaseForCase() throws {
        let url = RepoRoot.path("contracts/logic/remote-attach.json")
        guard let data = try? Data(contentsOf: url) else {
            Issue.record("contracts/logic/remote-attach.json missing — run `npm run contracts:logic`")
            return
        }
        let fixture = try JSONDecoder().decode(AttachFixture.self, from: data)
        #expect(!fixture.cases.isEmpty)

        for testCase in fixture.cases {
            let events = try #require(fixture.events[testCase.events], "unknown event set \(testCase.events)")
            let picked = RemoteRecording.pickRecordingEvent(events, todayIso: testCase.todayIso)
            #expect(
                picked?.id == testCase.expectedId,
                """
                \(testCase.events) on \(testCase.todayIso): the web picks \
                \(testCase.expectedId ?? "nothing"), this port picks \(picked?.id ?? "nothing")
                """
            )
        }
    }

    private struct AttachFixture: Decodable {
        var events: [String: [FixtureEvent]]
        var cases: [Case]

        struct Case: Decodable {
            var events: String
            var todayIso: String
            var expectedId: String?
        }
    }

    /// The fixture's events, in the server's field names — and with `days` absent in
    /// one set, which is exactly the shape the JS tolerates.
    private struct FixtureEvent: Decodable, RemoteRecording.EventCandidate {
        var id: String
        var startDate: String
        var days: Double

        enum CodingKeys: String, CodingKey {
            case id
            case startDate = "start_date"
            case days
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            startDate = try c.decode(String.self, forKey: .startDate)
            // `Math.max(1, Number(e.days) || 1)` in the JS: absent means one day.
            days = try c.decodeIfPresent(Double.self, forKey: .days) ?? 1
        }
    }

    /// The rule has to work on the real model, not only on the test's shape.
    @Test
    func appliesToTheLogbooksOwnEvents() throws {
        let events = try Goldens.decode([Event].self, "events-list")
        let first = try #require(events.first)
        let picked = RemoteRecording.pickRecordingEvent(events, todayIso: first.startDate)
        #expect(picked != nil, "an event covers its own start date")
    }
}
