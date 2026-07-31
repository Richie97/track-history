import SwiftUI
import TrackEvolutionKit

/// Turn telemetry into sessions: pick the start/finish line, check the laps,
/// choose the event, save.
///
/// One screen for two sources, because the web app funnels both into one
/// `reviewResults` (`public/js/import/ui.js`): a stopped phone recording (NS-17)
/// and a video imported from Files or Photos (NS-30). What differs is small and
/// stays behind `Source` — a recording can be discarded and stays checkpointed on
/// disk until it is saved or explicitly discarded, including if the save fails; an
/// import has nothing to keep, and can be several clips at once.
struct ReviewScreen: View {
    /// What is being reviewed.
    enum Source {
        /// The app-global recorder's stopped recording.
        case recording
        /// Clips picked and parsed by `TelemetryImporter`.
        case imported([ImportedClip])
    }

    var source: Source = .recording
    /// The event an import came from, pre-selected in the picker below. A
    /// recording gets this from its own checkpoint instead.
    var preferredEventId: Int?
    /// Where to go once the recording is discarded — see `RecordingScreen.onFinish`.
    var onFinish: (() -> Void)?

    @Environment(RecordingController.self) private var recorder
    @Environment(AuthController.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var model: ReviewModel?
    @State private var showingDiscardConfirmation = false

    private var isRecording: Bool {
        if case .recording = source { return true }
        return false
    }

    var body: some View {
        ScrollView {
            if let model {
                content(model)
            } else {
                ProgressView().padding(40)
            }
        }
        .background(Color(.bgPage))
        .navigationTitle(isRecording ? "Review recording" : "Review import")
        .task {
            if model == nil {
                let model = ReviewModel(
                    api: auth.api,
                    recorder: isRecording ? recorder : nil,
                    source: source,
                    preferredEventId: preferredEventId
                )
                self.model = model
                await model.load()
            }
        }
        .confirmationDialog(
            "Discard this recording?",
            isPresented: $showingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                recorder.discard()
                // Out of the recorder entirely, not back one step onto a Start button.
                if let onFinish { onFinish() } else { dismiss() }
            }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The GPS trace is deleted from this device and can't be recovered.")
        }
    }

    @ViewBuilder
    private func content(_ model: ReviewModel) -> some View {
        VStack(alignment: .leading, spacing: TESpacing.gridGap) {
            if model.items.isEmpty {
                TECard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(isRecording ? "Not enough to time" : "Nothing to import")
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Text(
                            isRecording
                                ? """
                                This recording is too short to derive laps from — it needs \
                                at least 30 fixes over a minute of driving.
                                """
                                : "None of the videos you picked carried telemetry."
                        )
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                    }
                }
            } else {
                if model.needsLinePick {
                    pickerCard(model)
                }
                ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                    itemCard(model, index: index, item: item)
                }
                saveCard(model)
            }

            if isRecording {
                Button("Discard recording") { showingDiscardConfirmation = true }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            }
        }
        .padding(TESpacing.pageGutter)
    }

    // MARK: - Cards

    private func pickerCard(_ model: ReviewModel) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Start/finish line")
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textMuted))
                Text(model.pickerHint)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))

                LinePickerView(
                    trace: model.pickTrace,
                    pickedIndex: Binding(
                        get: { model.pickedIndex },
                        set: { model.pick($0) }
                    )
                )
                .frame(height: 280)

                if let guidance = model.guidance {
                    Text(guidance)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.dangerInk))
                }
            }
        }
    }

    private func itemCard(_ model: ReviewModel, index: Int, item: ReviewItem) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                if !item.file.isEmpty {
                    HStack(alignment: .firstTextBaseline) {
                        if model.items.count > 1 {
                            Toggle(
                                "",
                                isOn: Binding(
                                    get: { model.items[index].include },
                                    set: {
                                    model.items[index].include = $0
                                    model.items[index].includeTouched = true
                                }
                                )
                            )
                            .labelsHidden()
                            .disabled(item.parsed?.laps.isEmpty ?? true)
                            .accessibilityLabel("Include \(item.file)")
                        }
                        Text(item.file)
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Spacer()
                    }
                    if let meta = model.meta(for: item) {
                        Text(meta)
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    }
                }

                if let error = item.error {
                    TEErrorBanner(message: error)
                }

                if let parsed = item.parsed {
                    HStack {
                        Text("\(parsed.laps.count) lap\(parsed.laps.count == 1 ? "" : "s")")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textMuted))
                        Spacer()
                        if model.isPersonalBest(item) {
                            Text("Personal best")
                                .teStyle(.xxs)
                                .foregroundStyle(Color(.accentContrast))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color(.accent), in: .capsule)
                        }
                    }

                    if parsed.laps.isEmpty {
                        Text(model.noLapsHint(for: parsed))
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                    } else {
                        ForEach(Array(parsed.laps.enumerated()), id: \.offset) { lapIndex, lap in
                            HStack {
                                // `String(...)`: a lap number is an identifier, so it must
                                // not pick up the locale's grouping separator the way a
                                // count should. Same as the event page's lap rows.
                                Text("Lap \(String(lapIndex + 1))")
                                    .teStyle(.sm)
                                    .foregroundStyle(Color(.textMuted))
                                Spacer()
                                // The `~` marks a derived time, exactly as the web
                                // app renders an estimated lap.
                                Text("\(lap.estimated ? "~" : "")\(LapTime.fmtMs(lap.timeMs))")
                                    .teStyle(.lapTime)
                                    .foregroundStyle(
                                        lap.timeMs == model.bestLapMs(item)
                                            ? Color(.accentInk) : Color(.textStrong)
                                    )
                            }
                        }
                        if let note = model.lapNote(for: parsed) {
                            Text(note)
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textFaint))
                        }
                    }

                    if let metrics = model.metrics(for: parsed) {
                        Text(metrics)
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    }

                    TextField(
                        "Session label",
                        text: Binding(
                            get: { model.items[index].label },
                            set: { model.items[index].label = $0 }
                        )
                    )
                    .textFieldStyle(.roundedBorder)
                }
            }
        }
    }

    private func saveCard(_ model: ReviewModel) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Save to")
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textMuted))

                if model.events.isEmpty {
                    Text(
                        model.loadFailure
                            ?? "No events yet — create one in the app, then come back to save this."
                    )
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                } else {
                    Picker("Event", selection: Binding(get: { model.eventId }, set: { model.eventId = $0 })) {
                        ForEach(model.events) { event in
                            Text("\(event.trackName) · \(event.startDate)").tag(Optional(event.id))
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Color(.accentInk))
                }

                if isRecording {
                    TextField(
                        "Notes (optional)",
                        text: Binding(get: { model.notes }, set: { model.notes = $0 }),
                        axis: .vertical
                    )
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)
                }

                if let error = model.saveError {
                    Text(error)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.dangerInk))
                    if isRecording {
                        Text("The recording is still here — nothing was lost. Try again when you have signal.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }

                Button(model.isSaving ? "Saving…" : model.saveTitle) {
                    Task {
                        if await model.save() { dismiss() }
                    }
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .disabled(!model.canSave)
            }
        }
    }
}

/// One thing being reviewed: a recording, or one clip out of an import.
struct ReviewItem: Identifiable {
    let id: UUID
    /// The file's name. Empty for a phone recording, which has no file.
    var file: String
    var parsed: ParsedTelemetry?
    /// Why this clip yielded nothing.
    var error: String?
    /// Whether it gets saved as a session.
    var include: Bool
    /// Whether the driver has changed `include` by hand. Until they do, a line
    /// pick that produces laps re-checks the clip — the web app's rule, where a
    /// disabled checkbox defaults back to checked once there is something to save.
    var includeTouched = false
    var label: String
}

/// The review screen's state: the picked line, the laps it yields, and the save.
@MainActor
@Observable
final class ReviewModel {
    private let api: APIClient
    /// nil for an import — only a live recording has a checkpoint to keep, and
    /// only it can be discarded.
    private let recorder: RecordingController?
    private let source: ReviewScreen.Source
    private let preferredEventId: Int?

    var items: [ReviewItem] = []

    /// The shared projection frame: one picked line applies to every trace in the
    /// batch, which only means anything if they are all projected the same way.
    private(set) var origin: Geo.Point?
    private(set) var pickTrace: [Geo.Projected] = []
    private(set) var pickedIndex: Int?
    /// Why the current pick yielded nothing, in the web app's words.
    private(set) var guidance: String?

    private(set) var events: [Event] = []
    private(set) var loadFailure: String?
    var eventId: Int?
    var notes = ""
    private(set) var isSaving = false
    private(set) var saveError: String?

    init(
        api: APIClient,
        recorder: RecordingController?,
        source: ReviewScreen.Source,
        preferredEventId: Int? = nil
    ) {
        self.api = api
        self.recorder = recorder
        self.source = source
        self.preferredEventId = preferredEventId
    }

    // MARK: - Derived state

    var needsLinePick: Bool {
        !pickTrace.isEmpty
    }

    var pickerHint: String {
        let live = items.allSatisfy { $0.parsed?.kind == .live }
        let prefix = live
            ? "Your recording has a GPS trace"
            : "This footage has GPS data but no lap markers"
        return "\(prefix). Tap the trace where the start/finish line is — laps are timed each pass across it."
    }

    var saveTitle: String {
        selectedCount > 1 ? "Save \(selectedCount) sessions" : "Save session"
    }

    var canSave: Bool {
        selectedCount > 0 && eventId != nil && !isSaving
    }

    private var selectedCount: Int {
        items.filter { $0.include && !($0.parsed?.laps.isEmpty ?? true) }.count
    }

    func bestLapMs(_ item: ReviewItem) -> Int? {
        item.parsed?.laps.map(\.timeMs).min()
    }

    /// Does this clip's best beat the event's existing best? Drives the chip and
    /// the celebratory haptic.
    func isPersonalBest(_ item: ReviewItem) -> Bool {
        guard let best = bestLapMs(item), let eventId,
              let event = events.first(where: { $0.id == eventId })
        else { return false }
        guard let previous = event.bestMs else { return true }
        return best < previous
    }

    /// "2026-06-20 09:15:00 · 3 min" — a clip's own header line.
    func meta(for item: ReviewItem) -> String? {
        guard let parsed = item.parsed else { return nil }
        var parts: [String] = []
        if let date = parsed.date { parts.append(date) }
        if let time = parsed.time { parts.append(time) }
        parts.append("\(Int((parsed.durationS / 60).rounded())) min")
        return parts.joined(separator: " · ")
    }

    func metrics(for parsed: ParsedTelemetry) -> String? {
        let summary = Telemetry.metricsSummary(parsed)
        return summary.isEmpty ? nil : summary
    }

    func lapNote(for parsed: ParsedTelemetry) -> String? {
        let estCount = parsed.laps.filter(\.estimated).count
        let note = Telemetry.estimatedNote(parsed, estCount: estCount)
        return note.isEmpty ? nil : "~ = \(note)"
    }

    func noLapsHint(for parsed: ParsedTelemetry) -> String {
        if parsed.needsLine {
            return pickedIndex == nil
                ? "\(parsed.gps?.count ?? 0) GPS points — set the start/finish line above to time laps."
                : "No laps cross the picked line — try a different spot."
        }
        if parsed.kind == .pdr, parsed.beaconCount == 0 {
            return "No laps found — no beacons, and the telemetry shows no repeating lap pattern (pit/paddock footage?)."
        }
        return "No complete laps found (no start/finish crossings in telemetry)."
    }

    // MARK: - Loading

    func load() async {
        switch source {
        case .recording:
            if let parsed = recorder?.parsed()?.asTelemetry {
                items = [
                    ReviewItem(
                        id: UUID(),
                        file: "",
                        parsed: parsed,
                        error: nil,
                        include: true,
                        // "Recorded 14:32" — the same default the web app's review flow uses.
                        label: "Recorded \(parsed.time ?? "")"
                    )
                ]
            }
            eventId = recorder?.recording?.eventIdValue
        case .imported(let clips):
            items = clips.map { clip in
                ReviewItem(
                    id: clip.id,
                    file: clip.file,
                    parsed: clip.parsed,
                    error: clip.error,
                    include: !(clip.parsed?.laps.isEmpty ?? true),
                    label: clip.parsed.map { Telemetry.defaultLabel($0, file: clip.file) } ?? clip.file
                )
            }
            eventId = preferredEventId
        }
        rebuildPickTrace()

        do {
            events = try await api.events()
            // Newest first: a session being saved almost always belongs to the
            // most recent event.
            events.sort { $0.startDate > $1.startDate }
            if eventId == nil { eventId = events.first?.id }
        } catch let error as APIError {
            loadFailure = "Couldn't load your events: \(error.message)"
        } catch {
            loadFailure = "Couldn't load your events: \(error.localizedDescription)"
        }
    }

    /// The trace the picker draws: the longest one still waiting for a line, in
    /// the batch's shared frame. `reduce` rather than `max(by:)` so ties keep the
    /// *first* candidate, as the JS does.
    private func rebuildPickTrace() {
        let candidates = items.compactMap(\.parsed).filter { $0.needsLine && !($0.gps ?? []).isEmpty }
        guard let first = candidates.first else {
            origin = nil
            pickTrace = []
            return
        }
        origin = first.gps?.first
        let longest = candidates.dropFirst().reduce(first) {
            ($1.gps?.count ?? 0) > ($0.gps?.count ?? 0) ? $1 : $0
        }
        guard let gps = longest.gps, let origin else {
            pickTrace = []
            return
        }
        pickTrace = Geo.projectTrace(gps, origin: Geo.Origin(lat: origin.lat, lon: origin.lon))
    }

    // MARK: - Picking

    /// Recompute every waiting clip's laps for a picked point.
    func pick(_ index: Int?) {
        pickedIndex = index
        guidance = nil
        guard let index, pickTrace.indices.contains(index) else {
            applyGate(nil)
            return
        }
        guard let gate = Geo.buildGate(pickTrace, idx: index) else {
            // The car wasn't moving there, so there's no direction of travel to
            // build a gate across.
            guidance = "The car was stationary here, so there's no line to cross — pick a spot where you were moving."
            Haptics.warn()
            applyGate(nil)
            return
        }
        applyGate(gate)
        if items.allSatisfy({ ($0.parsed?.laps ?? []).isEmpty }) {
            guidance = "No laps cross the picked line — try a different spot."
        }
    }

    private func applyGate(_ gate: Geo.Gate?) {
        for i in items.indices {
            guard var parsed = items[i].parsed, parsed.needsLine else { continue }
            Telemetry.applyGate(&parsed, origin: origin, gate: gate)
            items[i].parsed = parsed
            // A clip that only just produced laps becomes includable, and a pick
            // that took them away must not stay checked — unless the driver has
            // already made that choice themselves.
            if !items[i].includeTouched { items[i].include = !parsed.laps.isEmpty }
        }
    }

    // MARK: - Saving

    /// `POST /events/:id/sessions` per included clip. Keeps a recording on any
    /// failure — it is only forgotten once the server has it.
    func save() async -> Bool {
        guard let eventId else { return false }
        let selected = items.indices.filter { items[$0].include && !(items[$0].parsed?.laps.isEmpty ?? true) }
        guard !selected.isEmpty else { return false }

        isSaving = true
        saveError = nil
        defer { isSaving = false }

        let personalBest = selected.contains { isPersonalBest(items[$0]) }
        for i in selected {
            let item = items[i]
            guard let parsed = item.parsed else { continue }
            let label = item.label.trimmingCharacters(in: .whitespaces)
            let draft = SessionDraft(
                label: label.isEmpty ? nil : label,
                notes: notesFor(item, parsed),
                laps: parsed.laps.map(\.timeMs),
                // The best lap's downsampled polyline, drawn as the racing line on
                // the event page, plus the per-lap channel arrays the lap overlay
                // (NS-23) draws. Both are produced by the same pick that timed the
                // laps, so neither needs recomputing here.
                trace: parsed.bestLapTrace,
                channels: parsed.lapChannels
            )
            do {
                _ = try await api.createSession(eventId: eventId, draft)
            } catch let error as APIError {
                saveError = error.message
                Haptics.warn()
                return false
            } catch {
                saveError = error.localizedDescription
                Haptics.warn()
                return false
            }
        }
        // Only now is the recording safe to forget.
        recorder?.finishSaving()
        if personalBest { Haptics.personalBest() } else { Haptics.confirm() }
        return true
    }

    /// A recording's notes are whatever the driver typed; an import's are the line
    /// the web importer writes, so the same file reads identically either way.
    private func notesFor(_ item: ReviewItem, _ parsed: ParsedTelemetry) -> String? {
        if parsed.kind == .live {
            let typed = notes.trimmingCharacters(in: .whitespaces)
            return typed.isEmpty ? nil : typed
        }
        return Telemetry.importNotes(parsed, file: item.file)
    }
}
