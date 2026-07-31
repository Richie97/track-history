import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/gpmf.test.js`, ported with the code. The fixture MP4
/// is the same bytes the JS test builds, read from `contracts/logic/video/`.
struct GPMFTests {
    /// 3.3 revolutions of a 300 m circle at 40 m/s: one lap is 47.12 s.
    private static let lapS = (2 * Double.pi * 300) / 40
    private static let lapMs = Int((lapS * 1000).rounded())

    @Test func extractsTheGPSTraceAndUTCDateFromTheGpmdTrack() throws {
        let out = try GPMF.parseGpmfFile(try VideoFixtures.source("gopro.mp4"))
        #expect(out.kind == .gopro)
        #expect(out.needsLine)
        #expect(out.laps.isEmpty)
        #expect(out.date == "2026-06-20")
        #expect(out.time == "09:15:00")
        let gps = try #require(out.gps)
        // The trace the fixture was built from has 1,556 points.
        #expect(Double(gps.count) > 1556 * 0.95)
        #expect(abs(gps[0].lat - 36.56) < 1e-4)
        #expect(abs((gps[0].v ?? 0) - 40) < 0.1)
    }

    @Test func supportsLinePickingEndToEnd() throws {
        let out = try GPMF.parseGpmfFile(try VideoFixtures.source("gopro.mp4"))
        let gps = try #require(out.gps)
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: gps[0].lat, lon: gps[0].lon))
        // pick the trace point nearest a quarter revolution
        let gate = try #require(Geo.buildGate(trace, idx: Int((0.25 * Self.lapS * 10).rounded())))
        let laps = Geo.deriveLaps(trace, gate: gate)
        #expect(laps.count == 3)
        for lap in laps {
            #expect(abs(lap.timeMs - Self.lapMs) < 300)
        }
    }

    @Test func rejectsMP4sWithoutAGPMFTrack() {
        #expect(throws: TelemetryParseError.self) {
            try GPMF.parseGpmfFile(PDRTests.DispatchTests.emptyMp4())
        }
        // …and says so as "no track of mine", so the dispatch can try the other
        // parser rather than reporting this file as broken.
        do {
            _ = try GPMF.parseGpmfFile(PDRTests.DispatchTests.emptyMp4())
            Issue.record("expected a throw")
        } catch let error as TelemetryParseError {
            #expect(error.isNoTrack)
            #expect(error.message.contains("telemetry track"))
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }
}
