import Foundation

/// The HTTP client for the Worker's `/api` surface. One method per endpoint,
/// typed to the models; `public/js/api.js` is the reference for request shaping
/// and error handling.
///
/// An `actor` because the base URL is mutable at runtime (the server-settings
/// panel, for pointing a dev build at `wrangler dev`) and every screen shares
/// one instance.
///
/// Deliberately not in scope here: caching, the offline write queue (NS-21), and
/// obtaining a token (NS-08 — this layer only asks `TokenProviding` for one).
public actor APIClient {
    private var baseURL: URL
    private let tokens: any TokenProviding
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(
        baseURL: URL = TrackEvolutionKit.defaultBaseURL,
        tokens: any TokenProviding = NoToken(),
        session: URLSession = .shared
    ) {
        self.baseURL = Self.normalize(baseURL)
        self.tokens = tokens
        self.session = session
    }

    /// Trailing slashes would double up when paths are appended.
    private static func normalize(_ url: URL) -> URL {
        guard url.absoluteString.hasSuffix("/") else { return url }
        return URL(string: String(url.absoluteString.dropLast())) ?? url
    }

    public var serverURL: URL { baseURL }

    /// Point the client at another instance — the hosted app, a self-hosted
    /// deploy, or `wrangler dev` on the LAN.
    public func setServerURL(_ url: URL) {
        baseURL = Self.normalize(url)
    }

    // MARK: - Account

    public func me() async throws -> Me {
        try await get("/me", as: Me.self)
    }

    // MARK: - Events

    public func events(trackId: Int? = nil) async throws -> [Event] {
        let query = trackId.map { [URLQueryItem(name: "track_id", value: String($0))] }
        return try await get("/events", query: query, as: [Event].self)
    }

    public func event(id: Int) async throws -> EventDetail {
        try await get("/events/\(id)", as: EventDetail.self)
    }

    /// Returns the new event's id.
    @discardableResult
    public func createEvent(_ draft: EventDraft) async throws -> Int {
        try await send("POST", "/events", body: draft, as: CreatedID.self).id
    }

    public func updateEvent(id: Int, _ patch: EventPatch) async throws {
        _ = try await send("PUT", "/events/\(id)", body: patch, as: OKResponse.self)
    }

    public func deleteEvent(id: Int) async throws {
        _ = try await send("DELETE", "/events/\(id)", body: NoBody?.none, as: OKResponse.self)
    }

    // MARK: - Sessions and laps

    /// Returns the new session's id. Laps, trace and channels can all ride along
    /// in the same request — this is what the recorder saves.
    @discardableResult
    public func createSession(eventId: Int, _ draft: SessionDraft) async throws -> Int {
        try await send("POST", "/events/\(eventId)/sessions", body: draft, as: CreatedID.self).id
    }

    public func updateSession(id: Int, _ patch: SessionPatch) async throws {
        _ = try await send("PUT", "/sessions/\(id)", body: patch, as: OKResponse.self)
    }

    public func deleteSession(id: Int) async throws {
        _ = try await send("DELETE", "/sessions/\(id)", body: NoBody?.none, as: OKResponse.self)
    }

    /// Append laps to an existing session. Lap numbers continue from the last
    /// one stored.
    public func appendLaps(sessionId: Int, laps: [Int]) async throws {
        _ = try await send(
            "POST", "/sessions/\(sessionId)/laps",
            body: LapsBody(laps: laps), as: OKResponse.self
        )
    }

    public func deleteLap(id: Int) async throws {
        _ = try await send("DELETE", "/laps/\(id)", body: NoBody?.none, as: OKResponse.self)
    }

    private struct LapsBody: Encodable {
        var laps: [Int]
    }

    /// Stand-in body type for requests that don't have one.
    private struct NoBody: Encodable {}

    // MARK: - Tracks

    public func tracks() async throws -> [Track] {
        try await get("/tracks", as: [Track].self)
    }

    /// The seeded canonical catalog behind the event form's name suggestions.
    public func catalog() async throws -> [CatalogTrack] {
        try await get("/catalog", as: [CatalogTrack].self)
    }

    public func updateTrack(id: Int, _ patch: TrackPatch) async throws {
        _ = try await send("PUT", "/tracks/\(id)", body: patch, as: OKResponse.self)
    }

    public func deleteTrack(id: Int) async throws {
        _ = try await send("DELETE", "/tracks/\(id)", body: NoBody?.none, as: OKResponse.self)
    }

    // MARK: - Garage

    /// The user's vehicles — enough to pre-fill an event's car from the default.
    /// Wear tracking and the setup notebook stay web-only for now (see
    /// `docs/specs/native/README.md`), so there are no methods for those.
    public func vehicles() async throws -> [Vehicle] {
        try await get("/vehicles", as: [Vehicle].self)
    }

    // MARK: - Sharing

    public func shareSlug(_ slug: String) async throws -> String {
        try await send("PUT", "/share", body: SlugBody(slug: slug), as: ShareSlug.self).slug
    }

    public func clearShare() async throws {
        _ = try await send("DELETE", "/share", body: NoBody?.none, as: OKResponse.self)
    }

    /// The public share page. Unauthenticated on purpose — no token is sent.
    public func sharedLogbook(slug: String) async throws -> ShareData {
        try await get("/share/\(slug)", authenticated: false, as: ShareData.self)
    }

    private struct SlugBody: Encodable {
        var slug: String
    }

    // MARK: - Plumbing

    private func get<Response: Decodable>(
        _ path: String,
        query: [URLQueryItem]? = nil,
        authenticated: Bool = true,
        as type: Response.Type
    ) async throws -> Response {
        try await send(
            "GET", path, query: query, body: NoBody?.none,
            authenticated: authenticated, as: type
        )
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem]? = nil,
        body: Body?,
        authenticated: Bool = true,
        as type: Response.Type
    ) async throws -> Response {
        var request = URLRequest(url: try url(for: path, query: query))
        request.httpMethod = method
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated, let token = await tokens.currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Malformed response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.from(status: http.statusCode, body: data)
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding("\(path): \(error)")
        }
    }

    private func url(for path: String, query: [URLQueryItem]?) throws -> URL {
        guard var components = URLComponents(string: baseURL.absoluteString + "/api" + path) else {
            throw APIError.transport("Invalid server URL")
        }
        if let query, !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw APIError.transport("Invalid server URL")
        }
        return url
    }
}
