import Foundation
import GRDB

/// The offline layer: a durable cache of GET `/api` responses plus a persistent
/// queue of writes made while offline, replayed in order once the server is
/// reachable. A port of `public/js/offline.js`.
///
/// This is not a nice-to-have. A paddock has no usable signal, and the app is used
/// *there*.
///
/// One SQLite database holds both the cache and the queue, which is the win over
/// the web version: a queued write and the optimistic cache patch that makes it
/// visible commit in a **single transaction**, so the UI can never show a change
/// whose queue entry didn't survive, or vice versa. IndexedDB can't do that across
/// object stores.
///
/// ## Temp ids: negative integers, not `tmp-N`
///
/// The web app gives an offline-created row the string id `tmp-3`, because JS
/// doesn't care. Here `Event.id` is an `Int`, pinned by the golden API contract, so
/// a temp row gets a **negative** id instead and `isTemp(_:)` is `id < 0`. Real
/// server ids are always positive, the values never reach the server (they're
/// substituted on replay, and an unresolvable one is dropped), and the two clients
/// never share this storage — so the representation differs while the behavior
/// doesn't. A `String` id would have meant an untyped id everywhere else.
public actor OfflineStore {
    /// How a queued write is sent when the queue flushes. Returns the HTTP status
    /// and body; throws only when the network failed.
    public typealias Sender = @Sendable (_ method: String, _ path: String, _ body: Data?) async throws -> (
        status: Int, body: Data
    )

    /// What the sync banner needs to know.
    public struct SyncStatus: Hashable, Sendable {
        /// The last request failed at the network level.
        public var offline = false
        /// Writes waiting to be replayed.
        public var pending = 0
        /// Writes the server rejected, or that kept failing. Surfaced once, then
        /// cleared by the UI — never retried forever.
        public var failed = 0
    }

    /// One queued mutation.
    public struct QueuedWrite: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
        public static let databaseTableName = "queued_write"

        public var qid: Int64?
        public var method: String
        public var path: String
        public var body: Data?
        /// The negative id handed out for a create, so later writes can reference a
        /// row the server hasn't seen yet.
        public var tempId: Int?
        /// 5xx retries, capped.
        public var attempts: Int

        public enum Columns: String, ColumnExpression {
            case qid, method, path, body, tempId, attempts
        }
    }

    private let dbQueue: DatabaseQueue
    private var status = SyncStatus()

    // MARK: - Lifecycle

    /// A store at `url`, or in memory when nil (tests).
    public init(url: URL? = nil) throws {
        if let url {
            dbQueue = try DatabaseQueue(path: url.path)
        } else {
            dbQueue = try DatabaseQueue()
        }
        try Self.migrator.migrate(dbQueue)
        // **Load-bearing.** `status.pending` is in-memory, and everything that moves
        // the queue is gated on it: `flushQueue` returns early at zero, the sync
        // banner says nothing, and a fresh queueable write is sent *directly* instead
        // of queueing behind the ones already waiting.
        //
        // Without this line all three are wrong on every launch, because the queue
        // outlives the process and the count didn't. The symptom is the worst one this
        // layer has: writes made in the paddock sit in SQLite forever, the app stops
        // mentioning them, and they arrive at the server — if ever — out of order.
        //
        // Written to the property directly rather than through `refreshPending()`: an
        // actor's `init` is nonisolated, so it can assign stored state but not call
        // isolated methods.
        status.pending = try dbQueue.read { try QueuedWrite.fetchCount($0) }
    }

    private static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            // Raw JSON bodies, keyed by request path: the cache is a response
            // cache, not a model store, so a shape this layer doesn't understand
            // still round-trips.
            try db.create(table: "cached_response") { t in
                t.primaryKey("path", .text)
                t.column("body", .blob).notNull()
            }
            try db.create(table: "queued_write") { t in
                t.autoIncrementedPrimaryKey("qid")
                t.column("method", .text).notNull()
                t.column("path", .text).notNull()
                t.column("body", .blob)
                t.column("tempId", .integer)
                t.column("attempts", .integer).notNull().defaults(to: 0)
            }
            try db.create(table: "kv") { t in
                t.primaryKey("key", .text)
                t.column("value", .blob).notNull()
            }
        }
        return migrator
    }

    /// Sign-out: a shared device must not retain the previous user's logbook or
    /// their unsent writes.
    public func clear() throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM cached_response")
            try db.execute(sql: "DELETE FROM queued_write")
            try db.execute(sql: "DELETE FROM kv")
        }
        status = SyncStatus()
    }

    // MARK: - Status

    public func syncStatus() -> SyncStatus { status }
    public func pendingCount() -> Int { status.pending }
    public func noteOffline() { status.offline = true }
    public func noteOnline() { status.offline = false }
    public func clearFailed() { status.failed = 0 }

    private func refreshPending() throws {
        status.pending = try dbQueue.read { try QueuedWrite.fetchCount($0) }
    }

    // MARK: - Temp ids

    public static func isTemp(_ id: Int) -> Bool { id < 0 }

    /// Does this path reference a row the server has never seen?
    public static func isTempPath(_ path: String) -> Bool {
        path.split(whereSeparator: { $0 == "/" || $0 == "?" })
            .compactMap { Int($0) }
            .contains { isTemp($0) }
    }

    /// The real id a temp id became, once its create flushed.
    public func resolveId(_ tempId: Int) throws -> Int? {
        try idMap()[String(tempId)]
    }

    private func idMap() throws -> [String: Int] {
        try dbQueue.read { db in
            guard let data = try Data.fetchOne(db, sql: "SELECT value FROM kv WHERE key = 'idMap'") else {
                return [:]
            }
            return (try? JSONDecoder().decode([String: Int].self, from: data)) ?? [:]
        }
    }

    private func nextTempId(_ db: Database) throws -> Int {
        let current: Int = try {
            guard let data = try Data.fetchOne(db, sql: "SELECT value FROM kv WHERE key = 'tempSeq'") else {
                return 0
            }
            return (try? JSONDecoder().decode(Int.self, from: data)) ?? 0
        }()
        let next = current + 1
        try db.execute(
            sql: "INSERT OR REPLACE INTO kv (key, value) VALUES ('tempSeq', ?)",
            arguments: [try JSONEncoder().encode(next)]
        )
        return -next
    }

    /// Swap temp segments for their real ids.
    private func substituteIds(_ path: String, using map: [String: Int]) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .map { segment in
                guard let id = Int(segment), Self.isTemp(id), let real = map[String(id)] else {
                    return String(segment)
                }
                return String(real)
            }
            .joined(separator: "/")
    }

    // MARK: - Response cache

    public func cachePut(_ path: String, body: Data) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "INSERT OR REPLACE INTO cached_response (path, body) VALUES (?, ?)",
                arguments: [path, body]
            )
        }
    }

    public func removeCached(_ path: String) throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM cached_response WHERE path = ?", arguments: [path])
        }
    }

    public func cachedKeys() throws -> [String] {
        try dbQueue.read { try String.fetchAll($0, sql: "SELECT path FROM cached_response ORDER BY path") }
    }

    /// A cached response, with one derivation: a track-filtered events list is
    /// computed from the cached full list, so a track page works offline even if it
    /// was never visited.
    public func cachedGet(_ path: String) throws -> Data? {
        try dbQueue.read { db in try Self.cachedGet(path, db) }
    }

    private static func cachedGet(_ path: String, _ db: Database) throws -> Data? {
        if let hit = try Data.fetchOne(db, sql: "SELECT body FROM cached_response WHERE path = ?", arguments: [path]) {
            return hit
        }
        guard let trackId = trackFilter(in: path),
              let all = try Data.fetchOne(
                  db, sql: "SELECT body FROM cached_response WHERE path = '/events'"
              ),
              let events = try? JSONDecoder().decode([Event].self, from: all)
        else { return nil }
        return try? JSONEncoder().encode(events.filter { String($0.trackId) == trackId })
    }

    /// `/events?track_id=7` → `"7"`.
    private static func trackFilter(in path: String) -> String? {
        guard path.hasPrefix("/events?track_id=") else { return nil }
        let value = path.dropFirst("/events?track_id=".count)
        guard !value.contains("&"), !value.isEmpty else { return nil }
        return String(value).removingPercentEncoding ?? String(value)
    }

    // MARK: - The queueable whitelist

    /// Only mutations whose effect can be mirrored locally may queue. Everything
    /// else fails offline with its normal error.
    ///
    /// Vehicle and garage-part writes are **deliberately** absent: they need a live
    /// server. Don't "improve" this.
    /// A path shape: literal segments, `*` for any id, `#` for digits. Segment
    /// matching rather than regex, because `Regex` isn't `Sendable` and these paths
    /// are all fixed-shape anyway.
    private struct Queueable: Sendable {
        let method: String
        let segments: [String]
        let creates: Bool

        init(_ method: String, _ path: String, creates: Bool = false) {
            self.method = method
            self.segments = path.split(separator: "/").map(String.init)
            self.creates = creates
        }

        func matches(method: String, segments path: [String]) -> Bool {
            guard method == self.method, path.count == segments.count else { return false }
            return zip(segments, path).allSatisfy { pattern, actual in
                switch pattern {
                case "*": !actual.isEmpty
                case "#": !actual.isEmpty && actual.allSatisfy(\.isNumber)
                default: pattern == actual
                }
            }
        }
    }

    private static let queueable: [Queueable] = [
        Queueable("POST", "/events", creates: true),
        Queueable("PUT", "/events/*"),
        Queueable("DELETE", "/events/*"),
        Queueable("POST", "/events/*/sessions", creates: true),
        Queueable("PUT", "/events/*/setups/#"),
        Queueable("DELETE", "/events/*/setups/#"),
        Queueable("PUT", "/sessions/*"),
        Queueable("DELETE", "/sessions/*"),
        Queueable("POST", "/sessions/*/laps"),
        Queueable("DELETE", "/laps/*"),
        Queueable("PUT", "/tracks/*")
    ]

    public static func isQueueable(method: String, path: String) -> Bool {
        rule(method: method, path: path) != nil
    }

    private static func rule(method: String, path: String) -> Queueable? {
        let segments = path.split(separator: "/").map(String.init)
        return queueable.first { $0.matches(method: method, segments: segments) }
    }

    // MARK: - Enqueue

    /// What the caller gets back instead of the server's answer.
    public enum QueuedResult: Hashable, Sendable {
        /// A create: the temp id the row will have until it flushes.
        case created(id: Int)
        case ok
    }

    /// Queue a mutation, patch the cache so the UI shows it immediately, and hand
    /// back the synthetic response — all in one transaction.
    public func enqueue(method: String, path: String, body: Data?) throws -> QueuedResult {
        let result = try dbQueue.write { db -> QueuedResult in
            // Deleting a row that only exists as a queued create cancels that
            // create — and everything created under it — rather than queueing a
            // DELETE the server could never resolve.
            if method == "DELETE",
               let target = path.split(separator: "/").last.flatMap({ Int($0) }),
               Self.isTemp(target) {
                try Self.dropQueuedFor(target, db)
                try Self.applyLocal(.init(qid: nil, method: method, path: path, body: body, tempId: nil, attempts: 0), db)
                return .ok
            }

            let spec = Self.rule(method: method, path: path)
            let tempId = spec?.creates == true ? try nextTempId(db) : nil
            var item = QueuedWrite(
                qid: nil, method: method, path: path, body: body, tempId: tempId, attempts: 0
            )
            try item.insert(db)
            item.qid = db.lastInsertedRowID
            try Self.applyLocal(item, db)
            return tempId.map { .created(id: $0) } ?? .ok
        }
        try refreshPending()
        return result
    }

    /// Re-patch the caches from the queue, after a fresh server response landed
    /// while writes are still pending — so queued changes stay visible.
    /// `applyLocal` is idempotent: patched rows carry temp ids and are deduped.
    public func reapplyQueue() throws {
        try dbQueue.write { db in
            for item in try QueuedWrite.order(QueuedWrite.Columns.qid).fetchAll(db) {
                try Self.applyLocal(item, db)
            }
        }
    }

    /// Cancel a queued create and everything queued underneath it, walking
    /// transitively: sessions of a temp event, laps of a temp session.
    private static func dropQueuedFor(_ tempId: Int, _ db: Database) throws {
        var targets: Set<Int> = [tempId]
        var grew = true
        while grew {
            grew = false
            for item in try QueuedWrite.fetchAll(db) {
                let references = item.path.split(separator: "/").compactMap { Int($0) }.contains { targets.contains($0) }
                if let itemTemp = item.tempId, references || targets.contains(itemTemp), !targets.contains(itemTemp) {
                    targets.insert(itemTemp)
                    grew = true
                }
            }
        }
        for item in try QueuedWrite.fetchAll(db) {
            let references = item.path.split(separator: "/").compactMap { Int($0) }.contains { targets.contains($0) }
            if let itemTemp = item.tempId, targets.contains(itemTemp) {
                try item.delete(db)
            } else if references {
                try item.delete(db)
            }
        }
    }

    // MARK: - Flush

    /// Replay the queue in order. Stops — keeping the remainder — on a network
    /// failure. Drops what the server rejects (4xx) or what keeps failing (5xx),
    /// counting them so the UI can say so. Conflict policy is last-write-wins;
    /// there is no merge and no conflict UI, deliberately.
    @discardableResult
    public func flush(using send: Sender) async throws -> SyncStatus {
        var map = try idMap()
        let items = try await dbQueue.read { try QueuedWrite.order(QueuedWrite.Columns.qid).fetchAll($0) }

        for var item in items {
            let path = substituteIds(item.path, using: map)
            if Self.isTempPath(path) {
                // Depends on a create that failed or was cancelled: unresolvable.
                try delete(item)
                status.failed += 1
                continue
            }

            let response: (status: Int, body: Data)
            do {
                response = try await send(item.method, path, item.body)
            } catch {
                status.offline = true
                break
            }
            status.offline = false

            if (200..<300).contains(response.status) {
                if let tempId = item.tempId,
                   let created = try? JSONDecoder().decode(CreatedID.self, from: response.body) {
                    map[String(tempId)] = created.id
                    try persist(idMap: map)
                }
                try delete(item)
            } else if response.status >= 500 {
                item.attempts += 1
                if item.attempts >= 5 {
                    try delete(item)
                    status.failed += 1
                } else {
                    try update(item)
                    // Server trouble rather than a bad request: leave the rest for
                    // the next kick.
                    break
                }
            } else {
                try delete(item)
                status.failed += 1
            }
        }
        try refreshPending()
        return status
    }

    private func delete(_ item: QueuedWrite) throws {
        guard let qid = item.qid else { return }
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM queued_write WHERE qid = ?", arguments: [qid])
        }
    }

    private func update(_ item: QueuedWrite) throws {
        try dbQueue.write { db in try item.update(db) }
    }

    private func persist(idMap map: [String: Int]) throws {
        let data = try JSONEncoder().encode(map)
        try dbQueue.write { db in
            try db.execute(
                sql: "INSERT OR REPLACE INTO kv (key, value) VALUES ('idMap', ?)", arguments: [data]
            )
        }
    }

    /// Queue contents, for tests and for the sync banner's detail.
    public func queuedWrites() throws -> [QueuedWrite] {
        try dbQueue.read { try QueuedWrite.order(QueuedWrite.Columns.qid).fetchAll($0) }
    }
}
