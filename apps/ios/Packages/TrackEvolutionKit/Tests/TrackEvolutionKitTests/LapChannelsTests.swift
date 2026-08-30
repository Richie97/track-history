import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/channels.test.js`, ported with the code.
struct LapChannelsTests {
    // Constant 40 m/s: distance is 40t, one 47.12 s lap covers 1884.8 m.
    private static let dist = (0..<400).map { ChannelPoint(t: Double($0) * 0.5, v: Double($0) * 20) }
    private static let speed = (0..<400).map { ChannelPoint(t: Double($0) * 0.5, v: 144) }  // km/h
    private static let rpm = (0..<400).map {
        ChannelPoint(t: Double($0) * 0.5, v: Double(5000 + $0 % 10))
    }

    // MARK: - buildLapChannels

    @Test func cutsChannelArraysOnTheDistanceGridForWindowedLaps() throws {
        let laps = [
            ParsedLap(lapNumber: 3, timeMs: 47120, estimated: false, startT: 10, endT: 57.12),
            ParsedLap(timeMs: 47120, estimated: false),  // no window: skipped
        ]
        let out = try #require(
            TelemetryChannels.buildLapChannels(
                laps, Self.dist, ParsedTelemetry.CarChannels(speed: Self.speed, rpm: Self.rpm)
            )
        )
        #expect(out.dStepM == 20)
        #expect(out.laps.count == 1)
        let lap = out.laps[0]
        #expect(lap.n == 3)
        // 47.12s at 40 m/s = 1884.8m -> 95 grid points (0..1880m)
        #expect(lap.speed?.count == 95)
        #expect(lap.rpm?.count == 95)
        #expect(lap.speed?[0] == 144)
        #expect((lap.rpm?[50] ?? 0) >= 5000)
    }

    @Test func synthesizesSpeedFromTheDistanceSlopeWhenNoSpeedChannelExists() throws {
        let laps = [ParsedLap(timeMs: 47120, estimated: false, startT: 10, endT: 57.12)]
        let out = try #require(
            TelemetryChannels.buildLapChannels(laps, Self.dist, ParsedTelemetry.CarChannels())
        )
        #expect(out.laps[0].speed?.count == 95)
        // 40 m/s = 144 km/h from the odometer slope
        #expect(abs((out.laps[0].speed?[40] ?? 0) - 144) < 0.5)
        #expect(out.laps[0].rpm == nil)
    }

    @Test func returnsNilWhenThereIsNothingToCut() {
        let withSpeed = ParsedTelemetry.CarChannels(speed: Self.speed)
        #expect(TelemetryChannels.buildLapChannels([], Self.dist, withSpeed) == nil)
        #expect(
            TelemetryChannels.buildLapChannels(
                [ParsedLap(timeMs: 1000, estimated: false)], Self.dist, withSpeed
            ) == nil
        )
        #expect(
            TelemetryChannels.buildLapChannels(
                [ParsedLap(timeMs: 47120, estimated: false, startT: 10, endT: 57.12)],
                Array(Self.dist.prefix(5)), withSpeed
            ) == nil
        )
        // degenerate lap: shorter than 10 grid points
        #expect(
            TelemetryChannels.buildLapChannels(
                [ParsedLap(timeMs: 4000, estimated: false, startT: 10, endT: 14)],
                Self.dist, withSpeed
            ) == nil
        )
    }

    // MARK: - Trace-derived channel data

    /// The reference circle: 3.3 revolutions of a 300 m circle at 40 m/s, 10 Hz —
    /// `circleTrace()` in `test/fixtures/build.mjs`.
    static func circleTrace(
        revolutions: Double = 3.3, radius: Double = 300, speed: Double = 40, hz: Double = 10,
        lat0: Double = 36.56, lon0: Double = -79.2
    ) -> [Geo.Point] {
        let totalS = (2 * Double.pi * radius * revolutions) / speed
        let n = Int((totalS * hz).rounded(.down))
        let kx = 111_320 * cos(lat0 * .pi / 180)
        let ky = 110_540.0
        return (0...n).map { i in
            let t = Double(i) / hz
            let ang = (speed * t) / radius
            return Geo.Point(
                t: t, lat: lat0 + (radius * sin(ang)) / ky, lon: lon0 + (radius * cos(ang)) / kx, v: speed
            )
        }
    }

    @Test func integratesDistanceFromAProjectedTrace() {
        let trace = Self.circleTrace()
        let d = TelemetryChannels.distFromTrace(Geo.projectTrace(trace))
        // 3.3 revolutions of a 300m-radius circle ≈ 6220m
        #expect((d.last?.v ?? 0) > 6100)
        #expect((d.last?.v ?? 0) < 6350)
    }

    @Test func usesTheSourcesOwnSpeedWhenPresent() throws {
        let trace = Self.circleTrace()  // v = 40 m/s on every point
        let data = TelemetryChannels.traceChannelData(trace, Geo.projectTrace(trace))
        let speed = try #require(data.series.speed)
        #expect(abs(speed[10].v - 144) < 1e-5)  // km/h
    }

    // MARK: - End-to-end on parsed imports

    @Test func attachesFullCarChannelsToABeaconTimedDeltaPDRFile() throws {
        let out = try Telemetry.parseTelemetryFile(try VideoFixtures.source("pdr-delta.mp4"))
        let channels = try #require(out.lapChannels)
        #expect(channels.laps.count == 2)
        let lap = channels.laps[0]
        let speed = try #require(lap.speed)
        #expect(speed.count > 80)
        #expect(lap.rpm?.count == speed.count)
        #expect(lap.latG?.count == speed.count)
        #expect(lap.throttle?.count == speed.count)
        #expect(lap.brake?.count == speed.count)
        #expect(lap.steering?.count == speed.count)
        #expect((speed.max() ?? 0) < 160)  // ~151 km/h peak
        #expect((lap.rpm?.max() ?? 0) <= 6000)
        // pedals within 0-100%, steering signed degrees (±28.6° in the fixture)
        #expect((lap.throttle?.min() ?? -1) >= 0)
        #expect((lap.throttle?.max() ?? 999) <= 100)
        #expect((lap.brake?.max() ?? 999) <= 100)
        #expect((lap.steering?.min() ?? 0) < -20)
        #expect((lap.steering?.max() ?? 999) < 29.2)
    }

    @Test func channelDataForPicksTheOdometerForPDRAndTheTraceForGPSSources() throws {
        let pdr = try Telemetry.parseTelemetryFile(try VideoFixtures.source("pdr-delta.mp4"))
        #expect(TelemetryChannels.channelDataFor(pdr)?.dist == pdr.channels?.odoPts)
        let gopro = ParsedTelemetry(kind: .gopro, gps: Self.circleTrace())
        let data = try #require(TelemetryChannels.channelDataFor(gopro))
        #expect(data.dist.count == gopro.gps?.count)
    }

    @Test func linePickedLapsGetSpeedChannelsViaApplyGate() throws {
        var parsed = try Telemetry.parseTelemetryFile(try VideoFixtures.source("pdr-nobeacon.mp4"))
        #expect(parsed.lapChannels == nil)  // no laps yet
        let gps = try #require(parsed.gps)
        let origin = gps[0]
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: origin.lat, lon: origin.lon))
        let lapS = (2 * Double.pi * 300) / 40
        let gate = Geo.buildGate(trace, idx: Int((0.25 * lapS * 10).rounded()))
        Telemetry.applyGate(&parsed, origin: origin, gate: gate)
        #expect(parsed.laps.count == 3)
        #expect(parsed.lapChannels?.laps.count == 3)
        #expect((parsed.lapChannels?.laps[0].speed?.count ?? 0) > 80)
    }
}
