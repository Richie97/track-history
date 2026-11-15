import Foundation

// Coach comments on sessions and laps (NS-52,
// docs/specs/native/NS-52-coach-comments.md).
//
// Decoded here ahead of the iOS screens (ticket 2) so the golden contract pins
// them from the server PR on; nothing reads them yet. A comment sits in one
// coach's private thread (`coachId`) on a session, a lap of it (`lapId`) or a
// place on that lap (`distM`, whole metres from the start/finish line).

public struct CommentAuthor: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String?
    public var picture: String?
}

public struct CoachComment: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    /// Whose thread this is — not necessarily who wrote it.
    public var coachId: Int
    public var sessionId: Int
    public var lapId: Int?
    public var distM: Int?
    public var body: String
    /// Epoch ms.
    public var createdAt: Int
    public var editedAt: Int?
    public var author: CommentAuthor
    /// The caller wrote it.
    public var mine: Bool
    /// Its one reader has read it: the read receipt on a comment the caller
    /// wrote, the caller's own unread mark on any other.
    public var seen: Bool

    public enum CodingKeys: String, CodingKey {
        case id, body, author, mine, seen
        case coachId = "coach_id"
        case sessionId = "session_id"
        case lapId = "lap_id"
        case distM = "dist_m"
        case createdAt = "created_at"
        case editedAt = "edited_at"
    }
}

/// `GET /api/events/:id/comments` (the owner: every thread, with `coaches`)
/// and `GET /api/coaching/students/:sid/events/:eid/comments` (a coach: their
/// own thread, no `coaches`).
public struct EventComments: Codable, Hashable, Sendable {
    public var comments: [CoachComment]
    public var coaches: [Coach]?

    /// A thread's coach, and whether they can still read it (a closed thread
    /// takes no reply).
    public struct Coach: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var name: String?
        public var picture: String?
        public var active: Bool
    }
}

/// A comment created (201) or edited.
public struct CommentSaved: Codable, Hashable, Sendable {
    public var comment: CoachComment
}

/// `POST …/comments/seen`: how many it marked read.
public struct CommentsSeen: Codable, Hashable, Sendable {
    public var ok: Bool
    public var seen: Int
}

/// `GET /api/coaching/comments`: what was said to the caller, newest first.
public struct CommentFeed: Codable, Hashable, Sendable {
    public var unread: Int
    public var comments: [Row]

    public struct Student: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var name: String?
    }

    /// One row: a comment plus where it is.
    public struct Row: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var coachId: Int
        public var sessionId: Int
        public var lapId: Int?
        public var distM: Int?
        public var body: String
        public var createdAt: Int
        public var editedAt: Int?
        public var author: CommentAuthor
        public var mine: Bool
        public var seen: Bool
        /// Nil on the caller's own logbook; otherwise the student whose
        /// logbook it is.
        public var student: Student?
        public var eventId: Int
        public var trackName: String?
        public var startDate: String
        public var sessionLabel: String?
        public var lapNum: Int?

        public enum CodingKeys: String, CodingKey {
            case id, body, author, mine, seen, student
            case coachId = "coach_id"
            case sessionId = "session_id"
            case lapId = "lap_id"
            case distM = "dist_m"
            case createdAt = "created_at"
            case editedAt = "edited_at"
            case eventId = "event_id"
            case trackName = "track_name"
            case startDate = "start_date"
            case sessionLabel = "session_label"
            case lapNum = "lap_num"
        }
    }
}
