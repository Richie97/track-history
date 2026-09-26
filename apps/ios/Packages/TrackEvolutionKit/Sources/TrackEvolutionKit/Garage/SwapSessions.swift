import Foundation

/// Swaps between sessions (migration 0030).
///
/// A swap on one of a car's track days sits at a point in that event — after
/// one of its sessions, or at its start — so a mid-day pad or tire change
/// divides the day's hours between the two parts instead of crediting both
/// with all of it. The server picks the point on its own (after the last
/// session logged so far); these are the pure half of the pickers that correct
/// it. A port of `eventLastDay` / `swapSessionEvent` / `swapSessionChoices` /
/// `defaultSwapChoice` in `public/js/garage.js`, under the same names and
/// pinned by `contracts/logic/garage-swap.json`.
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

    /// One row of the picker — the value it sends as `after_session_id` (nil:
    /// the event's start), and its words. `Identifiable` on the optional id
    /// itself: there is one start row, and nil never equals a session id.
    struct SwapChoice: Hashable, Sendable, Decodable, Identifiable {
        public let id: Int?
        public let label: String

        public init(id: Int?, label: String) {
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

    /// `swapSessionChoices(sessions)` — the event's start ("Start of the day",
    /// id nil), then after each session in the order they ran: "After Session 2
    /// · 5 laps". A swap after a session means the part coming off ran it and
    /// everything before, and the part going on ran everything after. A blank
    /// label is named by its place.
    static func swapSessionChoices<S: SwapSession>(_ sessions: [S]) -> [SwapChoice] {
        [SwapChoice(id: nil, label: "Start of the day")] + sessions.enumerated().map { i, s in
            let trimmed = (s.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let name = trimmed.isEmpty ? "Session \(i + 1)" : trimmed
            let n = s.lapCount
            let laps = n > 0 ? " · \(n) lap\(n == 1 ? "" : "s")" : ""
            return SwapChoice(id: s.id, label: "After \(name)\(laps)")
        }
    }

    /// `defaultSwapChoice(sessions)` — where the server puts a swap it isn't
    /// told the point of: after the last session logged so far, or the event's
    /// start (nil) when none is.
    static func defaultSwapChoice<S: SwapSession>(_ sessions: [S]) -> Int? {
        sessions.last?.id
    }
}

extension Event: Garage.SwapEvent {}

extension Session: Garage.SwapSession {
    public var lapCount: Int { laps.count }
}
