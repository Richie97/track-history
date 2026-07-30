import SwiftUI
import TrackEvolutionKit

/// New event, or edit an existing one. `viewEventForm` in `public/app.js` is the
/// reference for fields and copy.
///
/// Two rules this screen exists to not break:
///
/// - **The track name carries the layout.** "Virginia International Raceway (Full)"
///   and "(Patriot)" are different circuits that time differently, and the server
///   resolves tracks by name `COLLATE NOCASE`. So the field is passed through with
///   nothing but a whitespace trim: no title-casing, no punctuation tidying, no
///   collapsing of the parenthetical. Normalizing here silently merges two layouts'
///   personal bests, and there is no undo for that.
/// - **`car` is free text.** The server auto-matches it to a garage vehicle by name.
///   The garage suggestions are a convenience, not a picker — typing a car that
///   isn't in the garage has to keep working.
struct EventFormScreen: View {
    let target: EventFormTarget

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    @State private var model: EventFormModel?

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model {
                form(model)
            }
        }
        .navigationTitle(model?.isEditing == true ? "Edit event" : "New event")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = EventFormModel(api: auth.api, target: target)
                self.model = model
                await model.load()
            }
        }
    }

    private func form(_ model: EventFormModel) -> some View {
        // Every field is owned by the model, so the bindings come from it: a form this
        // long with @State per field would drift out of step with a re-load.
        @Bindable var model = model
        return TEPage {
            TECard {
                VStack(alignment: .leading, spacing: 16) {
                    TEField(
                        label: "Track",
                        hint: """
                            Pick from your tracks and known US tracks, or type a new name — layouts time \
                            differently, so name them separately ("Virginia International Raceway (Full)" \
                            vs "(Patriot)") to keep PBs honest
                            """
                    ) {
                        SuggestingField(
                            placeholder: "Virginia International Raceway (Full)",
                            text: $model.trackName,
                            options: model.trackOptions
                        )
                    }

                    TEField(label: "Start date") {
                        DatePicker(
                            "Start date",
                            selection: $model.startDate,
                            displayedComponents: .date
                        )
                        .labelsHidden()
                        .datePickerStyle(.compact)
                    }

                    TEField(label: "Days", hint: "Half days count — a Saturday plus a Sunday morning is 1.5") {
                        HStack(spacing: 12) {
                            Text(fmtDays(model.days))
                                .teStyle(.bodyStrong)
                                .foregroundStyle(Color(.textStrong))
                            Stepper("Days", value: $model.days, in: 0.5...30, step: 0.5)
                                .labelsHidden()
                        }
                    }

                    TEField(
                        label: "On-track hours (optional)",
                        hint: "Seat time for consumable wear tracking — leave blank for the 2h-per-day estimate"
                    ) {
                        TextField("est. 2h per day", text: $model.trackHours)
                            .teInput()
                            .keyboardType(.decimalPad)
                    }

                    TEField(label: "Club / organizer") {
                        TextField("VIR Club", text: $model.club)
                            .teInput()
                    }

                    TEField(label: "Run group") {
                        TextField("High Speed", text: $model.runGroup)
                            .teInput()
                    }

                    TEField(label: "Car", hint: "Pick from your garage or type anything") {
                        SuggestingField(
                            placeholder: "Corvette Z06, Miata, GT3…",
                            text: $model.car,
                            options: model.carOptions
                        )
                    }

                    TEField(label: "Conditions") {
                        Picker("Conditions", selection: $model.conditions) {
                            Text("—").tag(Conditions?.none)
                            ForEach(Conditions.all, id: \.rawValue) { condition in
                                Text(condition.label).tag(Optional(condition))
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    TEField(label: "Temp °F (optional)") {
                        TextField("72", text: $model.tempF)
                            .teInput()
                            .keyboardType(.numbersAndPunctuation)
                    }

                    TEField(
                        label: "Best time (optional)",
                        hint: "Only needed when you don't log laps — logged laps compute this automatically"
                    ) {
                        TextField("2:01.24", text: $model.bestTime)
                            .teInput()
                            .keyboardType(.numbersAndPunctuation)
                            .autocorrectionDisabled()
                    }

                    TEField(label: "Notes") {
                        TextField("Weather, setup changes, incidents…", text: $model.notes, axis: .vertical)
                            .teInput()
                            .lineLimit(3...6)
                    }
                }
            }

            if let error = model.error {
                TEErrorBanner(message: error)
            }

            Button(model.isSaving ? "Saving…" : (model.isEditing ? "Save changes" : "Create event")) {
                Task {
                    guard let id = await model.save() else { return }
                    Haptics.confirm()
                    if model.isEditing {
                        dismiss()
                    } else {
                        // Replace the form in the stack with the event it created:
                        // going "back" from a new event should reach the dashboard,
                        // not the form again.
                        router.path = [.event(id)]
                    }
                }
            }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .disabled(model.isSaving || model.trackName.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        // The keyboard must not cover the field being typed into; a form this long
        // needs the scroll view to dismiss it interactively too.
        .scrollDismissesKeyboard(.interactively)
    }
}

/// A text field with suggestions under it — the native counterpart to `bindCombo`.
///
/// Free text with hints, **not** a picker: the track field has to accept a circuit
/// the catalog has never heard of, and the car field a car that isn't in the garage.
struct SuggestingField: View {
    let placeholder: String
    @Binding var text: String
    let options: [String]

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(placeholder, text: $text)
                .teInput()
                .autocorrectionDisabled()
                // Track names are proper nouns with parenthetical layouts; iOS
                // autocapitalization would fight the user on "(Full)" vs "(full)"
                // and the server matches case-insensitively anyway.
                .textInputAutocapitalization(.words)
                .focused($focused)

            if focused, !matches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(matches, id: \.self) { option in
                            Button(option) {
                                text = option
                                focused = false
                            }
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textBody))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color(.surfaceRaised), in: .capsule)
                            .overlay(Capsule().strokeBorder(Color(.borderHairline), lineWidth: 1))
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    /// Substring matching, case-insensitive, capped so the strip stays a strip.
    private var matches: [String] {
        let query = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return Array(options.prefix(8)) }
        // An exact hit needs no suggestion — offering the thing already typed is noise.
        if options.count == 1, options[0].lowercased() == query { return [] }
        return Array(options.filter { $0.lowercased().contains(query) }.prefix(8))
    }
}

/// The form's fields and the one write it makes.
@MainActor
@Observable
final class EventFormModel {
    private let api: APIClient
    let target: EventFormTarget

    private(set) var state: LoadState = .loading
    private(set) var isSaving = false
    var error: String?

    // Fields, as strings where the server takes a nullable column: an empty string
    // is "clear it", which a numeric binding can't express.
    var trackName = ""
    var startDate = Date()
    var days: Double = 2
    var trackHours = ""
    var club = ""
    var runGroup = ""
    var car = ""
    var conditions: Conditions?
    var tempF = ""
    var bestTime = ""
    var notes = ""

    private(set) var trackOptions: [String] = []
    private(set) var carOptions: [String] = []
    /// The track id the event already has, so an unedited name doesn't re-resolve.
    private var existingTrackId: Int?

    init(api: APIClient, target: EventFormTarget) {
        self.api = api
        self.target = target
    }

    var isEditing: Bool {
        if case .edit = target { return true }
        return false
    }

    func load() async {
        do {
            async let tracks = api.tracks()
            async let catalog = api.catalog()
            // The garage is deferred, but `/vehicles` is the car field's suggestion
            // list and the source of the default car on a new event.
            async let vehicles = api.vehicles()
            let loaded = try await (tracks: tracks, catalog: catalog, vehicles: vehicles)

            // Your own tracks first, then the rest of the seeded catalog.
            let own = loaded.tracks.map(\.name)
            let seen = Set(own.map { $0.lowercased() })
            trackOptions = own + loaded.catalog.map(\.name).filter { !seen.contains($0.lowercased()) }
            carOptions = loaded.vehicles.map(\.name)

            switch target {
            case .new(let presetTrack):
                trackName = presetTrack ?? ""
                car = loaded.vehicles.first(where: \.isDefault)?.name ?? ""
            case .edit(let id):
                let detail = try await api.event(id: id)
                fill(from: detail.event)
            }
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func fill(from event: Event) {
        trackName = event.trackName
        existingTrackId = event.trackId
        startDate = EventDates.date(fromISO: event.startDate) ?? Date()
        days = event.days
        trackHours = event.trackHours.map { fmtNumber($0) } ?? ""
        club = event.club ?? ""
        runGroup = event.runGroup ?? ""
        car = event.car ?? ""
        conditions = event.conditions
        tempF = event.tempF.map(String.init) ?? ""
        bestTime = event.bestTimeMs.map { LapTime.fmtMs($0) } ?? ""
        notes = event.notes ?? ""
    }

    /// Create or update. Returns the event's id on success.
    func save() async -> Int? {
        error = nil
        // Trim only. See the note on the screen: any further normalization merges
        // layouts that must stay apart.
        let name = trackName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            error = "A track name is required."
            return nil
        }
        let raw = bestTime.trimmingCharacters(in: .whitespaces)
        let best = raw.isEmpty ? nil : LapTime.parseTime(raw)
        if !raw.isEmpty, best == nil {
            error = "Couldn't parse best time \"\(raw)\" — use 2:01.24 format."
            return nil
        }
        let hoursRaw = trackHours.trimmingCharacters(in: .whitespaces)
        if !hoursRaw.isEmpty, Double(hoursRaw) == nil {
            error = "Couldn't parse on-track hours \"\(hoursRaw)\" — use a number like 4 or 4.5."
            return nil
        }

        isSaving = true
        defer { isSaving = false }

        let iso = EventDates.isoString(from: startDate)
        do {
            switch target {
            case .new:
                var draft = EventDraft(startDate: iso, trackName: name)
                draft.days = days
                draft.trackHours = Double(hoursRaw)
                draft.club = nilIfEmpty(club)
                draft.runGroup = nilIfEmpty(runGroup)
                draft.car = nilIfEmpty(car)
                draft.conditions = conditions
                draft.tempF = Int(tempF.trimmingCharacters(in: .whitespaces))
                draft.bestTimeMs = best
                draft.notes = nilIfEmpty(notes)
                return try await api.createEvent(draft)
            case .edit(let id):
                var patch = EventPatch()
                // The name is always sent: the server find-or-creates the track from
                // it, which is also how an event moves between layouts.
                patch.trackName = .set(name)
                patch.startDate = .set(iso)
                patch.days = .set(days)
                patch.trackHours = .set(Double(hoursRaw))
                patch.club = .set(nilIfEmpty(club))
                patch.runGroup = .set(nilIfEmpty(runGroup))
                patch.car = .set(nilIfEmpty(car))
                patch.conditions = .set(conditions)
                patch.tempF = .set(Int(tempF.trimmingCharacters(in: .whitespaces)))
                patch.bestTimeMs = .set(best)
                patch.notes = .set(nilIfEmpty(notes))
                try await api.updateEvent(id: id, patch)
                return id
            }
        } catch let error as APIError {
            self.error = error.message
            return nil
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    private func nilIfEmpty(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// "4" not "4.0" — the hours field is typed by hand and read back.
    private func fmtNumber(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}
