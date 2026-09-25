import Foundation
import Testing

@testable import TrackEvolutionKit

/// Parse the *same bytes* the JS parsed (`contracts/logic/csv/`) and prove the
/// Swift port of `public/js/import/csv.js` agrees with it — lap times exactly,
/// everything else to `VideoContractTests.epsilon` — and run `lapsFromLaptime`
/// over the fixture's timer tables, whose pit stop, short last lap and pit-lane
/// finish the committed files are too regular to reach.
struct TrackPrecisionCsvContractTests {
    private static let epsilon = VideoContractTests.epsilon

    @Test(arguments: [
        "recording-2026-06-06-09-53-45.csv",
        "recording-2024-06-08-11-21-21.csv",
        "recording-2025-07-19-09-47-12.csv",
        "recording-2026-07-26-14-35-55.csv",
        "session.csv",
    ])
    func matchesTheJavaScriptParser(file: String) throws {
        let parsed = try CsvFixtures.parse(file)
        let expected = CsvFixtures.expected(file).expected

        #expect(parsed.kind.rawValue == expected.kind, "\(file): kind")
        #expect(parsed.date == expected.date, "\(file): date")
        #expect(parsed.time == expected.time, "\(file): time")
        #expect(abs(parsed.durationS - expected.durationS) < Self.epsilon, "\(file): durationS")
        #expect(parsed.needsLine == expected.needsLine, "\(file): needsLine")
        #expect(parsed.metrics == nil, "\(file): metrics")
        #expect(parsed.sessionMeta == nil, "\(file): a CSV carries no session meta")

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
        VBOContractTests.assertTrace(parsed.bestLapTrace, expected.bestLapTrace, file: file)
        VideoContractTests.assertChannels(parsed.lapChannels, expected.lapChannels, file: file)

        // Walk the name lists, not the fixture's keys, so a channel the port
        // produces and the JS doesn't fails as surely as the other way round.
        for (name, _) in TelemetryChannels.CHANNEL_NAMES {
            VBOContractTests.assertSummary(
                parsed.carChannels[name], expected.carChannels[name], "\(file): carChannels.\(name)")
        }
        for (name, _, _) in TelemetryChannels.SCALAR_NAMES {
            VBOContractTests.assertSummary(
                parsed.lapScalarChannels[name], expected.lapScalarChannels[name],
                "\(file): lapScalarChannels.\(name)")
        }
    }

    /// The line picker over the file whose timer never runs, run exactly as
    /// `contracts/logic.mjs` does.
    @Test func linePickedLapsMatchTheJavaScript() throws {
        let file = "session.csv"
        var parsed = try CsvFixtures.parse(file)
        let picked = try #require(CsvFixtures.expected(file).picked)
        let gps = try #require(parsed.gps)

        let origin = gps[0]
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: origin.lat, lon: origin.lon))
        let gate = try #require(Geo.buildGate(trace, idx: picked.pickedIndex))
        VideoContractTests.assertGate(gate, picked.gate, file: file)

        Telemetry.applyGate(&parsed, origin: origin, gate: gate)
        VideoContractTests.assertLaps(parsed.laps, picked.laps, file: file)
        VideoContractTests.assertChannels(parsed.lapChannels, picked.lapChannels, file: file)
        VBOContractTests.assertTrace(parsed.bestLapTrace, picked.bestLapTrace, file: file)
    }

    @Test(arguments: CsvFixtures.fixture.lapsFromLaptime.map(\.name))
    func lapsFromLaptimeMatchesTheJavaScript(name: String) {
        let c = CsvFixtures.timer(name)
        let rows = c.rows.map { TrackPrecisionCsv.TimerRow(t: $0.t, lapMs: $0.lapMs, lapM: $0.lapM, v: $0.v) }
        VideoContractTests.assertLaps(TrackPrecisionCsv.lapsFromLaptime(rows), c.laps, file: name)
    }
}

/// `test/unit/csv.test.js`'s cases the contract doesn't already pin, plus the
/// Swift-only seams. The JS builds its inputs with `buildTrackPrecisionCsv`;
/// this suite edits the committed contract files instead.
struct TrackPrecisionCsvTests {
    private let name = "recording-2026-06-06-09-53-45.csv"

    @Test func isReachedThroughTheDispatchByItsExtension() throws {
        let out = try CsvFixtures.parse(name)
        #expect(out.kind == .trackPrecision)
        #expect(out.lapChannels?.laps.count == 3)
        #expect(Telemetry.isCsv("X.CSV") && Telemetry.isLog("a.csv") && !Telemetry.isLog("a.mp4"))
        #expect(Telemetry.SUPPORTED_EXTENSIONS.contains("csv"))
    }

    @Test func stripsAByteOrderMarkAsBlobTextDoes() throws {
        var bytes = Data([0xEF, 0xBB, 0xBF])
        bytes.append(try CsvFixtures.data(name))
        let out = try Telemetry.parseTelemetryFile(DataByteSource(bytes), name: name)
        #expect(out.laps.count == 3)
        #expect(out.carChannels["rpm"] != nil)
    }

    @Test func skipsADuplicatedRow() throws {
        let lines = try CsvFixtures.text(name).split(separator: "\n").map(String.init)
        let doubled = ([lines[0]] + lines.dropFirst().flatMap { [$0, $0] }).joined(separator: "\n")
        let out = try TrackPrecisionCsv.parseTrackPrecisionCsv(doubled, fileName: name)
        #expect(out.gps?.count == lines.count - 1)
    }

    @Test func rejectsACsvThatIsNotTrackPrecisions() throws {
        #expect(throws: TelemetryParseError.self) {
            try TrackPrecisionCsv.parseTrackPrecisionCsv("a,b,c\n1,2,3\n", fileName: "x.csv")
        }
        let header = try CsvFixtures.text(name).split(separator: "\n")[0]
        #expect(throws: TelemetryParseError.self) {
            try TrackPrecisionCsv.parseTrackPrecisionCsv("\(header)\n", fileName: self.name)
        }
    }

    @Test func speedToMsFallsBackToKmhWithNothingToGoOn() throws {
        let gps = try #require(try CsvFixtures.parse(name).gps)
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: gps[0].lat, lon: gps[0].lon))
        #expect(abs(TrackPrecisionCsv.speedToMs(trace, gps.map { _ in nil }) - 1 / 3.6) < 1e-12)
        #expect(abs(TrackPrecisionCsv.speedToMs(trace, gps.map { _ in 40 }) - 1) < 1e-12)
        #expect(abs(TrackPrecisionCsv.speedToMs(trace, gps.map { _ in 89.477 }) - 1 / 2.2369362920544) < 1e-12)
    }
}
