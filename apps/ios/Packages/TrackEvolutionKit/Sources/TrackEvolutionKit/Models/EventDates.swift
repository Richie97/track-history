import Foundation

/// Dates as the logbook models them: an ISO `yyyy-mm-dd` string, which is what
/// every date column stores and what the API sends.
///
/// A port of the date helpers in `public/app.js` — `todayISO`, `isUpcoming`,
/// `daysUntil`, `fmtCountdown`, `eventDayISO`, `DEFAULT_CHECKLIST` — plus `fmtDate`
/// from `public/js/format.js` (the rest of that file is `LapTime`). Same names, and
/// the same two different clocks the JS uses, deliberately:
///
/// - `todayISO`/`eventDayISO` are **UTC**, because `toISOString()` is.
/// - `daysUntil` counts **local calendar days**, because `new Date(y, m - 1, d)`
///   and `setHours(0,0,0,0)` are local. A countdown has to say "Tomorrow" by the
///   user's midnight, not UTC's.
///
/// Keeping the split means "In 1 day" and "upcoming" agree with the web app on the
/// same data, including in the hours either side of midnight where they differ.
public enum EventDates {
    /// Today's date in UTC, as `yyyy-mm-dd`.
    public static func todayISO(now: Date = Date()) -> String {
        utcISOString(from: now)
    }

    /// A date the user picked, as `yyyy-mm-dd` — in **their** calendar, not UTC.
    ///
    /// This is not `todayISO`'s clock, on purpose, and the difference is a whole day
    /// wide: at 10pm in New York, UTC has already rolled over. A date picker's answer
    /// must round-trip to the day the picker showed, so it is formatted locally —
    /// exactly what the web app's `<input type="date">` submits.
    public static func isoString(from date: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The reverse: local midnight on that date, which is what a `DatePicker` binds
    /// to. nil when the string isn't a date.
    public static func date(fromISO iso: String, calendar: Calendar = .autoupdatingCurrent) -> Date? {
        guard let parts = ymd(iso) else { return nil }
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d
        return calendar.date(from: components)
    }

    /// Is this event still ahead? String comparison, exactly as the JS: ISO dates
    /// sort lexicographically.
    public static func isUpcoming(_ startDate: String, now: Date = Date()) -> Bool {
        startDate > todayISO(now: now)
    }

    /// Whole local calendar days from today to `iso`. Negative once it's past.
    /// nil when the string isn't a date.
    public static func daysUntil(
        _ iso: String, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent
    ) -> Int? {
        guard let parts = ymd(iso) else { return nil }
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d
        guard let target = calendar.date(from: components) else { return nil }
        let today = calendar.startOfDay(for: now)
        return calendar.dateComponents([.day], from: today, to: calendar.startOfDay(for: target)).day
    }

    /// "Today" / "Tomorrow" / "In 5 days". nil when the date won't parse.
    public static func fmtCountdown(
        _ iso: String, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent
    ) -> String? {
        guard let dd = daysUntil(iso, now: now, calendar: calendar) else { return nil }
        if dd <= 0 { return "Today" }
        if dd == 1 { return "Tomorrow" }
        return "In \(dd) days"
    }

    /// ISO date of an event's Nth day — day 1 is `startDate`.
    public static func eventDayISO(_ startDate: String, day: Int) -> String? {
        guard let parts = ymd(startDate) else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d + day - 1
        guard let date = utc.date(from: components) else { return nil }
        return utcISOString(from: date)
    }

    /// An ISO date rendered for display: "Jul 30, 2026", ordered by the user's
    /// locale. `nil` or an unparseable string is the em dash every other formatter
    /// uses for absent data.
    public static func fmtDate(_ iso: String?) -> String {
        guard let iso, let parts = ymd(iso) else { return "—" }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        var components = DateComponents()
        components.year = parts.y
        components.month = parts.m
        components.day = parts.d
        guard let date = utc.date(from: components) else { return "—" }
        // Formatted in UTC too, or a date built at UTC midnight renders as the
        // previous day for anyone west of Greenwich.
        return date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: utc.timeZone)
        )
    }

    /// The prep checklist a new event starts from when the user hasn't made their
    /// own — a port of `DEFAULT_CHECKLIST` in `public/js/checklist.js`, pinned to
    /// it item for item by `contracts/logic/checklist.json`.
    ///
    /// A user who edits the list in Settings gets their own, stored server-side
    /// and served by `GET /api/me` as `User.checklistTemplate`; that wins over
    /// this whenever it is present.
    public static let DEFAULT_CHECKLIST = [
        // First because it is the only item with a deadline days before the event
        // rather than the morning of it.
        "Purchase Track insurance",
        "Tech inspection",
        "Torque lug nuts",
        "Check brake pads & fluid",
        "Set tire pressures",
        "Top off fuel",
        "Pack helmet & gloves",
        "Empty the car — remove loose items",
        "Charge camera / lap timer"
    ]

    // MARK: - Parsing

    /// `yyyy-mm-dd` → components. Rejects anything else, including a date with a
    /// time on it, so a bad string fails visibly rather than becoming 1 January.
    static func ymd(_ iso: String) -> (y: Int, m: Int, d: Int)? {
        let parts = iso.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d)
        else { return nil }
        return (y, m, d)
    }

    private static func utcISOString(from date: Date) -> String {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return isoString(from: date, calendar: utc)
    }
}
