import SwiftUI
import TrackEvolutionKit

/// The logbook's front page: what's next, what you've done, and how fast you were.
///
/// `viewDashboard` in `public/app.js` is the reference for behavior and copy. One
/// deliberate difference: pull-to-refresh is `.refreshable`, not
/// `public/js/pull-refresh.js`'s hand-built approximation of it.
///
/// The garage appears here as it does on the web — a collapsed maintenance strip
/// and a card per vehicle — but it is the one section allowed to be **missing**.
/// `GET /api/garage` is fetched independently of the rest and its failure is
/// swallowed: a user with no garage, or an offline first launch, still gets the
/// whole logbook rather than an error page about a feature they may not use.
struct DashboardScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(RecordingController.self) private var recorder

    @State private var model: DashboardModel?
    @State private var showingDiscardConfirmation = false

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

            MaintenanceStrip(garage: model.garage, collapsed: true)

            // The two ways into a track day, side by side — the web app's `.btn-row`.
            // Recording is offered here because the alternative is navigating into an
            // event first, which is exactly the wrong amount of friction with a helmet
            // in your other hand.
            HStack(spacing: TESpacing.gridGap) {
                Button("+ Add event") { router.push(.eventForm(.new(presetTrack: nil))) }
                    .buttonStyle(TEButtonStyle(kind: .accent))

                // Only when the recorder is idle. A live recording already has the
                // always-visible `RecordingBanner`, and an unsaved one has the card
                // above; a third control would be a third answer to the same question.
                if recorder.phase == .idle {
                    Button("Record laps") {
                        router.push(.record(eventId: model.todaysEvent?.id))
                    }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityIdentifier("dashboardRecord")
                    .accessibilityLabel(Self.recordLabel(model.todaysEvent))
                }
            }

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

            if !model.garage.isEmpty {
                TESectionHeader("Garage")
                ForEach(model.garage) { vehicle in
                    garageCard(vehicle)
                }
            }
        }
        .refreshable { await model.load() }
    }

    /// Where the laps are going to land, said out loud. The button can't carry a
    /// subtitle without pushing the fold down on every day that isn't a track day,
    /// but a screen reader can have the whole sentence for free.
    private static func recordLabel(_ event: Event?) -> String {
        guard let event else { return "Record laps. No event today — the recording is saved to one afterwards." }
        return "Record laps at \(event.trackName)"
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
                Text(verbatim: "\(done)/\(items.count)")
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
            // The text column sets the row's height and the sparkline fills it, so the
            // trend line reads as part of the card rather than a stamp floating in it.
            // `.fixedSize(vertical:)` is what pins that height to the text: without it
            // the flexible chart and the flexible stack negotiate with each other and
            // the row collapses.
            //
            // Since the text is the only thing setting the height, the name reserves two
            // lines whether it needs them or not — that's what makes every card in the
            // list the same height instead of a row of ragged ones, and two lines is
            // what a track name with its layout suffix ("… — Grand West") actually
            // takes at this width.
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.name)
                        .teStyle(.h3)
                        .lineLimit(2, reservesSpace: true)
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
                .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 0)
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

    // MARK: - Garage cards

    /// A car's accrued hours and the worst thing fitted to it — enough to know
    /// whether the garage needs opening before the next event.
    private func garageCard(_ vehicle: GarageVehicle) -> some View {
        let active = vehicle.parts.filter { $0.retiredOn == nil }
        let worst = Garage.garageAlerts([vehicle]).first?.status
        return TENavCard(route: .vehicle(vehicle.id), identifier: "garageCard") {
            Text(vehicle.name)
                .teStyle(.h3)
                .foregroundStyle(Color(.textStrong))
            Text(Garage.fmtHours(vehicle.hours))
                .teStyle(.lapTimeHero)
                .foregroundStyle(Color(.textStrong))
            TEMeta([
                fmtCount(vehicle.eventDays, "track day"),
                "\(fmtCount(active.count, "part")) in service"
            ])
            Text(Self.garageStatusLine(worst: worst, activeParts: active.count))
                .teStyle(.xs)
                .foregroundStyle((worst ?? .ok).ink)
        }
    }

    private static func garageStatusLine(worst: Garage.PartStatus?, activeParts: Int) -> String {
        switch worst {
        case .due: "Replace something now"
        case .low: "Something's due soon"
        // No alert isn't the same as nothing fitted: an empty garage card says so
        // rather than claiming everything's healthy.
        case .ok, nil: activeParts == 0 ? "No consumables tracked yet" : "Nothing due"
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
                    route: .record(eventId: eventId),
                    discardable: true
                )
            } else {
                banner(
                    title: "Unsaved track recording",
                    hint: "Create its event to pick the start/finish line and save the laps, or discard it.",
                    action: "+ Add event",
                    route: .eventForm(.new(presetTrack: nil)),
                    discardable: true
                )
            }
        }
    }

    private var stoppedRecording: Recording? {
        guard case .stopped = recorder.phase else { return nil }
        return recorder.recording
    }

    /// `discardable` offers the way out alongside the way forward: an unsaved
    /// recording you've decided not to keep can be thrown away from here, without
    /// creating an event for it just to reach a discard button. Destructive, so it
    /// asks first — the trace is the only copy.
    private func banner(
        title: String,
        hint: String,
        action: String,
        route: Route,
        discardable: Bool = false
    ) -> some View {
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
                HStack(spacing: TESpacing.gridGap) {
                    Button(action) { router.push(route) }
                        .buttonStyle(TEButtonStyle(kind: .accent))
                    if discardable {
                        Button("Discard") { showingDiscardConfirmation = true }
                            .buttonStyle(TEButtonStyle(kind: .danger))
                            .accessibilityIdentifier("dashboardDiscardRecording")
                    }
                }
            }
        }
        .confirmationDialog(
            "Discard this recording?",
            isPresented: $showingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) { recorder.discard() }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The GPS trace is deleted from this device and can't be recovered.")
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
    private(set) var garage: [GarageVehicle] = []

    init(api: APIClient) {
        self.api = api
    }

    /// Four requests, in parallel — all four read through the offline cache, so
    /// this works in the paddock as long as the dashboard has been seen once.
    ///
    /// The garage is the one that's allowed to fail. It is a section of this
    /// screen rather than the screen itself, and failing the whole dashboard
    /// because a user's empty garage 500'd would be the wrong trade.
    func load() async {
        async let garageList = try? api.garage()
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
        garage = await garageList ?? []
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

    /// The event a recording started from the dashboard attaches to.
    ///
    /// Deliberately `RemoteRecording.pickRecordingEvent` — the *same* rule CarPlay
    /// uses — so a session started on the phone and one started from the head unit
    /// can never disagree about where the laps belong. It reads the already-loaded
    /// event list, so the button costs no request and works offline.
    ///
    /// nil means record unattached, which is a normal outcome rather than a failure:
    /// the event often doesn't exist until after the session is driven, and
    /// `recordingBanner` above offers the recording to the first event that opens it.
    var todaysEvent: Event? {
        RemoteRecording.pickRecordingEvent(events, todayIso: RemoteRecording.localTodayIso())
    }
    var alsoUpcoming: [Event] { Array(upcoming.dropFirst()) }
}
