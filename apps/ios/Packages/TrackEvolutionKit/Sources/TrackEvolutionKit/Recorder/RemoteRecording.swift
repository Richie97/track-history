import Foundation

/// Which event a recording started from the car attaches itself to.
///
/// A port of `public/js/record/remote.js`, keeping its names, and it brings
/// `test/unit/record-remote.test.js`'s cases with it. This is the one piece of real
/// judgment in the CarPlay integration, and the rule is **deliberately
/// conservative**: it attaches to an event whose day range covers today, and it
/// never guesses beyond that.
///
/// The reason is asymmetric cost. A recording that lands in last month's event is
/// worse than one that waits, unattached, for its event to be created at review
/// time — an unattached recording is offered on the dashboard and adopted by the
/// first event whose record screen it's opened from, so nothing is lost. A
/// misattached one silently corrupts a logbook entry. If a "closest event" or "most
/// likely event" heuristic starts to look appealing, that trade is the answer.
public enum RemoteRecording {
    /// The minimum an event needs for the rule to apply. A protocol rather than a
    /// concrete `Event` so tests can express a case in three fields, mirroring the
    /// JS, which duck-types the same way.
    public protocol EventCandidate {
        /// ISO `yyyy-mm-dd`.
        var startDate: String { get }
        var days: Double { get }
    }

    /// Today as the **phone's local calendar date** — track time is phone time.
    ///
    /// Not `EventDates.todayISO`, which is UTC to mirror JS's `toISOString()`. The
    /// distinction is the point: an evening session in New York is still today's
    /// event even after UTC has rolled over.
    public static func localTodayIso(now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> String {
        EventDates.isoString(from: now, calendar: calendar)
    }

    /// The event a remote "start recording" attaches to, or nil to record unattached.
    ///
    /// Ties — overlapping events — go to the one that started most recently, which is
    /// almost always the specific day inside a longer entry.
    public static func pickRecordingEvent<E: EventCandidate>(_ events: [E]?, todayIso: String) -> E? {
        (events ?? [])
            .filter { candidate in
                guard !candidate.startDate.isEmpty else { return false }
                guard let lastDay = addDays(candidate.startDate, spanDays(candidate.days) - 1) else {
                    return false
                }
                // ISO dates compare correctly as strings, which is what the JS relies on.
                return candidate.startDate <= todayIso && todayIso <= lastDay
            }
            // Descending by start date. A stable sort keeps the input order among
            // equal starts, matching the JS comparator, which returns 0 for a tie.
            .enumerated()
            .sorted { left, right in
                left.element.startDate == right.element.startDate
                    ? left.offset < right.offset
                    : left.element.startDate > right.element.startDate
            }
            .first?.element
    }

    /// How many whole calendar days an event covers.
    ///
    /// **Fractional days truncate**, so a 1.5-day event covers only its start date.
    /// That is not a decision made here — `addDays` in the JS passes `days - 1` to
    /// `Date.UTC`, which floors it, and `Int(_:)` truncates the same way. The two
    /// clients have to agree on which event a car-started recording lands in, so this
    /// mirrors the reference rather than quietly improving on it. See the note in
    /// `RemoteRecordingTests`.
    private static func spanDays(_ days: Double) -> Int {
        Int(Swift.max(1, days.isFinite ? days : 1))
    }

    /// Date-only arithmetic in **UTC**, so a DST transition can't skip or repeat a
    /// calendar day — an hour lost in March must not shorten a race weekend.
    private static func addDays(_ iso: String, _ n: Int) -> String? {
        guard let parts = EventDates.ymd(iso) else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d + n
        guard let date = utc.date(from: components) else { return nil }
        return EventDates.isoString(from: date, calendar: utc)
    }
}

/// The logbook's own event satisfies the rule; nothing else has to.
extension Event: RemoteRecording.EventCandidate {}
