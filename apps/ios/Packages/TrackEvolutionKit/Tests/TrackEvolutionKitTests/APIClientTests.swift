import Foundation
import Testing

@testable import TrackEvolutionKit

/// Request shaping and error mapping, against a stubbed transport. Mirrors what
/// `public/js/api.js` does — minus its offline routing, which is NS-21.
struct APIClientTests {
    private func client(
        tokens: any TokenProviding = StaticToken("tok_123"),
        baseURL: URL = URL(string: "https://example.test")!,
        respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> APIClient {
        APIClient(baseURL: baseURL, tokens: tokens, session: StubProtocol.session(respond))
    }

    @Test func getsSendTheBearerTokenToTheApiPath() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, try Goldens.body("me"))
        }
        _ = try await api.me()

        let request = try #require(seen.last)
        #expect(request.url?.absoluteString == "https://example.test/api/me")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_123")
        #expect(request.httpMethod == "GET")
    }

    @Test func trailingSlashesInTheServerUrlDoNotDoubleUp() async throws {
        let seen = Recorder()
        let api = client(baseURL: URL(string: "https://example.test/")!) { request in
            seen.record(request)
            return (200, try Goldens.body("tracks-list"))
        }
        _ = try await api.tracks()
        #expect(seen.last?.url?.absoluteString == "https://example.test/api/tracks")
    }

    @Test func theEventsListPassesTrackIdAsAQuery() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, try Goldens.body("events-list"))
        }
        _ = try await api.events(trackId: 7)
        #expect(seen.last?.url?.absoluteString == "https://example.test/api/events?track_id=7")
    }

    @Test func thePublicSharePageIsFetchedWithoutAToken() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, try Goldens.body("share-public"))
        }
        _ = try await api.sharedLogbook(slug: "abc")
        #expect(seen.last?.url?.absoluteString == "https://example.test/api/share/abc")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func aCreateReturnsTheNewIdAndPostsJson() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (201, try Goldens.body("event-create"))
        }
        var draft = EventDraft(startDate: "2026-08-01", trackName: "Summit Point")
        draft.days = 2
        let id = try await api.createEvent(draft)

        #expect(id == 1)
        let request = try #require(seen.last)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(seen.lastBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["start_date"] as? String == "2026-08-01")
        #expect(json["track_name"] as? String == "Summit Point")
        #expect(json["days"] as? Int == 2)
        #expect(json["club"] == nil, "absent fields are omitted, not nulled")
    }

    @Test func a401BecomesTheUnauthorizedCaseCarryingTheServerMessage() async throws {
        let api = client { _ in (401, try Goldens.body("error-401")) }
        await #expect(throws: APIError.unauthorized("unauthorized")) {
            try await api.me()
        }
    }

    @Test func otherFailuresKeepTheirStatusAndMessage() async throws {
        let api = client { _ in (400, try Goldens.body("error-400")) }
        do {
            _ = try await api.createEvent(EventDraft(startDate: ""))
            Issue.record("expected a 400")
        } catch let error as APIError {
            #expect(error == .server(status: 400, message: "start_date required"))
            #expect(error.message == "start_date required")
            #expect(!error.isUnauthorized)
        }
    }

    @Test func anEmptyErrorBodyFallsBackToAGenericMessage() {
        let error = APIError.from(status: 500, body: Data("<html>oops</html>".utf8))
        #expect(error == .server(status: 500, message: "Request failed (500)"))
    }

    @Test func aTransportFailureIsDistinctFromAServerError() async throws {
        let api = client { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await api.me()
            Issue.record("expected a transport failure")
        } catch let error as APIError {
            #expect(error.status == nil, "no status: the server never answered")
            if case .transport = error {} else { Issue.record("expected .transport, got \(error)") }
        }
    }

    @Test func aBodyThatDoesNotMatchTheModelIsADecodingError() async throws {
        let api = client { _ in (200, Data(#"{"user":{"id":"one"}}"#.utf8)) }
        do {
            _ = try await api.me()
            Issue.record("expected a decoding failure")
        } catch let error as APIError {
            if case .decoding = error {} else { Issue.record("expected .decoding, got \(error)") }
        }
    }

    // MARK: - Update bodies

    @Test func anUnchangedPatchFieldIsOmittedAndAnExplicitNullClears() throws {
        var patch = EventPatch()
        patch.notes = .set("Rained after lunch")
        patch.club = .set(nil)

        let encoded = try JSONEncoder().encode(patch)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(json["notes"] as? String == "Rained after lunch")
        #expect(json["club"] is NSNull, "an explicit null is what clears a column")
        #expect(json.keys.sorted() == ["club", "notes"], "untouched fields must not be sent")
    }

    @Test func aSessionPatchAlwaysSendsBothColumns() throws {
        let encoded = try JSONEncoder().encode(SessionPatch(label: "Session 4"))
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        // The route writes `SET label = ?, notes = ?` unconditionally.
        #expect(json.keys.sorted() == ["label", "notes"])
        #expect(json["notes"] is NSNull)
    }

    @Test func aTrackRenameNeverSendsANullName() throws {
        var patch = TrackPatch()
        patch.goalMs = .set(120_000)
        let encoded = try JSONEncoder().encode(patch)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(json.keys.sorted() == ["goal_ms"])
        #expect(json["goal_ms"] as? Int == 120_000)
    }

    @Test func recordedLapsAreSentAsMilliseconds() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (201, try Goldens.body("session-create"))
        }
        _ = try await api.createSession(
            eventId: 3,
            SessionDraft(label: "Session 1", laps: [121_500, 120_900])
        )
        #expect(seen.last?.url?.absoluteString == "https://example.test/api/events/3/sessions")
        let body = try #require(seen.lastBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["laps"] as? [Int] == [121_500, 120_900])
    }
}

/// Captures the requests the client made. `URLProtocol` strips `httpBody` from
/// the request it hands back, so the body is read from the stream instead.
final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [(URLRequest, Data?)] = []

    func record(_ request: URLRequest) {
        let body = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open()
            defer { stream.close() }
            var data = Data()
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: size)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        }
        lock.withLock { requests.append((request, body)) }
    }

    var last: URLRequest? { lock.withLock { requests.last?.0 } }
    var lastBody: Data? { lock.withLock { requests.last?.1 } }
}

/// A `URLProtocol` that answers from a closure, so client tests never touch the
/// network.
///
/// `URLProtocol` subclasses are registered process-wide, so a single shared
/// handler would let concurrent tests answer each other's requests. Each session
/// therefore gets an id, carried in a request header, and its own handler —
/// which keeps the suites running in parallel.
final class StubProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data)

    static let headerName = "X-Stub-Session"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]
    nonisolated(unsafe) private static var nextID = 0

    /// A `URLSession` wired to `respond`, tagged so only its own requests reach it.
    static func session(_ respond: @escaping Handler) -> URLSession {
        let id = lock.withLock {
            nextID += 1
            let id = "stub-\(nextID)"
            handlers[id] = respond
            return id
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        config.httpAdditionalHeaders = [headerName: id]
        return URLSession(configuration: config)
    }

    private static func handler(for request: URLRequest) -> Handler? {
        guard let id = request.value(forHTTPHeaderField: headerName) else { return nil }
        return lock.withLock { handlers[id] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let respond = Self.handler(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        do {
            let (status, data) = try respond(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
