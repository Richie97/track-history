import Foundation
import Testing

@testable import TrackEvolutionKit

/// Push notifications for coach comments (NS-54): registering this phone
/// (live, never queued) and the table a tapped notification is routed by —
/// the same table Android's `DeepLink.commentPush` in `:core` carries.
struct PushTests {
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

    // MARK: - Registration

    @Test func registeringSendsThePlatformAndTokenWithTheBearer() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        try await api.registerPushDevice(platform: .ios, token: "fcm:abc")
        let put = try #require(seen.last)
        #expect(put.httpMethod == "PUT")
        #expect(put.url?.path == "/api/push/device")
        #expect(put.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        let body = try #require(seen.lastBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: String]
        #expect(json == ["platform": "ios", "token": "fcm:abc"])

        try await api.unregisterPushDevice()
        #expect(seen.last?.httpMethod == "DELETE")
        #expect(seen.last?.url?.path == "/api/push/device")
    }

    @Test func registrationIsLiveAndNeverQueued() async throws {
        #expect(!OfflineStore.isQueueable(method: "PUT", path: "/push/device"))
        #expect(!OfflineStore.isQueueable(method: "DELETE", path: "/push/device"))

        let store = try OfflineStore()
        let api = client(offline: store) { _ in throw Offline() }
        await #expect(throws: (any Error).self) {
            try await api.registerPushDevice(platform: .ios, token: "t")
        }
        #expect(await store.pendingCount() == 0)
    }

    @Test func aServerRefusalThrowsItsWords() async throws {
        let api = client { _ in (400, Data(#"{"error":"push needs the app"}"#.utf8)) }
        await #expect(throws: APIError.server(status: 400, message: "push needs the app")) {
            try await api.registerPushDevice(platform: .ios, token: "t")
        }
    }

    // MARK: - Where a tap goes

    private let base = ["kind": "comment", "comment_id": "9", "event_id": "30", "session_id": "40"]

    private func link(_ extra: [String: String] = [:], drop: [String] = []) -> DeepLink? {
        var data = base.merging(extra) { $1 }
        for key in drop { data[key] = nil }
        return DeepLink.commentPush(data)
    }

    @Test func aLapCommentOpensTheLap() {
        #expect(link(["lap_id": "50"]) == .comment(.init(studentId: nil, eventId: 30, sessionId: 40, lapId: 50)))
    }

    @Test func aSessionCommentOpensTheEvent() {
        #expect(link() == .comment(.init(studentId: nil, eventId: 30, sessionId: 40, lapId: nil)))
    }

    @Test func aCoachsNotificationOpensInTheStudentsLogbook() {
        #expect(link(["lap_id": "50", "student_id": "7"])
            == .comment(.init(studentId: 7, eventId: 30, sessionId: 40, lapId: 50)))
        #expect(link(["student_id": "7"]) == .comment(.init(studentId: 7, eventId: 30, sessionId: 40, lapId: nil)))
    }

    @Test func anythingButACommentIsNotOurs() {
        #expect(link(["kind": "share"]) == nil)
        #expect(link(drop: ["kind"]) == nil)
        #expect(DeepLink.commentPush([:]) == nil)
    }

    @Test func theEventAndSessionMustBePositiveIds() {
        for junk in ["", "0", "-3", "abc", "3.0", " 3", "+3", "١٢", "9999999999999999"] {
            #expect(link(["event_id": junk]) == nil, "event_id \(junk)")
            #expect(link(["session_id": junk]) == nil, "session_id \(junk)")
        }
        #expect(link(drop: ["event_id"]) == nil)
        #expect(link(drop: ["session_id"]) == nil)
    }

    @Test func aMalformedLapOrStudentFallsBackRatherThanFailing() {
        for junk in ["", "0", "-1", "x", "1.5"] {
            #expect(link(["lap_id": junk]) == .comment(.init(studentId: nil, eventId: 30, sessionId: 40, lapId: nil)))
            #expect(link(["lap_id": "50", "student_id": junk])
                == .comment(.init(studentId: nil, eventId: 30, sessionId: 40, lapId: 50)))
        }
    }
}
