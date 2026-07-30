import Foundation

// The checkpoint wire format, kept deliberately identical to the JS:
//
//   { "v": 1, "eventId": "3"|3|null, "startedAtMs": 1750000000000,
//     "fixes": [[tRelS, lat, lon, v|null, acc|null], …] }
//
// Tuple-encoded fixes are what keep a checkpoint ~50 bytes per fix, and a shared
// format means a recording written by any of the three clients is readable (and
// debuggable) by the others. Don't replace it with a Swift-native encoding.

extension Recording: Codable {
    public enum CodingKeys: String, CodingKey {
        case v, eventId, startedAtMs, fixes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        startedAtMs = try c.decode(Double.self, forKey: .startedAtMs)
        fixes = try c.decode([Fix].self, forKey: .fixes)
        // The web writes the route parameter, so this is a string there ("3", or
        // "tmp-4" for an event created offline); the native app writes an
        // integer. Both are accepted, and null is normal — an event-less
        // recording is adopted by an event later.
        if c.contains(.eventId), try !c.decodeNil(forKey: .eventId) {
            if let string = try? c.decode(String.self, forKey: .eventId) {
                eventId = string
            } else if let number = try? c.decode(Int.self, forKey: .eventId) {
                eventId = String(number)
            } else {
                throw DecodingError.dataCorruptedError(
                    forKey: .eventId, in: c, debugDescription: "eventId is neither a string nor an int"
                )
            }
        } else {
            eventId = nil
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        // Explicitly null rather than omitted, matching JSON.stringify.
        try c.encode(eventId, forKey: .eventId)
        try c.encode(startedAtMs, forKey: .startedAtMs)
        try c.encode(fixes, forKey: .fixes)
    }
}

extension Recording.Fix: Codable {
    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        t = try c.decode(Double.self)
        lat = try c.decode(Double.self)
        lon = try c.decode(Double.self)
        v = try Self.decodeOptionalNumber(&c)
        acc = try Self.decodeOptionalNumber(&c)
        guard t.isFinite, lat.isFinite, lon.isFinite else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: c.codingPath, debugDescription: "fix holds a non-finite value")
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(t)
        try c.encode(lat)
        try c.encode(lon)
        try c.encode(v)
        try c.encode(acc)
    }

    /// A trailing tuple slot: absent, null, or a finite number. Anything else
    /// fails the decode, which surfaces as a nil recording rather than a throw.
    private static func decodeOptionalNumber(_ c: inout any UnkeyedDecodingContainer) throws -> Double? {
        if c.isAtEnd { return nil }
        if try c.decodeNil() { return nil }
        let value = try c.decode(Double.self)
        guard value.isFinite else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: c.codingPath, debugDescription: "fix holds a non-finite value")
            )
        }
        return value
    }
}
