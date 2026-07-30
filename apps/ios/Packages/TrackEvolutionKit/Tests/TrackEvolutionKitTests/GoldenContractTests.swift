import Foundation
import Testing

@testable import TrackEvolutionKit

/// Decodes every entry in `contracts/golden/manifest.json` into its model.
///
/// This is the drift alarm: if the backend changes a field's name, type or
/// nullability, or adds an endpoint no model covers, these fail. Regenerate the
/// goldens with `npm run contracts:generate` and fix the models — never the
/// other way round.
struct GoldenContractTests {
    @Test(arguments: Goldens.entries)
    func goldenDecodesIntoItsModel(entry: Goldens.Entry) throws {
        // Failures are captured responses too: they decode as APIError.
        if entry.status >= 400 {
            let error = APIError.from(status: entry.status, body: try Goldens.body(entry.name))
            let sent = try JSONDecoder().decode(ServerErrorBody.self, from: try Goldens.body(entry.name))
            #expect(error.status == entry.status)
            #expect(error.message == sent.error, "the server's own message must survive")
            #expect(!error.message.hasPrefix("Request failed"), "fell back instead of reading { error }")
            return
        }

        switch entry.name {
        case "me": try roundTrip(Me.self, entry.name)
        case "events-list": try roundTrip([Event].self, entry.name)
        case "event-detail", "event-detail-no-laps": try roundTrip(EventDetail.self, entry.name)
        case "event-setups-prefill": try roundTrip(SetupPrefill.self, entry.name)
        case "tracks-list": try roundTrip([Track].self, entry.name)
        case "track-setups": try roundTrip([TrackSetupRow].self, entry.name)
        case "catalog": try roundTrip([CatalogTrack].self, entry.name)
        case "vehicles-list": try roundTrip([Vehicle].self, entry.name)
        case "garage": try roundTrip([GarageVehicle].self, entry.name)
        case "share-public": try roundTrip(ShareData.self, entry.name)
        case "track-create": try roundTrip(CreatedTrack.self, entry.name)
        case "vehicle-create": try roundTrip(Vehicle.self, entry.name)
        case "part-refresh": try roundTrip(PartRefresh.self, entry.name)
        case "share-set": try roundTrip(ShareSlug.self, entry.name)
        case "event-create", "session-create", "part-create", "measurement-create":
            try roundTrip(CreatedID.self, entry.name)
        case "event-update", "session-update", "laps-append", "track-update", "vehicle-update",
             "part-update", "setup-upsert", "setup-delete", "lap-delete", "session-delete",
             "measurement-delete", "part-delete", "vehicle-delete", "event-delete", "share-clear":
            try roundTrip(OKResponse.self, entry.name)
        default:
            Issue.record("""
                golden "\(entry.name)" (\(entry.method) \(entry.path)) has no model. \
                Add one and map it here — an endpoint the clients can't decode is drift.
                """)
        }
    }

    /// Decode, re-encode, and require the two JSON trees to match (ignoring
    /// nulls, which our encoders omit). Proves the model is **complete**: a field
    /// the server sends and we don't model shows up as a missing key, not as a
    /// silently dropped value.
    private func roundTrip<T: Codable>(_ type: T.Type, _ name: String) throws {
        let original = try Goldens.body(name)
        let model = try Goldens.decode(type, name)
        let reencoded = try JSONEncoder().encode(model)

        let want = JSONShape.normalize(try JSONSerialization.jsonObject(with: original))
        let got = JSONShape.normalize(try JSONSerialization.jsonObject(with: reencoded))
        let difference = JSONShape.difference(want, got)
        #expect(
            difference == nil,
            """
            \(name) does not round-trip through \(type) — the model has drifted \
            from the server: \(difference ?? "")
            """
        )
    }
}

/// Helpers for comparing two decoded-JSON trees.
enum JSONShape {
    /// Drop nulls recursively. Swift's synthesized `encode(to:)` omits nil
    /// optionals where the server sends explicit nulls; both mean "absent".
    static func normalize(_ value: Any) -> NSObject {
        switch value {
        case let dict as [String: Any]:
            let out = NSMutableDictionary()
            for (key, item) in dict where !(item is NSNull) {
                out[key] = normalize(item)
            }
            return out
        case let array as [Any]:
            return NSMutableArray(array: array.map { normalize($0) })
        case let object as NSObject:
            return object
        default:
            return NSNull()
        }
    }

    /// Where the two trees first diverge, phrased as something actionable, or nil
    /// when they agree. This is the comparison itself, not just its message.
    static func difference(_ a: NSObject, _ b: NSObject, path: String = "") -> String? {
        if let a = a as? NSDictionary, let b = b as? NSDictionary {
            let aKeys = Set(a.allKeys.compactMap { $0 as? String })
            let bKeys = Set(b.allKeys.compactMap { $0 as? String })
            if let missing = aKeys.subtracting(bKeys).sorted().first {
                return "\(path).\(missing) is in the response but not in the model"
            }
            if let extra = bKeys.subtracting(aKeys).sorted().first {
                return "\(path).\(extra) is in the model but not in the response"
            }
            for key in aKeys.sorted() {
                guard let av = a[key] as? NSObject, let bv = b[key] as? NSObject else { continue }
                if let diff = difference(av, bv, path: "\(path).\(key)") { return diff }
            }
            return nil
        }
        if let a = a as? NSArray, let b = b as? NSArray {
            if a.count != b.count { return "\(path) has \(a.count) items, model produced \(b.count)" }
            for i in 0..<a.count {
                guard let av = a[i] as? NSObject, let bv = b[i] as? NSObject else { continue }
                if let diff = difference(av, bv, path: "\(path)[\(i)]") { return diff }
            }
            return nil
        }
        // Numbers are compared as doubles with a relative tolerance: the two
        // JSON parsers can land a last-digit apart on a value like a
        // 17-significant-digit coefficient of variation, which is not drift.
        if let a = a as? NSNumber, let b = b as? NSNumber, !isBool(a), !isBool(b) {
            let (x, y) = (a.doubleValue, b.doubleValue)
            let tolerance = 1e-12 * Swift.max(1, Swift.abs(x))
            return Swift.abs(x - y) <= tolerance ? nil : "\(path): response \(x) vs model \(y)"
        }
        return a.isEqual(b) ? nil : "\(path): response \(a) vs model \(b)"
    }

    /// `NSNumber` boxes booleans too; those must compare exactly.
    private static func isBool(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }
}
