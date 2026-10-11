import Foundation
import Testing

@testable import TrackEvolutionKit

/// The setup notebook's pure half (NS-40) — `Garage`'s setup-sheet helpers and
/// `Health`'s pressure loop — asserted against `contracts/logic/setups.json`,
/// which `npm run contracts:logic` generates from `public/js/garage.js` and
/// `public/js/health.js`. Android's `SetupsTest` reads the same fixture.
struct SetupsTests {
    /// Read per use rather than stored: a `[String: Any]` isn't `Sendable`.
    private var fixture: [String: Any] {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/setups.json"))
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    private func units(_ name: Any?) -> UnitSystem { (name as? String) == "metric" ? .metric : .imperial }
    private func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

    /// A sheet from fixture JSON, through the real decoder — `null` included.
    private func sheet(_ v: Any?) -> SetupSheet? {
        guard let v, !(v is NSNull) else { return nil }
        let data = try! JSONSerialization.data(withJSONObject: v)
        return try! JSONDecoder().decode(SetupSheet.self, from: data)
    }

    private func corners(_ v: Any?) -> CornerValues? {
        guard let v, !(v is NSNull) else { return nil }
        let data = try! JSONSerialization.data(withJSONObject: v)
        return try! JSONDecoder().decode(CornerValues.self, from: data)
    }

    private struct HealthInput: Decodable {
        struct Input: Decodable { let channels: SessionChannels }
        let input: Input
    }

    @Test func theFieldSpecMatchesTheWebs() {
        let want = fixture["SETUP_FIELDS"] as! [[String: Any]]
        #expect(want.map { $0["key"] as! String } == Garage.SETUP_FIELDS.map(\.key))
        for (w, f) in zip(want, Garage.SETUP_FIELDS) {
            #expect(w["label"] as? String == f.label)
            #expect(w["unit"] as? String == f.unit)
            #expect(w["shape"] as? String == f.shape.rawValue)
            #expect(num(w["step"]) == f.step)
        }
        #expect((fixture["PART_REFS"] as! [[String]]) == Garage.PART_REFS.map { [$0.key, $0.label, $0.kind.rawValue] })
        #expect((fixture["CORNER_KEYS"] as! [[String]]) == Garage.CORNER_KEYS.map { [$0.key, $0.label] })
        #expect((fixture["AXLE_KEYS"] as! [[String]]) == Garage.AXLE_KEYS.map { [$0.key, $0.label] })
    }

    @Test func displayAndStoredConversionsMatchInBothSystems() {
        for row in fixture["fields"] as! [[String: Any]] {
            let f = Garage.SETUP_FIELDS.first { $0.key == row["key"] as? String }!
            let u = units(row["units"])
            #expect(row["unit"] as? String == Garage.setupUnit(f, u), "\(f.key) \(u)")
            #expect(num(row["step"]) == Garage.setupStep(f, u), "\(f.key) \(u)")
            for pair in row["display"] as! [[Any]] {
                let got = Garage.setupToDisplay(f, num(pair[0]), u)!
                #expect(abs(got - num(pair[1])!) < 1e-9, "\(f.key) \(u) display \(pair[0])")
            }
            for pair in row["stored"] as! [[Any]] {
                let got = Garage.setupToStored(f, num(pair[0]), u)!
                #expect(abs(got - num(pair[1])!) < 1e-9, "\(f.key) \(u) stored \(pair[0])")
            }
        }
    }

    @Test func flatteningLabelsUnitsAndValueTextMatch() {
        for pair in fixture["fieldFor"] as! [[Any]] {
            #expect(Garage.setupFieldFor(pair[0] as! String)?.key == pair[1] as? String, "\(pair[0])")
        }
        let flat = fixture["flat"] as! [String: Any]
        let full = sheet(flat["sheet"])!
        let want = (flat["flatten"] as! [[Any]]).map { "\($0[0]) \(num($0[1])!)" }
        #expect(Garage.flattenSetup(full).map { "\($0.key) \($0.value)" } == want)
        for pair in flat["labels"] as! [[String]] {
            #expect(Garage.flatLabel(pair[0]) == pair[1])
        }
        #expect(Garage.flatLabel("nonsense") == flat["unknownLabel"] as? String)
        #expect(Garage.flattenSetup(nil).isEmpty)
        for system in flat["units"] as! [[String: Any]] {
            let u = units(system["units"])
            for pair in system["units_of"] as! [[String]] {
                #expect(Garage.flatUnit(pair[0], u) == pair[1], "\(pair[0]) \(u)")
            }
            for triple in system["values"] as! [[Any]] {
                let key = triple[0] as! String
                #expect(Garage.fmtSetupValue(key, num(triple[1]), u) == triple[2] as? String, "\(key) \(triple[1]) \(u)")
            }
        }
    }

    @Test func diffsMatch() {
        let diff = fixture["diff"] as! [String: Any]
        func changes(_ v: Any?) -> [Garage.SetupChange] {
            (v as! [[String: Any]]).map {
                Garage.SetupChange(key: $0["key"] as! String, from: num($0["from"]), to: num($0["to"]))
            }
        }
        #expect(Garage.diffSetups(sheet(diff["prev"]), sheet(diff["cur"])) == changes(diff["changes"]))
        var fromNothing = SetupSheet()
        fromNothing.tpCold = CornerValues(fl: 26)
        fromNothing.fuel = 10
        #expect(Garage.diffSetups(nil, fromNothing) == changes(diff["fromNothing"]))
        var toNothing = SetupSheet()
        toNothing.camber = AxleValues(f: -3)
        #expect(Garage.diffSetups(toNothing, nil) == changes(diff["toNothing"]))
        #expect(Garage.diffSetups(sheet(diff["prev"]), sheet(diff["prev"])).isEmpty)
    }

    @Test func previousSheetMatches() {
        let prev = fixture["previous"] as! [String: Any]
        let setups = (prev["setups"] as! [[String: Any]]).map {
            Setup(day: $0["day"] as! Int, data: sheet($0["data"])!)
        }
        for pair in prev["cases"] as! [[Any]] {
            let day = pair[0] as! Int
            #expect(Garage.previousSheet(setups, day) == sheet(pair[1]), "day \(day)")
        }
        #expect(Garage.previousSheet([], 2) == nil)
        #expect(Garage.previousSheet(nil, 2) == nil)
    }

    @Test func thePressureLoopAndTheSheetsItsButtonsWriteMatch() throws {
        let healthData = try Data(contentsOf: RepoRoot.path("contracts/logic/health.json"))
        let channels = try JSONDecoder().decode(HealthInput.self, from: healthData).input.channels
        let fx = fixture["loop"] as! [String: Any]
        let daySheet = sheet(fx["sheet"])
        let target = num(fx["targetPsi"])!
        let loop = try #require(Health.pressureLoop(channels, daySheet, target))
        let noTarget = try #require(Health.pressureLoop(channels, daySheet, nil))

        let wantLoop = fx["loop"] as! [String: Any]
        #expect(loop.hotSheet == corners(wantLoop["hotSheet"]))
        #expect(loop.coldSheet == corners(wantLoop["coldSheet"]))
        let rows = wantLoop["rows"] as! [[String: Any]]
        #expect(rows.count == loop.rows.count)
        for (w, r) in zip(rows, loop.rows) {
            #expect(w["corner"] as? String == r.corner)
            #expect(num(w["coldPsi"]) == r.coldPsi)
            #expect(abs(num(w["hotPsi"])! - r.hotPsi!) < 1e-9)
            #expect(w["hotChIdx"] as? Int == r.hotChIdx)
            if let s = w["suggestion"] as? [String: Any] {
                #expect(num(s["suggestedPsi"]) == r.suggestion?.suggestedPsi)
            } else {
                #expect(r.suggestion == nil)
            }
        }
        #expect(noTarget.coldSheet == nil)
        #expect(Health.pressureLoop(channels, nil, target)?.coldSheet == nil)

        #expect(Health.nextTimeNote(loop) == fx["note"] as? String)
        #expect(Health.nextTimeNote(noTarget) == nil)

        let once = Health.recordHotSheet(daySheet, loop)
        #expect(once == sheet(fx["recordedOnce"]))
        #expect(Health.recordHotSheet(once, loop) == sheet(fx["recordedTwice"]))
        #expect(Health.recordHotSheet(nil, loop) == sheet(fx["recordedOnNothing"]))

        let full = sheet((fixture["flat"] as! [String: Any])["sheet"])
        #expect(Health.nextDaySheet(nil, full, loop) == sheet(fx["nextFromToday"]))
        var own = SetupSheet()
        own.camber = AxleValues(f: -2)
        own.tpCold = CornerValues(fl: 20)
        #expect(Health.nextDaySheet(own, full, loop) == sheet(fx["nextKeepsItsOwn"]))
        #expect(Health.nextDaySheet(nil, full, noTarget) == sheet(fx["nextNoSuggestion"]))
    }

    @Test func withSheetValueSetsClearsAndDropsAnEmptiedGroup() {
        var s = SetupSheet()
        s = Garage.withSheetValue(s, "tp_cold.fl", 26)
        s = Garage.withSheetValue(s, "tires_f_id", 12)
        #expect(Garage.sheetValue(s, "tp_cold.fl") == 26)
        #expect(Garage.sheetValue(s, "tires_f_id") == 12)
        s = Garage.withSheetValue(s, "tp_cold.fl", nil)
        // A group with nothing left is dropped, as sanitizeSetup drops it.
        #expect(s.tpCold == nil)
        #expect(!Garage.isEmptySheet(s))
        #expect(Garage.isEmptySheet(Garage.withSheetValue(s, "tires_f_id", nil)))
    }
}
