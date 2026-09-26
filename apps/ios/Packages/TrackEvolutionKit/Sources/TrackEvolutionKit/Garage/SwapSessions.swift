import Foundation

/// Swaps between sessions (migration 0030).
///
/// A swap can name the session it happened before, so a mid-day pad or tire
/// change divides the day's hours between the two parts instead of crediting
/// both with all of it. A port of `eventLastDay` / `swapSessionEvent` /
/// `swapSessionChoices` in `public/js/garage.js` — the picker's pure half —
/// under the same names and pinned by `contracts/logic/garage-swap.json`.
public extension Garage {
    /// The fields `swapSessionEvent` reads. A protocol, as `LogbookEvent` is, so
    /// the fixture's partial rows and a real `Event` pass the same way.
    protocol SwapEvent {
        var id: Int { get }
        var vehicleId: Int? { get }
        var startDate: String { get }
        var days: Double { get }
    }

    /// The fields `swapSessionChoices` reads: a session's label and how many
    /// laps it logged.
    protocol SwapSession {
        var id: Int { get }
        var label: String? { get }
        var lapCount: Int { get }
    }

    /// One row of the picker — the value it sends as `session_id`, and its words.
    struct SwapChoice: Hashable, Sendable, Decodable, Identifiable {
        public let id: Int
        public let label: String

        public init(id: Int, label: String) {
            self.id = id
            self.label = label
        }
    }

    /// `eventLastDay(event)` — the last day an event covers: its start plus its
    /// day count, less one, with a part day counting whole (the server's swap
    /// check's rule). A zero or missing day count is one day.
    static func eventLastDay<E: SwapEvent>(_ event: E) -> String {
        let raw = event.days.isNaN || event.days == 0 ? 1 : event.days
        let days = max(1, Int(raw.rounded(.up)))
        return EventDates.eventDayISO(event.startDate, day: days) ?? event.startDate
    }

    /// `swapSessionEvent(vehicleId, date, events)` — the event on this car whose
    /// days cover `date`, matched by `vehicleId` as the server matches it (never
    /// the free-text car). Two covering events go to the one that started later,
    /// then the higher id. Nil when none does, or `date` is empty.
    static func swapSessionEvent<E: SwapEvent>(_ vehicleId: Int, _ date: String?, _ events: [E]) -> E? {
        guard let date, !date.isEmpty else { return nil }
        var best: E?
        for e in events {
            guard let v = e.vehicleId, v == vehicleId else { continue }
            if e.startDate > date || eventLastDay(e) < date { continue }
            if let b = best {
                if e.startDate > b.startDate || (e.startDate == b.startDate && e.id > b.id) { best = e }
            } else {
                best = e
            }
        }
        return best
    }

    /// `swapSessionChoices(sessions)` — "Before Session 3 · 5 laps", in the order
    /// the sessions ran: the part coming off ran the ones above, the part going
    /// on ran this one onward. A blank label is named by its place.
    static func swapSessionChoices<S: SwapSession>(_ sessions: [S]) -> [SwapChoice] {
        sessions.enumerated().map { i, s in
            let trimmed = (s.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let name = trimmed.isEmpty ? "Session \(i + 1)" : trimmed
            let n = s.lapCount
            let laps = n > 0 ? " · \(n) lap\(n == 1 ? "" : "s")" : ""
            return SwapChoice(id: s.id, label: "Before \(name)\(laps)")
        }
    }
}

extension Event: Garage.SwapEvent {}

extension Session: Garage.SwapSession {
    public var lapCount: Int { laps.count }
}
