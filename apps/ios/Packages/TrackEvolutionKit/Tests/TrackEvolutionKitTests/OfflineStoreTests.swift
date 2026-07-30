import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/offline.test.js`, ported with the code.
///
/// Each store is in-memory and fresh, so these run in parallel and in any order.
struct OfflineStoreTests {
    private func store() throws -> OfflineStore { try OfflineStore() }

    private func encode<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }
    private func decode<T: Decodable>(_ type: T.Type, _ data: Data?) throws -> T {
        try JSONDecoder().decode(type, from: try #require(data))
    }
    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    /// An event as the server would return it in a list.
    private func event(id: Int, trackId: Int = 1, date: String, days: Int = 1) throws -> Event {
        var detail = EventDetail(
            event: Event(
                id: id, trackId: trackId, trackName: "Summit Point", startDate: date, days: days,
                club: nil, runGroup: nil, car: nil, vehicleId: nil, notes: nil, conditions: nil,
                tempF: nil, checklist: nil, bestTimeMs: nil, trackHours: nil, updatedAt: 0,
                lapBestMs: nil, lapCount: 0, sessionCount: 0, bestMs: nil, consistency: nil, hours: 0
            ),
            sessions: [], setups: []
        )
        OfflineMirrors.recomputeDetail(&detail)
        return detail.event
    }

    private func detail(_ event: Event, sessions: [Session] = []) -> EventDetail {
        var detail = EventDetail(event: event, sessions: sessions, setups: [])
        OfflineMirrors.recomputeDetail(&detail)
        return detail
    }

    private func session(id: Int, laps: [Int], sort: Int = 1) -> Session {
        Session(
            id: id, label: "Session \(sort)", notes: nil, sort: sort, trace: nil, channels: nil,
            laps: laps.enumerated().map { Lap(id: id * 100 + $0.offset, sessionId: id, lapNum: $0.offset + 1, timeMs: $0.element) }
        )
    }

    // MARK: - Response cache

    @Test func storesAndReturnsBodiesByPath() async throws {
        let store = try store()
        try await store.cachePut("/events", body: try encode([try event(id: 1, date: "2026-05-01")]))
        let cached = try await decode([Event].self, store.cachedGet("/events"))
        #expect(cached.count == 1)
        #expect(try await store.cachedGet("/nope") == nil)
    }

    @Test func derivesATrackFilteredEventsListFromTheCachedFullList() async throws {
        let store = try store()
        let all = [
            try event(id: 1, trackId: 1, date: "2026-05-01"),
            try event(id: 2, trackId: 2, date: "2026-06-01")
        ]
        try await store.cachePut("/events", body: try encode(all))
        // Never fetched, but derivable — so a track page works offline.
        let filtered = try await decode([Event].self, store.cachedGet("/events?track_id=2"))
        #expect(filtered.map(\.id) == [2])
    }

    // MARK: - The whitelist

    @Test func whitelistsOnlyMirrorableMutations() {
        #expect(OfflineStore.isQueueable(method: "POST", path: "/events"))
        #expect(OfflineStore.isQueueable(method: "PUT", path: "/events/3"))
        #expect(OfflineStore.isQueueable(method: "DELETE", path: "/events/3"))
        #expect(OfflineStore.isQueueable(method: "POST", path: "/events/3/sessions"))
        #expect(OfflineStore.isQueueable(method: "PUT", path: "/events/3/setups/2"))
        #expect(OfflineStore.isQueueable(method: "POST", path: "/sessions/9/laps"))
        #expect(OfflineStore.isQueueable(method: "DELETE", path: "/laps/4"))
        #expect(OfflineStore.isQueueable(method: "PUT", path: "/tracks/1"))

        // Vehicles and garage parts deliberately need a live server.
        #expect(!OfflineStore.isQueueable(method: "POST", path: "/vehicles"))
        #expect(!OfflineStore.isQueueable(method: "PUT", path: "/vehicles/1"))
        #expect(!OfflineStore.isQueueable(method: "POST", path: "/vehicles/1/parts"))
        #expect(!OfflineStore.isQueueable(method: "POST", path: "/parts/1/measurements"))
        #expect(!OfflineStore.isQueueable(method: "PUT", path: "/share"))
        // Shape matters, not just the prefix.
        #expect(!OfflineStore.isQueueable(method: "PUT", path: "/events/3/setups/notaday"))
        #expect(!OfflineStore.isQueueable(method: "GET", path: "/events"))
    }

    // MARK: - Optimistic patching

    @Test func createsAnEventLocallyWithATempIdInsertedInDateOrder() async throws {
        let store = try store()
        try await store.cachePut(
            "/events",
            body: try encode([
                try event(id: 1, date: "2026-06-01"), try event(id: 2, date: "2026-04-01")
            ])
        )

        let result = try await store.enqueue(
            method: "POST", path: "/events",
            body: try json(["start_date": "2026-05-01", "track_name": "Road Atlanta", "days": 2])
        )
        guard case .created(let tempId) = result else {
            Issue.record("a create should hand back a temp id")
            return
        }
        #expect(OfflineStore.isTemp(tempId))
        #expect(try await store.pendingCount() == 1)

        // Sorted newest first, like the list the server returns.
        let list = try await decode([Event].self, store.cachedGet("/events"))
        #expect(list.map(\.startDate) == ["2026-06-01", "2026-05-01", "2026-04-01"])
        #expect(list[1].id == tempId)
        #expect(list[1].trackName == "Road Atlanta")

        // …and the detail is there too, so opening the new event works offline.
        let detail = try await decode(EventDetail.self, store.cachedGet("/events/\(tempId)"))
        #expect(detail.event.days == 2)
        #expect(detail.sessions.isEmpty)
        #expect(detail.event.hours == 4, "2 days × 2h with no laps")
    }

    @Test func addsASessionWithLapsAndRecomputesAggregatesEverywhere() async throws {
        let store = try store()
        let event = try event(id: 7, date: "2026-05-01")
        try await store.cachePut("/events/7", body: try encode(detail(event)))
        try await store.cachePut("/events", body: try encode([event]))

        _ = try await store.enqueue(
            method: "POST", path: "/events/7/sessions",
            body: try json(["label": "Session 1", "laps": [121_500, 120_900, 122_100]])
        )

        let detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.sessions.count == 1)
        #expect(detail.sessions[0].laps.map(\.timeMs) == [121_500, 120_900, 122_100])
        #expect(detail.event.lapCount == 3)
        #expect(detail.event.sessionCount == 1)
        #expect(detail.event.bestMs == 120_900)
        #expect(detail.event.consistency != nil, "three laps is enough for consistency")

        // The dashboard list has to agree with the detail.
        let list = try await decode([Event].self, store.cachedGet("/events"))
        #expect(list[0].lapCount == 3)
        #expect(list[0].bestMs == 120_900)
        #expect(list[0].consistency == detail.event.consistency)
    }

    @Test func patchesEventEditsAndDeletesIntoDetailAndLists() async throws {
        let store = try store()
        let event = try event(id: 7, date: "2026-05-01")
        try await store.cachePut("/events/7", body: try encode(detail(event)))
        try await store.cachePut("/events", body: try encode([event]))

        _ = try await store.enqueue(
            method: "PUT", path: "/events/7", body: try json(["club": "Chin Track Days", "days": 2])
        )
        var detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.event.club == "Chin Track Days")
        #expect(detail.event.days == 2)
        #expect(detail.event.hours == 4, "hours follows the day count")
        var list = try await decode([Event].self, store.cachedGet("/events"))
        #expect(list[0].club == "Chin Track Days")

        // A field the request didn't carry is left alone.
        _ = try await store.enqueue(method: "PUT", path: "/events/7", body: try json(["notes": "Damp"]))
        detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.event.notes == "Damp")
        #expect(detail.event.club == "Chin Track Days", "an absent key must not clear the column")

        _ = try await store.enqueue(method: "DELETE", path: "/events/7", body: nil)
        #expect(try await store.cachedGet("/events/7") == nil)
        list = try await decode([Event].self, store.cachedGet("/events"))
        #expect(list.isEmpty)
    }

    @Test func cancelsQueuedCreatesAndTheirChildrenWhenATempRowIsDeleted() async throws {
        let store = try store()
        try await store.cachePut("/events", body: try encode([Event]()))

        guard case .created(let eventTemp) = try await store.enqueue(
            method: "POST", path: "/events", body: try json(["start_date": "2026-05-01", "track_name": "VIR"])
        ) else {
            Issue.record("expected a temp event id")
            return
        }
        guard case .created(let sessionTemp) = try await store.enqueue(
            method: "POST", path: "/events/\(eventTemp)/sessions", body: try json(["laps": [121_000]])
        ) else {
            Issue.record("expected a temp session id")
            return
        }
        _ = try await store.enqueue(
            method: "POST", path: "/sessions/\(sessionTemp)/laps", body: try json(["laps": [120_000]])
        )
        #expect(try await store.pendingCount() == 3)

        // Deleting the unsynced event drops its create *and* everything queued
        // underneath it, transitively — a DELETE the server could never resolve is
        // never queued.
        _ = try await store.enqueue(method: "DELETE", path: "/events/\(eventTemp)", body: nil)
        #expect(try await store.pendingCount() == 0)
        #expect(try await store.cachedGet("/events/\(eventTemp)") == nil)
    }

    @Test func updatesAndDeletesSessionsAndLapsInsideACachedDetail() async throws {
        let store = try store()
        let event = try event(id: 7, date: "2026-05-01")
        let existing = session(id: 5, laps: [121_500, 120_900, 122_100])
        try await store.cachePut("/events/7", body: try encode(detail(event, sessions: [existing])))
        try await store.cachePut("/events", body: try encode([detail(event, sessions: [existing]).event]))

        // The route writes both columns unconditionally, so an absent notes clears it.
        _ = try await store.enqueue(method: "PUT", path: "/sessions/5", body: try json(["label": "Renamed"]))
        var detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.sessions[0].label == "Renamed")
        #expect(detail.sessions[0].notes == nil)

        _ = try await store.enqueue(method: "POST", path: "/sessions/5/laps", body: try json(["laps": [119_800]]))
        detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.sessions[0].laps.count == 4)
        #expect(detail.sessions[0].laps.map(\.lapNum) == [1, 2, 3, 4])
        #expect(detail.event.bestMs == 119_800)

        let lapId = try #require(detail.sessions[0].laps.first?.id)
        _ = try await store.enqueue(method: "DELETE", path: "/laps/\(lapId)", body: nil)
        detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.sessions[0].laps.count == 3)
        #expect(detail.event.lapCount == 3)

        _ = try await store.enqueue(method: "DELETE", path: "/sessions/5", body: nil)
        detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.sessions.isEmpty)
        #expect(detail.event.lapCount == 0)
        #expect(detail.event.bestMs == nil)
        #expect(detail.event.consistency == nil)
    }

    @Test func patchesTrackGoalAndNotesIntoTheCachedTracksList() async throws {
        let store = try store()
        let track = Track(
            id: 1, name: "Summit Point", goalMs: nil, notes: nil, catalogId: nil, updatedAt: 0,
            eventCount: 1, trackDays: 1, bestMs: nil, lastDate: "2026-05-01", series: []
        )
        try await store.cachePut("/tracks", body: try encode([track]))

        _ = try await store.enqueue(
            method: "PUT", path: "/tracks/1", body: try json(["goal_ms": 120_000, "notes": "Bus stop in 4th"])
        )
        let tracks = try await decode([Track].self, store.cachedGet("/tracks"))
        #expect(tracks[0].goalMs == 120_000)
        #expect(tracks[0].notes == "Bus stop in 4th")
        #expect(tracks[0].name == "Summit Point", "an absent key is left alone")
    }

    @Test func setupSheetsArePatchedIntoTheEventDetail() async throws {
        let store = try store()
        try await store.cachePut("/events/7", body: try encode(detail(try event(id: 7, date: "2026-05-01"))))

        _ = try await store.enqueue(
            method: "PUT", path: "/events/7/setups/2", body: try json(["fuel": 12.5])
        )
        var detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.setups.map(\.day) == [2])
        #expect(detail.setups[0].data.fuel == 12.5)

        _ = try await store.enqueue(method: "DELETE", path: "/events/7/setups/2", body: nil)
        detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.setups.isEmpty)
    }

    // MARK: - Flush

    @Test func replaysInOrderAndMapsTempIdsIntoLaterPaths() async throws {
        let store = try store()
        try await store.cachePut("/events", body: try encode([Event]()))

        guard case .created(let eventTemp) = try await store.enqueue(
            method: "POST", path: "/events", body: try json(["start_date": "2026-05-01", "track_name": "VIR"])
        ) else {
            Issue.record("expected a temp id")
            return
        }
        _ = try await store.enqueue(
            method: "POST", path: "/events/\(eventTemp)/sessions", body: try json(["laps": [121_000]])
        )

        let sent = Recorder()
        let status = try await store.flush { method, path, _ in
            sent.record(method: method, path: path)
            return (201, Data(#"{"id":42}"#.utf8))
        }

        // Strict order, and the create's real id substituted into the path that
        // referenced it.
        #expect(sent.calls == ["POST /events", "POST /events/42/sessions"])
        #expect(status.pending == 0)
        #expect(status.failed == 0)
        #expect(try await store.resolveId(eventTemp) == 42)
    }

    @Test func stopsOnNetworkFailureAndKeepsTheRemainderQueued() async throws {
        let store = try store()
        _ = try await store.enqueue(method: "PUT", path: "/events/1", body: try json(["club": "A"]))
        _ = try await store.enqueue(method: "PUT", path: "/events/2", body: try json(["club": "B"]))

        let sent = Recorder()
        struct Offline: Error {}
        let status = try await store.flush { method, path, _ in
            sent.record(method: method, path: path)
            throw Offline()
        }
        #expect(sent.calls.count == 1, "should stop at the first failure, not burn through the queue")
        #expect(status.offline)
        #expect(status.pending == 2, "nothing is lost")
    }

    @Test func dropsServerRejectedItemsAndCountsThemAsFailed() async throws {
        let store = try store()
        _ = try await store.enqueue(method: "PUT", path: "/events/1", body: try json(["days": -1]))
        _ = try await store.enqueue(method: "PUT", path: "/events/2", body: try json(["club": "B"]))

        // The first write is rejected, the second accepted.
        let sent = Recorder()
        let status = try await store.flush { method, path, _ in
            sent.record(method: method, path: path)
            return (path == "/events/1" ? 400 : 200, Data(#"{"ok":true}"#.utf8))
        }
        // A rejected write is dropped once and reported — never retried forever.
        #expect(sent.calls.count == 2, "a rejection must not stop the queue")
        #expect(status.failed == 1)
        #expect(status.pending == 0)
    }

    @Test func retriesServerErrorsAndGivesUpAfterFive() async throws {
        let store = try store()
        _ = try await store.enqueue(method: "PUT", path: "/events/1", body: try json(["club": "A"]))

        for attempt in 1...5 {
            let status = try await store.flush { _, _, _ in (503, Data()) }
            if attempt < 5 {
                #expect(status.pending == 1, "a 5xx is the server's problem, so keep the write")
                #expect(status.failed == 0)
            } else {
                #expect(status.pending == 0, "but not forever")
                #expect(status.failed == 1)
            }
        }
    }

    @Test func dropsItemsWhoseTempIdDependencyNeverResolved() async throws {
        let store = try store()
        // A session for an event whose create is gone: unresolvable, so it can't be
        // sent and mustn't block the queue.
        _ = try await store.enqueue(
            method: "POST", path: "/events/-99/sessions", body: try json(["laps": [121_000]])
        )
        let sent = Recorder()
        let status = try await store.flush { method, path, _ in
            sent.record(method: method, path: path)
            return (201, Data(#"{"id":1}"#.utf8))
        }
        #expect(sent.calls.isEmpty, "nothing sendable")
        #expect(status.failed == 1)
        #expect(status.pending == 0)
    }

    // MARK: - Re-apply

    @Test func reapplyingTheQueueDoesNotDuplicateRows() async throws {
        let store = try store()
        let event = try event(id: 7, date: "2026-05-01")
        try await store.cachePut("/events/7", body: try encode(detail(event)))

        _ = try await store.enqueue(
            method: "POST", path: "/events/7/sessions", body: try json(["laps": [121_000, 120_000, 122_000]])
        )
        _ = try await store.enqueue(method: "POST", path: "/sessions/-1/laps", body: try json(["laps": [119_000]]))

        // A fresh server response landed while writes are still pending: re-patch it
        // so the queued changes stay visible, without doubling them up.
        try await store.reapplyQueue()
        try await store.reapplyQueue()

        let detail = try await decode(EventDetail.self, store.cachedGet("/events/7"))
        #expect(detail.sessions.count == 1)
        #expect(detail.sessions[0].laps.count == 4)
        #expect(detail.event.lapCount == 4)
    }

    // MARK: - Sign-out

    @Test func clearLeavesNoCachedRowsAndNoQueuedWrites() async throws {
        let store = try store()
        try await store.cachePut("/events", body: try encode([try event(id: 1, date: "2026-05-01")]))
        _ = try await store.enqueue(method: "PUT", path: "/events/1", body: try json(["club": "A"]))

        try await store.clear()
        #expect(try await store.cachedKeys().isEmpty)
        #expect(try await store.queuedWrites().isEmpty)
        #expect(try await store.pendingCount() == 0)
    }

    /// Records what the flush sent, in order.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [String] = []

        func record(method: String, path: String) {
            lock.withLock { seen.append("\(method) \(path)") }
        }

        var calls: [String] { lock.withLock { seen } }
    }
}
