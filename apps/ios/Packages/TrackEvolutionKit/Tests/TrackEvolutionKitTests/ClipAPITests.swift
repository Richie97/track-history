import Foundation
import Testing

@testable import TrackEvolutionKit

/// The best-lap video routes on the API client (NS-45): the paths and bodies,
/// `complete`'s missing-parts answer, the URL read past the cache, a coach's
/// read-only refusal, and the temp-id lookup the clip queue waits on.
struct ClipAPITests {
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

    @Test func theCreatePostsTheLapsTimeAndTheMeasuredCut() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (201, Data(#"{"clip_id":9,"part_bytes":52428800,"parts":3,"uploaded":[1]}"#.utf8))
        }
        let start = try await api.createClip(
            sessionId: 42, ClipCreateBody(timeMs: 121_345, sizeBytes: 120_000_000, durationMs: 126_400, lapOffsetMs: 3_317)
        )
        #expect(start == ClipUploadStart(clipId: 9, partBytes: 52_428_800, parts: 3, uploaded: [1]))
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/sessions/42/clip")
        let body = try #require(seen.lastBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Int])
        #expect(json == ["time_ms": 121_345, "size_bytes": 120_000_000, "duration_ms": 126_400, "lap_offset_ms": 3_317])
    }

    @Test func aFullStorageCreateCarriesTheServersWords() async throws {
        let api = client { _ in (409, Data(#"{"error":"clip storage full"}"#.utf8)) }
        await #expect(throws: APIError.server(status: 409, message: "clip storage full")) {
            _ = try await api.createClip(sessionId: 1, ClipCreateBody(timeMs: 1, sizeBytes: 1, durationMs: 2, lapOffsetMs: 0))
        }
    }

    @Test func completeAnswersTheClipOrTheMissingParts() async throws {
        let ready = client { _ in (200, Data(#"{"id":9,"duration_ms":126400,"lap_offset_ms":3317,"size_bytes":2048}"#.utf8)) }
        #expect(try await ready.completeClip(id: 9) == LapClip(id: 9, durationMs: 126_400, lapOffsetMs: 3_317, sizeBytes: 2048))

        let missing = client { _ in (409, Data(#"{"error":"missing parts","missing":[2,3]}"#.utf8)) }
        await #expect(throws: ClipMissingParts(missing: [2, 3])) { _ = try await missing.completeClip(id: 9) }
    }

    @Test func theUrlIsReadPastTheCache() async throws {
        let store = try OfflineStore()
        let api = client(offline: store) { _ in
            (200, Data(#"{"url":"https://example.test/clips/9.mp4?exp=1&sig=ab","expires_at":1000}"#.utf8))
        }
        let signed = try await api.clipURL(id: 9)
        #expect(signed.url.absoluteString == "https://example.test/clips/9.mp4?exp=1&sig=ab")
        #expect(signed.expiresAt == 1000)
        #expect(try await store.cachedKeys().isEmpty, "a signed URL must never be served from the cache")
    }

    @Test func aCoachGetsTheStudentsUrlAndNothingElse() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, Data(#"{"url":"https://example.test/clips/9.mp4?exp=1&sig=ab","expires_at":1000}"#.utf8))
        }
        let student = api.scoped(toStudent: 7)
        _ = try await student.clipURL(id: 9)
        #expect(seen.last?.url?.path == "/api/students/7/clips/9/url")

        await #expect(throws: APIError.readOnly) { try await student.deleteClip(id: 9) }
        await #expect(throws: APIError.readOnly) { _ = try await student.completeClip(id: 9) }
        await #expect(throws: APIError.readOnly) {
            _ = try await student.createClip(sessionId: 1, ClipCreateBody(timeMs: 1, sizeBytes: 1, durationMs: 2, lapOffsetMs: 0))
        }
        await #expect(throws: APIError.readOnly) { _ = try await student.authorizedRequest("GET", "/clips/9/download") }
    }

    @Test func deletingIsLiveAndNeverQueued() async throws {
        let store = try OfflineStore()
        let api = client(offline: store) { _ in throw Offline() }
        await #expect(throws: (any Error).self) { try await api.deleteClip(id: 9) }
        #expect(try await store.pendingCount() == 0)
    }

    @Test func anAuthorizedRequestCarriesTheBearer() async throws {
        let api = client { _ in (200, Data()) }
        let request = try await api.authorizedRequest("PUT", "/clips/9/parts/2")
        #expect(request.url?.absoluteString == "https://example.test/api/clips/9/parts/2")
        #expect(request.httpMethod == "PUT")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    @Test func aTempSessionIsQueuedThenMapped() async throws {
        let store = try OfflineStore()
        try await store.cachePut("/events/5", body: try Goldens.body("event-detail"))
        let created = try await store.enqueue(
            method: "POST", path: "/events/5/sessions",
            body: try JSONSerialization.data(withJSONObject: ["label": "S1", "laps": [90_000]])
        )
        guard case .created(let temp) = created else {
            Issue.record("a session create should hand back a temp id")
            return
        }
        let api = client(offline: store) { _ in (201, Data(#"{"id":77}"#.utf8)) }
        let before = await api.tempIdState(temp)
        #expect(before.mapped == nil && before.queued)
        await api.flushQueue()
        let after = await api.tempIdState(temp)
        #expect(after.mapped == 77 && !after.queued)
        #expect(ClipUploadQueue.sessionState(temp, mapped: after.mapped, queued: after.queued) == .real(77))
    }
}
