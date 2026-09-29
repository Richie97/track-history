import Foundation
import Testing

@testable import TrackEvolutionKit

/// A coach reading a student's logbook through the API client (NS-38): the
/// prefix, the read-only refusal and the offline rules — the three things the
/// web's `api()` does under `viewing`, each a quiet failure if it goes wrong.
struct CoachingAPITests {
    private struct Offline: Error {}

    private func client(
        offline: OfflineStore? = nil,
        respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://example.test")!,
            tokens: StaticToken("tok"),
            session: StubProtocol.session(respond),
            offline: offline
        )
    }

    /// Every URL the transport was asked for, in order.
    private final class Paths: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [String] = []
        func record(_ request: URLRequest) {
            lock.withLock { seen.append("\(request.httpMethod ?? "?") \(request.url?.path ?? "")") }
        }
        var all: [String] { lock.withLock { seen } }
    }

    @Test func aStudentsReadsGoThroughTheirPrefixWithTheCoachsToken() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, try Goldens.body("student-events"))
        }.scoped(toStudent: 7)

        _ = try await api.events()
        let request = try #require(seen.last)
        #expect(request.url?.absoluteString == "https://example.test/api/students/7/events")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    @Test func aStudentsProfileCarriesTheirTier() async throws {
        let api = client { _ in (200, try Goldens.body("student-profile")) }.scoped(toStudent: 1)
        let profile = try await api.profile()
        #expect(profile.pro)
        #expect(profile.profile?.helmetRating == "SA2020")
    }

    @Test func aWriteUnderAStudentIsRefusedBeforeItIsSent() async throws {
        let seen = Paths()
        let store = try OfflineStore()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }.scoped(toStudent: 7)

        await #expect(throws: APIError.readOnly) {
            var patch = EventPatch(); patch.notes = .set("hi"); try await api.updateEvent(id: 5, patch)
        }
        await #expect(throws: APIError.readOnly) {
            _ = try await api.createSession(eventId: 5, SessionDraft(label: "S1", laps: [90_000]))
        }
        await #expect(throws: APIError.readOnly) {
            try await api.deleteLap(id: 3)
        }
        #expect(seen.all.isEmpty, "nothing reached the transport")
        #expect(try await store.pendingCount() == 0, "and nothing was queued")
    }

    @Test func aWriteUnderAStudentNeverQueuesEvenWhileTheCoachsOwnWritesArePending() async throws {
        // The case that would otherwise slip through: with the coach's own writes
        // queued, a queueable path queues rather than sending.
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))
        _ = try await store.enqueue(
            method: "POST", path: "/events",
            body: try JSONSerialization.data(withJSONObject: ["start_date": "2026-05-01", "track_name": "VIR"])
        )
        let api = client(offline: store) { _ in throw Offline() }
        let student = api.scoped(toStudent: 7)

        await #expect(throws: APIError.readOnly) {
            try await student.deleteEvent(id: 12)
        }
        #expect(try await store.pendingCount() == 1, "only the coach's own write")
        #expect(await student.flushQueue() == nil, "a student's view never flushes the owner's queue")
    }

    @Test func aStudentsResponsesAreCachedUnderTheirPrefixAndServedOffline() async throws {
        let store = try OfflineStore()
        let online = client(offline: store) { _ in (200, try Goldens.body("student-events")) }
        _ = try await online.scoped(toStudent: 7).events()
        #expect(try await store.cachedKeys() == ["/students/7/events"])

        // Offline, the student's copy answers — and the coach's own list is not it.
        let offline = client(offline: store) { _ in throw Offline() }
        let events = try await offline.scoped(toStudent: 7).events()
        #expect(!events.isEmpty)
        await #expect(throws: (any Error).self) { _ = try await offline.events() }
    }

    @Test func forgettingAStudentDropsTheirResponsesAndKeepsYourOwn() async throws {
        let store = try OfflineStore()
        let body = try Goldens.body("student-events")
        try await store.cachePut("/events", body: body)
        try await store.cachePut("/students/7/events", body: body)
        try await store.cachePut("/students/7/events/3", body: body)
        try await store.cachePut("/students/70/events", body: body)

        let api = client(offline: store) { _ in throw Offline() }
        await api.scoped(toStudent: 7).forgetStudent(7)
        #expect(try await store.cachedKeys() == ["/events", "/students/70/events"])
    }

    @Test func leavingAStudentForgetsThem() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/students/7/events", body: Data("[]".utf8))
        let seen = Paths()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        try await api.leaveStudent(id: 7)
        #expect(seen.all == ["DELETE /api/coaching/students/7"])
        #expect(try await store.cachedKeys().isEmpty)
    }

    @Test func yourOwnLogbookIsTheSameClient() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, try Goldens.body("events-list"))
        }
        _ = try await api.scoped(to: .me).events()
        #expect(seen.last?.url?.path == "/api/events")
        #expect(api.scoped(to: .me).studentId == nil)
        #expect(api.scoped(to: .student(id: 4, name: nil, pro: false)).studentId == 4)
    }

    @Test func anInvitePreviewIsNeverCached() async throws {
        let store = try OfflineStore()
        let seen = Recorder()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, try Goldens.body("coaching-invite-preview"))
        }
        let preview = try await api.coachInvitePreview(token: "abc_123-XYZ")
        #expect(preview.student.name == "Dev User")
        #expect(seen.last?.url?.path == "/api/coaching/invites/abc_123-XYZ")
        #expect(try await store.cachedKeys().isEmpty, "the path carries a single-use token")
    }

    @Test func acceptingPostsToTheTokensPath() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (201, try Goldens.body("coaching-accept"))
        }
        let accepted = try await api.acceptCoachInvite(token: "tok")
        #expect(accepted.student.id == 1)
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/coaching/invites/tok/accept")
    }

    @Test func savingANilProfileSendsAnExplicitNull() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, Data(#"{"ok":true,"profile":null}"#.utf8))
        }
        let saved = try await api.saveProfile(nil)
        #expect(saved == nil)
        let body = try #require(seen.lastBody)
        #expect(String(decoding: body, as: UTF8.self) == #"{"profile":null}"#)
        #expect(seen.last?.httpMethod == "PUT")
        #expect(seen.last?.url?.path == "/api/me/profile")
    }

    @Test func coachingWritesAreNeverQueued() {
        for (method, path) in [
            ("POST", "/coaching/invites"), ("DELETE", "/coaching/invites/3"),
            ("POST", "/coaching/invites/tok/accept"), ("DELETE", "/coaching/coaches/2"),
            ("DELETE", "/coaching/students/2"), ("PUT", "/me/profile"),
            ("PUT", "/students/7/events/3"), ("DELETE", "/students/7/sessions/3")
        ] {
            #expect(!OfflineStore.isQueueable(method: method, path: path), "\(method) \(path)")
        }
    }
}
