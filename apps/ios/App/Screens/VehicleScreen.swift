import SwiftUI
import TrackEvolutionKit

/// One car's garage page: what it has accrued, what's fitted to it, and what's
/// about to need replacing. `viewVehicle` in `public/app.js` is the reference.
///
/// **Every account gets the page** (NS-37): the car, its logbook (track days,
/// last and next event, best lap per track — the Kit's `vehicleLogbook` over the
/// cached events) and its form are free. The rest reads the Pro
/// `GET /api/garage`, and a 402 from it locks that half in place rather than
/// making the whole page a paywall.
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
    @Environment(\.layout) private var layout

    @State private var model: VehicleModel?
    /// Sheet and dialog presentation state, held here rather than in the model:
    /// the model is re-read from the server after every write.
    @State private var sheet: VehicleSheet?
    /// Which consumable the right column is showing (NS-34 ticket 3).
    @State private var selectedPartId: Int?
    @State private var confirmingRefresh: Part?
    @State private var confirmingDelete = false

    /// Which form is on screen. One value rather than a bool per form, so there
    /// is one `.sheet` to present them all — see the comment on that modifier.
    enum VehicleSheet: Identifiable, Hashable {
        case addPart
        case editPart(Part)
        /// The car itself: name, mods, target hot pressure, default.
        case car

        var id: Int {
            switch self {
            case .addPart: 0
            case .editPart(let part): part.id
            case .car: -1
            }
        }

        var part: Part? {
            switch self {
            case .editPart(let part): part
            case .addPart, .car: nil
            }
        }

        var partMode: PartFormSheet.Mode? {
            switch self {
            case .addPart: .add
            case .editPart(let part): .edit(part)
            case .car: nil
            }
        }
    }

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let vehicle = model.vehicle {
                page(model, vehicle)
            } else {
                TEPage { TEEmpty("That vehicle isn't in your garage.") }
            }
        }
        .navigationTitle(model?.vehicle?.name ?? "Garage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = VehicleModel(api: auth.api, vehicleId: vehicleId) { [router] in
                    router.garageRevision += 1
                }
                self.model = model
                await model.load()
                if model.garageVehicle != nil { router.garageAlertCount = model.alertCount }
            }
        }
        // One `.sheet`, not three. Stacking a second on the same view is not
        // merely redundant — SwiftUI presents one sheet per view, and the pair of
        // them (add / edit) fought over the presentation and took the process down
        // with them. The enum is what makes "which form" a single piece of state.
        .sheet(item: $sheet) { form in
            if let model {
                if let mode = form.partMode {
                    PartFormSheet(
                        mode: mode,
                        submit: { draft, patch in
                            switch form {
                            case .addPart: await model.addPart(draft)
                            case .editPart(let part): await model.updatePart(id: part.id, patch)
                            case .car: false
                            }
                        },
                        onDelete: form.part.map { part in
                            { await model.deletePart(id: part.id) }
                        }
                    )
                } else if let vehicle = model.vehicle {
                    VehicleFormSheet(api: auth.api, vehicle: vehicle) { patch in
                        await model.updateVehicle(patch)
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // The car itself — name, mods, the pressure the health strip aims
                // at, whether new events start on it. This used to live only in
                // Settings, a screen away from the garage it describes, and on
                // iOS not even there.
                Button("Edit") { sheet = .car }
                    .accessibilityLabel("Edit car")
                    .accessibilityIdentifier("editVehicle")
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

    /// One column, or the garage beside its detail (NS-34 ticket 3).
    ///
    /// At expanded width the consumables stay on the left and the **selected
    /// part's measurements** move to the right. That is the split the spec asks
    /// for: logging a measurement is a two-field form that on a phone sits inside
    /// whichever card you scrolled to, and the column gives it a fixed place.
    @ViewBuilder
    private func page(_ model: VehicleModel, _ vehicle: Vehicle) -> some View {
        if let partWidth, model.garageVehicle != nil {
            HStack(spacing: 0) {
                content(model, vehicle)
                    // Inside the frame on both columns — see the note on
                    // `EventScreen.page`: a greedy `GeometryReader` around a fixed
                    // frame splits the row in half instead.
                    .measuringPaneWidth()
                    .frame(maxWidth: .infinity)
                Divider()
                partColumn(model)
                    .measuringPaneWidth()
                    .frame(width: partWidth)
            }
        } else {
            content(model, vehicle)
        }
    }

    private var isTwoColumn: Bool { partWidth != nil }

    /// How wide the selected part's column gets, or nil for one column.
    ///
    /// Narrower than the event page's analysis column and with a lower floor,
    /// because what goes in it is a two-field form rather than a track map and a
    /// stack of charts. Measured against this page's own column for the reason
    /// `sideColumnWidth` states.
    private var partWidth: CGFloat? {
        layout.sideColumnWidth(fraction: 0.42, minimum: 340, maximum: 560)
    }

    /// The selected part's measurements.
    private func partColumn(_ model: VehicleModel) -> some View {
        let part = model.activeParts.first { $0.id == selectedPartId } ?? model.activeParts.first
        return ScrollView {
            VStack(alignment: .leading, spacing: TESpacing.gridGap) {
                if let part {
                    Text(part.name ?? part.kind.label)
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    WearStatusLine(part: part)
                    if !part.measurements.isEmpty {
                        TESectionHeader("Measurements")
                        measurements(model, part)
                    }
                    MeasurementField(part: part) { draft in
                        await model.addMeasurement(partId: part.id, draft)
                    }
                } else {
                    TEEmpty("Add a consumable and its measurements will show here.")
                }
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.bgPage))
        .accessibilityIdentifier("partColumn")
    }

    private func content(_ model: VehicleModel, _ vehicle: Vehicle) -> some View {
        TEPage {
            if vehicle.isDefault {
                DefaultBadge()
            }
            if let notes = vehicle.notes, !notes.isEmpty {
                Text(notes)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }

            if let garageVehicle = model.garageVehicle {
                MaintenanceStrip(garage: [garageVehicle])

                TEStatRow(tiles: [
                    TEStatTile(label: "Track hours", value: Garage.fmtHours(garageVehicle.hours)),
                    TEStatTile(label: "Track days", value: "\(garageVehicle.eventDays)"),
                    TEStatTile(label: "Events", value: "\(garageVehicle.eventCount)"),
                    TEStatTile(label: "Parts spend", value: Garage.fmtCost(model.spendCents) ?? "—")
                ])
            } else {
                TEStatRow(tiles: [
                    TEStatTile(label: "Track days", value: Self.fmtDays(model.logbook.trackDays)),
                    TEStatTile(label: "Events", value: "\(model.logbook.events)")
                ])
            }

            if let error = model.writeError {
                TEErrorBanner(message: error)
            }

            logbookSection(model)

            if model.garageVehicle != nil {
                proSection(model)
            } else if model.proLocked {
                ProUpsellCard(
                    title: "Consumables, hours and costs",
                    blurb: """
                        Pads, tires, rotors and fluid, each with the hours it has actually done — \
                        accrued from this car's own track days — a wear projection, reminders before \
                        the next event, and what the car has cost you. The car and what it has done \
                        stay free.
                        """
                )
            } else if let error = model.garageError {
                TEErrorBanner(message: error)
            }

            // An alert rather than a confirmation dialog: on an iPad a dialog is a
            // popover anchored to this button, far down a long page, and a
            // destructive choice deserves the middle of the screen. On the button
            // rather than the screen, which already carries the refresh dialog —
            // one presentation per view is the rule documented above.
            Button("Delete car") { confirmingDelete = true }
                .buttonStyle(TEButtonStyle(kind: .danger))
                .accessibilityIdentifier("deleteVehicle")
                .alert("Delete \(vehicle.name)?", isPresented: $confirmingDelete) {
                    Button("Delete this car", role: .destructive) {
                        Task {
                            if await model.deleteVehicle() { router.popToRoot() }
                        }
                    }
                    Button("Keep it", role: .cancel) {}
                } message: {
                    Text("Events keep their car name and simply stop being linked"
                        + (model.garageVehicle != nil ? "; its consumables, measurements and wear history go with it." : "."))
                }
        }
        .refreshable { await model.load() }
    }

    /// `9` not `9.0` — the sum of `days`, which the model carries as a Double.
    private static func fmtDays(_ days: Double) -> String {
        days == days.rounded() ? "\(Int(days))" : "\(days)"
    }

    /// Last out, next up and the best lap at each track — the car's logbook,
    /// free for every account.
    @ViewBuilder
    private func logbookSection(_ model: VehicleModel) -> some View {
        let logbook = model.logbook
        if logbook.lastEvent == nil, logbook.nextEvent == nil {
            Text("No track days in this car yet — pick it on an event and they'll show up here.")
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if let last = logbook.lastEvent {
                    eventLink("Last out", last)
                }
                if let next = logbook.nextEvent {
                    eventLink("Next up", next)
                }
            }
        }
        if !logbook.bests.isEmpty {
            TESectionHeader("Best in this car")
            ForEach(logbook.bests) { best in
                TENavCard(route: .event(best.eventId), identifier: "vehicleBest") {
                    Text(best.trackName)
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.textStrong))
                    HStack {
                        Text(LapTime.fmtMs(best.bestMs))
                            .teStyle(.lapTime)
                            .foregroundStyle(Color(.textStrong))
                        Spacer()
                        Text(EventDates.fmtDate(best.startDate))
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }
            }
        }
    }

    private func eventLink(_ label: String, _ ref: Garage.EventRef) -> some View {
        Button {
            router.push(.event(ref.id))
        } label: {
            HStack(spacing: 6) {
                Text(label)
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textFaint))
                Text(ref.trackName)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.accentInk))
                Text(EventDates.fmtDate(ref.startDate))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
        }
        .buttonStyle(.plain)
    }

    /// The consumables — everything the Pro `GET /api/garage` carries.
    @ViewBuilder
    private func proSection(_ model: VehicleModel) -> some View {
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

            Button("+ Add part") { sheet = .addPart }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .accessibilityIdentifier("addPart")

            if !model.retiredParts.isEmpty {
                TESectionHeader("Retired parts", detail: "cost per hour, once a part has run its life")
                ForEach(model.retiredParts) { part in
                    retiredCard(part)
                }
            }
    }

    // MARK: - A part in service

    private func partCard(_ model: VehicleModel, _ part: Part) -> some View {
        let selected = isTwoColumn && selectedPart(model)?.id == part.id
        return TECard(padding: 16) {
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

                // Both move to the right column at expanded width (NS-34 ticket 3).
                if !isTwoColumn {
                    if !part.measurements.isEmpty {
                        measurements(model, part)
                    }
                    MeasurementField(part: part) { draft in
                        await model.addMeasurement(partId: part.id, draft)
                    }
                }

                HStack(spacing: 10) {
                    Button("Refresh") { confirmingRefresh = part }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                    Button("Retire") { Task { await model.retirePart(id: part.id) } }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                    Button("Edit") { sheet = .editPart(part) }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            }
        }
        // Selecting a card fills the column beside it. The buttons inside keep
        // their own taps — SwiftUI gives a `Button` priority over a container's
        // tap gesture — so Refresh, Retire and Edit still do what they say.
        .contentShape(Rectangle())
        .onTapGesture { if isTwoColumn { selectedPartId = part.id } }
        .overlay(
            RoundedRectangle(cornerRadius: TERadius.lg)
                .strokeBorder(Color(.accent), lineWidth: selected ? 2 : 0)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("partCard")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The part the right column is showing: the selection, or the first in
    /// service. Never nothing while there is something to show — an empty column
    /// beside a list of parts reads as broken rather than as unselected.
    private func selectedPart(_ model: VehicleModel) -> Part? {
        model.activeParts.first { $0.id == selectedPartId } ?? model.activeParts.first
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

    /// For the default unit of a first measurement (tread depth: 32nds or mm).
    @Environment(\.unitSystem) private var units

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
        part.measurements.last?.unit ?? Units.defaultMeasurementUnit(part.kind, units)
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
    /// For the replace-at placeholder (tread depth: 32nds or mm).
    @Environment(\.unitSystem) private var units
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
                            TextField(Units.wearLimitHint(kind, units) ?? "3", text: $wearLimit)
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
    /// The car itself, from the free vehicle list.
    private(set) var vehicle: Vehicle?
    /// Its Pro half, when `GET /api/garage` answered.
    private(set) var garageVehicle: GarageVehicle?
    /// A 402 from `/garage`: the Pro half renders locked.
    private(set) var proLocked = false
    /// Any other `/garage` failure — offline with nothing cached — said in place
    /// of the Pro half rather than instead of the page.
    private(set) var garageError: String?
    private(set) var logbook = Garage.vehicleLogbook(0, [Event](), today: "")
    private(set) var alertCount = 0
    var writeError: String?
    /// Told after every write that landed, so the Garage list can re-read.
    private let onWrite: @MainActor () -> Void

    init(api: APIClient, vehicleId: Int, onWrite: @escaping @MainActor () -> Void = {}) {
        self.api = api
        self.vehicleId = vehicleId
        self.onWrite = onWrite
    }

    func load() async {
        async let garageList: Result<[GarageVehicle], Error> = {
            do { return .success(try await api.garage()) } catch { return .failure(error) }
        }()
        do {
            async let vehicleList = api.vehicles()
            async let eventList = api.events()
            let loaded = try await (vehicles: vehicleList, events: eventList)
            vehicle = loaded.vehicles.first { $0.id == vehicleId }
            logbook = Garage.vehicleLogbook(vehicleId, loaded.events, today: EventDates.todayISO())
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
        garageError = nil
        switch await garageList {
        case .success(let rows):
            garageVehicle = rows.first { $0.id == vehicleId }
            // The garage row is the fresher copy when both answered.
            if let garageVehicle { vehicle = garageVehicle.vehicle }
            alertCount = Garage.garageAlerts(rows).count
            proLocked = false
        case .failure(let error as APIError) where error.isProRequired:
            // A 402 is an offer, not a failure: GET /api/garage is Pro since
            // phase D, and "Couldn't load this — pro required" would read as a
            // bug rather than as a price.
            garageVehicle = nil
            proLocked = true
        case .failure(let error as APIError):
            garageVehicle = nil
            garageError = error.message
        case .failure(let error):
            garageVehicle = nil
            garageError = error.localizedDescription
        }
    }

    var activeParts: [Part] { garageVehicle?.parts.filter { $0.retiredOn == nil } ?? [] }
    var retiredParts: [Part] { garageVehicle?.parts.filter { $0.retiredOn != nil } ?? [] }

    /// What this car's consumables have cost so far — retired sets included, since
    /// the point of the number is what the season actually cost.
    var spendCents: Int? {
        let total = (garageVehicle?.parts ?? []).compactMap(\.costCents).reduce(0, +)
        return total == 0 ? nil : total
    }

    // MARK: Writes

    /// The car itself. Renaming matters more than it looks: `events.car` is free
    /// text matched to a vehicle **by name** server-side, so a car renamed away
    /// from what past events say stops accruing their hours. The form says so.
    func updateVehicle(_ patch: VehiclePatch) async -> Bool {
        await write { try await $0.updateVehicle(id: self.vehicleId, patch) }
    }

    /// Cascades to the car's parts and measurements; events keep their car name.
    func deleteVehicle() async -> Bool {
        await write { try await $0.deleteVehicle(id: self.vehicleId) }
    }

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
            onWrite()
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

// MARK: - The car itself

/// Edit the car: its name, its modifications and notes, the hot tyre pressure the
/// health strip's pressure loop aims at, whether new events start on it, and —
/// #208 / #222 — its two spec-sheet numbers, picked from the car catalog or
/// typed. `viewVehicle`'s `#veh-form` in `public/app.js` is the reference.
///
/// Presented from the garage page rather than Settings because that is where
/// the car is being looked at — and, until now, iOS could not edit one at all.
///
/// The catalog pick follows the web's rules exactly, through the Kit's
/// `Garage.catalogPrefill`: **pre-fill, never overwrite** — a number the driver
/// typed is asked about, inline under its field, per field; a number the
/// previous pick filled in is replaced silently on a re-pick; clearing the pick
/// keeps the numbers, because they are the driver's now. `pick` is the row the
/// form's numbers came from — the stored one to begin with — which is what
/// tells those two cases apart.
struct VehicleFormSheet: View {
    let api: APIClient
    let vehicle: Vehicle
    /// Returns true when the write landed.
    let submit: (VehiclePatch) async -> Bool

    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var notes = ""
    @State private var targetHotPsi = ""
    @State private var isDefault = false
    @State private var wheelbase = ""
    @State private var steering = ""
    /// The catalog row the numbers came from; nil for a car typed by hand.
    @State private var pick: CatalogCar?
    /// A catalog value waiting on the driver's answer for that field.
    @State private var wheelbaseAsk: Int?
    @State private var steeringAsk: Double?
    @State private var showingPicker = false
    @State private var saving = false
    @State private var loaded = false
    @State private var error: String?
    /// The car's per-session steering fits (#223), fetched when the sheet
    /// opens; empty until then, and empty when the read fails — the measured
    /// line is then absent, never an error.
    @State private var steeringFits: [SteeringFit] = []

    var body: some View {
        NavigationStack {
            TEPage {
                TECard {
                    VStack(alignment: .leading, spacing: 16) {
                        TEField(
                            label: "Car",
                            hint: "Past events match this car by name — renaming it away from what they say stops their hours accruing here"
                        ) {
                            TextField("2023 Corvette Z06", text: $name)
                                .teInput()
                        }

                        TEField(label: "Modifications & notes") {
                            TextField("Coilovers, pads, tires, alignment…", text: $notes, axis: .vertical)
                                .teInput()
                                .lineLimit(3...8)
                        }

                        TEField(
                            label: "Target hot tire pressure (psi, optional)",
                            hint: "What the pressure loop on an imported session's Car tab aims at"
                        ) {
                            TextField("e.g. 34", text: $targetHotPsi)
                                .teInput()
                                .keyboardType(.decimalPad)
                        }

                        Toggle("Default car for new events", isOn: $isDefault)
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textBody))
                            .tint(Color(.accent))

                        catalogField

                        TEField(label: "Wheelbase (mm, optional)") {
                            TextField("e.g. 2710", text: $wheelbase)
                                .teInput()
                                .keyboardType(.numberPad)
                                .accessibilityIdentifier("wheelbaseField")
                        }
                        if let ask = wheelbaseAsk {
                            askRow(
                                "The catalog says \(ask) mm for the wheelbase; you have \(wheelbase) mm.",
                                use: { wheelbase = String(ask) }
                            ) { wheelbaseAsk = nil }
                        }

                        TEField(label: "Steering ratio (optional)") {
                            TextField("e.g. 16.25 for 16.25:1", text: $steering)
                                .teInput()
                                .keyboardType(.decimalPad)
                                .accessibilityIdentifier("steeringRatioField")
                        }
                        if let ask = steeringAsk {
                            askRow(
                                "The catalog says \(CatalogCarPicker.fmtRatio(ask)):1 for the steering ratio; you have \(steering):1.",
                                use: { steering = CatalogCarPicker.fmtRatio(ask) }
                            ) { steeringAsk = nil }
                        }
                        if let measured, let line = Balance.measuredRatioLine(measured, typed: typedRatio) {
                            measuredRow(line, measured)
                        }

                        if let pick {
                            // Where the numbers came from, so the driver knows
                            // what they are trusting.
                            Text(pick.source)
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textFaint))
                                .accessibilityIdentifier("catalogSource")
                        }
                        Text("Both are on the spec sheet or in the owner's manual. They let the balance read-out say how much understeer, rather than only which corner differs from the rest — leave them blank and it keeps the relative reading.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }

                if let error {
                    TEErrorBanner(message: error)
                }

                Button(saving ? "Saving…" : "Save changes") {
                    Task { await save() }
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("saveVehicle")
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Edit car")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear {
            // Once: re-running on every appearance would wipe what's been typed.
            guard !loaded else { return }
            loaded = true
            name = vehicle.name
            notes = vehicle.notes ?? ""
            targetHotPsi = vehicle.targetHotPsi.map(Self.formatPsi) ?? ""
            isDefault = vehicle.isDefault
            wheelbase = vehicle.wheelbaseMm.map(String.init) ?? ""
            steering = vehicle.steeringRatio.map(CatalogCarPicker.fmtRatio) ?? ""
        }
        .task {
            // Resolve the stored pick so a re-pick knows which numbers are the
            // catalog's. The catalog is a cached GET, so this works offline; if it
            // fails, the numbers count as the driver's and a re-pick asks — the
            // safe way to be wrong.
            guard let id = vehicle.catalogId, pick == nil else { return }
            if let rows = try? await api.carCatalog() {
                pick = rows.first { $0.id == id }
            }
        }
        .task {
            // The measured steering ratio's inputs (#223). Its own read — the
            // server fits the car's recent session blobs to answer it — made
            // when the form opens rather than with the page.
            steeringFits = (try? await api.steeringFits(vehicleId: vehicle.id))?.fits ?? []
        }
    }

    // MARK: - The measured steering ratio (#223)

    /// The car's recent sessions' fits pooled against the wheelbase *in the
    /// form*, so the line follows both fields as they are typed.
    private var measured: Balance.RatioEstimate? {
        Balance.estimateSteeringRatio(
            steeringFits.map(\.fit),
            wheelbaseMm: Int(wheelbase.trimmingCharacters(in: .whitespaces))
        )
    }

    private var typedRatio: Double? {
        Double(steering.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }

    /// One line under the steering-ratio field. With the field empty it offers
    /// the number; with a number in it, it is the typo check ("— matches" /
    /// "well off this; check the units"). "Use this" writes the field, never
    /// the row — the driver still saves.
    private func measuredRow(_ line: String, _ estimate: Balance.RatioEstimate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(line)
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
                .accessibilityIdentifier("measuredRatio")
            if !Balance.ratioAgrees(estimate, typedRatio) {
                Button("Use this") {
                    steering = Balance.fmtSteeringRatio(Balance.measuredRatioValue(estimate))
                }
                .teStyle(.xs)
                .foregroundStyle(Color(.accentInk))
                .accessibilityIdentifier("useMeasuredRatio")
            }
        }
    }

    /// The catalog field: what is picked, the door to the picker, and Clear.
    /// The label says what a pick *does*, because that is the only reason to
    /// pick rather than type.
    private var catalogField: some View {
        TEField(
            label: "Find your car in the catalog (optional)",
            hint: "Picking a car fills in the wheelbase and steering ratio the balance read-out uses — nothing else changes, and a car the catalog doesn't know is just typed in below."
        ) {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    showingPicker = true
                } label: {
                    Text(pick.map(Garage.catalogCarLabel) ?? "Search the catalog…")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(pick == nil ? Color(.textMuted) : Color(.textStrong))
                        .teInput()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("pickCatalogCar")
                .sheet(isPresented: $showingPicker) {
                    CatalogCarPicker(api: api) { picked($0) }
                }
                if pick != nil {
                    Button("Clear the pick — keep the numbers") { clearPick() }
                        .teStyle(.xs)
                        .foregroundStyle(Color(.accentInk))
                        .accessibilityIdentifier("clearCatalogCar")
                }
            }
        }
    }

    /// A per-field question, inline rather than in an alert: a second modal on
    /// this view would be the presentation hazard `VehicleScreen` documents, and
    /// the answer belongs next to the number it is about.
    private func askRow(_ text: String, use: @escaping () -> Void, done: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
            HStack(spacing: 12) {
                Button("Use the catalog's") {
                    use()
                    done()
                }
                .teStyle(.xs)
                .foregroundStyle(Color(.accentInk))
                Button("Keep mine") { done() }
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }

    private var currentGeometry: Garage.VehicleGeometry {
        Garage.VehicleGeometry(
            wheelbaseMm: Int(wheelbase.trimmingCharacters(in: .whitespaces)),
            steeringRatio: Double(steering.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
        )
    }

    private func picked(_ row: CatalogCar) {
        let plan = Garage.catalogPrefill(row, current: currentGeometry, previous: pick)
        switch plan.wheelbaseMm.action {
        case .fill:
            wheelbase = plan.wheelbaseMm.value.map(String.init) ?? ""
            wheelbaseAsk = nil
        case .ask:
            wheelbaseAsk = plan.wheelbaseMm.value
        case .keep:
            wheelbaseAsk = nil
        }
        switch plan.steeringRatio.action {
        case .fill:
            steering = plan.steeringRatio.value.map(CatalogCarPicker.fmtRatio) ?? ""
            steeringAsk = nil
        case .ask:
            steeringAsk = plan.steeringRatio.value
        case .keep:
            steeringAsk = nil
        }
        pick = row
        // A car already called "Betty" keeps its name.
        if name.trimmingCharacters(in: .whitespaces).isEmpty {
            name = Garage.catalogCarName(row)
        }
    }

    /// The link goes; the numbers stay, because they are the driver's now.
    private func clearPick() {
        pick = nil
        wheelbaseAsk = nil
        steeringAsk = nil
    }

    /// 34.0 reads as "34"; 34.5 stays "34.5" — what a driver would have typed.
    private static func formatPsi(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
    }

    private func save() async {
        error = nil
        let trimmedPsi = targetHotPsi.trimmingCharacters(in: .whitespaces)
        var psi: Double?
        if !trimmedPsi.isEmpty {
            guard let value = Double(trimmedPsi.replacingOccurrences(of: ",", with: ".")), value >= 5, value <= 100 else {
                error = "Target pressure should be between 5 and 100 psi."
                Haptics.warn()
                return
            }
            psi = value
        }
        // The same ranges `src/lib/validate.ts` enforces, so a slip is caught
        // here with a sentence rather than there with a 400.
        let trimmedWheelbase = wheelbase.trimmingCharacters(in: .whitespaces)
        var wheelbaseMm: Int?
        if !trimmedWheelbase.isEmpty {
            guard let value = Int(trimmedWheelbase), value >= 1500, value <= 4500 else {
                error = "Wheelbase should be between 1500 and 4500 mm."
                Haptics.warn()
                return
            }
            wheelbaseMm = value
        }
        let trimmedSteering = steering.trimmingCharacters(in: .whitespaces)
        var steeringRatio: Double?
        if !trimmedSteering.isEmpty {
            guard let value = Double(trimmedSteering.replacingOccurrences(of: ",", with: ".")), value >= 5, value <= 30 else {
                error = "Steering ratio should be between 5 and 30 — 16.25 for 16.25:1."
                Haptics.warn()
                return
            }
            steeringRatio = value
        }
        var patch = VehiclePatch()
        patch.name = .set(name.trimmingCharacters(in: .whitespaces))
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        patch.notes = .set(trimmedNotes.isEmpty ? nil : trimmedNotes)
        patch.targetHotPsi = .set(psi)
        // The pick and both numbers together: the server pre-fills only the
        // numbers a body leaves out, and this form never leaves one out, so what
        // is on screen is what gets saved — the pick is recorded as identity.
        patch.catalogId = .set(pick?.id)
        patch.wheelbaseMm = .set(wheelbaseMm)
        patch.steeringRatio = .set(steeringRatio)
        // Only when it changed: a false sent for a default left alone would
        // silently unset it.
        if isDefault != vehicle.isDefault { patch.isDefault = .set(isDefault) }

        saving = true
        let ok = await submit(patch)
        saving = false
        if ok {
            dismiss()
        } else {
            Haptics.warn()
        }
    }
}
