import SwiftUI
import TrackEvolutionKit

/// One circuit over time: the progress chart, the goal you're chasing, the course
/// notes you reread the night before, and every event you've run here.
///
/// `viewTrack` in `public/app.js` is the reference. The **setup-vs-lap-times table
/// is deferred** with the rest of the garage feature and is absent rather than
/// stubbed; so is the two-event lap overlay (`viewCompare`). The two-lap telemetry
/// compare (`viewLapCompare`, #165) *is* here, as a sheet. The leaderboard is
/// **not** a section of this page any more — it is `LeaderboardScreen`, behind a
/// button, for the reason stated there.
struct TrackScreen: View {
    let trackId: Int

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.layout) private var layout

    @State private var model: TrackModel?
    @State private var showingCompareLaps = false

    /// How wide the compare column gets, or nil for the sheet.
    ///
    /// The event page's numbers, because it is the same kind of content: two laps
    /// of channel traces need the width a track map and its charts need.
    /// Measured against this page's own column rather than the window's class,
    /// for the reason `sideColumnWidth` states.
    private var compareWidth: CGFloat? {
        layout.sideColumnWidth(fraction: 0.46, minimum: 380, maximum: 620)
    }

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let track = model.track {
                // At expanded width the compare opens in a **column beside** the
                // page rather than as a sheet over it (NS-34 ticket 3). The view
                // is the same `CompareLapsScreen`; only its container changes,
                // which is the whole claim the ticket makes about it.
                if let compareWidth, showingCompareLaps {
                    HStack(spacing: 0) {
                        content(model, track)
                            // Inside the frame on both columns — see the note on
                            // `EventScreen.page`: a greedy `GeometryReader` around
                            // a fixed frame splits the row in half instead.
                            .measuringPaneWidth()
                            .frame(maxWidth: .infinity)
                        Divider()
                        compareColumn
                            .measuringPaneWidth()
                            .frame(width: compareWidth)
                    }
                } else {
                    content(model, track)
                }
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

    /// The compare as a sheet — only where there is no room for it as a column.
    ///
    /// "Where there is room" is `compareWidth`, the same value the column is
    /// drawn from, so the two can never both be showing the same compare — which
    /// is what a width check there and a class check here would eventually allow.
    private var compareSheet: Binding<Bool> {
        .init(
            get: { showingCompareLaps && compareWidth == nil },
            set: { showingCompareLaps = $0 }
        )
    }

    /// The compare as this page's right-hand column, with a way to close it —
    /// a sheet has a swipe-down and a column has nothing, so it needs one.
    private var compareColumn: some View {
        // The screen already titles itself, so the column adds only the way out
        // — overlaid rather than stacked above, which would push its heading down
        // and put two headings in a row.
        CompareLapsScreen(trackId: trackId)
            .overlay(alignment: .topTrailing) {
                Button {
                    showingCompareLaps = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textFaint))
                        .padding(TESpacing.pageGutter)
                }
                .accessibilityLabel("Close the comparison")
            }
            .background(Color(.bgPage))
            .accessibilityIdentifier("compareColumn")
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
                    // How much the track climbs and falls (#191), from whatever
                    // telemetry has been imported here. Context, not coaching —
                    // one line, and no more.
                    if !model.elevationLine(auth.units).isEmpty {
                        Text("· \(model.elevationLine(auth.units))")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                    }
                }
            }

            chartCard(model, track)
            goalCard(model, track)

            // Web parity: offered whenever any event here has laps — the screen
            // explains itself when none of them stored telemetry channels.
            if model.hasComparableLaps {
                Button("Compare two laps") { showingCompareLaps = true }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityHint("Pick two laps with telemetry and see where the time is gained or lost")
            }

            // The leaderboard is its own screen rather than a section here: this
            // page is the driver's own history, and a board they may not care
            // about was costing it a screen of space. Offered for every catalog
            // track — before the driver is on it, and before they have been here
            // at all. A push, not a sheet: it is a place you go, and the lap it
            // opens is the sheet.
            if track.catalogId != nil {
                Button("Leaderboard") { router.push(.leaderboard(trackId: trackId)) }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityHint("Best device-timed laps by other drivers at this track — opt-in only")
                    .accessibilityIdentifier("trackLeaderboard")
            }

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
        // The screen's one modal presentation — a second `.sheet` on this view
        // would be the SwiftUI hazard that takes the app down with a watchdog
        // "lost connection" rather than a stack trace. The leaderboard lap used
        // to share this sheet; it now opens from `LeaderboardScreen`, which has
        // its own.
        //
        // Where there is no room for a second column the compare stays the sheet
        // it has always been: there is nowhere to put one, and a half-width lap
        // comparison is a worse comparison rather than a smaller one.
        .sheet(isPresented: compareSheet) {
            CompareLapsScreen(trackId: trackId)
        }
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
                    band: model.conditionsBand,
                    xLabel: { EventDates.fmtDate(EventDates.isoString(from: Date(timeIntervalSince1970: $0))) },
                    unit: "events"
                )
                // The wash's key: pale is the coolest event in view, deep the
                // hottest. Absent when the band is, which is most young logbooks.
                if let band = model.conditionsBand {
                    ConditionsKey(band: band)
                }
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

    /// Whether the two-lap compare is worth offering: any event here has laps.
    /// Channel data can't be known from the list — the compare screen's empty
    /// state covers a track whose laps carry none, same as the web.
    var hasComparableLaps: Bool {
        allEvents.contains { $0.lapCount > 0 }
    }

    var personalBest: Int? {
        events.compactMap(\.bestMs).min()
    }

    /// Chronological, and only events that set a time the chart can place — the
    /// server does the same for `Track.series`. The band's cells are built from
    /// this same list so the two line up one for one; deriving them separately
    /// is how an unparseable date shifts every event's shading by one.
    var plottedEvents: [Event] {
        events
            .filter { $0.bestMs != nil && EventDates.date(fromISO: $0.startDate) != nil }
            .sorted { $0.startDate < $1.startDate }
    }

    var chartPoints: [ProgressChart.Point] {
        plottedEvents.compactMap { event in
            guard let best = event.bestMs, let date = EventDates.date(fromISO: event.startDate) else {
                return nil
            }
            // Time-proportional x, like the web chart: a two-year gap should look
            // like a gap, not like the next event along.
            return .init(
                x: date.timeIntervalSince1970,
                label: EventDates.fmtDate(event.startDate),
                ms: best
            )
        }
    }

    /// The ambient wash behind the chart (#191) — nil when too few events here
    /// carry a temperature, or when they were all run in much the same air.
    var conditionsBand: SessionConditions.Band? {
        SessionConditions.conditionsBand(plottedEvents)
    }

    /// The track's elevation change, from every event at it — the dry-only
    /// filter has nothing to do with the hill.
    func elevationLine(_ units: UnitSystem) -> String {
        SessionConditions.elevationText(SessionConditions.trackElevationM(allEvents), SessionConditions.Units(units))
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
}
