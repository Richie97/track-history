import Foundation
import Testing

@testable import TrackEvolutionKit

/// Access to `contracts/logic/csv/` and `contracts/logic/csv-parsers.json` — the
/// committed synthetic Track Precision CSVs, what the JS parser made of them,
/// and `lapsFromLaptime` over small timer tables.
///
/// Read from the repo rather than bundled, for the reason `Goldens` gives.
/// Regenerate with `npm run contracts:logic`.
enum CsvFixtures {
    static let directory = RepoRoot.path("contracts/logic/csv")

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
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/csv-parsers.json"))
        return try! JSONDecoder().decode(Fixture.self, from: data)
    }()

    static func expected(_ file: String) -> VBOFixtures.Case {
        guard let entry = fixture.files.first(where: { $0.file == file }) else {
            fatalError("no csv fixture named \(file) — run `npm run contracts:logic`")
        }
        return entry
    }

    static func timer(_ name: String) -> TimerCase {
        guard let entry = fixture.lapsFromLaptime.first(where: { $0.name == name }) else {
            fatalError("no lapsFromLaptime case named \(name) — run `npm run contracts:logic`")
        }
        return entry
    }

    struct Fixture: Decodable {
        var description: String
        var files: [VBOFixtures.Case]
        var lapsFromLaptime: [TimerCase]
    }

    struct TimerCase: Decodable {
        var name: String
        var rows: [Row]
        var laps: [VideoFixtures.Lap]
    }

    struct Row: Decodable {
        var t: Double
        var lapMs: Double?
        var lapM: Double?
        var v: Double?
    }
}
