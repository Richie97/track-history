import Foundation
import Testing

@testable import TrackEvolutionKit

/// The whole point of NS-30's fixtures: parse the *same bytes* the JS parsed and
/// prove the two agree.
///
/// Lap times are compared exactly — they are integer milliseconds, and "close
/// enough" is precisely the failure mode a reverse-engineered decoder produces.
/// Coordinates and channel values get a tolerance far below their own rounding
/// (channels are stored rounded to 0.1 km/h, 1 rpm, 0.001 G), because the two
/// languages' `hypot` and transcendental functions may differ in the last bit and
/// nothing user-visible depends on that bit.
struct VideoContractTests {
    /// Below any difference either implementation could produce that meant
    /// something, and far above float noise.
    private static let epsilon = 1e-9

    @Test(arguments: [
        "gopro.mp4",
        "pdr-beacons.mp4",
        "pdr-delta.mp4",
        "pdr-delta-nobeacon.mp4",
        "pdr-nobeacon.mp4",
        "pdr-real-beacons.mp4",
        "pdr-real-shifted.mp4",
    ])
    func matchesTheJavaScriptParsers(file: String) throws {
        let parsed = try VideoFixtures.parse(file)
        let entry = VideoFixtures.expected(file)
        Self.assertMatches(parsed, entry.expected, file: file)
    }

    @Test(arguments: ["gopro.mp4", "pdr-delta-nobeacon.mp4", "pdr-nobeacon.mp4"])
    func linePickedLapsMatchTheJavaScript(file: String) throws {
        var parsed = try VideoFixtures.parse(file)
        let picked = try #require(VideoFixtures.expected(file).picked)
        let gps = try #require(parsed.gps)

        // The same flow the review screen runs: project on the file's own first
        // fix, build a gate at the picked index, re-derive.
        let origin = gps[0]
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: origin.lat, lon: origin.lon))
        let gate = try #require(Geo.buildGate(trace, idx: picked.pickedIndex))
        Self.assertGate(gate, picked.gate, file: file)

        Telemetry.applyGate(&parsed, origin: origin, gate: gate)
        Self.assertLaps(parsed.laps, picked.laps, file: file)
        Self.assertChannels(parsed.lapChannels, picked.lapChannels, file: file)

        let expectedTrace = try #require(picked.bestLapTrace)
        let actualTrace = try #require(parsed.bestLapTrace)
        #expect(actualTrace.count == expectedTrace.count, "\(file): best-lap trace length")
        for (a, b) in zip(actualTrace, expectedTrace) {
            #expect(abs(a.x - b.x) < Self.epsilon)
            #expect(abs(a.y - b.y) < Self.epsilon)
            #expect(abs(a.v - b.v) < Self.epsilon)
        }
    }

    /// The batch pass: a beacon-timed recording of the same track pulls a
    /// beacon-less one's rolling laps onto the real start/finish. Both files are
    /// parsed first, exactly as an import of a multi-file selection does.
    @Test func batchAnchoringMatchesTheJavaScript() throws {
        var batch: [ParsedTelemetry?] = try VideoFixtures.fixture.files.map {
            try VideoFixtures.parse($0.file)
        }
        PDRLaps.anchorPdrBatch(&batch)
        for i in batch.indices {
            guard var p = batch[i], p.kind == .pdr, p.lapRecovery != nil else { continue }
            TelemetryChannels.attachLapChannels(&p)
            batch[i] = p
        }

        let anchored = VideoFixtures.fixture.afterBatchAnchor
        #expect(!anchored.isEmpty, "the fixture should include at least one anchored recording")
        for expected in anchored {
            let index = try #require(
                VideoFixtures.fixture.files.firstIndex { $0.file == expected.file }
            )
            let parsed = try #require(batch[index])
            Self.assertMatches(parsed, expected.expected, file: expected.file)
            #expect(parsed.lapRecovery?.anchored == true)
        }
    }

    // MARK: - Comparisons

    private static func assertMatches(_ parsed: ParsedTelemetry, _ expected: VideoFixtures.Parsed, file: String) {
        #expect(parsed.kind.rawValue == expected.kind, "\(file): kind")
        #expect(parsed.date == expected.date, "\(file): date")
        #expect(parsed.time == expected.time, "\(file): time")
        #expect(abs(parsed.durationS - expected.durationS) < epsilon, "\(file): durationS")
        #expect(parsed.needsLine == expected.needsLine, "\(file): needsLine")
        #expect(parsed.beaconCount == expected.beaconCount, "\(file): beaconCount")

        assertLaps(parsed.laps, expected.laps, file: file)
        assertChannels(parsed.lapChannels, expected.lapChannels, file: file)

        if let expectedMetrics = expected.metrics {
            let metrics = parsed.metrics
            #expect(closeOrBothNil(metrics?.topSpeedKph, expectedMetrics.topSpeedKph), "\(file): topSpeedKph")
            #expect(closeOrBothNil(metrics?.maxRpm, expectedMetrics.maxRpm), "\(file): maxRpm")
            #expect(closeOrBothNil(metrics?.maxLatG, expectedMetrics.maxLatG), "\(file): maxLatG")
        } else {
            #expect(parsed.metrics == nil, "\(file): metrics should be absent")
        }

        #expect((parsed.gps?.count ?? 0) == expected.gpsCount, "\(file): gps count")
        if let sample = expected.gpsSample, let gps = parsed.gps {
            for point in sample where gps.indices.contains(point.i) {
                let actual = gps[point.i]
                #expect(abs(actual.t - point.t) < epsilon, "\(file): gps[\(point.i)].t")
                #expect(abs(actual.lat - point.lat) < epsilon, "\(file): gps[\(point.i)].lat")
                #expect(abs(actual.lon - point.lon) < epsilon, "\(file): gps[\(point.i)].lon")
                #expect(closeOrBothNil(actual.v, point.v), "\(file): gps[\(point.i)].v")
            }
        }

        if let expectedRecovery = expected.lapRecovery {
            let recovery = parsed.lapRecovery
            #expect(abs((recovery?.lapM ?? .nan) - expectedRecovery.lapM) < epsilon, "\(file): lapM")
            #expect(abs((recovery?.r ?? .nan) - expectedRecovery.r) < epsilon, "\(file): recovery r")
            #expect(recovery?.anchored == expectedRecovery.anchored, "\(file): anchored")
            #expect(closeOrBothNil(recovery?.phaseR, expectedRecovery.phaseR), "\(file): phaseR")
            #expect(recovery?.laps.count == expectedRecovery.lapCount, "\(file): recovered lap count")
        } else {
            #expect(parsed.lapRecovery == nil, "\(file): lapRecovery should be absent")
        }

        if let expectedChannels = expected.channels {
            let channels = parsed.channels
            #expect(channels?.latPts.count == expectedChannels.latCount, "\(file): latPts count")
            #expect(channels?.odoPts.count == expectedChannels.odoCount, "\(file): odoPts count")
            #expect(channels?.odoPts.first == expectedChannels.odoFirst, "\(file): odoPts first")
            #expect(channels?.odoPts.last == expectedChannels.odoLast, "\(file): odoPts last")
        }
    }

    private static func assertLaps(_ laps: [ParsedLap], _ expected: [VideoFixtures.Lap], file: String) {
        #expect(laps.count == expected.count, "\(file): lap count")
        for (i, pair) in zip(laps, expected).enumerated() {
            let (actual, want) = pair
            // Exact: a lap time is an integer number of milliseconds.
            #expect(actual.timeMs == want.timeMs, "\(file): lap \(i) timeMs")
            #expect(actual.estimated == want.estimated, "\(file): lap \(i) estimated")
            #expect(actual.lapNumber == want.lapNumber, "\(file): lap \(i) lapNumber")
            #expect(closeOrBothNil(actual.startT, want.startT), "\(file): lap \(i) startT")
            #expect(closeOrBothNil(actual.endT, want.endT), "\(file): lap \(i) endT")
        }
    }

    private static func assertChannels(
        _ channels: SessionChannels?, _ expected: SessionChannels?, file: String
    ) {
        guard let expected else {
            #expect(channels == nil, "\(file): lapChannels should be absent")
            return
        }
        guard let channels else {
            Issue.record("\(file): expected lapChannels but got none")
            return
        }
        #expect(channels.v == expected.v, "\(file): channels version")
        #expect(channels.dStepM == expected.dStepM, "\(file): dStepM")
        #expect(channels.laps.count == expected.laps.count, "\(file): channel lap count")
        for (lap, want) in zip(channels.laps, expected.laps) {
            #expect(lap.n == want.n, "\(file): channel lap \(want.n) number")
            #expect(lap.timeMs == want.timeMs, "\(file): channel lap \(want.n) timeMs")
            assertSeries(lap.speed, want.speed, "\(file): lap \(want.n) speed")
            assertSeries(lap.rpm, want.rpm, "\(file): lap \(want.n) rpm")
            assertSeries(lap.latG, want.latG, "\(file): lap \(want.n) latG")
            assertSeries(lap.throttle, want.throttle, "\(file): lap \(want.n) throttle")
            assertSeries(lap.brake, want.brake, "\(file): lap \(want.n) brake")
            assertSeries(lap.steering, want.steering, "\(file): lap \(want.n) steering")
        }
    }

    private static func assertSeries(_ actual: [Double]?, _ expected: [Double]?, _ label: String) {
        guard let expected else {
            #expect(actual == nil, "\(label): should be absent")
            return
        }
        guard let actual else {
            Issue.record("\(label): expected \(expected.count) values but got none")
            return
        }
        #expect(actual.count == expected.count, "\(label): length")
        for (i, pair) in zip(actual, expected).enumerated() where abs(pair.0 - pair.1) >= epsilon {
            Issue.record("\(label)[\(i)]: \(pair.0) != \(pair.1)")
        }
    }

    private static func assertGate(_ gate: Geo.Gate, _ expected: Geo.Gate, file: String) {
        #expect(abs(gate.x - expected.x) < epsilon, "\(file): gate x")
        #expect(abs(gate.y - expected.y) < epsilon, "\(file): gate y")
        #expect(closeOrBothNil(gate.hx, expected.hx), "\(file): gate hx")
        #expect(closeOrBothNil(gate.hy, expected.hy), "\(file): gate hy")
        #expect(abs(gate.x1 - expected.x1) < epsilon, "\(file): gate x1")
        #expect(abs(gate.y1 - expected.y1) < epsilon, "\(file): gate y1")
        #expect(abs(gate.x2 - expected.x2) < epsilon, "\(file): gate x2")
        #expect(abs(gate.y2 - expected.y2) < epsilon, "\(file): gate y2")
    }

    private static func closeOrBothNil(_ a: Double?, _ b: Double?) -> Bool {
        switch (a, b) {
        case (nil, nil): true
        case let (x?, y?): abs(x - y) < epsilon
        default: false
        }
    }
}
