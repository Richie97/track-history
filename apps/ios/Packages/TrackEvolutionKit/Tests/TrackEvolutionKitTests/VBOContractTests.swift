import Foundation
import Testing

@testable import TrackEvolutionKit

/// Parse the *same bytes* the JS parsed (`contracts/logic/vbo/`) and prove the
/// Swift port of `public/js/import/vbo.js` agrees with it — lap times exactly,
/// everything else to `VideoContractTests.epsilon`.
struct VBOContractTests {
    private static let epsilon = VideoContractTests.epsilon

    @Test(arguments: [
        "vbox-noline.vbo",
        "vbox-laptiming.vbo",
        "vbox-laptiming-latfirst.vbo",
        "vbox-shortline.vbo",
        "trackprecision-2026-06-06-09-53-45.vbo",
        "trackprecision-2024-06-08-09-20-29.vbo",
        "trackprecision-2026-07-26-14-35-55.vbo",
    ])
    func matchesTheJavaScriptParser(file: String) throws {
        let parsed = try VBOFixtures.parse(file)
        let expected = VBOFixtures.expected(file).expected

        #expect(parsed.kind.rawValue == expected.kind, "\(file): kind")
        #expect(parsed.date == expected.date, "\(file): date")
        #expect(parsed.time == expected.time, "\(file): time")
        #expect(abs(parsed.durationS - expected.durationS) < Self.epsilon, "\(file): durationS")
        #expect(parsed.needsLine == expected.needsLine, "\(file): needsLine")
        #expect(parsed.beaconCount == expected.beaconCount, "\(file): beaconCount")
        #expect(parsed.metrics == nil, "\(file): metrics")
        #expect(parsed.lapRecovery == nil, "\(file): lapRecovery")
        #expect(parsed.channels == nil, "\(file): raw channels")

        #expect((parsed.gps?.count ?? 0) == expected.gpsCount, "\(file): gps count")
        let gps = try #require(parsed.gps)
        for point in expected.gpsSample ?? [] {
            try #require(gps.indices.contains(point.i), "\(file): gps[\(point.i)] missing")
            let actual = gps[point.i]
            #expect(abs(actual.t - point.t) < Self.epsilon, "\(file): gps[\(point.i)].t")
            #expect(abs(actual.lat - point.lat) < Self.epsilon, "\(file): gps[\(point.i)].lat")
            #expect(abs(actual.lon - point.lon) < Self.epsilon, "\(file): gps[\(point.i)].lon")
            #expect(
                VideoContractTests.closeOrBothNil(actual.v, point.v), "\(file): gps[\(point.i)].v")
        }

        VideoContractTests.assertLaps(parsed.laps, expected.laps, file: file)
        Self.assertTrace(parsed.bestLapTrace, expected.bestLapTrace, file: file)
        VideoContractTests.assertChannels(parsed.lapChannels, expected.lapChannels, file: file)

        // Walk the name lists, not the fixture's keys, so a channel the port
        // produces and the JS doesn't fails as surely as the other way round.
        for (name, _) in TelemetryChannels.CHANNEL_NAMES {
            Self.assertSummary(
                parsed.carChannels[name], expected.carChannels[name], "\(file): carChannels.\(name)")
        }
        for (name, _, _) in TelemetryChannels.SCALAR_NAMES {
            Self.assertSummary(
                parsed.lapScalarChannels[name], expected.lapScalarChannels[name],
                "\(file): lapScalarChannels.\(name)")
        }
        #expect(
            Set(parsed.lapScalarChannels.keys).isSubset(
                of: Set(TelemetryChannels.SCALAR_NAMES.map(\.0))),
            "\(file): an unknown scalar")
        let meta = parsed.sessionMeta.map {
            ChannelMeta(
                ambientC: $0.ambientC, intakeC: $0.intakeC, elevationM: $0.elevationM,
                odometerKm: $0.odometerKm)
        }
        #expect((parsed.sessionMeta == nil) == (expected.sessionMeta == nil), "\(file): sessionMeta")
        for (name, _) in TelemetryChannels.META_NAMES {
            #expect(
                VideoContractTests.closeOrBothNil(meta?[name], expected.sessionMeta?[name]),
                "\(file): sessionMeta.\(name)")
        }
    }

    /// The line picker over a file with no `[laptiming]`, run exactly as
    /// `contracts/logic.mjs` does: project on the file's first fix, build a gate
    /// at the picked index, `applyGate`.
    @Test func linePickedLapsMatchTheJavaScript() throws {
        let file = "vbox-noline.vbo"
        var parsed = try VBOFixtures.parse(file)
        let picked = try #require(VBOFixtures.expected(file).picked)
        let gps = try #require(parsed.gps)

        let origin = gps[0]
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: origin.lat, lon: origin.lon))
        let gate = try #require(Geo.buildGate(trace, idx: picked.pickedIndex))
        VideoContractTests.assertGate(gate, picked.gate, file: file)

        Telemetry.applyGate(&parsed, origin: origin, gate: gate)
        VideoContractTests.assertLaps(parsed.laps, picked.laps, file: file)
        VideoContractTests.assertChannels(parsed.lapChannels, picked.lapChannels, file: file)
        Self.assertTrace(parsed.bestLapTrace, picked.bestLapTrace, file: file)
    }

    // MARK: - Comparisons

    static func assertTrace(_ actual: [TracePoint]?, _ expected: [TracePoint]?, file: String) {
        guard let expected else {
            #expect(actual == nil, "\(file): bestLapTrace should be absent")
            return
        }
        guard let actual else {
            Issue.record("\(file): expected a bestLapTrace but got none")
            return
        }
        #expect(actual.count == expected.count, "\(file): bestLapTrace length")
        for (i, (a, b)) in zip(actual, expected).enumerated()
        where abs(a.x - b.x) >= epsilon || abs(a.y - b.y) >= epsilon || abs(a.v - b.v) >= epsilon {
            Issue.record("\(file): bestLapTrace[\(i)] \(a) != \(b)")
        }
    }

    static func assertSummary(
        _ actual: [ChannelPoint]?, _ expected: VBOFixtures.Summary?, _ label: String
    ) {
        guard let expected else {
            #expect(actual == nil, "\(label): should be absent")
            return
        }
        guard let actual else {
            Issue.record("\(label): expected \(expected.count) points but got none")
            return
        }
        #expect(actual.count == expected.count, "\(label): count")
        func close(_ a: ChannelPoint?, _ b: ChannelPoint) -> Bool {
            guard let a else { return false }
            return abs(a.t - b.t) < epsilon && abs(a.v - b.v) < epsilon
        }
        #expect(close(actual.first, expected.first), "\(label): first")
        #expect(close(actual.last, expected.last), "\(label): last")
        let sample = stride(from: 0, to: actual.count, by: 100).map { actual[$0] }
        #expect(sample.count == expected.sample.count, "\(label): sample count")
        for (i, (a, b)) in zip(sample, expected.sample).enumerated() where !close(a, b) {
            Issue.record("\(label): sample[\(i)] \(a) != \(b)")
        }
    }
}
