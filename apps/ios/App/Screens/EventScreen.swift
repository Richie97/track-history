import SwiftUI
import TrackEvolutionKit

/// A track day: what the car did, session by session.
///
/// `viewEvent` in `public/app.js` is the reference for behavior and copy. Built on
/// `List` rather than a `ScrollView` specifically for swipe-to-delete on laps and
/// sessions — the web app has a Delete button per row because it has no gesture to
/// reach for, and porting that button instead of the gesture would be porting the
/// workaround.
///
/// Out of scope here, and absent rather than stubbed: the per-day setup notebook,
/// the setup-vs-lap-times diff, and telemetry file import — all web-only
/// (`docs/specs/native/README.md`). The lap *recorder* is native, and its entry
/// point is the panel near the bottom.
struct EventScreen: View {
    let eventId: Int

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(RecordingController.self) private var recorder
    @Environment(\.dismiss) private var dismiss

    @State private var model: EventModel?
    @State private var editingSession: Session?
    @State private var confirmingDeleteEvent = false
    @State private var newChecklistItem = ""
    @State private var newSession = SessionFormFields()
    @State private var appendLapText: [Int: String] = [:]
    /// The session whose lap overlay is open, if any.
    @State private var channelSession: Session?

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let detail = model.detail {
                list(model, detail)
            }
        }
        .navigationTitle(model?.event?.trackName ?? "Event")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let model, model.detail != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            router.push(.eventForm(.edit(model.eventId)))
                        } label: {
                            Label("Edit event", systemImage: "pencil")
                        }
                        Button(role: .destructive) {
                            confirmingDeleteEvent = true
                        } label: {
                            Label("Delete event", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Event actions")
                    .accessibilityIdentifier("eventMenu")
                }
            }
        }
        .task {
            if model == nil {
                let model = EventModel(api: auth.api, eventId: eventId)
                self.model = model
                await model.load()
            }
        }
        .task(id: model?.state) {
            // An event created offline is renumbered when its create flushes; follow
            // it rather than staying parked on an id the server never had.
            if case .failed = model?.state { await model?.adoptResolvedId() }
        }
        .onChange(of: model?.isDeleted ?? false) { _, deleted in
            if deleted { dismiss() }
        }
        .confirmationDialog(
            "Delete this event and all its sessions and laps?",
            isPresented: $confirmingDeleteEvent,
            titleVisibility: .visible
        ) {
            Button("Delete event", role: .destructive) {
                Task { await model?.deleteEvent() }
            }
            Button("Keep", role: .cancel) {}
        }
        .sheet(item: $channelSession) { session in
            NavigationStack {
                LapChannelChart(channels: session.channels ?? SessionChannels(v: 1, dStepM: 20, laps: []), laps: session.laps)
                    .navigationTitle(session.label ?? "Channel graphs")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { channelSession = nil }
                        }
                    }
            }
        }
        .sheet(item: $editingSession) { session in
            SessionEditSheet(session: session) { label, notes in
                await model?.updateSession(id: session.id, label: label, notes: notes) ?? false
            }
        }
    }

    // MARK: - The page

    private func list(_ model: EventModel, _ detail: EventDetail) -> some View {
        List {
            summarySection(model, detail.event)
            if let error = model.writeError {
                row { TEErrorBanner(message: error) }
            }
            checklistSection(model, detail.event)
            traceSection(detail)
            paceSection(detail)
            ForEach(detail.sessions) { session in
                sessionSection(model, session)
            }
            if detail.sessions.isEmpty {
                row { TEEmpty("No sessions recorded yet.") }
            }
            recorderSection(detail.event)
            importSection(detail.event)
            addSessionSection(model)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(.bgPage))
        .refreshable { await model.load() }
    }

    /// A plain content row: no separator, no inset, transparent — the design system's
    /// cards supply their own surface.
    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 5, leading: TESpacing.pageGutter, bottom: 5, trailing: TESpacing.pageGutter))
    }

    @ViewBuilder
    private func summarySection(_ model: EventModel, _ event: Event) -> some View {
        row {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(event.trackName) — \(EventDates.fmtDate(event.startDate))")
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                TEMeta([
                    [event.club, event.runGroup].compactMap { $0 }.joined(separator: " · "),
                    event.car,
                    conditionsText(event)
                ])
            }
        }

        if EventDates.isUpcoming(event.startDate), let countdown = EventDates.fmtCountdown(event.startDate) {
            row {
                TECard(padding: 14) {
                    Text("**\(countdown)** — log sessions here once you're back from the track.")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textBody))
                }
            }
        }

        row {
            TEStatRow(tiles: [
                TEStatTile(label: "Best time", value: LapTime.fmtMs(event.bestMs), monospaced: true),
                TEStatTile(label: "Days", value: fmtDays(event.days)),
                TEStatTile(label: "Laps recorded", value: "\(event.lapCount)"),
                TEStatTile(label: "Consistency", value: LapTime.fmtConsistency(event.consistency))
            ])
        }

        if let notes = event.notes, !notes.isEmpty {
            row {
                TECard(padding: 14) {
                    Text(notes)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textBody))
                }
            }
        }
    }

    /// Temperature and conditions read as one phrase, like `fmtConditions`.
    private func conditionsText(_ event: Event) -> String? {
        let condition = event.conditions?.label
        let temp = event.tempF.map { "\($0)°F" }
        let parts = [condition, temp].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    // MARK: - Prep checklist

    /// Shown while the event is ahead, and afterwards only if a list exists — a past
    /// event shouldn't grow a prep panel it never had.
    @ViewBuilder
    private func checklistSection(_ model: EventModel, _ event: Event) -> some View {
        let items = event.checklist
        if EventDates.isUpcoming(event.startDate) || items != nil {
            Section {
                ForEach(Array((items ?? []).enumerated()), id: \.offset) { index, item in
                    row {
                        Button {
                            var next = items ?? []
                            next[index].done.toggle()
                            Haptics.select()
                            Task { await model.setChecklist(next) }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(item.done ? Color(.accentInk) : Color(.textFaint))
                                Text(item.text)
                                    .teStyle(.body)
                                    .foregroundStyle(item.done ? Color(.textFaint) : Color(.textBody))
                                    .strikethrough(item.done, color: Color(.textFaint))
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            var next = items ?? []
                            next.remove(at: index)
                            Task { await model.setChecklist(next) }
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }

                row {
                    HStack(spacing: 8) {
                        TextField("Add item…", text: $newChecklistItem)
                            .teInput()
                            .submitLabel(.done)
                            .onSubmit { addChecklistItem(model, items ?? []) }
                        Button("Add") { addChecklistItem(model, items ?? []) }
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.accentInk))
                            .disabled(newChecklistItem.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                if items?.isEmpty ?? true {
                    row {
                        // The user's own list when they have one (Settings → Prep
                        // checklist), else the app's built-in default.
                        Button(auth.hasCustomChecklistTemplate ? "Use my list" : "Use default list") {
                            let template = auth.checklistTemplate
                            Task {
                                await model.setChecklist(
                                    template.map { ChecklistItem(text: $0, done: false) }
                                )
                            }
                        }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .accessibilityIdentifier("useChecklistTemplate")
                    }
                }
            } header: {
                header("Prep checklist")
            }
        }
    }

    private func addChecklistItem(_ model: EventModel, _ items: [ChecklistItem]) {
        let text = newChecklistItem.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        newChecklistItem = ""
        Task { await model.setChecklist(items + [ChecklistItem(text: text, done: false)]) }
    }

    // MARK: - Best lap trace

    /// The racing line of the session holding the fastest lap, among those that
    /// stored a trace (an import, or a phone recording).
    @ViewBuilder
    private func traceSection(_ detail: EventDetail) -> some View {
        if let session = Self.tracedSession(detail.sessions), let best = session.bestLapMs {
            Section {
                row {
                    TECard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text("Brighter is faster")
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textFaint))
                                Spacer()
                                TETime(ms: best, emphasized: true)
                            }
                            TrackMapView(trace: session.trace ?? [])
                                .frame(height: 220)
                        }
                    }
                }
            } header: {
                header("Best lap trace")
            }
        }
    }

    /// Among sessions with a usable trace, the one holding the event's fastest lap.
    static func tracedSession(_ sessions: [Session]) -> Session? {
        sessions
            .filter { ($0.trace?.count ?? 0) >= 10 && !$0.laps.isEmpty }
            .min { ($0.bestLapMs ?? .max) < ($1.bestLapMs ?? .max) }
    }

    // MARK: - Pace through the day

    /// Every lap of the event in running order. The web app has no equivalent — it
    /// charts progress *across* events — but a day's laps in order is the question
    /// you actually ask on the drive home.
    @ViewBuilder
    private func paceSection(_ detail: EventDetail) -> some View {
        let laps = detail.sessions.flatMap(\.lapTimesMs)
        if laps.count >= 3 {
            Section {
                row {
                    TECard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Down is faster")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textFaint))
                            // No `xLabel`: the axis then labels each mark with the
                            // nearest real lap, rather than interpolating positions
                            // into laps that don't exist ("Lap 0").
                            ProgressChart(
                                points: laps.enumerated().map { index, ms in
                                    .init(x: Double(index + 1), label: "Lap \(index + 1)", ms: ms)
                                },
                                unit: "laps"
                            )
                        }
                    }
                }
            } header: {
                header("Lap times")
            }
        }
    }

    // MARK: - Sessions

    private func sessionSection(_ model: EventModel, _ session: Session) -> some View {
        Section {
            if let stats = session.statsSummary {
                row {
                    Text(stats)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
            }
            if let notes = session.notes, !notes.isEmpty {
                row {
                    Text(notes)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textBody))
                }
            }

            channelSection(session)

            ForEach(session.laps) { lap in
                row {
                    HStack {
                        // `String(...)` for the same reason as the copyright year in
                        // Settings: a lap number is an identifier, not a quantity, and
                        // `Text`'s number formatting would render lap 1024 as "1,024".
                        Text("Lap \(String(lap.lapNum))")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                        Spacer()
                        if lap.timeMs == session.bestLapMs {
                            Text("★")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.accentInk))
                        }
                        TETime(ms: lap.timeMs, emphasized: lap.timeMs == session.bestLapMs)
                    }
                }
                .swipeActions {
                    // There is no lap-edit endpoint, so a mistyped lap is deleted and
                    // retyped — which is also what the web app offers.
                    Button(role: .destructive) {
                        Task { await model.deleteLap(id: lap.id) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }

            row {
                HStack(spacing: 8) {
                    TextField(
                        "Add laps: 2:01.24, 2:03.1 …",
                        text: Binding(
                            get: { appendLapText[session.id] ?? "" },
                            set: { appendLapText[session.id] = $0 }
                        )
                    )
                    .teInput()
                    .keyboardType(.numbersAndPunctuation)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { appendLaps(model, session) }
                    Button("Add") { appendLaps(model, session) }
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.accentInk))
                        .disabled((appendLapText[session.id] ?? "").isEmpty)
                }
            }
        } header: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(session.label ?? "Session")
                    .teStyle(.h2)
                    .foregroundStyle(Color(.textStrong))
                if let best = session.bestLapMs {
                    Text("best \(LapTime.fmtMs(best)) · \(fmtCount(session.laps.count, "lap"))")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                } else {
                    Text("no laps")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                }
                Spacer()
                Menu {
                    Button {
                        editingSession = session
                    } label: {
                        Label("Edit label & notes", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        Task { await model.deleteSession(id: session.id) }
                    } label: {
                        Label("Delete session", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(Color(.textMuted))
                        .padding(.leading, 6)
                }
                .accessibilityLabel("Session actions")
            }
            .textCase(nil)
            .padding(.top, 12)
            .padding(.bottom, 4)
            .padding(.horizontal, TESpacing.pageGutter)
            // Same reason as `header(_:)`: pinned headers need an opaque background.
            .background(Color(.bgPage))
            .listRowInsets(EdgeInsets())
        }
    }

    /// The way into the lap overlay, for sessions that carry per-lap channel data —
    /// imports only, so most sessions never show it. Absent rather than empty when
    /// there is nothing to draw: a session recorded on the phone has laps but no
    /// channels, and a door onto an empty room is worse than no door.
    ///
    /// The charts themselves open as a sheet rather than expanding in place; see
    /// `LapChannelChart` for why that isn't only a layout preference.
    @ViewBuilder
    private func channelSection(_ session: Session) -> some View {
        let present = session.channels.map { ChannelGraphs.presentChannels($0) } ?? []
        if !present.isEmpty {
            row {
                Button {
                    channelSession = session
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Channel graphs")
                                .teStyle(.bodyStrong)
                                .foregroundStyle(Color(.textStrong))
                            Text("\(present.map(\.label).joined(separator: " · ")) vs distance")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textMuted))
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.surfaceCard), in: .rect(cornerRadius: TERadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: TERadius.md)
                            .strokeBorder(Color(.borderHairline), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("channelGraphs")
            }
        }
    }

    private func appendLaps(_ model: EventModel, _ session: Session) {
        let text = appendLapText[session.id] ?? ""
        guard !text.isEmpty else { return }
        Task {
            if await model.appendLaps(sessionId: session.id, text: text) {
                appendLapText[session.id] = ""
                Haptics.confirm()
            }
        }
    }

    // MARK: - Recorder entry point

    /// The live lap recorder (NS-17). Doubles as the way back into a running
    /// recording and the recovery path for an unsaved one — and opening it from this
    /// event is what adopts an event-less recording into it.
    private func recorderSection(_ event: Event) -> some View {
        Section {
            row {
                TECard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Record laps with your phone")
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Text("Start before heading out, stow the phone, stop back in the paddock — laps are timed from GPS.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                        Button(recorderCallToAction(event)) {
                            router.push(.record(eventId: recorderTargetEvent(event)))
                        }
                        .buttonStyle(TEButtonStyle(kind: recorderIsBusy ? .accent : .quiet))
                        // The label changes with the recorder's state, so tests reach
                        // it by identifier instead.
                        .accessibilityIdentifier("recordEntry")
                    }
                }
            }
        }
    }

    private var recorderIsBusy: Bool {
        if recorder.isRecording { return true }
        if case .stopped = recorder.phase { return recorder.recording != nil }
        return false
    }

    private func recorderCallToAction(_ event: Event) -> String {
        if recorder.isRecording {
            let attached = recorder.recording?.eventIdValue
            if attached == event.id { return "Recording — open" }
            if attached == nil { return "Recording — attach to this event" }
            return "Recording (other event)"
        }
        if case .stopped = recorder.phase, recorder.recording != nil {
            return "Review unsaved recording"
        }
        return "Start recording"
    }

    /// A recording already attached elsewhere opens *its* event, not this one — the
    /// alternative would silently steal it.
    private func recorderTargetEvent(_ event: Event) -> Int? {
        if recorder.isRecording, let attached = recorder.recording?.eventIdValue, attached != event.id {
            return attached
        }
        return event.id
    }

    // MARK: - Video import entry point

    /// Lap times out of a video already on the phone (NS-30). Only *video* import
    /// is native — `.vbo` and the rest of the desk-bound long tail stay on the web
    /// app (`docs/specs/native/README.md`).
    private func importSection(_ event: Event) -> some View {
        Section {
            row {
                TECard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Import a video")
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Text("PDR and GoPro clips carry telemetry. Pick one from Files or Photos and the laps come out of it — the video stays on this phone.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                        Button("Import video") {
                            router.push(.importVideo(eventId: event.id, incoming: nil))
                        }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .accessibilityIdentifier("importEntry")
                    }
                }
            }
        }
    }

    // MARK: - Add a session

    private func addSessionSection(_ model: EventModel) -> some View {
        Section {
            row {
                TECard {
                    VStack(alignment: .leading, spacing: 12) {
                        TEField(label: "Session label") {
                            TextField("Day 1 — Session 2", text: $newSession.label)
                                .teInput()
                        }
                        TEField(
                            label: "Lap times",
                            hint: "Comma, space or newline separated. Formats: 2:01.24 · 2:01 · 121.24 (seconds)"
                        ) {
                            TextField("2:03.55, 2:01.24, 2:02.61", text: $newSession.laps, axis: .vertical)
                                .teInput()
                                .keyboardType(.numbersAndPunctuation)
                                .autocorrectionDisabled()
                                .lineLimit(2...5)
                        }
                        TEField(label: "Session notes") {
                            TextField("Traffic, tire pressures, line changes…", text: $newSession.notes)
                                .teInput()
                        }
                        Button("Add session") {
                            Task {
                                if await model.addSession(
                                    label: newSession.label, notes: newSession.notes, laps: newSession.laps
                                ) {
                                    newSession = SessionFormFields()
                                    Haptics.confirm()
                                }
                            }
                        }
                        .buttonStyle(TEButtonStyle(kind: .accent))
                    }
                }
            }
        } header: {
            header("Add session")
        }
    }

    /// A section heading. `.listStyle(.plain)` pins headers while you scroll, so this
    /// carries the page background — without it the content scrolls *through* the
    /// heading and the two overlap into unreadable mush.
    private func header(_ title: String) -> some View {
        Text(title)
            .teStyle(.h2)
            .foregroundStyle(Color(.textStrong))
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 12)
            .padding(.bottom, 4)
            .padding(.horizontal, TESpacing.pageGutter)
            .background(Color(.bgPage))
            .listRowInsets(EdgeInsets())
    }
}

/// The add-session form's fields, grouped so clearing them is one assignment.
struct SessionFormFields {
    var label = ""
    var laps = ""
    var notes = ""
}

/// Rename a session, or edit its notes. `PUT /sessions/:id` writes both columns
/// unconditionally, so an emptied field clears it — which is why this edits them
/// together rather than one at a time.
struct SessionEditSheet: View {
    let session: Session
    let save: (String, String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var label: String
    @State private var notes: String
    @State private var isSaving = false

    init(session: Session, save: @escaping (String, String) async -> Bool) {
        self.session = session
        self.save = save
        _label = State(initialValue: session.label ?? "")
        _notes = State(initialValue: session.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            TEPage {
                TEField(label: "Session label") {
                    TextField("Day 1 — Session 2", text: $label)
                        .teInput()
                }
                TEField(label: "Session notes") {
                    TextField("Traffic, tire pressures, line changes…", text: $notes, axis: .vertical)
                        .teInput()
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("Edit session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        isSaving = true
                        Task {
                            if await save(label, notes) { dismiss() }
                            isSaving = false
                        }
                    }
                    .disabled(isSaving)
                }
            }
        }
    }
}
