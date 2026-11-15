import Foundation

// Push notifications for coach comments (NS-54,
// docs/specs/native/NS-54-comment-push.md): the pure half on the phone — what
// a registration sends, and where a tapped notification goes. The server's
// half is `src/lib/push.ts` and `src/routes/push.ts`.

/// Which push service a device token belongs to. Only `ios` is ever sent from
/// this app; the case list mirrors the server's `PUSH_PLATFORMS`.
public enum PushPlatform: String, Codable, Hashable, Sendable {
    case ios
    case android
}

/// `PUT /api/push/device`'s body: this app session's phone.
public struct PushDeviceDraft: Codable, Hashable, Sendable {
    public var platform: PushPlatform
    /// The FCM registration token.
    public var token: String

    public init(platform: PushPlatform, token: String) {
        self.platform = platform
        self.token = token
    }
}

/// Where a tapped comment notification opens: a lap, or the event for a
/// comment on a whole session — in the viewer's own logbook, or in a
/// student's when `studentId` is set (the recipient is that student's coach).
public struct CommentPushTarget: Hashable, Sendable {
    public var studentId: Int?
    public var eventId: Int
    public var sessionId: Int
    public var lapId: Int?

    public init(studentId: Int?, eventId: Int, sessionId: Int, lapId: Int?) {
        self.studentId = studentId
        self.eventId = eventId
        self.sessionId = sessionId
        self.lapId = lapId
    }
}

extension DeepLink {
    /// The notification's `data`, as `commentPushMessage` in `src/lib/push.ts`
    /// writes it — every value a string, FCM's rule — read into a place.
    ///
    /// The table, shared with Android's `DeepLink.commentPush` in `:core`:
    /// - `kind` must be `"comment"`, else nil;
    /// - `event_id` and `session_id` must be positive integers, else nil;
    /// - a valid `lap_id` opens that lap, anything else the event;
    /// - a valid `student_id` opens it in that student's logbook, anything
    ///   else in the viewer's own.
    ///
    /// A malformed optional id is dropped rather than failing the whole link:
    /// the event is still the right place to land.
    public static func commentPush(_ data: [String: String]) -> DeepLink? {
        guard data["kind"] == "comment",
              let eventId = positiveId(data["event_id"]),
              let sessionId = positiveId(data["session_id"])
        else { return nil }
        return .comment(CommentPushTarget(
            studentId: positiveId(data["student_id"]),
            eventId: eventId,
            sessionId: sessionId,
            lapId: positiveId(data["lap_id"])
        ))
    }

    /// Digits only — no sign, no whitespace, no `"7.0"` — and above zero.
    static func positiveId(_ raw: String?) -> Int? {
        guard let raw, !raw.isEmpty, raw.count <= 15, raw.allSatisfy({ $0.isASCII && $0.isNumber }),
              let id = Int(raw), id > 0
        else { return nil }
        return id
    }
}
