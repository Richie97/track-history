import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases in `test/unit/pdr25.test.js`, asked of the same committed files:
/// `pdr25-laps.mp4` is `buildPdr25Mp4({ lapCrossings: [30, 30 + lapS, 30 + 2·lapS] })`
/// and `pdr25-nolaps.mp4` is `buildPdr25Mp4()`. `VideoContractTests` pins the whole
/// output to the JS; these say what each part of it means.
struct PDR25Tests {
    private static let lapMs = 47124  // Math.round(LAP_S() * 1000)

    private func parse(_ file: String = "pdr25-nolaps.mp4") throws -> ParsedTelemetry {
        try PDR25.parsePdr25File(try VideoFixtures.source(file))
    }

    private func range(_ arr: [ChannelPoint]?) -> (Double, Double) {
        let v = (arr ?? []).map(\.v)
        return (v.min() ?? .nan, v.max() ?? .nan)
    }

    /// The `adco` sample entry's child boxes.
    private func adcoParts() throws -> (ByteView, [MP4.Box]) {
        let moov = try MP4.readMoov(try VideoFixtures.source("pdr25-nolaps.mp4"))
        let dv = moov.view
        let trak = try #require(MP4.boxes(dv, moov.root.body, moov.root.size).first { $0.type == "trak" })
        let mdia = try #require(MP4.child(dv, trak, "mdia"))
        let minf = try #require(MP4.child(dv, mdia, "minf"))
        let stbl = try #require(MP4.child(dv, minf, "stbl"))
        let stsd = try #require(MP4.child(dv, stbl, "stsd"))
        let adco = try #require(MP4.boxes(dv, stsd.body + 8, stsd.start + stsd.size).first)
        return (dv, MP4.boxes(dv, adco.body + 8, adco.start + adco.size))
    }

    // MARK: - The self-description

    @Test func readsEveryChannelEntryNumericScalingsAndEnumLabelsAlike() throws {
        let (dv, parts) = try adcoParts()
        let b = try #require(parts.first { $0.type == "adcp" })
        let chans = PDR25.parseChannelTable(dv, b.body, b.start + b.size)
        let byName = Dictionary(uniqueKeysWithValues: chans.values.map { ($0.name, $0) })
        let speed = try #require(byName["speed"])
        #expect(speed.kind == 1)
        #expect(speed.mult == 1 / 230.4)
        #expect(abs((byName["engine.temperature.oil"]?.off ?? 0) - 233.15) < 1e-9)
        let gear = try #require(byName["gear"]?.labels)
        #expect(gear["notsupported"] == 0 && gear["first"] == 1 && gear["tenth"] == 10 && gear["neutral"] == 13)
        // the reversed status: read by label, never assumed
        #expect(byName["stability.vehiclestabilityenhancement"]?.labels == ["unknown": 3, "active": 0, "inactive": 1])
        #expect(chans[58] != nil)
    }

    @Test func readsTheRecordScheduleWithEachGroupsByteSize() throws {
        let (dv, parts) = try adcoParts()
        let b = try #require(parts.first { $0.type == "adcr" })
        let groups = PDR25.parseSchedule(dv, b.body, b.start + b.size)
        #expect(groups.map(\.period) == [500_000, 1_000_000, 2_000_000, 10_000_000])
        // brake u8 + rpm u16 + steering s16 + yaw s16
        #expect(groups[0].bytes == 7)
    }

    // MARK: - parsePdr25File

    @Test func timesLapsFromLapStartAndLapEndEventsExactly() throws {
        let out = try parse("pdr25-laps.mp4")
        #expect(out.laps.map(\.timeMs) == [Self.lapMs, Self.lapMs])
        #expect(out.laps.allSatisfy { !$0.estimated })
        #expect(out.laps.map(\.lapNumber) == [1, 2])
        #expect(abs((out.laps[0].startT ?? 0) - 30) < 1e-6)
        // three crossings; the lap opened at the last one never closes
        #expect(out.beaconCount == 3)
    }

    @Test func takesTheRecordersTimestampAsLocalWallClockTime() throws {
        let out = try parse()
        #expect(out.date == "2026-07-17")
        #expect(out.time == "11:22:47")
    }

    @Test func convertsEveryCarChannelToParsePdrFilesDisplayUnits() throws {
        let out = try parse()
        let c = out.carChannels
        #expect(abs(range(c.speed).0 - 136.8) < 0.5)
        #expect(abs(range(c.speed).1 - 151.2) < 0.5)
        #expect(abs(range(c.rpm).0 - 3000) < 1e-6)
        #expect(abs(range(c.rpm).1 - 6000) < 1e-6)
        // the axis swap: lateral from vehicle.x (v²/r), longitudinal from -vehicle.y
        #expect(abs(range(c.latG).1 - 42 * 42 / 300 / 9.80665) < 0.005)
        #expect(abs(range(c.longG).0 + 0.8) < 0.001)
        #expect(abs((out.metrics?.maxBrakeG ?? 0) - 0.8) < 0.001)
        #expect(range(c.throttle) == (0, 100))
        #expect(abs(range(c.steering).1 - 30) < 0.05)
        #expect(range(c.yaw).0 > 7)
        #expect(range(c.boost) == (-60, 60))
        // rear wheels 2% over the fronts
        #expect(abs(range(c.wheelSlip).0 - 2) < 0.001)
    }

    @Test func readsGearsAndTheStabilityFlagsByLabel() throws {
        let c = try parse().carChannels
        // neutral (13) is the no-gear state, never a thirteenth gear
        #expect(Set((c.gear ?? []).map(\.v)) == [0, 1, 2, 3, 4, 5])
        let bits = (c.flags ?? []).reduce(0) { $0 | Int($1.v) }
        #expect(bits & 1 == 1)  // ABS
        #expect(bits & 2 == 2)  // traction control
        #expect(bits & 4 == 4)  // stability control
    }

    @Test func reducesTheSlowChannelsToPerLapScalarsAndSessionContext() throws {
        let out = try parse()
        let s = out.lapScalarChannels
        #expect(range(s["oilC"]) == (43, 130))
        #expect(range(s["oilKpa"]) == (224, 336))
        #expect(range(s["tyreKpaLF"]) == (144, 220))
        #expect(abs(range(s["tyreCRR"]).1 - 77) < 1e-6)
        #expect(s["battV"] == nil)  // the recorder has no battery channel
        #expect(abs((out.sessionMeta?.ambientC ?? 0) - 15) < 1e-6)
        #expect((out.sessionMeta?.odometerKm ?? 0) > 71000)
        #expect(out.channels == nil)
    }

    @Test func keepsOnlyGPSFixesThatHaveAPosition() throws {
        let gps = try #require(try parse().gps)
        #expect(gps[0].t >= 2)
        #expect(abs(gps[0].lat - 36.56) < 0.01)
        #expect(abs((gps[0].v ?? 0) - 40) < 0.5)  // m/s, like a PDR trace
    }

    @Test func refusesAFileWithoutTheAdrvTrackAsNotItsOwn() throws {
        #expect(throws: TelemetryParseError.self) {
            try PDR25.parsePdr25File(try VideoFixtures.source("pdr-delta.mp4"))
        }
        do {
            _ = try PDR25.parsePdr25File(try VideoFixtures.source("pdr-delta.mp4"))
        } catch let error as TelemetryParseError {
            #expect(error.isNoTrack)
        }
    }

    // MARK: - Through the import dispatch

    @Test func arrivesAsAPDRSessionWithExactLapsATraceAndChannels() throws {
        let out = try Telemetry.parseTelemetryFile(try VideoFixtures.source("pdr25-laps.mp4"))
        #expect(out.kind == .pdr)
        #expect(!out.needsLine)
        #expect((out.bestLapTrace?.count ?? 0) > 50)
        #expect(out.lapChannels?.laps.count == 2)
    }

    @Test func sendsARecordingWithNoLapEventsToTheLinePicker() throws {
        let out = try Telemetry.parseTelemetryFile(try VideoFixtures.source("pdr25-nolaps.mp4"))
        #expect(out.laps.isEmpty)
        #expect(out.needsLine)
        #expect(out.lapRecovery == nil)
    }
}
