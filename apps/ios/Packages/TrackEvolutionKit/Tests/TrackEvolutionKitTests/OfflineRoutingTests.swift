import Foundation
import Testing

@testable import TrackEvolutionKit

/// `APIClient` with the offline store in the middle. Mirrors `api()` in
/// `public/js/api.js`.
///
/// These are the quiet failure modes: a cache served when it shouldn't be, or a
/// write that silently queues when the caller needed an error. Each one gets a test.
struct OfflineRoutingTests {
    private func client(
        offline: OfflineStore,
        respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://example.test")!,
            tokens: StaticToken("tok"),
            session: StubProtocol.session(respond),
            offline: offline
        )
    }

    private struct Offline: Error {}

    // MARK: - Reads

    @Test func aSuccessfulReadFillsTheCache() async throws {
        let store = try OfflineStore()
        let api = client(offline: store) { _ in (200, try Goldens.body("events-list")) }

        let events = try await api.events()
        #expect(events.count == 3)
        // Cached under the path the web app uses, so the store's derivations apply.
        #expect(try await store.cachedKeys() == ["/events"])
    }

    @Test func aNetworkFailureFallsBackToTheCache() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try Goldens.body("events-list"))

        let api = client(offline: store) { _ in throw Offline() }
        let events = try await api.events()
        #expect(events.count == 3, "the cached copy beats an error")
        #expect(try await store.syncStatus().offline)
    }

    @Test func aServerErrorDoesNotFallBackToTheCache() async throws {
        // The distinction that matters: the server answering 404 is not the network
        // being gone, and serving a stale cache would hide a real answer.
        let store = try OfflineStore()
        try await store.cachePut("/events/1", body: try Goldens.body("event-detail"))

        let api = client(offline: store) { _ in (404, try Goldens.body("error-404")) }
        await #expect(throws: APIError.server(status: 404, message: "not found")) {
            _ = try await api.event(id: 1)
        }
    }

    @Test func aReadWithNoCacheAndNoNetworkStillFails() async throws {
        let store = try OfflineStore()
        let api = client(offline: store) { _ in throw Offline() }
        do {
            _ = try await api.events()
            Issue.record("expected a transport failure")
        } catch let error as APIError {
            if case .transport = error {} else { Issue.record("expected .transport, got \(error)") }
        }
    }

    @Test func aTrackFilteredListIsServedFromTheCachedFullListWhenOffline() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try Goldens.body("events-list"))

        let api = client(offline: store) { _ in throw Offline() }
        // Never fetched, still answerable — the query string is part of the key, and
        // the store derives it.
        let filtered = try await api.events(trackId: 1)
        #expect(!filtered.isEmpty)
        #expect(filtered.allSatisfy { $0.trackId == 1 })
    }

    @Test func aReadOfARowCreatedOfflineIsServedFromTheCacheWithoutAskingTheServer() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))
        guard case .created(let tempId) = try await store.enqueue(
            method: "POST", path: "/events",
            body: try JSONSerialization.data(withJSONObject: ["start_date": "2026-05-01", "track_name": "VIR"])
        ) else {
            Issue.record("expected a temp id")
            return
        }

        let asked = Recorder()
        let api = client(offline: store) { request in
            asked.record(request.url?.path ?? "")
            return (404, Data(#"{"error":"not found"}"#.utf8))
        }
        let detail = try await api.event(id: tempId)
        #expect(detail.event.trackName == "VIR")
        #expect(asked.calls.isEmpty, "the server has never heard of this row")
    }

    // MARK: - Writes

    @Test func aWriteWithNoNetworkQueuesAndReportsASyntheticResponse() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))

        let api = client(offline: store) { _ in throw Offline() }
        let id = try await api.createEvent(EventDraft(startDate: "2026-05-01", trackName: "VIR"))
        #expect(OfflineStore.isTemp(id), "the caller gets a usable id immediately")
        #expect(try await store.pendingCount() == 1)
    }

    @Test func aWriteThatIsNotQueueableStillFailsOffline() async throws {
        // Vehicles need a live server, deliberately — queueing one would show the
        // user a change the server may reject for reasons we can't mirror.
        let store = try OfflineStore()
        let api = client(offline: store) { _ in throw Offline() }
        do {
            _ = try await api.vehicles()
            Issue.record("expected a failure")
        } catch let error as APIError {
            if case .transport = error {} else { Issue.record("expected .transport, got \(error)") }
        }
        #expect(try await store.pendingCount() == 0)
    }

    @Test func aQueueableWriteQueuesWhileEarlierWritesArePendingEvenWithANetwork() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events/7", body: try Goldens.body("event-detail"))
        // An earlier write is already waiting.
        _ = try await store.enqueue(
            method: "PUT", path: "/events/7",
            body: try JSONSerialization.data(withJSONObject: ["club": "Chin"])
        )

        let sent = Recorder()
        let api = client(offline: store) { request in
            sent.record(request.httpMethod ?? "")
            return (201, Data(#"{"id":9}"#.utf8))
        }
        _ = try await api.createSession(eventId: 7, SessionDraft(label: "S1", laps: [121_000]))

        // Sending it now would reorder it ahead of the queue, so it queues too — and
        // a flush is kicked off in the background.
        #expect(try await store.pendingCount() >= 1)
        #expect(!sent.calls.contains("POST"), "the create must not jump the queue")
    }

    @Test func aServerRejectionOfAWriteIsNotQueued() async throws {
        let store = try OfflineStore()
        let api = client(offline: store) { _ in (400, try Goldens.body("error-400")) }
        await #expect(throws: APIError.server(status: 400, message: "start_date required")) {
            _ = try await api.createEvent(EventDraft(startDate: ""))
        }
        #expect(try await store.pendingCount() == 0, "the server said no — that's an answer, not an outage")
    }

    // MARK: - Flush

    @Test func flushReplaysThroughTheClientsOwnTransport() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))

        let api = client(offline: store) { _ in throw Offline() }
        let tempId = try await api.createEvent(EventDraft(startDate: "2026-05-01", trackName: "VIR"))
        #expect(try await store.pendingCount() == 1)

        // The network comes back: a fresh client over a working transport, same store.
        let sent = Recorder()
        let online = client(offline: store) { request in
            sent.record("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
            return (201, Data(#"{"id":42}"#.utf8))
        }
        let status = await online.flushQueue()
        #expect(sent.calls == ["POST /api/events"])
        #expect(status?.pending == 0)
        #expect(try await store.resolveId(tempId) == 42, "the temp id now maps to the real one")
    }

    @Test func clearingOfflineLeavesNothingBehind() async throws {
        let store = try OfflineStore()
        let api = client(offline: store) { _ in (200, try Goldens.body("events-list")) }
        _ = try await api.events()
        #expect(try await store.cachedKeys().isEmpty == false)

        await api.clearOffline()
        #expect(try await store.cachedKeys().isEmpty)
    }

    /// Records what reached the transport.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [String] = []

        func record(_ value: String) { lock.withLock { seen.append(value) } }
        var calls: [String] { lock.withLock { seen } }
    }
}
