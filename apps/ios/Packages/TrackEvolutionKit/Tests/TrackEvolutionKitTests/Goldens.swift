import Foundation
import Testing

/// Access to `contracts/golden/` — the pinned API contract, captured from a real
/// D1-backed Worker by `npm run contracts:generate`.
///
/// The files are read **from the repo**, located by walking up from this source
/// file, rather than copied into the package as bundled resources: a copy would
/// silently rot the moment the backend response shape changed, which is exactly
/// what these tests exist to catch.
enum Goldens {
    static let directory = RepoRoot.path("contracts/golden")

    /// One captured response.
    struct Entry: Codable, Sendable {
        var name: String
        var file: String
        var method: String
        var path: String
        var status: Int
        /// The manifest's human note about what the fixture covers.
        var description: String
        var source: String
    }

    private struct Manifest: Decodable {
        var entries: [Entry]
    }

    /// The captured file itself: the envelope, before the body.
    private struct Capture: Decodable {
        var status: Int
    }

    static let entries: [Entry] = {
        let data = try! Data(contentsOf: directory.appending(path: "manifest.json"))
        return try! JSONDecoder().decode(Manifest.self, from: data).entries
    }()

    static func entry(_ name: String) -> Entry {
        guard let entry = entries.first(where: { $0.name == name }) else {
            fatalError("no golden named \(name) — check contracts/golden/manifest.json")
        }
        return entry
    }

    /// The raw JSON of a capture's `body`, which is what a client would receive.
    static func body(_ name: String) throws -> Data {
        let url = directory.appending(path: entry(name).file)
        let object = try JSONSerialization.jsonObject(with: try Data(contentsOf: url))
        guard let dict = object as? [String: Any], let body = dict["body"] else {
            throw GoldenError.malformed(name)
        }
        return try JSONSerialization.data(withJSONObject: body)
    }

    /// Decode a golden's body into `type`, failing the test with the decoding
    /// error's detail (which names the offending key) rather than a bare throw.
    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        let data = try body(name)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            Issue.record("golden \(name) does not decode as \(type): \(error)")
            throw error
        }
    }

    enum GoldenError: Error {
        case malformed(String)
    }
}
