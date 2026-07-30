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
    /// The offline layer (NS-21). When present, every `/api` request routes through
    /// it: reads are network-first with a cache fallback, and queueable writes are
    /// stored and replayed. When nil the client talks straight to the server, which
    /// is what the contract tests want.
    private let offline: OfflineStore?

    public init(
        baseURL: URL = TrackEvolutionKit.defaultBaseURL,
        tokens: any TokenProviding = NoToken(),
        session: URLSession = .shared,
        offline: OfflineStore? = nil
    ) {
        self.baseURL = Self.normalize(baseURL)
        self.tokens = tokens
        self.session = session
        self.offline = offline
    }

    /// Replay anything queued. Safe to call often — it no-ops on an empty queue.
    @discardableResult
    public func flushQueue() async -> OfflineStore.SyncStatus? {
        guard let offline, await offline.pendingCount() > 0 else { return nil }
        return try? await offline.flush { [weak self] method, path, body in
            guard let self else { throw APIError.transport("client went away") }
            let response = try await self.rawSend(
                method, path, query: nil, body: body, authenticated: true, prefix: "/api"
            )
            return (status: response.status, body: response.data)
        }
    }

    public func syncStatus() async -> OfflineStore.SyncStatus? {
        await offline?.syncStatus()
    }

    /// Acknowledge dropped writes, so the banner stops reporting them.
    public func clearSyncFailures() async {
        await offline?.clearFailed()
    }

    /// Sign-out: drop the cached logbook and any unsent writes.
    public func clearOffline() async {
        try? await offline?.clear()
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

    /// `/auth/*` rather than `/api/*` — the sign-in flow (NS-08) lives outside the
    /// API surface and is unauthenticated until the token exists.
    func authGet<Response: Decodable>(_ path: String, as type: Response.Type) async throws -> Response {
        try await send("GET", path, body: NoBody?.none, authenticated: false, prefix: "/auth", as: type)
    }

    func authPost<Body: Encodable, Response: Decodable>(
        _ path: String, body: Body, as type: Response.Type
    ) async throws -> Response {
        // Authenticated: /auth/logout needs the bearer token; /auth/exchange
        // ignores it harmlessly (it has no token yet).
        try await send("POST", path, body: body, authenticated: true, prefix: "/auth", as: type)
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem]? = nil,
        body: Body?,
        authenticated: Bool = true,
        prefix: String = "/api",
        as type: Response.Type
    ) async throws -> Response {
        let encodedBody = try body.map { try encoder.encode($0) }
        let data = try await route(
            method, path, query: query, body: encodedBody,
            authenticated: authenticated, prefix: prefix
        )
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding("\(path): \(error)")
        }
    }

    /// One request, with the offline layer in the middle when there is one.
    /// Mirrors `api()` in `public/js/api.js`.
    private func route(
        _ method: String,
        _ path: String,
        query: [URLQueryItem]?,
        body: Data?,
        authenticated: Bool,
        prefix: String
    ) async throws -> Data {
        // Auth and the public share endpoint never touch the cache.
        guard let offline, prefix == "/api" else {
            let response = try await rawSend(
                method, path, query: query, body: body, authenticated: authenticated, prefix: prefix
            )
            guard (200..<300).contains(response.status) else {
                throw APIError.from(status: response.status, body: response.data)
            }
            return response.data
        }

        let cacheKey = Self.cacheKey(path: path, query: query)
        if method == "GET" {
            // A row created offline exists only in the cache: the server would 404
            // its temp id.
            if OfflineStore.isTempPath(cacheKey), let cached = try? await offline.cachedGet(cacheKey) {
                return cached
            }
            let response: (status: Int, data: Data)
            do {
                response = try await rawSend(
                    method, path, query: query, body: body, authenticated: authenticated, prefix: prefix
                )
            } catch {
                // Network gone: a cached copy is better than an error. An `APIError`
                // from the server is not a network failure and must not fall back.
                await offline.noteOffline()
                if let cached = try? await offline.cachedGet(cacheKey) { return cached }
                throw error
            }
            await offline.noteOnline()
            guard (200..<300).contains(response.status) else {
                throw APIError.from(status: response.status, body: response.data)
            }
            try? await offline.cachePut(cacheKey, body: response.data)
            if await offline.pendingCount() > 0 {
                // Fresh server state predates the queued writes — re-patch it so they
                // stay visible until the flush lands.
                try? await offline.reapplyQueue()
                if let patched = try? await offline.cachedGet(cacheKey) { return patched }
            }
            return response.data
        }

        // While writes are queued, a later queueable write has to queue too: sending
        // it directly would reorder it ahead of the queue.
        let queueable = OfflineStore.isQueueable(method: method, path: path)
        if queueable, await offline.pendingCount() > 0 {
            let result = try await offline.enqueue(method: method, path: path, body: body)
            Task { await flushQueue() }
            return Self.synthetic(result)
        }

        let response: (status: Int, data: Data)
        do {
            response = try await rawSend(
                method, path, query: query, body: body, authenticated: authenticated, prefix: prefix
            )
        } catch {
            await offline.noteOffline()
            guard queueable else { throw error }
            return Self.synthetic(try await offline.enqueue(method: method, path: path, body: body))
        }
        await offline.noteOnline()
        guard (200..<300).contains(response.status) else {
            throw APIError.from(status: response.status, body: response.data)
        }
        return response.data
    }

    /// The response a queued write stands in for, in the server's own shape.
    private static func synthetic(_ result: OfflineStore.QueuedResult) -> Data {
        switch result {
        case .created(let id): Data(#"{"id":\#(id)}"#.utf8)
        case .ok: Data(#"{"ok":true}"#.utf8)
        }
    }

    /// The cache is keyed by the path the web app uses, query string included, so
    /// `/events?track_id=7` is a distinct entry the store knows how to derive.
    private static func cacheKey(path: String, query: [URLQueryItem]?) -> String {
        guard let query, !query.isEmpty else { return path }
        let encoded = query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
        return "\(path)?\(encoded)"
    }

    /// The transport, with no offline behavior and no error mapping: throws only
    /// when the network failed.
    private func rawSend(
        _ method: String,
        _ path: String,
        query: [URLQueryItem]?,
        body: Data?,
        authenticated: Bool,
        prefix: String
    ) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: try url(for: path, query: query, prefix: prefix))
        request.httpMethod = method
        if let body {
            request.httpBody = body
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
        return (http.statusCode, data)
    }

    private func url(for path: String, query: [URLQueryItem]?, prefix: String) throws -> URL {
        guard var components = URLComponents(string: baseURL.absoluteString + prefix + path) else {
            throw APIError.transport("Invalid server URL")
        }
        if let query, !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw APIError.transport("Invalid server URL")
        }
        return url
    }
}
