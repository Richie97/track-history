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

    /// The real id a row created offline was given, once its create flushed. Screens
    /// parked on a temp id follow it here rather than 404ing against the server.
    public func resolveTempId(_ id: Int) async -> Int? {
        guard let offline else { return nil }
        return try? await offline.resolveId(id)
    }

    /// Pull every event's detail into the cache, so an event you never opened still
    /// reads in the paddock. The counterpart to `public/js/prefetch.js`, and the
    /// difference between "offline works" and "offline works for the two events you
    /// happened to tap": signal is gone *before* you need the data.
    ///
    /// Cheap on repeat visits — a row whose cached copy is already at the server's
    /// `updated_at` (migration 0011, trigger-maintained) is skipped without a
    /// request. Failures are ignored: this is a warm-up, not a load.
    public func warmCache(for events: [Event]) async {
        guard let offline else { return }
        for row in events where !OfflineStore.isTemp(row.id) {
            if let cached = try? await offline.cachedGet("/events/\(row.id)"),
               let detail = try? decoder.decode(EventDetail.self, from: cached),
               detail.event.updatedAt == row.updatedAt {
                continue
            }
            _ = try? await event(id: row.id)
        }
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
    public func vehicles() async throws -> [Vehicle] {
        try await get("/vehicles", as: [Vehicle].self)
    }

    /// The whole garage in one payload: every vehicle with its accrued track
    /// hours and its parts, each carrying measurements and a server-computed wear
    /// estimate. One round trip backs both the garage page and the dashboard's
    /// maintenance strip.
    ///
    /// **Reads cache, writes don't queue.** This GET falls back to the offline
    /// cache like any other, so the garage is readable in the paddock — but every
    /// mutation below needs a live server and fails offline with its normal
    /// error, because their effects (defaulted expected life, the retire-and-
    /// replace of a refresh, the recomputed wear on every other part) can't be
    /// mirrored locally. See the queueable whitelist in `OfflineStore`.
    public func garage() async throws -> [GarageVehicle] {
        try await get("/garage", as: [GarageVehicle].self)
    }

    public func createVehicle(_ draft: VehicleDraft) async throws -> Vehicle {
        try await send("POST", "/vehicles", body: draft, as: Vehicle.self)
    }

    public func updateVehicle(id: Int, _ patch: VehiclePatch) async throws {
        _ = try await send("PUT", "/vehicles/\(id)", body: patch, as: OKResponse.self)
    }

    /// Deleting a vehicle takes its parts and measurements with it. Events keep
    /// their free-text car name and simply stop being linked.
    public func deleteVehicle(id: Int) async throws {
        _ = try await send("DELETE", "/vehicles/\(id)", body: NoBody?.none, as: OKResponse.self)
    }

    public func createPart(vehicleId: Int, _ draft: PartDraft) async throws -> Int {
        try await send("POST", "/vehicles/\(vehicleId)/parts", body: draft, as: CreatedID.self).id
    }

    public func updatePart(id: Int, _ patch: PartPatch) async throws {
        _ = try await send("PUT", "/parts/\(id)", body: patch, as: OKResponse.self)
    }

    /// Deletes the part **and its measurements**. Retiring keeps the history;
    /// this doesn't.
    public func deletePart(id: Int) async throws {
        _ = try await send("DELETE", "/parts/\(id)", body: NoBody?.none, as: OKResponse.self)
    }

    /// One-tap replacement: retires this part as of the swap date and installs a
    /// same-spec successor, so accrued hours reset without re-entering the part.
    public func refreshPart(id: Int, _ draft: PartRefreshDraft = PartRefreshDraft()) async throws -> PartRefresh {
        try await send("POST", "/parts/\(id)/refresh", body: draft, as: PartRefresh.self)
    }

    public func addMeasurement(partId: Int, _ draft: MeasurementDraft) async throws -> Int {
        try await send("POST", "/parts/\(partId)/measurements", body: draft, as: CreatedID.self).id
    }

    public func deleteMeasurement(partId: Int, id: Int) async throws {
        _ = try await send(
            "DELETE", "/parts/\(partId)/measurements/\(id)", body: NoBody?.none, as: OKResponse.self
        )
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
