import Foundation
import Testing

@testable import TrackEvolutionKit

/// Access to `contracts/logic/video/` and `contracts/logic/video-parsers.json` —
/// the committed synthetic MP4s and what the JS parsers made of them.
///
/// Read from the repo rather than bundled as package resources, for the reason
/// `Goldens` gives: a copy would go stale exactly when it mattered. Regenerate
/// both with `npm run contracts:logic`.
enum VideoFixtures {
    static let directory = RepoRoot.path("contracts/logic/video")

    /// The bytes of one fixture clip, as a parser sees them.
    static func source(_ file: String) throws -> DataByteSource {
        DataByteSource(try Data(contentsOf: directory.appending(path: file)))
    }

    static func parse(_ file: String) throws -> ParsedTelemetry {
        try Telemetry.parseTelemetryFile(try source(file))
    }

    // MARK: - The pinned JS output

    static let fixture: Fixture = {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/video-parsers.json"))
        return try! JSONDecoder().decode(Fixture.self, from: data)
    }()

    static func expected(_ file: String) -> Case {
        guard let entry = fixture.files.first(where: { $0.file == file }) else {
            fatalError("no video fixture named \(file) — run `npm run contracts:logic`")
        }
        return entry
    }

    struct Fixture: Decodable {
        var description: String
        var gpsStride: Int
        var files: [Case]
        var afterBatchAnchor: [Anchored]
    }

    struct Case: Decodable {
        var file: String
        var note: String
        var expected: Parsed
        var picked: Picked?
    }

    struct Anchored: Decodable {
        var file: String
        var expected: Parsed
    }

    struct Parsed: Decodable {
        var kind: String
        var date: String?
        var time: String?
        var durationS: Double
        var needsLine: Bool
        var beaconCount: Int
        var metrics: Metrics?
        var gpsCount: Int
        var gpsSample: [GPSSample]?
        var laps: [Lap]
        var lapChannels: SessionChannels?
        var lapRecovery: Recovery?
        var channels: RawChannels?
    }

    struct Metrics: Decodable {
        var topSpeedKph: Double?
        var maxRpm: Double?
        var maxLatG: Double?
        var maxBrakeG: Double?
        var maxBoostKpa: Double?
        var maxOilC: Double?
    }

    struct GPSSample: Decodable {
        var i: Int
        var t: Double
        var lat: Double
        var lon: Double
        var v: Double?
    }

    struct Lap: Decodable {
        var lapNumber: Int?
        var timeMs: Int
        var estimated: Bool
        var startT: Double?
        var endT: Double?
    }

    struct Recovery: Decodable {
        var lapM: Double
        var r: Double
        var anchored: Bool
        var phaseR: Double?
        var lapCount: Int
    }

    struct RawChannels: Decodable {
        var latCount: Int
        var odoCount: Int
        var odoFirst: ChannelPoint?
        var odoLast: ChannelPoint?
    }

    struct Picked: Decodable {
        var pickedIndex: Int
        var gate: Geo.Gate
        var laps: [Lap]
        var bestLapTrace: [TracePoint]?
        var lapChannels: SessionChannels?
    }
}
