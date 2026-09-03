import SwiftUI
import TrackEvolutionKit

/// One car's garage page: what it has accrued, what's fitted to it, and what's
/// about to need replacing. `viewVehicle` in `public/app.js` is the reference.
///
/// The premise worth keeping in mind while reading this: **usage is computed,
/// never logged.** A part accrues the on-track hours of every event on its vehicle
/// between its install and retire dates, so the only thing this screen ever asks
/// the user for is the occasional measurement. Nothing here totals hours itself —
/// `GET /api/garage` arrives with the wear estimate already computed
/// (`src/lib/wear.ts`), and the app only decides how to say it.
///
/// **This screen needs a live server.** Its reads come through the offline cache
/// like everything else, but every write below is deliberately absent from the
/// queueable whitelist: retiring a part rewrites the wear of everything around it,
/// and a "refresh" is two rows in one request whose successor id the client can't
/// invent. Offline they fail with the server's own message, which is the honest
/// outcome.
struct VehicleScreen: View {
    let vehicleId: Int

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var model: VehicleModel?
    /// Sheet and dialog presentation state, held here rather than in the model:
    /// the model is re-read from the server after every write.
    @State private var partForm: PartForm?
    @State private var confirmingRefresh: Part?

    /// Which part form is on screen. One value rather than a bool plus an optional,
    /// so there is one `.sheet` to present it — see the comment on that modifier.
    enum PartForm: Identifiable, Hashable {
        case add
        case edit(Part)

        var id: Int {
            switch self {
            case .add: 0
            case .edit(let part): part.id
            }
        }

        var part: Part? {
            switch self {
            case .add: nil
            case .edit(let part): part
            }
        }

        var mode: PartFormSheet.Mode {
            switch self {
            case .add: .add
            case .edit(let part): .edit(part)
            }
        }
    }

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let vehicle = model.vehicle {
                content(model, vehicle)
            } else {
                TEPage { TEEmpty("That vehicle isn't in your garage.") }
            }
        }
        .navigationTitle(model?.vehicle?.name ?? "Garage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = VehicleModel(api: auth.api, vehicleId: vehicleId)
                self.model = model
                await model.load()
            }
        }
        // One `.sheet`, not two. Stacking a second on the same view is not merely
        // redundant — SwiftUI presents one sheet per view, and the pair of them
        // (add / edit) fought over the presentation and took the process down with
        // them. The enum is what makes "which form" a single piece of state.
        .sheet(item: $partForm) { form in
            if let model {
                PartFormSheet(
                    mode: form.mode,
                    submit: { draft, patch in
                        switch form {
                        case .add: await model.addPart(draft)
                        case .edit(let part): await model.updatePart(id: part.id, patch)
                        }
                    },
                    onDelete: form.part.map { part in
                        { await model.deletePart(id: part.id) }
                    }
                )
            }
        }
        .confirmationDialog(
            "Fresh set of the same part? This retires the current one today — keeping its history — "
                + "and installs a new one with the same details, so its hours start at zero.",
            isPresented: .init(get: { confirmingRefresh != nil }, set: { if !$0 { confirmingRefresh = nil } }),
            titleVisibility: .visible
        ) {
            Button("Install a fresh set") {
                if let part = confirmingRefresh {
                    Task { await model?.refreshPart(id: part.id) }
                }
                confirmingRefresh = nil
            }
            Button("Cancel", role: .cancel) { confirmingRefresh = nil }
        }
    }

    private func content(_ model: VehicleModel, _ vehicle: GarageVehicle) -> some View {
        TEPage {
            if let notes = vehicle.notes, !notes.isEmpty {
                Text(notes)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }

            MaintenanceStrip(garage: [vehicle])

            TEStatRow(tiles: [
                TEStatTile(label: "Track hours", value: Garage.fmtHours(vehicle.hours)),
                TEStatTile(label: "Track days", value: "\(vehicle.eventDays)"),
                TEStatTile(label: "Events", value: "\(vehicle.eventCount)"),
                TEStatTile(label: "Parts spend", value: Garage.fmtCost(model.spendCents) ?? "—")
            ])

            if let error = model.writeError {
                TEErrorBanner(message: error)
            }

            TESectionHeader("Consumables in service")
            Text("""
                Wear accrues automatically from this car's logged events — 2 h per track day unless an \
                event says otherwise. Log a quick pad or tread measurement between events and the \
                projection switches from estimated to measured.
                """)
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))

            if model.activeParts.isEmpty {
                TEEmpty("Nothing tracked yet — add pads, tires or fluid and the app will tell you when they're due.")
            } else {
                ForEach(model.activeParts) { part in
                    partCard(model, part)
                }
            }

            Button("+ Add part") { partForm = .add }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .accessibilityIdentifier("addPart")

            if !model.retiredParts.isEmpty {
                TESectionHeader("Retired parts", detail: "cost per hour, once a part has run its life")
                ForEach(model.retiredParts) { part in
                    retiredCard(part)
                }
            }

            if !model.ledger.isEmpty {
                TESectionHeader("Track-hours ledger")
                Text("Hours marked *est.* use the 2 h-per-day default — set exact hours on an event to correct a day that ran long or short.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
                ForEach(model.ledger) { event in
                    TENavCard(route: .event(event.id), identifier: "ledgerRow") {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(event.trackName)
                                    .teStyle(.bodyStrong)
                                    .foregroundStyle(Color(.textStrong))
                                TEMeta([EventDates.fmtDate(event.startDate), fmtDays(event.days)])
                            }
                            Spacer(minLength: 8)
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(Garage.fmtHours(event.hours))
                                    .teStyle(.bodyStrong)
                                    .foregroundStyle(Color(.textStrong))
                                if event.trackHours == nil {
                                    Text("est.")
                                        .teStyle(.xxs)
                                        .foregroundStyle(Color(.textFaint))
                                }
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await model.load() }
    }

    // MARK: - A part in service

    private func partCard(_ model: VehicleModel, _ part: Part) -> some View {
        TECard(padding: 16) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(part.kind.label)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(Color(.surfaceRaised), in: .capsule)
                    Text(part.name ?? part.kind.label)
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    Spacer(minLength: 4)
                    if let status = Garage.partStatus(part.wear) {
                        Text(status.label)
                            .teStyle(.xs)
                            .foregroundStyle(status.ink)
                    }
                }

                TEMeta([
                    "Installed \(EventDates.fmtDate(part.installedOn))",
                    Garage.fmtCost(part.costCents),
                    part.notes
                ])

                WearBar(wear: part.wear)
                WearStatusLine(part: part)

                if !part.measurements.isEmpty {
                    measurements(model, part)
                }

                MeasurementField(part: part) { draft in
                    await model.addMeasurement(partId: part.id, draft)
                }

                HStack(spacing: 10) {
                    Button("Refresh") { confirmingRefresh = part }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                    Button("Retire") { Task { await model.retirePart(id: part.id) } }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                    Button("Edit") { partForm = .edit(part) }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            }
        }
        .accessibilityIdentifier("partCard")
    }

    private func measurements(_ model: VehicleModel, _ part: Part) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(part.measurements) { measurement in
                HStack(spacing: 8) {
                    Text(EventDates.fmtDate(measurement.measuredOn))
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                    Text("\(trimZeros(measurement.value)) \(measurement.unit)")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textStrong))
                    Spacer()
                    Button {
                        Task { await model.deleteMeasurement(partId: part.id, id: measurement.id) }
                    } label: {
                        Image(systemName: "xmark")
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textFaint))
                    }
                    .accessibilityLabel("Remove measurement")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.xs))
            }
        }
    }

    // MARK: - Retired

    private func retiredCard(_ part: Part) -> some View {
        TECard(padding: 14) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(part.name ?? part.kind.label)
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.textStrong))
                    Spacer(minLength: 8)
                    Text(Self.costPerHour(part) ?? "—")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                }
                TEMeta([
                    part.kind.label,
                    "\(EventDates.fmtDate(part.installedOn)) – \(EventDates.fmtDate(part.retiredOn))",
                    Garage.fmtHours(part.wear.hours),
                    Garage.fmtCost(part.costCents)
                ])
            }
        }
    }

    /// What the part actually cost per hour on track — the number that makes a
    /// cheaper compound comparable to a longer-lasting one.
    private static func costPerHour(_ part: Part) -> String? {
        guard let cents = part.costCents, part.wear.hours > 0 else { return nil }
        return "$\(Int((Double(cents) / 100 / part.wear.hours).rounded()))/h"
    }
}

/// "4" for 4.0, "3.5" for 3.5 — a measurement is typed by a human and shouldn't
/// grow decimals it wasn't given.
func trimZeros(_ value: Double) -> String {
    value == value.rounded() ? String(Int(value)) : String(format: "%g", value)
}

// MARK: - Logging a measurement

/// The inline "log a measurement" row on a part card. Two of these unlock the
/// measured projection, which is why the hint says so on the first one.
struct MeasurementField: View {
    let part: Part
    let submit: (MeasurementDraft) async -> Bool

    @State private var value = ""
    @State private var unit = ""
    @State private var measuredOn = Date()
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if open {
                HStack(spacing: 8) {
                    TextField("Value", text: $value)
                        .teInput()
                        .keyboardType(.decimalPad)
                        .frame(maxWidth: 110)
                    TextField(defaultUnit, text: $unit)
                        .teInput()
                        .autocorrectionDisabled()
                        .frame(maxWidth: 90)
                    DatePicker("Measured on", selection: $measuredOn, displayedComponents: .date)
                        .labelsHidden()
                        .datePickerStyle(.compact)
                }
                if part.measurements.count < 2 {
                    Text("Two or more measurements unlock the wear projection.")
                        .teStyle(.xxs)
                        .foregroundStyle(Color(.textFaint))
                }
                HStack(spacing: 10) {
                    Button("Log measurement") {
                        Task {
                            guard let parsed = Double(value.replacingOccurrences(of: ",", with: ".")) else { return }
                            let draft = MeasurementDraft(
                                measuredOn: EventDates.isoString(from: measuredOn),
                                value: parsed,
                                unit: unit.trimmingCharacters(in: .whitespaces).isEmpty
                                    ? defaultUnit
                                    : unit.trimmingCharacters(in: .whitespaces)
                            )
                            if await submit(draft) {
                                value = ""
                                open = false
                                Haptics.confirm()
                            } else {
                                Haptics.warn()
                            }
                        }
                    }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                    .disabled(Double(value.replacingOccurrences(of: ",", with: ".")) == nil)
                    Button("Cancel") { open = false }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            } else {
                Button("Measure") { open = true }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityIdentifier("measurePart")
            }
        }
        // The unit the user last used on this part, so a second reading doesn't
        // ask again — and the kind's convention for the first.
        .onAppear { unit = part.measurements.last?.unit ?? defaultUnit }
    }

    private var defaultUnit: String {
        part.measurements.last?.unit ?? part.kind.defaultUnit
    }
}

// MARK: - The part form

/// Add or edit a consumable. One sheet for both, because the fields are the same
/// and the difference is which request it sends.
///
/// **Every `DatePicker` here names `.datePickerStyle(.compact)` explicitly, and
/// that is load-bearing.** Left to its default inside this sheet — a `ScrollView`
/// presented modally — focusing a text field below it wedged the layout and the
/// watchdog killed the app mid-keystroke. It fails as a lost connection, not as a
/// crash with a stack, so it costs an afternoon to find twice. `EventFormScreen`
/// names the style too.
struct PartFormSheet: View {
    enum Mode {
        case add
        case edit(Part)
    }

    let mode: Mode
    /// Returns true when the write landed. Both shapes are passed so the caller
    /// picks the one its request needs — a create takes a draft, an edit a patch.
    let submit: (PartDraft, PartPatch) async -> Bool
    /// Present only when editing. Deleting takes the measurements with it, which
    /// is why retiring is offered first on the card and this sits at the bottom.
    var onDelete: (() async -> Bool)?

    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDelete = false

    @State private var kind: PartKind = .padsFront
    @State private var name = ""
    @State private var installedOn = Date()
    @State private var retired = false
    @State private var retiredOn = Date()
    @State private var cost = ""
    @State private var expectedHours = ""
    @State private var wearLimit = ""
    @State private var notes = ""
    @State private var saving = false
    @State private var loaded = false

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            TEPage {
                TECard {
                    VStack(alignment: .leading, spacing: 16) {
                        TEField(label: "Type") {
                            Picker("Type", selection: $kind) {
                                ForEach(PartKind.all, id: \.rawValue) { option in
                                    Text(option.label).tag(option)
                                }
                            }
                            .pickerStyle(.menu)
                        }

                        TEField(label: "Part / compound") {
                            TextField("Hawk DTC-60, RE-71RS 255/40…", text: $name)
                                .teInput()
                        }

                        TEField(label: "Installed") {
                            DatePicker("Installed", selection: $installedOn, displayedComponents: .date)
                                .labelsHidden()
                                .datePickerStyle(.compact)
                        }

                        if isEditing {
                            TEField(label: "Retired", hint: "Off means still in service") {
                                VStack(alignment: .leading, spacing: 8) {
                                    Toggle("Retired", isOn: $retired)
                                        .labelsHidden()
                                    if retired {
                                        DatePicker("Retired on", selection: $retiredOn, displayedComponents: .date)
                                            .labelsHidden()
                                            .datePickerStyle(.compact)
                                    }
                                }
                            }
                        }

                        TEField(label: "Cost ($, optional)") {
                            TextField("389", text: $cost)
                                .teInput()
                                .keyboardType(.decimalPad)
                        }

                        TEField(
                            label: "Expected life (track hours)",
                            hint: "Leave blank and the app fills it from how long your last set of these lasted"
                        ) {
                            TextField("auto from history", text: $expectedHours)
                                .teInput()
                                .keyboardType(.decimalPad)
                        }

                        TEField(label: "Replace at (optional)", hint: "The measured value at which it's used up") {
                            TextField(kind.wearLimitHint ?? "3", text: $wearLimit)
                                .teInput()
                                .keyboardType(.decimalPad)
                        }

                        TEField(label: "Notes") {
                            TextField("Sizes, torque specs, where bought…", text: $notes, axis: .vertical)
                                .teInput()
                                .lineLimit(2...4)
                        }
                    }
                }

                Button(saving ? "Saving…" : (isEditing ? "Save changes" : "Add part")) {
                    Task { await save() }
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("savePart")

                if onDelete != nil {
                    Button("Delete part") { confirmingDelete = true }
                        .buttonStyle(TEButtonStyle(kind: .danger))
                }
            }
            .confirmationDialog(
                "Delete this part and its measurements? Retiring it instead keeps the history.",
                isPresented: $confirmingDelete,
                titleVisibility: .visible
            ) {
                Button("Delete part", role: .destructive) {
                    Task {
                        if await onDelete?() == true { dismiss() } else { Haptics.warn() }
                    }
                }
                Button("Keep it", role: .cancel) {}
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(isEditing ? "Edit part" : "Add part")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear {
            // Once: re-running on every appearance would wipe what's been typed
            // when the keyboard or a date picker re-presents.
            guard !loaded else { return }
            loaded = true
            if case .edit(let part) = mode {
                kind = part.kind
                name = part.name ?? ""
                installedOn = EventDates.date(fromISO: part.installedOn) ?? Date()
                retired = part.retiredOn != nil
                retiredOn = part.retiredOn.flatMap { EventDates.date(fromISO: $0) } ?? Date()
                cost = part.costCents.map { trimZeros(Double($0) / 100) } ?? ""
                expectedHours = part.expectedHours.map(trimZeros) ?? ""
                wearLimit = part.wearLimit.map(trimZeros) ?? ""
                notes = part.notes ?? ""
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let centsValue = cents(from: cost)
        let expected = number(from: expectedHours)
        let limit = number(from: wearLimit)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespaces)

        var draft = PartDraft(
            kind: kind, name: trimmedName, installedOn: EventDates.isoString(from: installedOn)
        )
        draft.costCents = centsValue
        draft.expectedHours = expected
        draft.wearLimit = limit
        draft.notes = trimmedNotes.isEmpty ? nil : trimmedNotes

        // Every field is sent on an edit, so clearing one clears it server-side —
        // `.set(nil)` rather than `.unchanged`, which would silently keep the old
        // value and make the field look unresponsive.
        var patch = PartPatch()
        patch.kind = .set(kind)
        patch.name = .set(trimmedName)
        patch.installedOn = .set(EventDates.isoString(from: installedOn))
        patch.retiredOn = .set(retired ? EventDates.isoString(from: retiredOn) : nil)
        patch.costCents = .set(centsValue)
        patch.expectedHours = .set(expected)
        patch.wearLimit = .set(limit)
        patch.notes = .set(trimmedNotes.isEmpty ? nil : trimmedNotes)

        if await submit(draft, patch) {
            Haptics.confirm()
            dismiss()
        } else {
            Haptics.warn()
        }
    }

    private func number(from text: String) -> Double? {
        Double(text.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces))
    }

    /// Dollars as typed → integer cents, which is the only shape the server takes.
    private func cents(from text: String) -> Int? {
        guard let dollars = number(from: text) else { return nil }
        return Int((dollars * 100).rounded())
    }
}

// MARK: - Model

/// The garage page's data and writes.
///
/// Every mutation re-reads `GET /api/garage` rather than patching a local copy:
/// one part changing shifts the accrued hours and remaining life of others (a
/// refresh retires one row and creates another; an install date moves which
/// events count), and the server is the only thing that knows the new numbers.
@MainActor
@Observable
final class VehicleModel {
    private let api: APIClient
    let vehicleId: Int

    private(set) var state: LoadState = .loading
    private(set) var vehicle: GarageVehicle?
    private(set) var events: [Event] = []
    var writeError: String?

    init(api: APIClient, vehicleId: Int) {
        self.api = api
        self.vehicleId = vehicleId
    }

    func load() async {
        do {
            async let garage = api.garage()
            async let eventList = api.events()
            let loaded = try await (garage: garage, events: eventList)
            vehicle = loaded.garage.first { $0.id == vehicleId }
            events = loaded.events
            state = .ready
        } catch let error as APIError {
            // A 402 is an offer, not a failure: GET /api/garage is Pro since
            // phase D, and "Couldn't load this — pro required" would read as a
            // bug rather than as a price.
            state = error.isProRequired ? .paywall : .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    var activeParts: [Part] { vehicle?.parts.filter { $0.retiredOn == nil } ?? [] }
    var retiredParts: [Part] { vehicle?.parts.filter { $0.retiredOn != nil } ?? [] }

    /// What this car's consumables have cost so far — retired sets included, since
    /// the point of the number is what the season actually cost.
    var spendCents: Int? {
        let total = (vehicle?.parts ?? []).compactMap(\.costCents).reduce(0, +)
        return total == 0 ? nil : total
    }

    /// The events whose hours this car accrued — past only, matching the server's
    /// rule that an upcoming event isn't wear yet.
    var ledger: [Event] {
        events.filter { $0.vehicleId == vehicleId && !EventDates.isUpcoming($0.startDate) }
    }

    // MARK: Writes

    func addPart(_ draft: PartDraft) async -> Bool {
        await write { _ = try await $0.createPart(vehicleId: self.vehicleId, draft) }
    }

    func updatePart(id: Int, _ patch: PartPatch) async -> Bool {
        await write { try await $0.updatePart(id: id, patch) }
    }

    func deletePart(id: Int) async -> Bool {
        await write { try await $0.deletePart(id: id) }
    }

    /// Retire as of today — the swap you're recording is the one you just did.
    func retirePart(id: Int) async -> Bool {
        await write { try await $0.updatePart(id: id, .retiring(on: EventDates.todayISO())) }
    }

    func refreshPart(id: Int) async -> Bool {
        await write { _ = try await $0.refreshPart(id: id) }
    }

    func addMeasurement(partId: Int, _ draft: MeasurementDraft) async -> Bool {
        await write { _ = try await $0.addMeasurement(partId: partId, draft) }
    }

    func deleteMeasurement(partId: Int, id: Int) async -> Bool {
        await write { try await $0.deleteMeasurement(partId: partId, id: id) }
    }

    /// Run a write, surface its error in the screen's own words, and re-read.
    private func write(_ body: (APIClient) async throws -> Void) async -> Bool {
        writeError = nil
        do {
            try await body(api)
            await load()
            return true
        } catch let error as APIError {
            writeError = error.message
            return false
        } catch {
            writeError = error.localizedDescription
            return false
        }
    }
}
