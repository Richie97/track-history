import SwiftUI
import TrackEvolutionKit

/// Turn a stopped recording into a session: pick the start/finish line, check the
/// laps, choose the event, save.
///
/// The web app funnels a recording into the same review flow an imported telemetry
/// file goes through (`reviewResults` in `public/js/import/ui.js`); this is the
/// native version of the recording half. Nothing is destroyed here — the recording
/// stays checkpointed on disk until it is saved or explicitly discarded, including
/// if the save fails.
struct ReviewScreen: View {
    @Environment(RecordingController.self) private var recorder
    @Environment(AuthController.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var model: ReviewModel?
    @State private var showingDiscardConfirmation = false

    var body: some View {
        ScrollView {
            if let model {
                content(model)
            } else {
                ProgressView().padding(40)
            }
        }
        .background(Color(.bgPage))
        .navigationTitle("Review recording")
        .task {
            if model == nil {
                let model = ReviewModel(api: auth.api, recorder: recorder)
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
                dismiss()
            }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The GPS trace is deleted from this device and can't be recovered.")
        }
    }

    @ViewBuilder
    private func content(_ model: ReviewModel) -> some View {
        VStack(alignment: .leading, spacing: TESpacing.gridGap) {
            if model.parsed == nil {
                TECard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Not enough to time")
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Text("""
                            This recording is too short to derive laps from — it needs \
                            at least 30 fixes over a minute of driving.
                            """)
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                    }
                }
            } else {
                pickerCard(model)
                lapsCard(model)
                saveCard(model)
            }

            Button("Discard recording") { showingDiscardConfirmation = true }
                .buttonStyle(TEButtonStyle(kind: .quiet))
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
                Text("Tap the trace where the start/finish line is. Laps are timed each pass across it.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))

                LinePickerView(
                    trace: model.projected,
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

    private func lapsCard(_ model: ReviewModel) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("\(model.laps.count) lap\(model.laps.count == 1 ? "" : "s")")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textMuted))
                    Spacer()
                    if model.isPersonalBest {
                        Text("Personal best")
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.accentContrast))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color(.accent), in: .capsule)
                    }
                }

                if model.laps.isEmpty {
                    Text("Pick a line above to time the laps.")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                } else {
                    ForEach(Array(model.laps.enumerated()), id: \.offset) { index, lap in
                        HStack {
                            Text("Lap \(index + 1)")
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textMuted))
                            Spacer()
                            // The `~` marks a GPS-derived time, exactly as the web
                            // app renders an estimated lap.
                            Text("\(lap.estimated ? "~" : "")\(LapTime.fmtMs(lap.timeMs))")
                                .teStyle(.lapTime)
                                .foregroundStyle(
                                    lap.timeMs == model.bestLapMs ? Color(.accentInk) : Color(.textStrong)
                                )
                        }
                    }
                    Text("Lap times are derived from GPS start/finish crossings (~±0.2–0.5s).")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
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

                TextField("Session label", text: Binding(get: { model.label }, set: { model.label = $0 }))
                    .textFieldStyle(.roundedBorder)
                TextField(
                    "Notes (optional)",
                    text: Binding(get: { model.notes }, set: { model.notes = $0 }),
                    axis: .vertical
                )
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)

                if let error = model.saveError {
                    Text(error)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.dangerInk))
                    Text("The recording is still here — nothing was lost. Try again when you have signal.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                }

                Button(model.isSaving ? "Saving…" : "Save session") {
                    Task {
                        if await model.save() { dismiss() }
                    }
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .disabled(model.laps.isEmpty || model.eventId == nil || model.isSaving)
            }
        }
    }
}

/// The review screen's state: the picked line, the laps it yields, and the save.
@MainActor
@Observable
final class ReviewModel {
    private let api: APIClient
    private let recorder: RecordingController

    private(set) var parsed: ParsedRecording?
    private(set) var projected: [Geo.Projected] = []
    private(set) var pickedIndex: Int?
    private(set) var laps: [Geo.DerivedLap] = []
    /// Why the current pick yielded nothing, in the web app's words.
    private(set) var guidance: String?

    private(set) var events: [Event] = []
    private(set) var loadFailure: String?
    var eventId: Int?
    var label = ""
    var notes = ""
    private(set) var isSaving = false
    private(set) var saveError: String?

    init(api: APIClient, recorder: RecordingController) {
        self.api = api
        self.recorder = recorder
    }

    var bestLapMs: Int? { laps.map(\.timeMs).min() }

    /// Does this session's best beat the event's existing best? Drives the chip and
    /// the celebratory haptic.
    var isPersonalBest: Bool {
        guard let best = bestLapMs, let eventId,
              let event = events.first(where: { $0.id == eventId })
        else { return false }
        guard let previous = event.bestMs else { return true }
        return best < previous
    }

    func load() async {
        parsed = recorder.parsed()
        guard let parsed else { return }
        projected = Geo.projectTrace(parsed.gps)
        // "Recorded 14:32" — the same default the web app's review flow uses.
        label = "Recorded \(parsed.time)"
        eventId = recorder.recording?.eventIdValue

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

    /// Recompute the laps for a picked point.
    func pick(_ index: Int?) {
        pickedIndex = index
        guidance = nil
        laps = []
        guard let index, projected.indices.contains(index) else { return }

        guard let gate = Geo.buildGate(projected, idx: index) else {
            // The car wasn't moving there, so there's no direction of travel to
            // build a gate across.
            guidance = "The car was stationary here, so there's no line to cross — pick a spot where you were moving."
            Haptics.warn()
            return
        }
        laps = Geo.deriveLaps(projected, gate: gate)
        if laps.isEmpty {
            guidance = "No laps cross the picked line — try a different spot."
        }
    }

    /// `POST /events/:id/sessions`. Keeps the recording on any failure.
    func save() async -> Bool {
        guard let eventId, !laps.isEmpty, let pickedIndex,
              let gate = Geo.buildGate(projected, idx: pickedIndex)
        else { return false }

        isSaving = true
        saveError = nil
        defer { isSaving = false }

        let draft = SessionDraft(
            label: label.trimmingCharacters(in: .whitespaces).isEmpty ? nil : label,
            notes: notes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : notes,
            laps: laps.map(\.timeMs),
            // The best lap's downsampled polyline, drawn as the racing line on the
            // event page. `channels` stays nil: per-lap speed channels would need
            // js/import/channels.js ported, and a half-formed shape is rejected by
            // sanitizeChannels with a 400.
            trace: Geo.bestLapTrace(projected, gate: gate),
            channels: nil
        )
        do {
            let personalBest = isPersonalBest
            _ = try await api.createSession(eventId: eventId, draft)
            // Only now is the recording safe to forget.
            recorder.finishSaving()
            if personalBest { Haptics.personalBest() } else { Haptics.confirm() }
            return true
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
}
