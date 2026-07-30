import Foundation
import TrackEvolutionKit

/// One event's data and every write you can make to it.
///
/// Every mutation here is on the offline layer's `QUEUEABLE` whitelist, which is
/// what makes the paddock work: the write is queued, the cached response is patched
/// so the change is on screen immediately, and `reload()` reads that patched copy
/// back. Nothing distinguishes the offline path at this level — deliberately, since
/// a code path that only runs without signal is a code path that is never tested.
@MainActor
@Observable
final class EventModel {
    private let api: APIClient
    /// Mutable: an event created offline is renumbered when its create flushes.
    private(set) var eventId: Int

    private(set) var state: LoadState = .loading
    private(set) var detail: EventDetail?
    /// The event's track, for the goal time and the track-wide best.
    private(set) var track: Track?
    /// The last failed write, in the server's own words. Not an alert: a failure
    /// here is usually a validation message about what you typed.
    var writeError: String?
    /// Set once the event is gone, so the screen can pop itself.
    private(set) var isDeleted = false

    init(api: APIClient, eventId: Int) {
        self.api = api
        self.eventId = eventId
    }

    var event: Event? { detail?.event }

    func load() async {
        do {
            async let detail = api.event(id: eventId)
            async let tracks = api.tracks()
            let loaded = try await (detail: detail, tracks: tracks)
            self.detail = loaded.detail
            track = loaded.tracks.first { $0.id == loaded.detail.event.trackId }
            state = .ready
        } catch let error as APIError {
            // A temp event whose create was rejected really is gone; anything else is
            // worth retrying.
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Re-read after a write. Keeps the current content on screen if the re-read
    /// fails, rather than replacing an event you can see with an error.
    private func reload() async {
        guard detail != nil else {
            await load()
            return
        }
        if let fresh = try? await api.event(id: eventId) {
            detail = fresh
        }
        // The track's aggregates move when laps do — the goal status on the track
        // page and the best here have to agree.
        if let trackId = detail?.event.trackId, let tracks = try? await api.tracks() {
            track = tracks.first { $0.id == trackId }
        }
    }

    // MARK: - Sessions and laps

    /// Add a session, with any lap times typed into the same form.
    @discardableResult
    func addSession(label: String, notes: String, laps: String) async -> Bool {
        let draft = SessionDraft(
            label: trimmedOrNil(label),
            notes: trimmedOrNil(notes),
            laps: LapTime.parseLapList(laps)
        )
        return await write { _ = try await api.createSession(eventId: eventId, draft) }
    }

    @discardableResult
    func updateSession(id: Int, label: String, notes: String) async -> Bool {
        // Both columns are written unconditionally by the server, so an emptied field
        // really does clear it.
        await write {
            try await api.updateSession(id: id, SessionPatch(label: trimmedOrNil(label), notes: trimmedOrNil(notes)))
        }
    }

    @discardableResult
    func deleteSession(id: Int) async -> Bool {
        await write { try await api.deleteSession(id: id) }
    }

    /// Append lap times to a session. Lap numbers continue from the last stored one,
    /// server-side.
    @discardableResult
    func appendLaps(sessionId: Int, text: String) async -> Bool {
        let laps = LapTime.parseLapList(text)
        guard !laps.isEmpty else {
            writeError = "Couldn't read any lap times from that — use 2:01.24, 2:01 or 121.24."
            return false
        }
        return await write { try await api.appendLaps(sessionId: sessionId, laps: laps) }
    }

    @discardableResult
    func deleteLap(id: Int) async -> Bool {
        await write { try await api.deleteLap(id: id) }
    }

    // MARK: - The event itself

    /// Save the prep checklist. nil (an emptied list) clears the column, which is
    /// what makes the checklist panel disappear again on a past event.
    @discardableResult
    func setChecklist(_ items: [ChecklistItem]) async -> Bool {
        var patch = EventPatch()
        patch.checklist = .set(items.isEmpty ? nil : items)
        return await write { try await api.updateEvent(id: eventId, patch) }
    }

    /// Delete the event and everything under it.
    @discardableResult
    func deleteEvent() async -> Bool {
        let ok = await write(reload: false) { try await api.deleteEvent(id: eventId) }
        if ok { isDeleted = true }
        return ok
    }

    /// Follow a temp id to its real one once the queue flushed, so the screen keeps
    /// talking about the same event instead of 404ing.
    func adoptResolvedId() async {
        guard OfflineStore.isTemp(eventId), let real = await api.resolveTempId(eventId) else { return }
        eventId = real
        await load()
    }

    // MARK: - Plumbing

    /// One write, its error surfaced, and a re-read on success.
    private func write(reload shouldReload: Bool = true, _ body: () async throws -> Void) async -> Bool {
        writeError = nil
        do {
            try await body()
            if shouldReload { await self.reload() }
            return true
        } catch let error as APIError {
            writeError = error.message
            return false
        } catch {
            writeError = error.localizedDescription
            return false
        }
    }

    private func trimmedOrNil(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

// MARK: - Derived views of a session

extension Session {
    var lapTimesMs: [Int] { laps.map(\.timeMs) }
    var bestLapMs: Int? { lapTimesMs.min() }

    /// The analysis line under a session header: representative pace, how long it
    /// took to get up to speed, and whether pace faded. Same wording and thresholds
    /// as `viewEvent` in `public/app.js`.
    var statsSummary: String? {
        let laps = lapTimesMs
        var parts: [String] = []
        if let best3 = LapStats.bestNAvg(laps, 3) {
            parts.append("best 3 avg \(LapTime.fmtMs(best3))")
        }
        if let warm = LapStats.warmupLapCount(laps) {
            parts.append(warm == 1 ? "on pace from lap 1" : "up to speed by lap \(warm)")
        }
        if let slope = LapStats.paceSlope(laps) {
            let trend = slope > 150 ? " — fading (tires? heat?)" : slope < -150 ? " — still improving" : ""
            parts.append("pace \(LapTime.fmtDelta(Int(slope.rounded())))/lap\(trend)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
