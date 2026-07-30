import Foundation
import Testing

@testable import TrackEvolutionKit

/// The optionality rules from `withComputed` (`src/lib/stats.ts`) that are easy
/// to get wrong, pinned against real captured responses.
struct ModelTests {
    @Test func consistencyIsNilBelowThreeLaps() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail-no-laps")
        #expect(detail.event.consistency == nil, "must be nil, never 0")
        #expect(detail.event.lapCount == 0)

        // …and populated once there are enough laps.
        let events = try Goldens.decode([Event].self, "events-list")
        let withLaps = events.filter { $0.lapCount >= 3 }
        #expect(!withLaps.isEmpty, "fixture should include an event with 3+ laps")
        #expect(withLaps.allSatisfy { $0.consistency != nil })
        #expect(events.filter { $0.lapCount < 3 }.allSatisfy { $0.consistency == nil })
    }

    @Test func bestMsIsNilWithoutAManualBestOrAnyLaps() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail-no-laps")
        #expect(detail.event.bestMs == nil)
        #expect(detail.event.bestTimeMs == nil)
        #expect(detail.event.lapBestMs == nil)
    }

    @Test func bestMsIsTheBetterOfTheManualBestAndTheLoggedLaps() throws {
        let events = try Goldens.decode([Event].self, "events-list")
        for event in events {
            let bests = [event.bestTimeMs, event.lapBestMs].compactMap { $0 }
            #expect(event.bestMs == bests.min(), "best_ms = MIN(manual, logged)")
        }
    }

    @Test func hoursIsNeverNilAndCarriesTheOverrideWhenSet() throws {
        let events = try Goldens.decode([Event].self, "events-list")
        #expect(!events.isEmpty)
        for event in events {
            #expect(event.hours > 0)
            if let override = event.trackHours {
                #expect(event.hours == override)
            } else {
                // Else max(days × 2h, logged lap time) — at least the 2h/day floor.
                #expect(event.hours >= Double(event.days) * 2)
            }
        }
    }

    @Test func eventDetailCarriesSessionsLapsAndSetups() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        #expect(detail.sessions.count == detail.event.sessionCount)
        #expect(detail.sessions.flatMap(\.laps).count == detail.event.lapCount)
        #expect(detail.setups.map(\.day) == [1, 2])
        #expect(detail.setups.first?.data.camber?.f == -3.2)
        #expect(detail.setups.first?.data.tpCold?.fl == 26)

        // Lap numbering is per session, starting at 1.
        for session in detail.sessions {
            #expect(session.laps.map(\.lapNum) == Array(1...session.laps.count))
        }

        // The imported session carries a trace and channels; the others don't.
        let imported = detail.sessions.filter { $0.channels != nil }
        #expect(imported.count == 1)
        #expect(imported.first?.channels?.dStepM == 20)
        #expect(imported.first?.channels?.laps.first?.speed?.count == 12)
        #expect(imported.first?.trace?.first == TracePoint(x: 400, y: 0, v: 30))
    }

    @Test func checklistIsDecodedAndOrderPreserved() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        #expect(detail.event.checklist?.count == 2)
        #expect(detail.event.checklist?.first == ChecklistItem(text: "Torque wheels", done: true))
        #expect(detail.event.checklist?.last?.done == false)
    }

    @Test func conditionsDecodeToKnownValuesButToleratesNewOnes() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        #expect(detail.event.conditions == .dry)

        // A value the server adds later must not break the whole event.
        let json = Data(#"{"conditions":"snow"}"#.utf8)
        struct Holder: Decodable { var conditions: Conditions? }
        #expect(try JSONDecoder().decode(Holder.self, from: json).conditions?.rawValue == "snow")
    }

    @Test func vehicleIsDefaultDecodesSQLitesZeroOrOne() throws {
        let vehicles = try Goldens.decode([Vehicle].self, "vehicles-list")
        #expect(vehicles.filter(\.isDefault).count == 1)
        #expect(vehicles.first?.isDefault == true)
        #expect(vehicles.last?.isDefault == false)
    }

    @Test func shareDataOmitsPrivateFields() throws {
        // The reduced public shape is modelled separately on purpose: if the
        // server ever leaked notes or per-lap data into it, this decode would
        // still pass but the round-trip test in GoldenContractTests would fail
        // on the unmodelled key. Here we simply pin what the public page shows.
        let share = try Goldens.decode(ShareData.self, "share-public")
        #expect(share.totals.events == 3)
        #expect(share.events.count == 3)
        #expect(share.tracks.count == 3)
        #expect(share.events.contains { $0.bestMs != nil })

        let body = try Goldens.body("share-public")
        let json = String(decoding: body, as: UTF8.self)
        for leaked in ["\"notes\"", "\"email\"", "\"checklist\"", "\"vehicle_id\"", "\"laps\""] {
            #expect(!json.contains(leaked), "public share payload must not carry \(leaked)")
        }
    }

    @Test func garageWearEstimateKeepsItsSourceAndNulls() throws {
        let garage = try Goldens.decode([GarageVehicle].self, "garage")
        let parts = garage.flatMap(\.parts)
        let tires = try #require(parts.first { $0.kind == .tires })
        #expect(tires.wear.source == nil, "no expected life and no measurements → no projection")
        #expect(tires.wear.remainingHours == nil)
        #expect(tires.wear.pctUsed == nil)

        let pads = try #require(parts.first { $0.kind == .padsFront })
        #expect(pads.wear.source == .expected)
        #expect(pads.wear.expectedHours == 24)
        #expect(pads.wear.lastValue == 7.8)
        #expect(pads.measurements.count == 2)
        #expect(pads.wearLimit == 3)
    }
}
