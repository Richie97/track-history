import Foundation
import Testing

@testable import TrackEvolutionKit

/// Sharing one event or one session (NS-48) — and one lap or two laps compared
/// (NS-56) — on the API client: the owner's
/// three routes, live and never queued, and the public reads — sent with
/// no token and kept out of the cache, since the token in the path is the
/// link's whole permission and *Stop sharing* has to take effect.
struct ItemShareAPITests {
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

    private let token = "AAAAAAAAAAAAAAAAAAAAAA"

    @Test func theOwnersRoutesAreUnderTheItemsOwnPath() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            switch request.httpMethod {
            case "DELETE": return (200, try Goldens.body("item-share-event-delete"))
            default: return (201, try Goldens.body("item-share-session-create"))
            }
        }
        let link = try await api.createItemShare(.session(42))
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/sessions/42/share")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(link.kind == .session)
        #expect(link.url.absoluteString == "https://trackevolution.app/share/s/\(token)")

        try await api.deleteItemShare(.event(7))
        #expect(seen.last?.httpMethod == "DELETE")
        #expect(seen.last?.url?.path == "/api/events/7/share")
    }

    /// NS-56: a lap's link, and a comparison's — A is `:id`, B `:otherId`, and
    /// the order is part of the link.
    @Test func aLapsAndAComparisonsRoutesAreUnderTheLap() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            let compare = request.url?.path.contains("/compare/") ?? false
            switch request.httpMethod {
            case "DELETE": return (200, Data(#"{"ok":true}"#.utf8))
            case "GET": return (200, try Goldens.body(compare ? "item-share-compare" : "item-share-lap"))
            default: return (201, try Goldens.body(compare ? "item-share-compare-create" : "item-share-lap-create"))
            }
        }
        let lap = try await api.createItemShare(.lap(991))
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/laps/991/share")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(lap.kind == .lap)
        #expect(lap.url.absoluteString == "https://trackevolution.app/share/l/\(token)")

        let compare = try await api.createItemShare(.compare(a: 991, b: 12))
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/laps/991/compare/12/share")
        #expect(compare.kind == .compare)
        #expect(compare.url.absoluteString == "https://trackevolution.app/share/c/\(token)")

        #expect(try await api.itemShare(.lap(991))?.kind == .lap)
        #expect(seen.last?.httpMethod == "GET")
        #expect(seen.last?.url?.path == "/api/laps/991/share")
        #expect(try await api.itemShare(.compare(a: 12, b: 991))?.kind == .compare)
        #expect(seen.last?.url?.path == "/api/laps/12/compare/991/share")

        try await api.deleteItemShare(.lap(991))
        #expect(seen.last?.httpMethod == "DELETE")
        #expect(seen.last?.url?.path == "/api/laps/991/share")
        try await api.deleteItemShare(.compare(a: 991, b: 12))
        #expect(seen.last?.httpMethod == "DELETE")
        #expect(seen.last?.url?.path == "/api/laps/991/compare/12/share")
    }

    @Test func aTargetNamesItsKindAndKnowsATempId() {
        #expect(ItemShareTarget.event(3).kind == .event)
        #expect(ItemShareTarget.session(9).kind == .session)
        #expect(ItemShareTarget.lap(4).kind == .lap)
        #expect(ItemShareTarget.compare(a: 4, b: 5).kind == .compare)
        #expect(!ItemShareTarget.lap(4).hasTempId)
        #expect(ItemShareTarget.lap(-4).hasTempId)
        #expect(ItemShareTarget.compare(a: 4, b: -5).hasTempId)
        #expect(ItemShareTarget.compare(a: 4, b: 5) != ItemShareTarget.compare(a: 5, b: 4))
    }

    @Test func notSharedIsNilAndAnyOtherFailureThrows() async throws {
        let shared = client { _ in (200, try Goldens.body("item-share-event")) }
        #expect(try await shared.itemShare(.event(1))?.token == token)

        let none = client { _ in (404, Data(#"{"error":"not shared"}"#.utf8)) }
        #expect(try await none.itemShare(.event(1)) == nil)

        let broken = client { _ in (500, Data(#"{"error":"boom"}"#.utf8)) }
        await #expect(throws: APIError.server(status: 500, message: "boom")) {
            _ = try await broken.itemShare(.session(1))
        }
    }

    @Test func sharingIsLiveAndNeverQueued() async throws {
        for (method, path) in [
            ("POST", "/events/3/share"), ("DELETE", "/events/3/share"),
            ("POST", "/sessions/9/share"), ("DELETE", "/sessions/9/share"),
            // NS-56 — and `DELETE /laps/4` itself *is* queueable, so the share
            // under it is the one worth pinning.
            ("POST", "/laps/4/share"), ("DELETE", "/laps/4/share"),
            ("POST", "/laps/4/compare/5/share"), ("DELETE", "/laps/4/compare/5/share")
        ] {
            #expect(!OfflineStore.isQueueable(method: method, path: path), "\(method) \(path)")
        }

        // Offline: the write fails, in the transport's words, and nothing waits
        // to mint a link later — not even behind the owner's own queued writes.
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))
        _ = try await store.enqueue(
            method: "POST", path: "/events",
            body: try JSONSerialization.data(withJSONObject: ["track_name": "VIR", "start_date": "2026-05-01"])
        )
        let api = client(offline: store) { _ in throw Offline() }
        await #expect {
            _ = try await api.createItemShare(.event(3))
        } throws: { error in
            if case .transport = error as? APIError { return true }
            return false
        }
        await #expect(throws: (any Error).self) { try await api.deleteItemShare(.session(9)) }
        await #expect(throws: (any Error).self) { _ = try await api.createItemShare(.lap(4)) }
        await #expect(throws: (any Error).self) { try await api.deleteItemShare(.lap(4)) }
        await #expect(throws: (any Error).self) { _ = try await api.createItemShare(.compare(a: 4, b: 5)) }
        await #expect(throws: (any Error).self) { try await api.deleteItemShare(.compare(a: 4, b: 5)) }
        #expect(try await store.pendingCount() == 1, "only the owner's own event create is queued")
    }

    @Test func aStudentsClientCannotShare() async throws {
        let seen = Recorder()
        let student = client { request in
            seen.record(request)
            return (201, try Goldens.body("item-share-event-create"))
        }.scoped(toStudent: 7)
        await #expect(throws: APIError.readOnly) { _ = try await student.createItemShare(.event(3)) }
        await #expect(throws: APIError.readOnly) { try await student.deleteItemShare(.event(3)) }
        await #expect(throws: APIError.readOnly) { _ = try await student.createItemShare(.lap(4)) }
        await #expect(throws: APIError.readOnly) { try await student.deleteItemShare(.lap(4)) }
        await #expect(throws: APIError.readOnly) { _ = try await student.createItemShare(.compare(a: 4, b: 5)) }
        await #expect(throws: APIError.readOnly) { try await student.deleteItemShare(.compare(a: 4, b: 5)) }
        #expect(seen.last == nil, "nothing reached the transport")
    }

    @Test func theSharedItemIsReadWithNoTokenAndPastTheCache() async throws {
        let seen = Recorder()
        let store = try OfflineStore()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, try Goldens.body("shared-session"))
        }
        let item = try await api.sharedItem(kind: .session, token: token)
        #expect(seen.last?.url?.path == "/api/share/s/\(token)")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(item.kind == .session)
        #expect(item.sessionId == item.event.sessions.first?.id)
        #expect(try await store.cachedKeys().isEmpty, "a shared item must never be served from the cache")

        // Under a coach's scoped client it is still the public read, unprefixed.
        _ = try await api.scoped(toStudent: 7).sharedItem(kind: .event, token: token)
        #expect(seen.last?.url?.path == "/api/share/e/\(token)")
    }

    /// NS-56: a lap link is the shared-session shape cut down to the one lap.
    @Test func aSharedLapIsReadWithNoTokenAndPastTheCache() async throws {
        let seen = Recorder()
        let store = try OfflineStore()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, try Goldens.body("shared-lap"))
        }
        let item = try await api.sharedItem(kind: .lap, token: token)
        #expect(seen.last?.url?.path == "/api/share/l/\(token)")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(item.kind == .lap)
        #expect(item.event.sessions.count == 1)
        #expect(item.event.sessions.first?.id == item.sessionId)
        #expect(item.event.sessions.first?.laps.map(\.id) == [item.lapId].compactMap(\.self))
        #expect(try await store.cachedKeys().isEmpty, "a shared lap must never be served from the cache")
    }

    /// …and a comparison two of them, A against B.
    @Test func aSharedComparisonIsReadWithNoTokenAndPastTheCache() async throws {
        let seen = Recorder()
        let store = try OfflineStore()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, try Goldens.body("shared-compare"))
        }
        let compare = try await api.sharedCompare(token: token)
        #expect(seen.last?.url?.path == "/api/share/c/\(token)")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(compare.kind == .compare)
        for side in [compare.a, compare.b] {
            #expect(side.session?.id == side.sessionId)
            #expect(side.lap?.id == side.lapId)
            #expect(side.event.sessions.count == 1)
            #expect(side.session?.laps.count == 1)
        }
        #expect(try await store.cachedKeys().isEmpty, "a shared comparison must never be served from the cache")

        // Under a coach's scoped client it is still the public read, unprefixed.
        _ = try await api.scoped(toStudent: 7).sharedCompare(token: token)
        #expect(seen.last?.url?.path == "/api/share/c/\(token)")
    }

    /// An event or session link says so by carrying no lap.
    @Test func anEventOrSessionLinkNamesNoLap() throws {
        #expect(try Goldens.decode(SharedItem.self, "shared-event").lapId == nil)
        #expect(try Goldens.decode(SharedItem.self, "shared-session").lapId == nil)
        #expect(try Goldens.decode(SharedItem.self, "shared-lap").lapId != nil)
    }

    @Test func aSharedClipsUrlIsPublicAndUncached() async throws {
        let seen = Recorder()
        let store = try OfflineStore()
        let api = client(offline: store) { request in
            seen.record(request)
            return (200, Data(#"{"url":"https://example.test/clips/9.mp4?exp=1&sig=ab","expires_at":1000}"#.utf8))
        }
        let signed = try await api.sharedClipURL(kind: .event, token: token, clipId: 9)
        #expect(seen.last?.url?.path == "/api/share/e/\(token)/clips/9/url")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(signed.expiresAt == 1000)
        _ = try await api.sharedClipURL(kind: .lap, token: token, clipId: 9)
        #expect(seen.last?.url?.path == "/api/share/l/\(token)/clips/9/url")
        _ = try await api.sharedClipURL(kind: .compare, token: token, clipId: 9)
        #expect(seen.last?.url?.path == "/api/share/c/\(token)/clips/9/url")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(try await store.cachedKeys().isEmpty)
    }

    @Test func aRevokedLinkIsA404() async throws {
        let api = client { _ in (404, Data(#"{"error":"not found"}"#.utf8)) }
        await #expect(throws: APIError.server(status: 404, message: "not found")) {
            _ = try await api.sharedItem(kind: .event, token: token)
        }
    }

    @Test func theKindsPathLetters() {
        #expect(ItemShareKind(pathLetter: "e") == .event)
        #expect(ItemShareKind(pathLetter: "s") == .session)
        #expect(ItemShareKind(pathLetter: "l") == .lap)
        #expect(ItemShareKind(pathLetter: "c") == .compare)
        #expect(ItemShareKind(pathLetter: "x") == nil)
        #expect(ItemShareKind.isToken(token))
        #expect(!ItemShareKind.isToken(String(token.dropLast())))
        #expect(!ItemShareKind.isToken(String(token.dropLast()) + "/"))
    }
}
