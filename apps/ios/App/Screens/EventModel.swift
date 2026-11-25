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
    /// The garage, for the setup notebook (NS-40): the event's car's parts name
    /// the sheets' part references, and its target hot pressure closes the
    /// pressure loop. Read only when the notebook is shown, and its failure is
    /// swallowed — a sheet reads fine without part names.
    private(set) var garage: [GarageVehicle]?

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

    /// Re-read after a write — here, or on a page pushed over this one (the
    /// setup form, the event form) that the page comes back to. Keeps the
    /// current content on screen if the re-read fails, rather than replacing an
    /// event you can see with an error.
    func reload() async {
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

    /// Rename a session or edit its notes. Only what changed is sent — the
    /// server writes only the keys present (NS-40), so a rename made here can't
    /// clear notes written on another device in the meantime. An emptied field
    /// is sent as null and clears.
    @discardableResult
    func updateSession(id: Int, label: String, notes: String) async -> Bool {
        let current = detail?.sessions.first { $0.id == id }
        let patch = Self.sessionPatch(from: current, label: label, notes: notes)
        guard !patch.isEmpty else { return true }
        return await write { try await api.updateSession(id: id, patch) }
    }

    /// The patch an edit makes: each field that differs from the session as
    /// loaded, trimmed, an empty one as null.
    static func sessionPatch(from session: Session?, label: String, notes: String) -> SessionPatch {
        func clean(_ text: String) -> String? {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        var patch = SessionPatch()
        if clean(label) != session?.label { patch.label = .set(clean(label)) }
        if clean(notes) != session?.notes { patch.notes = .set(clean(notes)) }
        return patch
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

    // MARK: - Setup notebook (NS-40)

    /// The event's car in the garage, when the garage has been read.
    var garageVehicle: GarageVehicle? {
        guard let vehicleId = event?.vehicleId else { return nil }
        return garage?.first { $0.id == vehicleId }
    }

    func loadGarage() async {
        // Offline with nothing cached, or a lapsed tier: the notebook shows the
        // sheets without part names or a target.
        if let garage = try? await api.garage() { self.garage = garage }
    }

    /// A day's sheet, written whole — the loop's *Record hot pressures*.
    /// Queueable, so it saves in the paddock with no signal and replays.
    @discardableResult
    func saveSetup(day: Int, _ sheet: SetupSheet) async -> Bool {
        await write { try await api.putSetup(eventId: eventId, day: day, sheet) }
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

    /// The stats strip under a session header — `lapStatItems` in
    /// `public/js/session-stats.js` plus what the channel data adds, the same
    /// items under the same labels as the web's and Android's. `units` is the
    /// account's system, for the health figures.
    func statItems(units: UnitSystem) -> [SessionStat] {
        let laps = lapTimesMs
        var items: [SessionStat] = []
        if let best3 = LapStats.bestNAvg(laps, 3) {
            items.append(SessionStat(key: "best3", label: "Best 3 avg", value: LapTime.fmtMs(best3)))
        }
        if let warm = LapStats.warmupLapCount(laps) {
            items.append(SessionStat(key: "warmup", label: "Up to speed", value: "Lap \(warm)"))
        }
        if let slope = LapStats.paceSlope(laps) {
            // A tenth and a half per lap either way is drift, not a story.
            let trend: (String, SessionStat.Tone)? =
                slope > SessionStat.FADING_MS_PER_LAP ? ("fading", .warn)
                : slope < -SessionStat.FADING_MS_PER_LAP ? ("improving", .good) : nil
            items.append(SessionStat(
                key: "pace", label: "Pace", value: "\(LapTime.fmtDelta(Int(slope.rounded())))/lap",
                note: trend?.0, tone: trend?.1
            ))
        }
        // Sector analysis (`Sectors`): what stringing the session's best sectors
        // together would have been worth. The splits themselves are in the panel.
        if let channels, let sec = Sectors.sessionSectors(channels), sec.laps.count >= 2, sec.gapMs > 0 {
            items.append(SessionStat(key: "theoretical", label: "Theoretical best", value: LapTime.fmtMs(sec.theoreticalBestMs)))
        }
        // Shift points (`Gears`, #187): the typical upshift rpm across the session.
        if let channels, let sp = Gears.shiftPoints(channels) {
            items.append(SessionStat(key: "upshifts", label: "Upshifts", value: "\(Gears.fmtRpm(Double(sp.medianRpm))) rpm"))
        }
        // Where the car hit its limit (`Limits`, #188), the corners whose
        // rotation sits off this car's typical response (`Balance`, #189) and
        // any figure past its line (`Health`, #190) — each a short sentence.
        if let channels, let limits = Limits.limitSummary(channels) {
            items.append(SessionStat(key: "limits", label: "Limits", value: limits, text: true))
        }
        if let channels, let balance = Balance.balanceSummary(channels) {
            items.append(SessionStat(key: "balance", label: "Balance", value: balance, text: true))
        }
        if let channels, let health = Health.healthSummary(channels, Health.Units(units)) {
            items.append(SessionStat(key: "car", label: "Car", value: health, text: true))
        }
        return items
    }
}

/// One cell of a session's stats strip: a small label over a figure — or, with
/// `text`, over a short sentence ("ABS in 3 places").
struct SessionStat: Identifiable, Equatable {
    enum Tone { case warn, good }

    static let FADING_MS_PER_LAP = 150.0

    let key: String
    let label: String
    let value: String
    var note: String?
    var tone: Tone?
    var text = false

    var id: String { key }
    var spoken: String { [label, value, note].compactMap { $0 }.joined(separator: ", ") }
}
