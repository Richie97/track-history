import SwiftUI
import TrackEvolutionKit

/// One day's setup sheet, logged or edited on the phone (NS-40) — the web's
/// `setupFormHtml` / `readSetupForm` as a pushed page of its own, never a sheet:
/// the event page already presents two, and a form this long belongs in the
/// stack. Android's `SetupFormScreen` is the same form.
///
/// Built from `Garage.SETUP_FIELDS`: each corner group a row of four fields,
/// each axle group a row of two, fuel on its own, then the tire and pad pickers
/// from the car's parts, then the notes.
///
/// **The draft is the typed text**, in the driver's units, one string per flat
/// key ("tp_cold.fl", "fuel"), held on the router (``AppRouter/heldFields``)
/// so crossing 840pt — which tears this view down — keeps it, and converted to
/// stored psi and gallons only on save. `hydratedKey` is Android's `hydrated`
/// rule: once the draft is filled, a later load never overwrites it.
///
/// Where the draft starts, in order: a held draft; `startFrom`, the pressure
/// loop's next-day sheet; the day's own sheet; the server's copy-forward prefill;
/// and, with that unreachable, `Garage.previousSheet` over the cached event.
struct SetupFormScreen: View {
    let eventId: Int
    let day: Int
    let startFrom: SetupSheet?

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    @State private var model: SetupFormModel?
    @State private var confirmingDelete = false

    private var route: Route { .setupForm(eventId: eventId, day: day, startFrom: startFrom) }

    static let hydratedKey = "_hydrated"
    static let notesKey = "notes"

    private func held(_ key: String) -> Binding<String> {
        Binding(
            get: { router.heldText(route, key) },
            set: { router.hold($0, key, route) }
        )
    }

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await load() }) {
            if let model {
                form(model)
            }
        }
        .navigationTitle("Day \(day) setup")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                model = SetupFormModel(api: auth.api, eventId: eventId, day: day, startFrom: startFrom)
                await load()
            }
        }
        .confirmationDialog(
            "Delete the day \(day) setup sheet?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                Task {
                    if await model?.delete() == true { dismiss() }
                }
            }
            Button("Keep", role: .cancel) {}
        }
    }

    /// Load, and fill the draft from where it starts — unless it already holds
    /// the driver's typing.
    private func load() async {
        guard let model else { return }
        let needsStart = router.heldText(route, Self.hydratedKey).isEmpty
        guard let start = await model.load(needsStart: needsStart), needsStart else { return }
        for (key, text) in SetupFormModel.fields(from: start.sheet, units: auth.units) {
            router.hold(text, key, route)
        }
        router.hold(start.sheet?.notes ?? "", Self.notesKey, route)
        router.hold("1", Self.hydratedKey, route)
    }

    private func form(_ model: SetupFormModel) -> some View {
        TEPage {
            if let source = model.source {
                Text(source)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }

            TECard {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Garage.SETUP_FIELDS) { field in
                        fieldRow(field)
                    }
                    ForEach(Garage.PART_REFS) { ref in
                        let options = model.parts.filter { $0.kind == ref.kind }
                        if !options.isEmpty {
                            partPicker(ref, options)
                        }
                    }
                    TEField(label: "Setup notes") {
                        TextField(
                            "What changed and why — pushing in T5, went two clicks stiffer front…",
                            text: held(Self.notesKey),
                            axis: .vertical
                        )
                        .teInput()
                        .lineLimit(3...8)
                        .accessibilityIdentifier("setupNotes")
                    }
                }
            }

            if let error = model.error {
                TEErrorBanner(message: error)
            }

            Button(model.isSaving ? "Saving…" : "Save day \(day) setup") {
                Task {
                    if await model.save(values: router.heldFields[route] ?? [:], units: auth.units) {
                        Haptics.confirm()
                        dismiss()
                    }
                }
            }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .disabled(model.isSaving)
            .accessibilityIdentifier("saveSetup")

            if model.existing {
                Button("Delete this sheet") { confirmingDelete = true }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .disabled(model.isSaving)
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// A corner group's four fields in a row, an axle's two, or fuel alone — the
    /// unit in the label, in the driver's system.
    private func fieldRow(_ field: Garage.SetupField) -> some View {
        let unit = Garage.setupUnit(field, auth.units)
        return TEField(label: unit.isEmpty ? field.label : "\(field.label) (\(unit))") {
            HStack(spacing: 6) {
                ForEach(Garage.flatKeys(field), id: \.self) { key in
                    let sub = Self.subLabel(key, of: field)
                    VStack(alignment: .leading, spacing: 2) {
                        if !sub.isEmpty {
                            Text(sub)
                                .teStyle(.xxs)
                                .foregroundStyle(Color(.textMuted))
                        }
                        TextField(sub.isEmpty ? field.label : sub, text: held(key))
                            .teInput()
                            .keyboardType(.numbersAndPunctuation)
                            .autocorrectionDisabled()
                            .accessibilityLabel(Garage.flatLabel(key))
                            .accessibilityIdentifier("setupField-\(key)")
                    }
                }
            }
        }
    }

    /// Which tire set or pads were on — chosen from the car's parts, retired and
    /// spare ones marked, never typed.
    private func partPicker(_ ref: Garage.PartRef, _ options: [Part]) -> some View {
        TEField(label: ref.label) {
            Picker(ref.label, selection: held(ref.key)) {
                Text("—").tag("")
                ForEach(options) { part in
                    Text(Garage.partTitle(part) + Self.partSuffix(part)).tag(String(part.id))
                }
            }
            .pickerStyle(.menu)
            .tint(Color(.accentInk))
            .accessibilityIdentifier("setupPart-\(ref.key)")
        }
    }

    static func subLabel(_ key: String, of field: Garage.SetupField) -> String {
        let full = Garage.flatLabel(key)
        guard full.hasPrefix(field.label) else { return full }
        return String(full.dropFirst(field.label.count)).trimmingCharacters(in: .whitespaces)
    }

    private static func partSuffix(_ part: Part) -> String {
        if part.retiredOn != nil { return " (retired)" }
        if part.equipped == false { return " (spare)" }
        return ""
    }
}

/// The form's loads and writes; the draft itself lives on the router.
@MainActor
@Observable
final class SetupFormModel {
    private let api: APIClient
    let eventId: Int
    let day: Int
    private let startFrom: SetupSheet?

    private(set) var state: LoadState = .loading
    /// Where the draft came from, said above the form: "Copied from day 1".
    private(set) var source: String?
    /// Whether the day already has a sheet — what offers *Delete*.
    private(set) var existing = false
    /// The event's car's parts, for the tire and pad pickers; empty hides them.
    private(set) var parts: [Part] = []
    var error: String?
    private(set) var isSaving = false

    init(api: APIClient, eventId: Int, day: Int, startFrom: SetupSheet?) {
        self.api = api
        self.eventId = eventId
        self.day = day
        self.startFrom = startFrom
    }

    /// The sheet the draft starts from, wrapped so "start from nothing" (a
    /// first day with no prefill) is distinct from "don't touch the draft".
    struct Start {
        let sheet: SetupSheet?
    }

    /// Load the event and the car's parts. Returns where the draft starts when
    /// `needsStart`, else nil; a failure sets `state`.
    func load(needsStart: Bool) async -> Start? {
        do {
            let detail = try await api.event(id: eventId)
            existing = detail.setups.contains { $0.day == day }
            if let vehicleId = detail.event.vehicleId, let garage = try? await api.garage() {
                parts = garage.first { $0.id == vehicleId }?.parts ?? []
            }
            var start: Start?
            if needsStart {
                if let startFrom {
                    source = "Suggested cold pressures from the pressure loop"
                    start = Start(sheet: startFrom)
                } else if let own = detail.setups.first(where: { $0.day == day })?.data {
                    start = Start(sheet: own)
                } else {
                    start = Start(sheet: await prefill(detail.setups))
                }
            }
            state = .ready
            return start
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
        return nil
    }

    /// The server's copy-forward prefill, else — offline, or a server that can't
    /// be reached — the latest earlier day's sheet from the cached event.
    private func prefill(_ setups: [Setup]) async -> SetupSheet? {
        let local = Garage.previousSheet(setups, day)
        do {
            let remote = try await api.setupPrefill(eventId: eventId, day: day)
            if let remote {
                source = local == remote
                    ? "Copied from day \(dayOf(setups, remote))"
                    : "Copied from your last event in this car"
            }
            return remote
        } catch {
            if let local { source = "Copied from day \(dayOf(setups, local))" }
            return local
        }
    }

    private func dayOf(_ setups: [Setup], _ sheet: SetupSheet) -> Int {
        setups.last { $0.day < day && $0.data == sheet }?.day ?? (day - 1)
    }

    /// The draft from a stored sheet: every value converted into the driver's
    /// units, as typed text by flat key. Notes are the caller's.
    static func fields(from sheet: SetupSheet?, units: UnitSystem) -> [String: String] {
        guard let sheet else { return [:] }
        var out: [String: String] = [:]
        for field in Garage.SETUP_FIELDS {
            for key in Garage.flatKeys(field) {
                if let shown = Garage.setupToDisplay(field, Garage.sheetValue(sheet, key), units) {
                    out[key] = Units.jsNumber(shown)
                }
            }
        }
        for ref in Garage.PART_REFS {
            if let id = Garage.partRefValue(sheet, ref.key) { out[ref.key] = String(id) }
        }
        return out
    }

    /// The sheet a draft spells, in stored units — or the error to show when a
    /// field doesn't read as a number. A comma reads as a decimal point, since
    /// that is what a European keyboard types.
    static func sheet(from values: [String: String], units: UnitSystem) -> Result<SetupSheet, SetupFormError> {
        var out = SetupSheet()
        for field in Garage.SETUP_FIELDS {
            for key in Garage.flatKeys(field) {
                let text = (values[key] ?? "")
                    .trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: ",", with: ".")
                if text.isEmpty { continue }
                guard let v = Double(text), v.isFinite else {
                    return .failure(SetupFormError(message: "Couldn't read \(Garage.flatLabel(key)) \"\(text)\"."))
                }
                out = Garage.withSheetValue(out, key, Garage.setupToStored(field, v, units))
            }
        }
        for ref in Garage.PART_REFS {
            if let id = Int(values[ref.key] ?? "") {
                out = Garage.withSheetValue(out, ref.key, Double(id))
            }
        }
        let notes = (values[SetupFormScreen.notesKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        out.notes = notes.isEmpty ? nil : notes
        return .success(out)
    }

    /// Save the draft. Queueable, like every setup write, so it saves with no
    /// signal and the notebook shows it at once.
    func save(values: [String: String], units: UnitSystem) async -> Bool {
        error = nil
        let sheet: SetupSheet
        switch Self.sheet(from: values, units: units) {
        case .success(let built): sheet = built
        case .failure(let failure):
            error = failure.message
            return false
        }
        if Garage.isEmptySheet(sheet) {
            error = existing ? "Nothing is recorded — delete the sheet instead." : "Nothing is recorded yet."
            return false
        }
        return await write { try await self.api.putSetup(eventId: self.eventId, day: self.day, sheet) }
    }

    func delete() async -> Bool {
        await write { try await self.api.deleteSetup(eventId: self.eventId, day: self.day) }
    }

    private func write(_ body: () async throws -> Void) async -> Bool {
        error = nil
        isSaving = true
        defer { isSaving = false }
        do {
            try await body()
            return true
        } catch let error as APIError {
            self.error = error.message
        } catch {
            self.error = error.localizedDescription
        }
        return false
    }
}

/// Why a draft didn't make a sheet, in words for the form.
struct SetupFormError: Error, Equatable {
    let message: String
}
