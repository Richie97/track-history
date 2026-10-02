import Foundation

/// The dates a review's *Save to a new event* (#344) hands the New Event form.
///
/// Native-only — the web review has no such hand-off — so there is no JS
/// original or fixture; Android's `:core` carries the same rule under the same
/// name. The sessions being handed over already say when they happened, so the
/// form starts on the earliest of their local dates (the date each review card
/// shows) and spans to the latest: a single-day recording is a one-day event,
/// not the form's default two. Only this hand-off applies it; the form's own
/// "Add laps" import leaves a date the driver may already have typed alone.
public enum NewEventDates {
    /// A new event's start date (`yyyy-mm-dd`) and length in days.
    public struct Span: Equatable, Sendable {
        public let startDate: String
        public let days: Int

        public init(startDate: String, days: Int) {
            self.startDate = startDate
            self.days = days
        }
    }

    /// The span covering `dates` — each a session's local `yyyy-mm-dd`, or nil
    /// when its source carried none. nil when no date parses, so the form keeps
    /// today and its default length.
    public static func span(_ dates: [String?]) -> Span? {
        // Day numbers on a fixed UTC calendar: the strings are already local
        // dates, so only their distance matters, and UTC has no DST gap to
        // make a day 23 hours long.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        let days: [(iso: String, day: Int)] = dates.compactMap { raw in
            guard let iso = raw?.trimmingCharacters(in: .whitespaces),
                  let parts = EventDates.ymd(iso),
                  let date = utc.date(from: DateComponents(year: parts.y, month: parts.m, day: parts.d)),
                  // Reject a day the month doesn't have (2026-02-31), which
                  // `ymd` lets through and `Calendar` would roll into March.
                  utc.component(.day, from: date) == parts.d
            else { return nil }
            return (String(format: "%04d-%02d-%02d", parts.y, parts.m, parts.d), Int(date.timeIntervalSince1970 / 86_400))
        }
        guard let first = days.min(by: { $0.day < $1.day }),
              let last = days.max(by: { $0.day < $1.day })
        else { return nil }
        return Span(startDate: first.iso, days: last.day - first.day + 1)
    }
}
