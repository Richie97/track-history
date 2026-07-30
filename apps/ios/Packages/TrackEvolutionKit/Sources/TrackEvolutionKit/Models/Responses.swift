import Foundation

/// `{ "id": 1 }` — what every create endpoint returns.
public struct CreatedID: Codable, Hashable, Sendable {
    public var id: Int
}

/// `{ "ok": true }` — what every update/delete endpoint returns.
public struct OKResponse: Codable, Hashable, Sendable {
    public var ok: Bool
}

/// `POST /api/tracks` — the row the server created (or found: tracks are
/// resolved by name, case-insensitively).
public struct CreatedTrack: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
    public var catalogId: Int?

    public enum CodingKeys: String, CodingKey {
        case id, name
        case catalogId = "catalog_id"
    }
}

/// `POST /api/parts/:id/refresh` — the new part, plus the id of the one it
/// replaced.
public struct PartRefresh: Codable, Hashable, Sendable {
    public var id: Int
    public var retiredId: Int

    public enum CodingKeys: String, CodingKey {
        case id
        case retiredId = "retired_id"
    }
}
