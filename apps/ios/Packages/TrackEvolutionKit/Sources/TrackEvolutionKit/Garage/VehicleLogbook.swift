import Foundation

/// A car's logbook (NS-37) — the free half of the Garage tab and a car's page.
///
/// A port of `vehicleLogbook` / `vehicleTileLine` in `public/js/garage.js`, under
/// the same names and pinned by `contracts/logic/garage-logbook.json`. It reduces
/// the event list every screen already has cached, so it costs no request and
/// works offline. Rows belong to the car by `vehicleId` — the server's name match
/// — and never by the free-text `car`. Past means `startDate <= today`, the
/// totals' rule. Hours are deliberately absent: they are the wear math's, and
/// arrive computed on the Pro `GET /api/garage`.
public extension Garage {
    /// The fields the logbook reads. A protocol, as `RemoteRecording.EventCandidate`
    /// is, so the fixture's partial rows and a real `Event` pass the same way.
    protocol LogbookEvent {
        var id: Int { get }
        var vehicleId: Int? { get }
        var trackId: Int { get }
        var trackName: String { get }
        var startDate: String { get }
        var days: Double { get }
        var bestMs: Int? { get }
    }

    struct EventRef: Hashable, Sendable, Decodable {
        public let id: Int
        public let trackId: Int
        public let trackName: String
        public let startDate: String

        enum CodingKeys: String, CodingKey {
            case id
            case trackId = "track_id"
            case trackName = "track_name"
            case startDate = "start_date"
        }
    }

    struct TrackBest: Hashable, Sendable, Decodable, Identifiable {
        public let trackId: Int
        public let trackName: String
        public let bestMs: Int
        public let eventId: Int
        public let startDate: String
        public var id: Int { trackId }

        enum CodingKeys: String, CodingKey {
            case trackId = "track_id"
            case trackName = "track_name"
            case bestMs = "best_ms"
            case eventId = "event_id"
            case startDate = "start_date"
        }
    }

    struct Logbook: Hashable, Sendable, Decodable {
        /// A sum of `days`, which the model carries as a `Double`.
        public let trackDays: Double
        public let events: Int
        public let lastEvent: EventRef?
        public let nextEvent: EventRef?
        public let bests: [TrackBest]

        enum CodingKeys: String, CodingKey {
            case trackDays = "track_days"
            case events
            case lastEvent = "last_event"
            case nextEvent = "next_event"
            case bests
        }
    }

    /// `vehicleLogbook(vehicleId, events, today)`.
    static func vehicleLogbook<E: LogbookEvent>(_ vehicleId: Int, _ events: [E], today: String) -> Logbook {
        // `eventOrder`: by date, then id — a tie on date is broken the same way
        // on every client.
        let ascending: (E, E) -> Bool = { a, b in
            a.startDate == b.startDate ? a.id < b.id : a.startDate < b.startDate
        }
        let mine = events.filter { $0.vehicleId != nil && $0.vehicleId == vehicleId }.sorted(by: ascending)
        let past = mine.filter { $0.startDate <= today }
        let upcoming = mine.filter { $0.startDate > today }

        // Insertion order is irrelevant — the bests are sorted below — but each
        // track keeps its latest event and its fastest one. `past` ascends, so the
        // last one seen is the latest, and a strict `<` keeps the earlier event on
        // a tie, the day the time was first set.
        var latest: [Int: E] = [:]
        var best: [Int: E] = [:]
        for e in past {
            latest[e.trackId] = e
            if let ms = e.bestMs, best[e.trackId].map({ ms < $0.bestMs! }) ?? true {
                best[e.trackId] = e
            }
        }
        let bests = best.keys
            .sorted { a, b in ascending(latest[b]!, latest[a]!) }
            .map { trackId -> TrackBest in
                let e = best[trackId]!
                return TrackBest(trackId: e.trackId, trackName: e.trackName, bestMs: e.bestMs!, eventId: e.id, startDate: e.startDate)
            }
        return Logbook(
            trackDays: past.reduce(0) { $0 + $1.days },
            events: past.count,
            lastEvent: past.last.map(ref),
            nextEvent: upcoming.first.map(ref),
            bests: bests
        )
    }

    /// `vehicleTileLine(logbook)` — the one line a car's tile carries. Dateless:
    /// a date is locale work, and three clients writing the same words is why
    /// it is pinned.
    static func vehicleTileLine(_ logbook: Logbook) -> String {
        if let last = logbook.lastEvent {
            let days = logbook.trackDays
            return "\(jsNumber(days)) track day\(days == 1 ? "" : "s") · last at \(last.trackName)"
        }
        if let next = logbook.nextEvent { return "Next: \(next.trackName)" }
        return "No track days yet"
    }

    private static func ref<E: LogbookEvent>(_ e: E) -> EventRef {
        EventRef(id: e.id, trackId: e.trackId, trackName: e.trackName, startDate: e.startDate)
    }

    /// A number the way JavaScript's template literal writes it: `9` not `9.0`.
    private static func jsNumber(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }
}

extension Event: Garage.LogbookEvent {}
