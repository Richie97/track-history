import Foundation
import Testing

@testable import TrackEvolutionKit

/// Access to `contracts/logic/vbo/` and `contracts/logic/vbo-parsers.json` — the
/// committed synthetic `.vbo` files and what the JS parser made of them.
///
/// Read from the repo rather than bundled, for the reason `Goldens` gives.
/// Regenerate both with `npm run contracts:logic`.
enum VBOFixtures {
    static let directory = RepoRoot.path("contracts/logic/vbo")

    static func data(_ file: String) throws -> Data {
        try Data(contentsOf: directory.appending(path: file))
    }

    static func text(_ file: String) throws -> String {
        String(decoding: try data(file), as: UTF8.self)
    }

    /// Through the dispatch, by name, exactly as `contracts/logic.mjs` does.
    static func parse(_ file: String) throws -> ParsedTelemetry {
        try Telemetry.parseTelemetryFile(DataByteSource(try data(file)), name: file)
    }

    static let fixture: Fixture = {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/vbo-parsers.json"))
        return try! JSONDecoder().decode(Fixture.self, from: data)
    }()

    static func expected(_ file: String) -> Case {
        guard let entry = fixture.files.first(where: { $0.file == file }) else {
            fatalError("no vbo fixture named \(file) — run `npm run contracts:logic`")
        }
        return entry
    }

    struct Fixture: Decodable {
        var description: String
        var gpsStride: Int
        var files: [Case]
    }

    struct Case: Decodable {
        var file: String
        var note: String
        var expected: Parsed
        var picked: VideoFixtures.Picked?
    }

    struct Parsed: Decodable {
        var kind: String
        var date: String?
        var time: String?
        var durationS: Double
        var needsLine: Bool
        var beaconCount: Int
        var gpsCount: Int
        var gpsSample: [VideoFixtures.GPSSample]?
        var laps: [VideoFixtures.Lap]
        var lapChannels: SessionChannels?
        var bestLapTrace: [TracePoint]?
        var carChannels: [String: Summary]
        var lapScalarChannels: [String: Summary]
        var sessionMeta: [String: Double]?
    }

    /// A series as `summarizeSeries` in `contracts/logic.mjs` reduces it: the
    /// count, both ends, and every 100th point.
    struct Summary: Decodable {
        var count: Int
        var first: ChannelPoint
        var last: ChannelPoint
        var sample: [ChannelPoint]
    }
}
