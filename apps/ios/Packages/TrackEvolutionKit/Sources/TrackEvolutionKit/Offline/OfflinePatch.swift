import Foundation
import GRDB

// Optimistic patching: a queued mutation edits the cached responses it affects, so
// the UI shows the change immediately and every view agrees — the dashboard, the
// event page and the track page are three different cache entries describing the
// same rows.
//
// Patches are best-effort *display* state. A missing cache entry is skipped, never
// created: the queue is the source of truth until it flushes. Every patch is
// idempotent, because `reapplyQueue` runs them again over a fresh server response.
//
// Unlike the web mirror, which surgically edits plain JSON, this decodes into the
// typed models and re-encodes. That's only safe because the golden contract test
// proves those models round-trip losslessly — a field this layer doesn't know about
// would otherwise be silently dropped on every patch.

extension OfflineStore {
    /// A create's request body, in the server's field names.
    private struct EventBody: Decodable {
        var track_id: Int?
        var track_name: String?
        var start_date: String?
        var days: Int?
        var club: String?
        var run_group: String?
        var car: String?
        var notes: String?
        var conditions: Conditions?
        var temp_f: Int?
        var checklist: [ChecklistItem]?
        var best_time_ms: Int?
        var track_hours: Double?
    }

    private struct SessionBody: Decodable {
        var label: String?
        var notes: String?
        var laps: [Double]?
        var trace: [TracePoint]?
        var channels: SessionChannels?
    }

    private struct LapsBody: Decodable {
        var laps: [Double]?
    }

    private struct TrackBody: Decodable {
        var name: String?
        var notes: String?
        var goal_ms: Int?
    }

    /// Local ids for rows the server hasn't seen. Derived from the queue id so a
    /// re-apply produces the same ids and dedupes instead of duplicating.
    private static func tempLapId(seed: Int, lapNum: Int) -> Int {
        -(abs(seed) * 1000 + lapNum)
    }

    static func applyLocal(_ item: QueuedWrite, _ db: Database) throws {
        let s = item.path.split(separator: "/").map(String.init)
        let method = item.method

        if method == "POST", s == ["events"] {
            try createEvent(item, db)
        } else if method == "PUT", s.count == 2, s[0] == "events" {
            try updateEvent(id: s[1], item, db)
        } else if method == "DELETE", s.count == 2, s[0] == "events" {
            try deleteEvent(id: s[1], db)
        } else if s.count == 4, s[0] == "events", s[2] == "setups", method == "PUT" || method == "DELETE" {
            try patchSetup(eventId: s[1], day: s[3], item, db)
        } else if method == "POST", s.count == 3, s[0] == "events", s[2] == "sessions" {
            try addSession(eventId: s[1], item, db)
        } else if s.count == 2, s[0] == "sessions", method == "PUT" || method == "DELETE" {
            try patchSession(id: s[1], item, db)
        } else if method == "POST", s.count == 3, s[0] == "sessions", s[2] == "laps" {
            try appendLaps(sessionId: s[1], item, db)
        } else if method == "DELETE", s.count == 2, s[0] == "laps" {
            try deleteLap(id: s[1], db)
        } else if method == "PUT", s.count == 2, s[0] == "tracks" {
            try patchTrack(id: s[1], item, db)
        }
    }

    // MARK: - Events

    private static func createEvent(_ item: QueuedWrite, _ db: Database) throws {
        guard let tempId = item.tempId, let bodyData = item.body,
              let body = try? JSONDecoder().decode(EventBody.self, from: bodyData),
              let startDate = body.start_date
        else { return }

        // The track name is unknown offline unless the tracks list is cached; the
        // server resolves the real one (and the vehicle link) on flush.
        var trackName = body.track_name ?? "(new track)"
        if let trackId = body.track_id,
           let cached = try cached("/tracks", db),
           let tracks = try? JSONDecoder().decode([Track].self, from: cached),
           let track = tracks.first(where: { $0.id == trackId }) {
            trackName = track.name
        }

        var detail = EventDetail(
            event: Event(
                id: tempId,
                trackId: body.track_id ?? 0,
                trackName: trackName,
                startDate: startDate,
                days: body.days ?? 1,
                club: body.club,
                runGroup: body.run_group,
                car: body.car,
                vehicleId: nil,
                notes: body.notes,
                conditions: body.conditions,
                tempF: body.temp_f,
                checklist: body.checklist,
                bestTimeMs: body.best_time_ms,
                trackHours: body.track_hours,
                updatedAt: 0,
                lapBestMs: nil,
                lapCount: 0,
                sessionCount: 0,
                bestMs: nil,
                consistency: nil,
                hours: 0
            ),
            sessions: [],
            setups: []
        )
        OfflineMirrors.recomputeDetail(&detail)
        try put("/events/\(tempId)", try JSONEncoder().encode(detail), db)

        try patchEventLists(db) { list, key in
            // Track-filtered lists are left alone: offline, we may not know which
            // track this event belongs to.
            guard key == "/events" else { return nil }
            var rest = list.filter { $0.id != tempId }
            let at = rest.firstIndex { $0.startDate <= detail.event.startDate } ?? rest.count
            rest.insert(detail.event, at: at)
            return rest
        }
    }

    private static func updateEvent(id: String, _ item: QueuedWrite, _ db: Database) throws {
        guard let bodyData = item.body,
              let body = try? JSONDecoder().decode(EventBody.self, from: bodyData),
              let keys = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
        else { return }

        let path = "/events/\(id)"
        if let cached = try cached(path, db), var detail = try? JSONDecoder().decode(EventDetail.self, from: cached) {
            apply(body, keys: keys, to: &detail.event)
            OfflineMirrors.recomputeDetail(&detail)
            try put(path, try JSONEncoder().encode(detail), db)
            try syncLists(from: detail, db)
        } else {
            // No detail cached: patch the list rows directly so the dashboard still
            // shows the edit.
            try patchEventLists(db) { list, _ in
                list.map { row in
                    guard String(row.id) == id else { return row }
                    var next = row
                    apply(body, keys: keys, to: &next)
                    return next
                }
            }
        }
    }

    /// Only the fields the request actually carried — the server updates just those,
    /// so a patch that filled in the rest would invent data.
    private static func apply(_ body: EventBody, keys: [String: Any], to event: inout Event) {
        if keys.keys.contains("track_name"), let value = body.track_name { event.trackName = value }
        if keys.keys.contains("start_date"), let value = body.start_date { event.startDate = value }
        if keys.keys.contains("days"), let value = body.days { event.days = value }
        if keys.keys.contains("club") { event.club = body.club }
        if keys.keys.contains("run_group") { event.runGroup = body.run_group }
        if keys.keys.contains("car") { event.car = body.car }
        if keys.keys.contains("notes") { event.notes = body.notes }
        if keys.keys.contains("conditions") { event.conditions = body.conditions }
        if keys.keys.contains("temp_f") { event.tempF = body.temp_f }
        if keys.keys.contains("checklist") { event.checklist = body.checklist }
        if keys.keys.contains("best_time_ms") { event.bestTimeMs = body.best_time_ms }
        if keys.keys.contains("track_hours") { event.trackHours = body.track_hours }
    }

    private static func deleteEvent(id: String, _ db: Database) throws {
        try db.execute(sql: "DELETE FROM cached_response WHERE path = ?", arguments: ["/events/\(id)"])
        try patchEventLists(db) { list, _ in list.filter { String($0.id) != id } }
    }

    // MARK: - Setup sheets (inside the event detail)

    private static func patchSetup(eventId: String, day: String, _ item: QueuedWrite, _ db: Database) throws {
        let path = "/events/\(eventId)"
        guard let day = Int(day), let cached = try cached(path, db),
              var detail = try? JSONDecoder().decode(EventDetail.self, from: cached)
        else { return }

        var setups = detail.setups.filter { $0.day != day }
        if item.method == "PUT", let bodyData = item.body,
           let sheet = try? JSONDecoder().decode(SetupSheet.self, from: bodyData) {
            setups.append(Setup(day: day, data: sheet))
        }
        detail.setups = setups.sorted { $0.day < $1.day }
        try put(path, try JSONEncoder().encode(detail), db)
    }

    // MARK: - Sessions and laps

    private static func addSession(eventId: String, _ item: QueuedWrite, _ db: Database) throws {
        let path = "/events/\(eventId)"
        guard let tempId = item.tempId, let cached = try cached(path, db),
              var detail = try? JSONDecoder().decode(EventDetail.self, from: cached)
        else { return }
        // Re-apply dedupe.
        guard !detail.sessions.contains(where: { $0.id == tempId }) else { return }

        let body = item.body.flatMap { try? JSONDecoder().decode(SessionBody.self, from: $0) }
        let laps = OfflineMirrors.cleanLaps(body?.laps ?? [])
        detail.sessions.append(
            Session(
                id: tempId,
                label: body?.label,
                notes: body?.notes,
                sort: (detail.sessions.map(\.sort).max() ?? 0) + 1,
                trace: body?.trace,
                channels: body?.channels,
                laps: laps.enumerated().map { index, ms in
                    Lap(
                        id: tempLapId(seed: tempId, lapNum: index + 1),
                        sessionId: tempId,
                        lapNum: index + 1,
                        timeMs: ms
                    )
                }
            )
        )
        OfflineMirrors.recomputeDetail(&detail)
        try put(path, try JSONEncoder().encode(detail), db)
        try syncLists(from: detail, db)
    }

    private static func patchSession(id: String, _ item: QueuedWrite, _ db: Database) throws {
        try eachEventDetail(db) { path, detail in
            guard let index = detail.sessions.firstIndex(where: { String($0.id) == id }) else { return false }
            if item.method == "PUT" {
                // The route writes both columns unconditionally (missing → null),
                // so mirror that rather than merging.
                let body = item.body.flatMap { try? JSONDecoder().decode(SessionBody.self, from: $0) }
                detail.sessions[index].label = body?.label
                detail.sessions[index].notes = body?.notes
            } else {
                detail.sessions.remove(at: index)
            }
            return true
        }
    }

    private static func appendLaps(sessionId: String, _ item: QueuedWrite, _ db: Database) throws {
        guard let qid = item.qid.map(Int.init) else { return }
        let seed = qid + 100_000
        try eachEventDetail(db) { _, detail in
            guard let index = detail.sessions.firstIndex(where: { String($0.id) == sessionId }) else { return false }
            // Re-apply dedupe. Lap numbers continue from whatever the session
            // already had, so the check is "does any lap belong to this queue
            // entry?" — every id this entry mints falls in its own 1000-wide band,
            // which is the typed equivalent of the web mirror's `q{qid}-l` marker.
            let band = abs(seed) * 1000
            let alreadyApplied = detail.sessions[index].laps.contains { lap in
                lap.id < 0 && abs(lap.id) > band && abs(lap.id) < band + 1000
            }
            guard !alreadyApplied else { return true }

            var lapNum = detail.sessions[index].laps.map(\.lapNum).max() ?? 0
            let body = item.body.flatMap { try? JSONDecoder().decode(LapsBody.self, from: $0) }
            for ms in OfflineMirrors.cleanLaps(body?.laps ?? []) {
                lapNum += 1
                detail.sessions[index].laps.append(
                    Lap(
                        id: tempLapId(seed: seed, lapNum: lapNum),
                        sessionId: detail.sessions[index].id,
                        lapNum: lapNum,
                        timeMs: ms
                    )
                )
            }
            return true
        }
    }

    private static func deleteLap(id: String, _ db: Database) throws {
        try eachEventDetail(db) { _, detail in
            guard let index = detail.sessions.firstIndex(where: { session in
                session.laps.contains { String($0.id) == id }
            }) else { return false }
            detail.sessions[index].laps.removeAll { String($0.id) == id }
            return true
        }
    }

    // MARK: - Tracks

    private static func patchTrack(id: String, _ item: QueuedWrite, _ db: Database) throws {
        guard let bodyData = item.body,
              let body = try? JSONDecoder().decode(TrackBody.self, from: bodyData),
              let keys = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any],
              let cached = try cached("/tracks", db),
              let tracks = try? JSONDecoder().decode([Track].self, from: cached)
        else { return }

        let patched = tracks.map { track -> Track in
            guard String(track.id) == id else { return track }
            var next = track
            if keys.keys.contains("name"), let value = body.name { next.name = value }
            if keys.keys.contains("notes") { next.notes = body.notes }
            if keys.keys.contains("goal_ms") { next.goalMs = body.goal_ms }
            return next
        }
        try put("/tracks", try JSONEncoder().encode(patched), db)
    }

    // MARK: - Cache plumbing

    private static func cached(_ path: String, _ db: Database) throws -> Data? {
        try Data.fetchOne(db, sql: "SELECT body FROM cached_response WHERE path = ?", arguments: [path])
    }

    private static func put(_ path: String, _ body: Data, _ db: Database) throws {
        try db.execute(
            sql: "INSERT OR REPLACE INTO cached_response (path, body) VALUES (?, ?)",
            arguments: [path, body]
        )
    }

    /// Every cached events list — the unfiltered one and any track-filtered ones.
    private static func patchEventLists(_ db: Database, _ transform: ([Event], String) -> [Event]?) throws {
        let keys = try String.fetchAll(db, sql: "SELECT path FROM cached_response")
        for key in keys where key == "/events" || key.hasPrefix("/events?") {
            guard let data = try cached(key, db),
                  let list = try? JSONDecoder().decode([Event].self, from: data),
                  let next = transform(list, key)
            else { continue }
            try put(key, try JSONEncoder().encode(next), db)
        }
    }

    /// Keep the list rows in step with a patched detail: the same event appears in
    /// the dashboard list and on the track page, and they must agree.
    private static func syncLists(from detail: EventDetail, _ db: Database) throws {
        let row = OfflineMirrors.listRow(from: detail)
        try patchEventLists(db) { list, _ in
            list.map { $0.id == row.id ? row : $0 }
        }
    }

    /// Walk cached event details until `transform` claims one, then persist it and
    /// re-sync the lists. Sessions and laps are addressed by their own ids, so which
    /// event holds them isn't known from the path.
    private static func eachEventDetail(_ db: Database, _ transform: (String, inout EventDetail) -> Bool) throws {
        let keys = try String.fetchAll(db, sql: "SELECT path FROM cached_response")
        for key in keys {
            guard key.hasPrefix("/events/"), !key.contains("?"),
                  key.split(separator: "/").count == 2,
                  let data = try cached(key, db),
                  var detail = try? JSONDecoder().decode(EventDetail.self, from: data)
            else { continue }
            guard transform(key, &detail) else { continue }
            OfflineMirrors.recomputeDetail(&detail)
            try put(key, try JSONEncoder().encode(detail), db)
            try syncLists(from: detail, db)
            return
        }
    }
}
