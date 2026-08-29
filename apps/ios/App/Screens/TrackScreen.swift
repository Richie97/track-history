import SwiftUI
import TrackEvolutionKit

/// One circuit over time: the progress chart, the goal you're chasing, the course
/// notes you reread the night before, and every event you've run here.
///
/// `viewTrack` in `public/app.js` is the reference. The **setup-vs-lap-times table
/// is deferred** with the rest of the garage feature and is absent rather than
/// stubbed; so is the two-event lap overlay (`viewCompare`).
struct TrackScreen: View {
    let trackId: Int

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var model: TrackModel?
    @State private var confirmingLeaveLeaderboard = false

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let track = model.track {
                content(model, track)
            }
        }
        .navigationTitle(model?.track?.name ?? "Track")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = TrackModel(api: auth.api, trackId: trackId)
                self.model = model
                await model.load()
            }
        }
    }

    private func content(_ model: TrackModel, _ track: Track) -> some View {
        // The screen's editable fields (notes, the goal, the dry-only filter) live on
        // the model, so the bindings come from it rather than from local @State — one
        // owner for the page's state, and a re-load can't leave a stale copy behind.
        @Bindable var model = model
        return TEPage {
            VStack(alignment: .leading, spacing: 4) {
                Text(track.name)
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                HStack(spacing: 6) {
                    Text("Personal best")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                    TETime(ms: model.personalBest, emphasized: true)
                    Text("· \(fmtCount(model.events.count, "event"))\(model.dryOnly ? " (dry)" : "")")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                }
            }

            chartCard(model, track)
            goalCard(model, track)

            // The page title already says which track, so the button doesn't repeat
            // it — a circuit name with a layout suffix wraps to three lines.
            Button("+ Add event here") {
                router.push(.eventForm(.new(presetTrack: track.name)))
            }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .accessibilityLabel("Add event at \(track.name)")

            if let error = model.writeError {
                TEErrorBanner(message: error)
            }

            TESectionHeader("Course notes")
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    TEField(label: "Notes to reread the night before") {
                        TextField(
                            "T1: brake at the 300 board, 4th gear\nT5a: patience — late apex, track out over the curb…",
                            text: $model.notes,
                            axis: .vertical
                        )
                        .teInput()
                        .lineLimit(5...12)
                    }
                    HStack(spacing: 12) {
                        Button(model.isSavingNotes ? "Saving…" : "Save notes") {
                            Task { await model.saveNotes() }
                        }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .disabled(model.isSavingNotes || !model.notesChanged)
                        if model.notesSaved {
                            Text("Saved.")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textMuted))
                        }
                    }
                }
            }

            if let leaderboard = model.leaderboard, leaderboard.catalogId != nil {
                leaderboardSection(model, leaderboard)
            }

            TESectionHeader("Events", detail: model.dryOnly ? "dry only" : nil)
            if model.events.isEmpty {
                TEEmpty(model.dryOnly ? "No dry events logged here." : "No events at this track yet.")
            } else {
                ForEach(model.events) { event in
                    TENavCard(route: .event(event.id), identifier: "trackEventCard") {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(EventDates.fmtDate(event.startDate))
                                    .teStyle(.bodyStrong)
                                    .foregroundStyle(Color(.textStrong))
                                TEMeta([
                                    fmtDays(event.days),
                                    event.club,
                                    event.runGroup,
                                    event.conditions?.label
                                ])
                            }
                            Spacer(minLength: 8)
                            VStack(alignment: .trailing, spacing: 2) {
                                TETime(ms: event.bestMs)
                                Text(LapTime.fmtConsistency(event.consistency))
                                    .teStyle(.xxs)
                                    .foregroundStyle(Color(.textFaint))
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await model.load() }
        .toolbar {
            if let url = model.shareURL(serverURL: auth.server.url) {
                ToolbarItem(placement: .topBarTrailing) {
                    // A real share sheet, not the web app's copy-to-clipboard
                    // fallback: sending a run-group organizer your times is the
                    // reason the share link exists.
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
    }

    // MARK: - Leaderboard

    /// The per-track community leaderboard — the port of the web track page's
    /// section. Strictly opt-in: drivers who haven't opted in, the viewer
    /// included, simply aren't on it. Only rendered for catalog tracks (the
    /// caller checks `catalogId`), since only those have a cross-user identity.
    private func leaderboardSection(_ model: TrackModel, _ leaderboard: TrackLeaderboard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            TESectionHeader("Leaderboard", detail: "opt-in only")
            Text("Best laps by Track Evolution drivers at this track.")
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
            if leaderboard.entries.isEmpty {
                TEEmpty("No opted-in drivers here yet\(leaderboard.optedIn ? "" : " — be the first").")
            } else {
                TECard {
                    VStack(spacing: 0) {
                        ForEach(Array(leaderboard.entries.enumerated()), id: \.offset) { index, entry in
                            HStack(spacing: 10) {
                                Text("\(String(index + 1))")
                                    .teStyle(.lapTime)
                                    .foregroundStyle(Color(.textFaint))
                                    .frame(width: 24, alignment: .trailing)
                                Text(entry.name ?? "Driver")
                                    .teStyle(entry.you ? .bodyStrong : .body)
                                    .foregroundStyle(Color(.textBody))
                                    .lineLimit(1)
                                if entry.you {
                                    Text("you")
                                        .teStyle(.xxs)
                                        .foregroundStyle(Color(.accentInk))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 2)
                                        .background(Color(.accentTint), in: .capsule)
                                }
                                Spacer(minLength: 8)
                                TETime(ms: entry.bestMs)
                                Text(EventDates.fmtDate(entry.date))
                                    .teStyle(.xxs)
                                    .foregroundStyle(Color(.textFaint))
                            }
                            .padding(.vertical, 8)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(
                                "Rank \(index + 1), \(entry.name ?? "Driver")\(entry.you ? ", you" : ""), "
                                    + "\(LapTime.fmtMs(entry.bestMs)), \(EventDates.fmtDate(entry.date))"
                            )
                            if index < leaderboard.entries.count - 1 {
                                Divider().overlay(Color(.borderHairline))
                            }
                        }
                    }
                }
            }
            if let error = model.leaderboardError {
                TEErrorBanner(message: error)
            }
            if leaderboard.optedIn {
                HStack(spacing: 8) {
                    Text("You're on the leaderboards — your name and best lap per track are visible to other signed-in drivers.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    Spacer(minLength: 4)
                    Button("Leave") { confirmingLeaveLeaderboard = true }
                        .teStyle(.xs)
                        .foregroundStyle(Color(.dangerInk))
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("You're not on the leaderboards. Joining shares exactly two things with other signed-in drivers, per track: your name and your best lap.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    Button("Join leaderboards") { Task { await model.setLeaderboardOptIn(true) } }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            }
        }
        .confirmationDialog(
            "Leave the leaderboards? Your name and times disappear from every track's leaderboard.",
            isPresented: $confirmingLeaveLeaderboard,
            titleVisibility: .visible
        ) {
            Button("Leave leaderboards", role: .destructive) {
                Task { await model.setLeaderboardOptIn(false) }
            }
            Button("Stay on them", role: .cancel) {}
        }
    }

    // MARK: - Chart

    private func chartCard(_ model: TrackModel, _ track: Track) -> some View {
        @Bindable var model = model
        return TECard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Best lap per event — down is faster")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    Spacer()
                }
                ProgressChart(
                    points: model.chartPoints,
                    goalMs: track.goalMs,
                    xLabel: { EventDates.fmtDate(EventDates.isoString(from: Date(timeIntervalSince1970: $0))) },
                    unit: "events"
                )
                // Only offered once something here was logged as damp/wet/mixed:
                // "Dry only" keeps a rain weekend from reading as regression, and it
                // hides events *known* not to be dry — unlabelled history stays.
                if model.hasWetData {
                    Toggle("Dry only", isOn: $model.dryOnly)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textBody))
                        .tint(Color(.accent))
                }
            }
        }
    }

    // MARK: - Goal

    private func goalCard(_ model: TrackModel, _ track: Track) -> some View {
        @Bindable var model = model
        return TECard {
            VStack(alignment: .leading, spacing: 10) {
                TEField(label: "Goal lap", hint: "The time you're chasing here — drawn on the chart above") {
                    HStack(spacing: 8) {
                        TextField("e.g. 1:59.0", text: $model.goalText)
                            .teInput()
                            .keyboardType(.numbersAndPunctuation)
                            .autocorrectionDisabled()
                        Button("Save") { Task { await model.saveGoal() } }
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.accentInk))
                        if track.goalMs != nil {
                            Button("Clear") { Task { await model.clearGoal() } }
                                .teStyle(.bodyStrong)
                                .foregroundStyle(Color(.textMuted))
                        }
                    }
                }
                if let status = model.goalStatus {
                    Text(status.text)
                        .teStyle(.sm)
                        .foregroundStyle(status.met ? Color(.positive) : Color(.textMuted))
                }
            }
        }
    }
}

/// A track page's data, its goal, and its notes.
@MainActor
@Observable
final class TrackModel {
    private let api: APIClient
    let trackId: Int

    private(set) var state: LoadState = .loading
    private(set) var track: Track?
    private(set) var allEvents: [Event] = []
    var writeError: String?

    /// Hides events *known* to be damp/wet/mixed. Unlabelled history stays, because
    /// "no conditions recorded" is not the same as "not dry".
    var dryOnly = false

    var goalText = ""
    var notes = ""
    private var savedNotes = ""
    private(set) var isSavingNotes = false
    private(set) var notesSaved = false

    init(api: APIClient, trackId: Int) {
        self.api = api
        self.trackId = trackId
    }

    func load() async {
        do {
            async let tracks = api.tracks()
            async let events = api.events(trackId: trackId)
            let loaded = try await (tracks: tracks, events: events)
            guard let found = loaded.tracks.first(where: { $0.id == trackId }) else {
                state = .failed("That track isn't in your logbook any more.")
                return
            }
            track = found
            allEvents = loaded.events
            goalText = found.goalMs.map { LapTime.fmtMs($0) } ?? ""
            savedNotes = found.notes ?? ""
            notes = savedNotes
            state = .ready
            shareSlug = (try? await api.me())?.user.shareSlug
            // Non-fatal on purpose: an older server or a failed fetch costs the
            // leaderboard section, never the track page.
            leaderboard = try? await api.trackLeaderboard(id: trackId)
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Newest first, as the server returns them.
    var events: [Event] {
        dryOnly ? allEvents.filter { $0.conditions == nil || $0.conditions == .dry } : allEvents
    }

    var hasWetData: Bool {
        allEvents.contains { $0.conditions != nil && $0.conditions != .dry }
    }

    var personalBest: Int? {
        events.compactMap(\.bestMs).min()
    }

    /// Chronological, and only events that set a time — the server does the same for
    /// `Track.series`.
    var chartPoints: [ProgressChart.Point] {
        events
            .filter { $0.bestMs != nil }
            .sorted { $0.startDate < $1.startDate }
            .compactMap { event in
                guard let best = event.bestMs,
                      let date = EventDates.date(fromISO: event.startDate)
                else { return nil }
                // Time-proportional x, like the web chart: a two-year gap should look
                // like a gap, not like the next event along.
                return .init(
                    x: date.timeIntervalSince1970,
                    label: EventDates.fmtDate(event.startDate),
                    ms: best
                )
            }
    }

    /// How the personal best stands against the goal, in the web app's words.
    var goalStatus: (text: String, met: Bool)? {
        guard let goal = track?.goalMs else { return nil }
        guard let pb = personalBest else { return ("Not yet beaten", false) }
        if pb <= goal {
            return ("Goal beaten by \(LapTime.fmtDelta(goal - pb).replacingOccurrences(of: "+", with: "")) ✓", true)
        }
        return ("\(LapTime.fmtDelta(pb - goal)) to goal", false)
    }

    var notesChanged: Bool { notes != savedNotes }

    // MARK: - Writes

    func saveGoal() async {
        let raw = goalText.trimmingCharacters(in: .whitespaces)
        if raw.isEmpty {
            await clearGoal()
            return
        }
        guard let ms = LapTime.parseTime(raw), ms > 0 else {
            writeError = "Couldn't parse \"\(raw)\" — use 1:59.0"
            return
        }
        var patch = TrackPatch()
        patch.goalMs = .set(ms)
        await write(patch)
    }

    func clearGoal() async {
        goalText = ""
        var patch = TrackPatch()
        patch.goalMs = .set(nil)
        await write(patch)
    }

    func saveNotes() async {
        isSavingNotes = true
        notesSaved = false
        var patch = TrackPatch()
        patch.notes = .set(notes.isEmpty ? nil : notes)
        await write(patch)
        isSavingNotes = false
        notesSaved = writeError == nil
    }

    private func write(_ patch: TrackPatch) async {
        writeError = nil
        do {
            try await api.updateTrack(id: trackId, patch)
            await load()
        } catch let error as APIError {
            writeError = error.message
        } catch {
            writeError = error.localizedDescription
        }
    }

    /// The public link to this track on your share page, when you have one. nil
    /// otherwise — there is nothing to share until a slug exists, and offering a
    /// share button that produces a 404 is worse than offering none.
    func shareURL(serverURL: URL) -> URL? {
        guard let slug = shareSlug else { return nil }
        return URL(string: "\(serverURL.absoluteString)/share/\(slug)#/track/\(trackId)")
    }

    /// The share slug from `/me`. Read separately from the page's own load, because a
    /// missing slug must not cost you the track page.
    private(set) var shareSlug: String?

    // MARK: - Leaderboard

    /// The per-track community leaderboard, or nil when it couldn't be loaded
    /// (older server, offline) — the section simply doesn't render then.
    private(set) var leaderboard: TrackLeaderboard?
    var leaderboardError: String?

    /// Join or leave the leaderboards. A live write on purpose — never queued
    /// offline: publishing your name shouldn't replay silently later.
    func setLeaderboardOptIn(_ optIn: Bool) async {
        leaderboardError = nil
        do {
            try await api.setLeaderboardOptIn(optIn)
            leaderboard = try? await api.trackLeaderboard(id: trackId)
            Haptics.confirm()
        } catch let error as APIError {
            leaderboardError = error.message
            Haptics.warn()
        } catch {
            leaderboardError = error.localizedDescription
            Haptics.warn()
        }
    }
}
