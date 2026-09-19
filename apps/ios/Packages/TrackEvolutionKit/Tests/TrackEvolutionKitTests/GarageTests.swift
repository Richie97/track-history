import Foundation
import Testing

@testable import TrackEvolutionKit

/// The garage's presentation logic, and its agreement with the web app.
///
/// The port carries the JS test cases with it (`test/unit/garage.test.js`), and
/// adds the cross-language fixture — `contracts/logic/garage-status.json`, run
/// through `public/js/garage.js` by `npm run contracts:logic` — because the
/// due/low thresholds are the kind of thing that drifts silently: a boundary an
/// hour out still looks entirely reasonable on screen.
struct GarageTests {
    // MARK: - Cross-language agreement

    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let fixture = try GarageFixture.load()

        for wearCase in fixture.cases {
            let status = Garage.partStatus(wearCase.wear)
            #expect(
                status?.rawValue == wearCase.status,
                "\(wearCase.name): status \(status?.rawValue ?? "nil") != \(wearCase.status ?? "nil")"
            )
            #expect(
                Garage.fmtRemaining(wearCase.wear) == wearCase.remaining,
                "\(wearCase.name): remaining phrasing differs"
            )
        }

        for hours in fixture.hours {
            #expect(Garage.fmtHours(hours.input) == hours.output, "fmtHours(\(hours.input ?? .nan))")
        }
        for cost in fixture.cost {
            #expect(Garage.fmtCost(cost.input) == cost.output, "fmtCost(\(cost.input.map(String.init) ?? "nil"))")
        }
        for kind in fixture.kinds {
            let ported = PartKind(rawValue: kind.kind)
            #expect(ported.label == kind.label)
            #expect(ported.wearLimitHint == kind.wearLimitHint)
        }
        // A guard against the fixture silently emptying out and the loops above
        // passing vacuously.
        #expect(fixture.cases.count >= 10)
        #expect(fixture.kinds.count == PartKind.all.count)
    }

    // MARK: - Car catalog picker (#222)

    @Test func matchesTheJavaScriptCatalogMatcherOnASharedFixture() throws {
        let fixture = try CatalogMatchFixture.load()
        let rows = fixture.rows
        for labels in fixture.labels {
            let row = try #require(rows.first(where: { $0.id == labels.id }))
            #expect(Garage.catalogCarName(row) == labels.name, "name of \(labels.id)")
            #expect(Garage.catalogCarLabel(row) == labels.label, "label of \(labels.id)")
        }
        for query in fixture.queries {
            #expect(
                Garage.matchCatalogCars(query.query, rows).map(\.id) == query.ids,
                "query \"\(query.query)\""
            )
        }
        for prefill in fixture.prefill {
            let row = try #require(rows.first(where: { $0.id == prefill.row }))
            let previous = prefill.previous.flatMap { id in rows.first(where: { $0.id == id }) }
            let plan = Garage.catalogPrefill(
                row,
                current: Garage.VehicleGeometry(
                    wheelbaseMm: prefill.current.wheelbaseMm, steeringRatio: prefill.current.steeringRatio
                ),
                previous: previous
            )
            #expect(plan.wheelbaseMm.action.rawValue == prefill.plan.wheelbaseMm.action, "\(prefill.name): wheelbase")
            #expect(plan.wheelbaseMm.value == prefill.plan.wheelbaseMm.value, "\(prefill.name): wheelbase value")
            #expect(plan.steeringRatio.action.rawValue == prefill.plan.steeringRatio.action, "\(prefill.name): ratio")
            #expect(plan.steeringRatio.value == prefill.plan.steeringRatio.value, "\(prefill.name): ratio value")
        }
        #expect(fixture.queries.count >= 10)
        #expect(fixture.prefill.count >= 5)
    }

    @Test func everyQueryTokenHasToFitSoExtraWordsNarrow() {
        let rows = catalogRows
        #expect(Garage.matchCatalogCars("corvette c8", rows).map(\.id) == [3])
        #expect(Garage.matchCatalogCars("corvette miata", rows).isEmpty)
        #expect(Garage.matchCatalogCars("", rows).map(\.id) == [1, 2, 3, 4, 5, 6])
    }

    @Test func ranksWholeWordsOverPrefixesOverSubstrings() {
        let rows = catalogRows
        // "e46" is a whole word on the M3; "e" is only inside the others' names.
        #expect(Garage.matchCatalogCars("e", rows).map(\.id) == [1, 2, 3, 5])
        #expect(Garage.matchCatalogCars("mx5", rows).map(\.id) == [4])
        #expect(Garage.matchCatalogCars("corvette 2017", rows).map(\.id) == [2])
    }

    @Test func prefillsSilentlyOnlyWhatIsNotTheDrivers() {
        let c7 = catalogRows[1], c8 = catalogRows[2], cayman = catalogRows[4]
        let empty = Garage.catalogPrefill(c7, current: .init(), previous: nil)
        #expect(empty.wheelbaseMm == .init(value: 2710, action: .fill))
        #expect(empty.steeringRatio == .init(value: 16.25, action: .fill))

        let typed = Garage.catalogPrefill(c7, current: .init(wheelbaseMm: 2700, steeringRatio: 15), previous: nil)
        #expect(typed.wheelbaseMm.action == .ask)
        #expect(typed.steeringRatio.action == .ask)

        let repick = Garage.catalogPrefill(c8, current: .init(wheelbaseMm: 2710, steeringRatio: 15), previous: c7)
        #expect(repick.wheelbaseMm.action == .fill)
        #expect(repick.steeringRatio.action == .ask)

        // The catalog never offers to replace the driver's number with nothing,
        // but does clear the previous car's ratio when the new car has none.
        let noRatio = Garage.catalogPrefill(cayman, current: .init(wheelbaseMm: 2700, steeringRatio: 15), previous: nil)
        #expect(noRatio.steeringRatio.action == .keep)
        let cleared = Garage.catalogPrefill(cayman, current: .init(wheelbaseMm: 2710, steeringRatio: 16.25), previous: c7)
        #expect(cleared.steeringRatio == .init(value: nil, action: .fill))
    }

    // MARK: - Status thresholds

    @Test func hasNoStatusWithoutAProjection() {
        #expect(Garage.partStatus(nil) == nil)
        #expect(Garage.partStatus(makeWear(remaining: nil)) == nil)
    }

    @Test func treatsAFullyUsedPartAsDueEvenWithHoursLeft() {
        // The measured fit and the expectation can disagree; the pessimistic one
        // wins, because "you have 1.5 h left" on a pad that's at its limit is the
        // one wrong answer that costs a rotor.
        #expect(Garage.partStatus(makeWear(remaining: 1.5, pctUsed: 1)) == .due)
    }

    @Test func drawsTheLowLineAtTwoTrackDays() {
        #expect(Garage.partStatus(makeWear(remaining: 4)) == .low)
        #expect(Garage.partStatus(makeWear(remaining: 4.01)) == .ok)
        #expect(Garage.partStatus(makeWear(remaining: 0)) == .due)
        #expect(Garage.partStatus(makeWear(remaining: -1)) == .due)
    }

    // MARK: - Formatting

    @Test func formatsHoursTheWayJavaScriptStringifiesThem() {
        #expect(Garage.fmtHours(nil) == "—")
        #expect(Garage.fmtHours(4) == "4 h")
        #expect(Garage.fmtHours(4.25) == "4.3 h")
        #expect(Garage.fmtHours(0.04) == "0 h")
    }

    @Test func namesTheRemainingLifeInTrackDays() {
        #expect(Garage.fmtRemaining(nil) == nil)
        #expect(Garage.fmtRemaining(makeWear(remaining: 0)) == "replace now")
        #expect(Garage.fmtRemaining(makeWear(remaining: 2)) == "~2 h left (≈1 track day)")
        #expect(Garage.fmtRemaining(makeWear(remaining: 3.4)) == "~3.4 h left (≈1.5 track days)")
        #expect(Garage.fmtRemaining(makeWear(remaining: 9.4)) == "~9.4 h left (≈5 track days)")
    }

    @Test func formatsCostWithCentsOnlyWhenThereAreAny() {
        #expect(Garage.fmtCost(nil) == nil)
        #expect(Garage.fmtCost(38900) == "$389")
        #expect(Garage.fmtCost(38950) == "$389.50")
        #expect(Garage.fmtCost(5) == "$0.05")
    }

    @Test func fallsBackToTheRawValueForAKindThisBuildHasNeverHeardOf() {
        // A kind added server-side must degrade to something readable rather than
        // rendering an empty chip. Same reason `PartKind` isn't an enum.
        let future = PartKind(rawValue: "clutch")
        #expect(future.label == "clutch")
        #expect(future.wearLimitHint == nil)
    }

    // MARK: - Alerts

    @Test func alertsOnlyOnActivePartsThatAreDueOrLow() {
        let garage = [
            makeVehicle(id: 1, name: "Corvette", parts: [
                makePart(id: 10, kind: .padsFront, remaining: 20),      // ok
                makePart(id: 11, kind: .tires, remaining: 1),           // low
                makePart(id: 12, kind: .oil, remaining: nil),           // no estimate
                makePart(id: 13, kind: .padsRear, remaining: 0, retiredOn: "2026-01-04")
            ])
        ]
        let alerts = Garage.garageAlerts(garage)
        #expect(alerts.map(\.part.id) == [11])
        #expect(alerts.first?.status == .low)
    }

    @Test func putsDueBeforeLowAndKeepsTheOriginalOrderWithin() {
        let garage = [
            makeVehicle(id: 1, name: "Corvette", parts: [
                makePart(id: 10, kind: .padsFront, remaining: 3),  // low
                makePart(id: 11, kind: .tires, remaining: 0)       // due
            ]),
            makeVehicle(id: 2, name: "Miata", parts: [
                makePart(id: 20, kind: .padsRear, remaining: -1),  // due
                makePart(id: 21, kind: .oil, remaining: 1)         // low
            ])
        ]
        let alerts = Garage.garageAlerts(garage)
        // Both due parts first, in the order the payload listed them, then both low.
        #expect(alerts.map(\.part.id) == [11, 20, 10, 21])
        #expect(alerts.map(\.vehicle.id) == [1, 2, 1, 2])
    }

    @Test func hasNothingToSayAboutAnEmptyGarage() {
        #expect(Garage.garageAlerts([]).isEmpty)
        #expect(Garage.garageAlerts([makeVehicle(id: 1, name: "Corvette", parts: [])]).isEmpty)
    }

    // MARK: - Fixtures

    /// The six rows `test/unit/garage.test.js` uses for the catalog cases.
    private var catalogRows: [CatalogCar] {
        [
            makeCar(id: 1, make: "BMW", model: "M3", generation: "E46", from: 2000, to: 2006, wheelbase: 2731, ratio: 15.4),
            makeCar(id: 2, make: "Chevrolet", model: "Corvette", generation: "C7", from: 2014, to: 2019, wheelbase: 2710, ratio: 16.25),
            makeCar(id: 3, make: "Chevrolet", model: "Corvette", generation: "C8", from: 2020, to: nil, wheelbase: 2722, ratio: 15.7),
            makeCar(id: 4, make: "Mazda", model: "MX-5", generation: "ND", from: 2015, to: nil, wheelbase: 2310, ratio: 15.5),
            makeCar(id: 5, make: "Porsche", model: "718 Cayman", generation: "982", from: 2016, to: nil, wheelbase: 2475, ratio: nil),
            makeCar(id: 6, make: "Toyota", model: "GR86", generation: nil, from: 2022, to: nil, wheelbase: 2575, ratio: 13.5),
        ]
    }

    private func makeCar(
        id: Int, make: String, model: String, generation: String?, from: Int, to: Int?, wheelbase: Int, ratio: Double?
    ) -> CatalogCar {
        CatalogCar(
            id: id, make: make, model: model, generation: generation, yearFrom: from, yearTo: to,
            wheelbaseMm: wheelbase, steeringRatio: ratio, source: "test"
        )
    }

    private func makeWear(remaining: Double?, pctUsed: Double? = nil) -> WearEstimate {
        WearEstimate(
            hours: 0, events: 0, cycles: 0, expectedHours: nil, remainingHours: remaining,
            pctUsed: pctUsed, source: nil, wearPerHour: nil, lastValue: nil, unit: nil
        )
    }

    private func makePart(
        id: Int, kind: PartKind, remaining: Double?, retiredOn: String? = nil
    ) -> Part {
        Part(
            id: id, vehicleId: 1, kind: kind, name: "test", installedOn: "2026-01-01",
            retiredOn: retiredOn, expectedHours: nil, wearLimit: nil, costCents: nil, notes: nil,
            measurements: [], wear: makeWear(remaining: remaining)
        )
    }

    private func makeVehicle(id: Int, name: String, parts: [Part]) -> GarageVehicle {
        GarageVehicle(
            id: id, name: name, notes: nil, isDefault: false, updatedAt: 0,
            hours: 0, eventCount: 0, eventDays: 0, parts: parts
        )
    }
}

/// `contracts/logic/garage-status.json` — reference output captured from
/// `public/js/garage.js`.
struct GarageFixture: Decodable {
    struct WearCase: Decodable {
        let name: String
        let wear: WearEstimate
        /// Nil when the estimate has no basis — not a missing field.
        let status: String?
        let remaining: String?
    }

    struct HoursCase: Decodable {
        let input: Double?
        let output: String
    }

    struct CostCase: Decodable {
        let input: Int?
        let output: String?
    }

    struct KindCase: Decodable {
        let kind: String
        let label: String
        let wearLimitHint: String?
    }

    let cases: [WearCase]
    let hours: [HoursCase]
    let cost: [CostCase]
    let kinds: [KindCase]

    static func load() throws -> GarageFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/garage-status.json"))
        return try JSONDecoder().decode(GarageFixture.self, from: data)
    }
}

/// `contracts/logic/car-catalog-match.json` — the catalog picker's matching,
/// labels and pre-fill rule, captured from `public/js/garage.js`.
struct CatalogMatchFixture: Decodable {
    struct Labels: Decodable {
        let id: Int
        let name: String
        let label: String
    }

    struct Query: Decodable {
        let query: String
        let ids: [Int]
    }

    struct Geometry: Decodable {
        let wheelbaseMm: Int?
        let steeringRatio: Double?

        enum CodingKeys: String, CodingKey {
            case wheelbaseMm = "wheelbase_mm"
            case steeringRatio = "steering_ratio"
        }
    }

    struct Step<Value: Decodable>: Decodable {
        let value: Value?
        let action: String
    }

    struct Plan: Decodable {
        let wheelbaseMm: Step<Int>
        let steeringRatio: Step<Double>

        enum CodingKeys: String, CodingKey {
            case wheelbaseMm = "wheelbase_mm"
            case steeringRatio = "steering_ratio"
        }
    }

    struct Prefill: Decodable {
        let name: String
        let row: Int
        let current: Geometry
        let previous: Int?
        let plan: Plan
    }

    let rows: [CatalogCar]
    let labels: [Labels]
    let queries: [Query]
    let prefill: [Prefill]

    static func load() throws -> CatalogMatchFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/car-catalog-match.json"))
        return try JSONDecoder().decode(CatalogMatchFixture.self, from: data)
    }
}
