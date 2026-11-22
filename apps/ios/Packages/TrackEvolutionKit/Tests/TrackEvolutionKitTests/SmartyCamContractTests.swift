import Foundation
import Testing

@testable import TrackEvolutionKit

/// Access to `contracts/logic/smartycam/` and
/// `contracts/logic/smartycam-parsers.json` — the committed synthetic `.mov`
/// files and what the JS parser made of them.
///
/// A fixture of its own rather than rows in `video-parsers.json`, as
/// `contracts/logic.mjs` says: each port's video contract test walks every file
/// listed there. Regenerate both with `npm run contracts:logic`.
enum SmartyCamFixtures {
    static let directory = RepoRoot.path("contracts/logic/smartycam")

    static func data(_ file: String) throws -> Data {
        try Data(contentsOf: directory.appending(path: file))
    }

    static func source(_ file: String) throws -> DataByteSource {
        DataByteSource(try data(file))
    }

    /// Through the dispatch, by name, exactly as `contracts/logic.mjs` does.
    static func parse(_ file: String) throws -> ParsedTelemetry {
        try Telemetry.parseTelemetryFile(try source(file), name: file)
    }

    static let fixture: Fixture = {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/smartycam-parsers.json"))
        return try! JSONDecoder().decode(Fixture.self, from: data)
    }()

    struct Fixture: Decodable {
        var description: String
        var gpsStride: Int
        var files: [Case]
    }

    struct Case: Decodable {
        var file: String
        var note: String
        var expected: Parsed
    }

    struct Parsed: Decodable {
        var kind: String
        var date: String?
        var time: String?
        var durationS: Double
        var needsLine: Bool
        var beaconCount: Int
        var metrics: VideoFixtures.Metrics?
        var sessionMeta: [String: Double]?
        var gpsCount: Int
        var gpsSample: [VideoFixtures.GPSSample]?
        var laps: [VideoFixtures.Lap]
        var lapChannels: SessionChannels?
        var lapRecovery: VideoFixtures.Recovery?
        var channels: VideoFixtures.RawChannels?
        var bestLapTrace: [TracePoint]?
        var traceGeo: TraceGeo?
        var carChannels: [String: VBOFixtures.Summary]
    }
}

/// Parse the *same bytes* the JS parsed and prove the Swift port of
/// `public/js/import/smartycam.js` agrees with it — lap times exactly,
/// everything else to `VideoContractTests.epsilon`.
struct SmartyCamContractTests {
    private static let epsilon = VideoContractTests.epsilon

    /// Every file the fixture lists, so one added there is one checked here.
    @Test func coversEveryFixtureFile() {
        #expect(
            SmartyCamFixtures.fixture.files.map(\.file)
                == ["smartycam-laps.mov", "smartycam-midsession.mov"])
    }

    @Test(arguments: ["smartycam-laps.mov", "smartycam-midsession.mov"])
    func matchesTheJavaScriptParser(file: String) throws {
        let parsed = try SmartyCamFixtures.parse(file)
        let expected = try #require(
            SmartyCamFixtures.fixture.files.first { $0.file == file }
        ).expected

        #expect(parsed.kind.rawValue == expected.kind, "\(file): kind")
        #expect(parsed.date == expected.date, "\(file): date")
        #expect(parsed.time == expected.time, "\(file): time")
        #expect(abs(parsed.durationS - expected.durationS) < Self.epsilon, "\(file): durationS")
        #expect(parsed.needsLine == expected.needsLine, "\(file): needsLine")
        #expect(parsed.beaconCount == expected.beaconCount, "\(file): beaconCount")
        #expect(parsed.lapRecovery == nil && expected.lapRecovery == nil, "\(file): lapRecovery")
        #expect(parsed.channels == nil && expected.channels == nil, "\(file): raw channels")
        #expect(parsed.sessionMeta == nil && expected.sessionMeta == nil, "\(file): sessionMeta")
        #expect(parsed.lapScalarChannels.isEmpty, "\(file): lapScalarChannels")

        let metrics = try #require(parsed.metrics, "\(file): metrics")
        let want = try #require(expected.metrics, "\(file): expected metrics")
        let close = VideoContractTests.closeOrBothNil
        #expect(close(metrics.topSpeedKph, want.topSpeedKph), "\(file): topSpeedKph")
        #expect(close(metrics.maxRpm, want.maxRpm), "\(file): maxRpm")
        #expect(close(metrics.maxLatG, want.maxLatG), "\(file): maxLatG")
        #expect(close(metrics.maxBrakeG, want.maxBrakeG), "\(file): maxBrakeG")
        #expect(close(metrics.maxBoostKpa, want.maxBoostKpa), "\(file): maxBoostKpa")
        #expect(close(metrics.maxOilC, want.maxOilC), "\(file): maxOilC")

        let gps = try #require(parsed.gps)
        #expect(gps.count == expected.gpsCount, "\(file): gps count")
        let sample = try #require(expected.gpsSample)
        #expect(!sample.isEmpty)
        for point in sample {
            try #require(gps.indices.contains(point.i), "\(file): gps[\(point.i)] missing")
            let actual = gps[point.i]
            #expect(abs(actual.t - point.t) < Self.epsilon, "\(file): gps[\(point.i)].t")
            #expect(abs(actual.lat - point.lat) < Self.epsilon, "\(file): gps[\(point.i)].lat")
            #expect(abs(actual.lon - point.lon) < Self.epsilon, "\(file): gps[\(point.i)].lon")
            #expect(close(actual.v, point.v), "\(file): gps[\(point.i)].v")
        }

        // timeMs exact, startT / endT to epsilon.
        #expect(!expected.laps.isEmpty)
        VideoContractTests.assertLaps(parsed.laps, expected.laps, file: file)
        #expect(expected.bestLapTrace != nil && expected.traceGeo != nil && expected.lapChannels != nil)
        VBOContractTests.assertTrace(parsed.bestLapTrace, expected.bestLapTrace, file: file)
        VBOContractTests.assertTraceGeo(parsed.traceGeo, expected.traceGeo, file: file)
        // Walks CHANNEL_NAMES / SCALAR_NAMES / META_NAMES, element for element.
        VideoContractTests.assertChannels(parsed.lapChannels, expected.lapChannels, file: file)

        // Walk the name list, not the fixture's keys, so a channel the port
        // produces and the JS doesn't fails as surely as the other way round.
        for (name, _) in TelemetryChannels.CHANNEL_NAMES {
            VBOContractTests.assertSummary(
                parsed.carChannels[name], expected.carChannels[name], "\(file): carChannels.\(name)")
        }
        #expect(
            Set(expected.carChannels.keys).isSubset(of: Set(TelemetryChannels.CHANNEL_NAMES.map(\.0))),
            "\(file): the fixture names a channel CHANNEL_NAMES lacks")
    }
}
