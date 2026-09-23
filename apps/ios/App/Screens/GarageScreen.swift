import SwiftUI
import TrackEvolutionKit

/// The Garage tab (NS-37): a card per car, and a last card that adds one.
/// `viewGarage` in `public/app.js` is the reference.
///
/// **Every account gets this screen.** The cars come from the free
/// `GET /api/vehicles` and each tile's line from the Kit's `vehicleLogbook` over
/// the cached event list, so a free driver sees their cars and what they have
/// done, offline included. The Pro half — hours, the worst part's status and the
/// maintenance strip — reads `GET /api/garage` alongside, and a 402 from it locks
/// that half **in place** rather than turning the screen into a paywall: the
/// garage is how a free driver finds out what Pro would do for their car.
struct GarageScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var model: GarageModel?
    /// The screen's one sheet: adding a car. The paywall hangs off
    /// `ProUpsellCard`'s own button — one presentation per view.
    @State private var addingCar = false

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model {
                content(model)
            }
        }
        .navigationTitle("Garage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    router.open(.settings)
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account")
            }
        }
        .task {
            if model == nil {
                let model = GarageModel(api: auth.api)
                self.model = model
                await model.load()
                router.garageAlertCount = model.alertCount
            }
        }
        // Back from a car — which may have been edited or deleted — reads the
        // list again. Through the offline cache, so it is cheap.
        .onAppear {
            guard let model else { return }
            Task {
                await model.load()
                router.garageAlertCount = model.alertCount
            }
        }
        .onChange(of: router.garageRevision) {
            guard let model else { return }
            Task {
                await model.load()
                router.garageAlertCount = model.alertCount
            }
        }
        .sheet(isPresented: $addingCar) {
            if let model {
                AddCarSheet(api: auth.api, firstCar: model.vehicles.isEmpty) { created in
                    await model.load()
                    router.garageAlertCount = model.alertCount
                    router.open(.vehicle(created.id))
                }
            }
        }
    }

    private func content(_ model: GarageModel) -> some View {
        TEPage {
            if model.pro == true {
                MaintenanceStrip(garage: model.garage)
            }

            TECardGrid(items: model.vehicles) { vehicle in
                carTile(model, vehicle)
            }
            addTile(model)

            if model.pro == false {
                TESectionHeader("Maintenance and costs")
                ProUpsellCard(
                    title: "Consumables, hours and costs",
                    blurb: """
                        Pads, tires, rotors and fluid, each with the hours it has actually done — \
                        accrued from your own track days — a wear projection, reminders before the \
                        next event, and what the car has cost you. Your cars and what they've done \
                        stay free.
                        """
                )
            }
        }
        .refreshable {
            await model.load()
            router.garageAlertCount = model.alertCount
        }
    }

    /// A car: its name, its catalog generation, what it has done, and — for Pro
    /// — its hours and the loudest thing fitted to it.
    private func carTile(_ model: GarageModel, _ vehicle: Vehicle) -> some View {
        let garageRow = model.garage.first { $0.id == vehicle.id }
        return TENavCard(route: .vehicle(vehicle.id), identifier: "garageCard", listPane: true) {
            HStack(spacing: 8) {
                Text(vehicle.name)
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                if vehicle.isDefault {
                    DefaultBadge()
                }
            }
            if let label = model.catalogLabel(for: vehicle) {
                Text(label)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            Text(model.tileLine(for: vehicle))
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
            if let garageRow {
                let active = garageRow.parts.filter { $0.retiredOn == nil }
                let worst = Garage.garageAlerts([garageRow]).first?.status
                Text("\(Garage.fmtHours(garageRow.hours)) on track")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                Text(Self.statusLine(worst: worst, activeParts: active.count))
                    .teStyle(.xs)
                    .foregroundStyle((worst ?? .ok).ink)
            }
        }
    }

    static func statusLine(worst: Garage.PartStatus?, activeParts: Int) -> String {
        switch worst {
        case .due: "Replace something now"
        case .low: "Something's due soon"
        // No alert isn't the same as nothing fitted: an empty tile says so
        // rather than claiming everything's healthy.
        case .ok, nil: activeParts == 0 ? "No consumables tracked yet" : "Nothing due"
        }
    }

    /// The last card: add a car. A button dressed as a card, so it reads as one
    /// more tile rather than as a form under the grid.
    private func addTile(_ model: GarageModel) -> some View {
        Button {
            addingCar = true
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: "plus")
                    .teStyle(.h2)
                    .foregroundStyle(Color(.accentInk))
                Text("Add car")
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                Text(model.vehicles.isEmpty
                    ? "Add the car you drive — new events fill it in, and its page keeps what it has done."
                    : "Pick it from the catalog or type it in.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(
                RoundedRectangle(cornerRadius: TERadius.md)
                    .strokeBorder(Color(.borderStrong), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Add car")
        .accessibilityIdentifier("addCar")
    }
}

/// The garage's "Default" pill, shared by the tile and the car's page.
struct DefaultBadge: View {
    var body: some View {
        Text("Default")
            .teStyle(.xxs)
            .foregroundStyle(Color(.accentInk))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Color(.accentTint), in: .capsule)
    }
}

/// What the Garage's detail pane says with no car picked (NS-34's rule: never
/// the list a second time).
struct GarageDetailPlaceholder: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "car")
                .font(.system(size: 36))
                .foregroundStyle(Color(.textFaint))
            Text("Pick a car")
                .teStyle(.h2)
                .foregroundStyle(Color(.textStrong))
        }
        .padding(TESpacing.cardPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.bgPage))
        .accessibilityIdentifier("garagePlaceholder")
    }
}

// MARK: - Adding a car

/// A new car: its name, optionally its catalog generation, and whether new events
/// start on it. The catalog pick (#222) lets the server pre-fill the wheelbase and
/// steering ratio, and names the car only when the driver hasn't.
///
/// Stacked controls, not side by side: `TEButtonStyle` sets
/// `frame(maxWidth: .infinity)`, and pinning that with `.fixedSize()` in an
/// `HStack` is the watchdog hazard documented on `VehicleScreen`.
struct AddCarSheet: View {
    let api: APIClient
    /// The first car in an empty garage becomes the default server-side; the
    /// toggle starts on to say so.
    let firstCar: Bool
    let added: (Vehicle) async -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var pick: CatalogCar?
    @State private var isDefault = false
    @State private var showingPicker = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            TEPage {
                TECard {
                    VStack(alignment: .leading, spacing: 14) {
                        TextField("2023 Corvette Z06", text: $name)
                            .teInput()
                            .accessibilityIdentifier("newVehicleName")
                        Button(pick.map(Garage.catalogCarLabel) ?? "Find it in the catalog…") {
                            showingPicker = true
                        }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .accessibilityIdentifier("pickCatalogCar")
                        .sheet(isPresented: $showingPicker) {
                            CatalogCarPicker(api: api) { row in
                                pick = row
                                if name.trimmingCharacters(in: .whitespaces).isEmpty {
                                    name = Garage.catalogCarName(row)
                                }
                            }
                        }
                        if pick != nil {
                            HStack {
                                Text("Its wheelbase and steering ratio fill in from the catalog.")
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textFaint))
                                Spacer()
                                Button("Clear") { pick = nil }
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.accentInk))
                                    .accessibilityIdentifier("clearCatalogCar")
                            }
                        }
                        Toggle("Default car for new events", isOn: $isDefault)
                            .teStyle(.sm)
                        if let error {
                            TEErrorBanner(message: error)
                        }
                        Button(saving ? "Adding…" : "Add car") { Task { await save() } }
                            .buttonStyle(TEButtonStyle(kind: .accent))
                            .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("addVehicle")
                        Text("Adding a car needs a connection.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }
            }
            .navigationTitle("Add car")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear { isDefault = firstCar }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        error = nil
        do {
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            // `isDefault` only when promoting: the first car is the default
            // server-side whatever the draft says.
            let created = try await api.createVehicle(
                VehicleDraft(name: trimmed, isDefault: isDefault ? true : nil, catalogId: pick?.id)
            )
            dismiss()
            await added(created)
        } catch let apiError as APIError {
            error = apiError.message
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Model

/// The Garage tab's data: the free vehicle list and events for everyone, and the
/// Pro garage beside them.
@MainActor
@Observable
final class GarageModel {
    private let api: APIClient

    private(set) var state: LoadState = .loading
    private(set) var vehicles: [Vehicle] = []
    private(set) var events: [Event] = []
    private(set) var garage: [GarageVehicle] = []
    private(set) var catalog: [CatalogCar] = []
    /// nil until `/garage` has answered; false on a 402, which locks the Pro half
    /// in place; true when it read. Any other failure (offline with nothing
    /// cached) leaves the Pro half simply absent — the free half still stands.
    private(set) var pro: Bool?

    init(api: APIClient) {
        self.api = api
    }

    func load() async {
        async let garageList: Result<[GarageVehicle], Error> = {
            do { return .success(try await api.garage()) } catch { return .failure(error) }
        }()
        async let catalogList = try? api.carCatalog()
        do {
            async let vehicleList = api.vehicles()
            async let eventList = api.events()
            let loaded = try await (vehicles: vehicleList, events: eventList)
            vehicles = loaded.vehicles
            events = loaded.events
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
        switch await garageList {
        case .success(let rows):
            garage = rows
            pro = true
        case .failure(let error as APIError) where error.isProRequired:
            garage = []
            pro = false
        case .failure:
            garage = []
        }
        catalog = await catalogList ?? catalog
    }

    var alertCount: Int { Garage.garageAlerts(garage).count }

    func tileLine(for vehicle: Vehicle) -> String {
        Garage.vehicleTileLine(Garage.vehicleLogbook(vehicle.id, events, today: EventDates.todayISO()))
    }

    func catalogLabel(for vehicle: Vehicle) -> String? {
        guard let id = vehicle.catalogId, let row = catalog.first(where: { $0.id == id }) else { return nil }
        return Garage.catalogCarLabel(row)
    }
}
