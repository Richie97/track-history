import Foundation

// Share one event or one session (NS-48, docs/specs/native/NS-48-share-event-session.md).
//
// A link anyone can open without signing in: `https://<host>/share/e/<token>`
// for a track day, `/share/s/<token>` for one session. Separate from the
// logbook share (`/share/<slug>`, `ShareData`), which it neither replaces nor
// touches — the one-letter prefixes are what keep the two apart, since a slug
// is three characters at least.

/// Which kind of thing a link shares.
public enum ItemShareKind: String, Codable, Hashable, Sendable, CaseIterable {
    case event
    case session

    /// The path letter after `/share/` — and after `/api/share/`.
    public var pathLetter: String {
        switch self {
        case .event: "e"
        case .session: "s"
        }
    }

    /// `e` → event, `s` → session, anything else nil.
    public init?(pathLetter: String) {
        guard let kind = Self.allCases.first(where: { $0.pathLetter == pathLetter }) else { return nil }
        self = kind
    }

    /// Where the owner's routes for it live: `/events/:id` or `/sessions/:id`.
    public var ownerCollection: String {
        switch self {
        case .event: "events"
        case .session: "sessions"
        }
    }

    /// A share token's shape: 128 random bits, base64url, so 22 characters of
    /// `[A-Za-z0-9_-]` — `SHARE_TOKEN` in `src/lib/itemShare.ts`.
    public static func isToken(_ raw: String) -> Bool {
        raw.count == 22 && raw.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", "_", "-": true
            default: false
            }
        }
    }
}

/// `POST` / `GET /api/events/:id/share` and `/api/sessions/:id/share`: the link.
/// One per item — a second Share answers the same link, and *Stop sharing*
/// deletes it, so the next Share mints a new one.
public struct ItemShareLink: Codable, Hashable, Sendable {
    public var kind: ItemShareKind
    public var token: String
    /// The page to send: the server builds it, so the host is the server's own.
    public var url: URL
    public var createdAt: Int

    public enum CodingKeys: String, CodingKey {
        case kind, token, url
        case createdAt = "created_at"
    }
}

/// `GET /api/share/e/:token` and `/api/share/s/:token` — **unauthenticated**.
///
/// `event` is `GET /events/:id`'s own shape, narrowed server-side: notes, the
/// checklist, the cost line items, setup sheets and the garage link arrive null
/// or empty, never as a different shape — so it decodes into the ordinary
/// `EventDetail` and the event page's pieces render it unchanged. A session
/// link carries that one session, with the header's figures worked out from it.
public struct SharedItem: Codable, Hashable, Sendable {
    public var kind: ItemShareKind
    /// The owner's display name.
    public var name: String?
    /// The **owner's** tier: what the channel panel opens to and whether the
    /// best-lap videos play — the viewer's own account never enters into it.
    public var pro: Bool
    /// The shared session, for a session link; nil for an event.
    public var sessionId: Int?
    public var event: EventDetail

    public enum CodingKeys: String, CodingKey {
        case kind, name, pro, event
        case sessionId = "session_id"
    }
}
