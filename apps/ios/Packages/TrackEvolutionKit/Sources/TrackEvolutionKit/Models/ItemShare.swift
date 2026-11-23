import Foundation

// Share one event or one session (NS-48, docs/specs/native/NS-48-share-event-session.md).
//
// A link anyone can open without signing in: `https://<host>/share/e/<token>`
// for a track day, `/share/s/<token>` for one session. Separate from the
// logbook share (`/share/<slug>`, `ShareData`), which it neither replaces nor
// touches — the one-letter prefixes are what keep the two apart, since a slug
// is three characters at least.

/// Which kind of thing a link shares.
///
/// NS-56 (`docs/specs/native/NS-56-share-lap-compare.md`) adds two to NS-48's:
/// `/share/l/<token>` for one lap and `/share/c/<token>` for two laps compared.
public enum ItemShareKind: String, Codable, Hashable, Sendable, CaseIterable {
    case event
    case session
    case lap
    case compare

    /// The path letter after `/share/` — and after `/api/share/`.
    public var pathLetter: String {
        switch self {
        case .event: "e"
        case .session: "s"
        case .lap: "l"
        case .compare: "c"
        }
    }

    /// `e` → event, `s` → session, `l` → lap, `c` → compare, anything else nil.
    public init?(pathLetter: String) {
        guard let kind = Self.allCases.first(where: { $0.pathLetter == pathLetter }) else { return nil }
        self = kind
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

/// What the owner shares: the item a link is minted for. One link per target —
/// and a comparison is **ordered**, so B against A is another link (NS-56).
public enum ItemShareTarget: Hashable, Sendable, Identifiable {
    case event(Int)
    case session(Int)
    case lap(Int)
    /// Two of the owner's laps at one track: `a` is side A, `b` side B.
    case compare(a: Int, b: Int)

    public var kind: ItemShareKind {
        switch self {
        case .event: .event
        case .session: .session
        case .lap: .lap
        case .compare: .compare
        }
    }

    /// The owner's route under `/api`: `/events/:id/share`, `/sessions/:id/share`,
    /// `/laps/:id/share` or `/laps/:id/compare/:otherId/share`.
    public var ownerPath: String {
        switch self {
        case .event(let id): "/events/\(id)/share"
        case .session(let id): "/sessions/\(id)/share"
        case .lap(let id): "/laps/\(id)/share"
        case .compare(let a, let b): "/laps/\(a)/compare/\(b)/share"
        }
    }

    /// Whether an id is still a temp id — created offline and not yet synced —
    /// so there is nothing the server could mint a link for.
    public var hasTempId: Bool {
        switch self {
        case .event(let id), .session(let id), .lap(let id): OfflineStore.isTemp(id)
        case .compare(let a, let b): OfflineStore.isTemp(a) || OfflineStore.isTemp(b)
        }
    }

    public var id: String {
        switch self {
        case .event(let id): "event-\(id)"
        case .session(let id): "session-\(id)"
        case .lap(let id): "lap-\(id)"
        case .compare(let a, let b): "compare-\(a)-\(b)"
        }
    }
}

/// `POST` / `GET /api/events/:id/share`, `/api/sessions/:id/share`,
/// `/api/laps/:id/share` and `/api/laps/:id/compare/:otherId/share`: the link.
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

/// `GET /api/share/e/:token`, `/api/share/s/:token` and `/api/share/l/:token`
/// — **unauthenticated**.
///
/// `event` is `GET /events/:id`'s own shape, narrowed server-side: notes, the
/// checklist, the cost line items, setup sheets and the garage link arrive null
/// or empty, never as a different shape — so it decodes into the ordinary
/// `EventDetail` and the event page's pieces render it unchanged. A session
/// link carries that one session, with the header's figures worked out from it;
/// a lap link (NS-56) that one session cut down to the one lap — its row, its
/// own channel entry, its clip — with `trace` kept only when it is the lap the
/// line was drawn from.
public struct SharedItem: Codable, Hashable, Sendable {
    public var kind: ItemShareKind
    /// The owner's display name.
    public var name: String?
    /// The **owner's** tier: what the channel panel opens to and whether the
    /// best-lap videos play — the viewer's own account never enters into it.
    public var pro: Bool
    /// The shared session, for a session link; nil for an event.
    public var sessionId: Int?
    /// The shared lap, for a lap link (NS-56); nil for an event or a session.
    public var lapId: Int?
    public var event: EventDetail

    public enum CodingKeys: String, CodingKey {
        case kind, name, pro, event
        case sessionId = "session_id"
        case lapId = "lap_id"
    }
}

/// One side of a shared comparison: a lap link's payload — the lap's event
/// narrowed to its one session with its one lap.
public struct SharedLapSide: Codable, Hashable, Sendable {
    public var sessionId: Int
    public var lapId: Int
    public var event: EventDetail

    public enum CodingKeys: String, CodingKey {
        case event
        case sessionId = "session_id"
        case lapId = "lap_id"
    }

    /// The side's one session.
    public var session: Session? {
        event.sessions.first { $0.id == sessionId } ?? event.sessions.first
    }

    /// The side's one lap.
    public var lap: Lap? {
        guard let session else { return nil }
        return session.laps.first { $0.id == lapId } ?? session.laps.first
    }

    /// The lap's own channel entry — the blob carries exactly one — or nil for
    /// a lap that stored no telemetry.
    public var channelEntry: LapChannels? {
        session?.channels?.laps.first
    }
}

/// `GET /api/share/c/:token` — **unauthenticated** (NS-56): two of the owner's
/// laps at one track, A against B. `pro` is the **owner's** tier; a free
/// owner's link still resolves, and the clients show the two lap times.
public struct SharedCompare: Codable, Hashable, Sendable {
    public var kind: ItemShareKind
    /// The owner's display name.
    public var name: String?
    public var pro: Bool
    public var a: SharedLapSide
    public var b: SharedLapSide
}
