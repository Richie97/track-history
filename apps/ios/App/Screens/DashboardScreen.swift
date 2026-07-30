import SwiftUI
import TrackEvolutionKit

/// The logbook's front page: what's next, what you've done, and how fast you were.
///
/// `viewDashboard` in `public/app.js` is the reference for behavior and copy. Two
/// deliberate differences:
///
/// - **The garage is not here.** The web dashboard carries a maintenance-due strip
///   and a card per vehicle from `GET /api/garage`; wear tracking is a deferred,
///   web-only feature (`docs/specs/native/README.md`), so rather than half-build it
///   this omits both cleanly. Settings links out to the web app for the garage.
/// - Pull-to-refresh is `.refreshable`, not `public/js/pull-refresh.js`'s hand-built
///   approximation of it.
struct DashboardScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(RecordingController.self) private var recorder

    @State private var model: DashboardModel?

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model {
                content(model)
            }
        }
        .navigationTitle("Track Evolution")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // The web app's account dropdown, which carries Settings, the theme
                // toggle and sign-out. All three live on the settings screen here —
                // a popover menu duplicating them would be two places to change.
                Button {
                    router.push(.settings)
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account")
            }
        }
        .task {
            if model == nil {
                let model = DashboardModel(api: auth.api)
                self.model = model
                await model.load()
                // Only once the dashboard is on screen: this is a background warm-up
                // for the paddock, and it must never delay first paint.
                await model.warmCache()
            }
        }
    }

    private func content(_ model: DashboardModel) -> some View {
        TEPage {
            recordingBanner

            Button("+ Add event") { router.push(.eventForm(.new(presetTrack: nil))) }
                .buttonStyle(TEButtonStyle(kind: .accent))

            if let hero = model.heroEvent {
                heroCard(hero)
            }

            TEStatRow(tiles: [
                TEStatTile(label: "Events", value: "\(model.totals?.events ?? model.events.count)"),
                TEStatTile(label: "Track days", value: "\(model.totals?.trackDays ?? 0)"),
                TEStatTile(label: "Tracks", value: "\(model.tracksWithData.count)")
            ])

            if !model.alsoUpcoming.isEmpty {
                TESectionHeader("Also upcoming")
                ForEach(model.alsoUpcoming) { event in
                    TENavCard(route: .event(event.id), identifier: "upcomingCard") {
                        Text(event.trackName)
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        if let countdown = EventDates.fmtCountdown(event.startDate) {
                            Text(countdown)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.accentInk))
                        }
                        TEMeta([EventDates.fmtDate(event.startDate), event.club, checklistProgress(event)])
                    }
                }
            }

            TESectionHeader("Tracks")
            if model.tracksWithData.isEmpty {
                TEEmpty("No events yet — add your first track day.")
            } else {
                ForEach(model.tracksWithData) { track in
                    trackCard(track)
                }
            }

            if !model.recent.isEmpty {
                TESectionHeader("Recent events")
                ForEach(model.recent) { event in
                    TENavCard(route: .event(event.id), identifier: "recentEventCard") {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(event.trackName)
                                    .teStyle(.bodyStrong)
                                    .foregroundStyle(Color(.textStrong))
                                TEMeta([EventDates.fmtDate(event.startDate), event.club])
                            }
                            Spacer(minLength: 8)
                            TETime(ms: event.bestMs)
                        }
                    }
                }
            }
        }
        .refreshable { await model.load() }
    }

    // MARK: - The next event

    /// The nearest upcoming event, with its countdown and prep progress — the web
    /// app's `heroEventHtml`.
    private func heroCard(_ event: Event) -> some View {
        Button {
            router.push(.event(event.id))
        } label: {
            TECard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Next event")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.accentInk))
                    Text(event.trackName)
                        .teStyle(.h1)
                        .foregroundStyle(Color(.textStrong))
                    TEMeta([EventDates.fmtDate(event.startDate), event.club, event.runGroup])
                    if let countdown = EventDates.fmtCountdown(event.startDate) {
                        Text(countdown)
                            .teStyle(.hero)
                            .foregroundStyle(Color(.textStrong))
                    }
                    if let checklist = event.checklist, !checklist.isEmpty {
                        checklistRing(checklist)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        // One tap target, so one accessibility element — and the label says the whole
        // thing in one breath, because "what's next, how long have I got, and is the
        // car ready" is a single question. Left as separate elements, the progress ring
        // reads as an unexplained fraction.
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("heroEvent")
        .accessibilityLabel(Self.heroLabel(event))
    }

    private static func heroLabel(_ event: Event) -> String {
        var parts = [
            "Next event: \(event.trackName)",
            EventDates.fmtCountdown(event.startDate) ?? EventDates.fmtDate(event.startDate)
        ]
        if let checklist = event.checklist, !checklist.isEmpty {
            parts.append("prep checklist \(checklist.filter(\.done).count) of \(checklist.count) done")
        }
        return parts.joined(separator: ", ")
    }

    private func checklistRing(_ items: [ChecklistItem]) -> some View {
        let done = items.filter(\.done).count
        let open = items.filter { !$0.done }
        return HStack(spacing: 12) {
            ZStack {
                Circle()
                    .stroke(Color(.surfaceRaised), lineWidth: 7)
                Circle()
                    .trim(from: 0, to: Double(done) / Double(items.count))
                    .stroke(Color(.accent), style: .init(lineWidth: 7, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(done)/\(items.count)")
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textStrong))
            }
            .frame(width: 56, height: 56)

            VStack(alignment: .leading, spacing: 2) {
                Text("Prep checklist")
                    .teStyle(.bodyStrong)
                    .foregroundStyle(Color(.textStrong))
                Text(
                    open.isEmpty
                        ? "All done ✓"
                        : "Still open: " + open.prefix(2).map(\.text).joined(separator: ", ")
                            + (open.count > 2 ? " +\(open.count - 2) more" : "")
                )
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
            }
        }
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Prep checklist, \(done) of \(items.count) done")
    }

    private func checklistProgress(_ event: Event) -> String? {
        guard let checklist = event.checklist, !checklist.isEmpty else { return nil }
        return "checklist \(checklist.filter(\.done).count)/\(checklist.count)"
    }

    // MARK: - Track cards

    private func trackCard(_ track: Track) -> some View {
        TENavCard(route: .track(track.id), identifier: "trackCard") {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.name)
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    Text(LapTime.fmtMs(track.bestMs))
                        .teStyle(.lapTimeHero)
                        .foregroundStyle(Color(.textStrong))
                    TEMeta([
                        fmtCount(track.eventCount, "event"),
                        fmtCount(track.trackDays, "day"),
                        EventDates.fmtDate(track.lastDate)
                    ])
                }
                Spacer(minLength: 8)
                // Two points is the least that can show a direction; one would be a
                // dot pretending to be a trend.
                if track.series.count >= 2 {
                    ProgressChart(
                        points: track.series.enumerated().map { index, point in
                            .init(x: Double(index), label: EventDates.fmtDate(point.date), ms: point.bestMs)
                        },
                        style: .sparkline
                    )
                    .frame(width: 110)
                }
            }
        }
    }

    // MARK: - The recording that no event page can reach

    /// A CarPlay-started recording with no event yet, or a stopped one still unsaved.
    /// Surfaced here because otherwise nothing in the app mentions it and a session's
    /// laps quietly rot on disk. Mirrors the web dashboard's `recBanner`.
    @ViewBuilder
    private var recordingBanner: some View {
        if recorder.isRecording, recorder.recording?.eventIdValue == nil {
            banner(
                title: "● Recording track session",
                hint: "No event for today yet — create it now or after you stop; the recording attaches when you open the event.",
                action: "+ Add event",
                route: .eventForm(.new(presetTrack: nil))
            )
        } else if let stopped = stoppedRecording {
            if let eventId = stopped.eventIdValue {
                banner(
                    title: "Unsaved track recording",
                    hint: "Review it to save the laps to its event, or discard it.",
                    action: "Review & save",
                    route: .record(eventId: eventId)
                )
            } else {
                banner(
                    title: "Unsaved track recording",
                    hint: "Create its event to pick the start/finish line and save the laps.",
                    action: "+ Add event",
                    route: .eventForm(.new(presetTrack: nil))
                )
            }
        }
    }

    private var stoppedRecording: Recording? {
        guard case .stopped = recorder.phase else { return nil }
        return recorder.recording
    }

    private func banner(title: String, hint: String, action: String, route: Route) -> some View {
        TECard(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Image(systemName: "stopwatch")
                        .foregroundStyle(Color(.accentInk))
                    Text(title)
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.textStrong))
                }
                Text(hint)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                Button(action) { router.push(route) }
                    .buttonStyle(TEButtonStyle(kind: .accent))
            }
        }
    }
}

/// The dashboard's data. One place that knows which lists come from where, so the
/// view is layout only.
@MainActor
@Observable
final class DashboardModel {
    private let api: APIClient

    private(set) var state: LoadState = .loading
    private(set) var totals: Totals?
    private(set) var tracks: [Track] = []
    private(set) var events: [Event] = []

    init(api: APIClient) {
        self.api = api
    }

    /// Three requests, in parallel — all three read through the offline cache, so
    /// this works in the paddock as long as the dashboard has been seen once.
    func load() async {
        do {
            async let account = api.me()
            async let trackList = api.tracks()
            async let eventList = api.events()
            let loaded = try await (me: account, tracks: trackList, events: eventList)
            totals = loaded.me.totals
            tracks = loaded.tracks
            events = loaded.events
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func warmCache() async {
        await api.warmCache(for: events)
    }

    /// Tracks you've actually driven, most recent first — the web app's `withData`.
    var tracksWithData: [Track] {
        tracks
            .filter { $0.eventCount > 0 }
            .sorted { ($0.lastDate ?? "") > ($1.lastDate ?? "") }
    }

    /// Soonest first, so the hero is the next thing happening.
    var upcoming: [Event] {
        events.filter { EventDates.isUpcoming($0.startDate) }
            .sorted { $0.startDate < $1.startDate }
    }

    var heroEvent: Event? { upcoming.first }
    var alsoUpcoming: [Event] { Array(upcoming.dropFirst()) }

    /// The server already returns events newest-first.
    var recent: [Event] {
        Array(events.filter { !EventDates.isUpcoming($0.startDate) }.prefix(6))
    }
}
