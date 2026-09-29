import Foundation

// Share with a coach (NS-38, docs/specs/native/NS-38-coach-sharing.md).
//
// Decoded here ahead of the iOS screens (ticket 3) so the golden contract pins
// them from the server PR on; nothing reads them yet. A coach's view of a
// student's logbook — `GET /api/students/:id/events`, `/events/:id`, `/tracks`,
// `/vehicles` — decodes into the ordinary `Event`, `EventDetail`, `Track` and
// `Vehicle`: the server sends the fields a coach may not see as null (or an
// empty list), never as a different shape.

/// The driver profile: what a driver tells their instructor about themselves.
/// Every field optional; validated by `sanitizeProfile` in
/// `src/lib/profile.ts`. Deliberately no birth date or emergency contact.
public struct DriverProfile: Codable, Hashable, Sendable {
    public var occupation: String?
    public var firstTrackYear: Int?
    public var experience: String?
    public var license: String?
    public var instruction: String?
    public var helmet: String?
    /// `SA2020`, `SA2025`, `SAH2020`, `FIA8859`, `M` or `other`.
    public var helmetRating: String?
    /// `none`, `hans`, `hybrid` or `other`.
    public var headNeck: String?
    public var suit: String?
    public var gloves: Bool?
    public var shoes: Bool?
    public var gearNotes: String?
    public var goals: String?
    public var forInstructor: String?

    public enum CodingKeys: String, CodingKey {
        case occupation, experience, license, instruction, helmet, suit, gloves, shoes, goals
        case firstTrackYear = "first_track_year"
        case helmetRating = "helmet_rating"
        case headNeck = "head_neck"
        case gearNotes = "gear_notes"
        case forInstructor = "for_instructor"
    }

    public init() {}
}

/// `GET /api/me/profile` — and, under `/api/students/:id`, the student's.
/// `pro` is the profile owner's tier: in a student's logbook it, not the
/// viewer's own entitlement, decides whether the channel panel opens.
public struct ProfileResponse: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String?
    public var picture: String?
    public var pro: Bool
    public var profile: DriverProfile?
}

/// `PUT /api/me/profile`: the profile as stored, trimmed; nil when cleared.
public struct ProfileSaved: Codable, Hashable, Sendable {
    public var ok: Bool
    public var profile: DriverProfile?
}

/// `GET /api/coaching`: both directions of the grant, and the open invites.
public struct Coaching: Codable, Hashable, Sendable {
    public var coaches: [Coach]
    public var students: [Student]
    public var invites: [OpenInvite]

    public struct Coach: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var name: String?
        public var picture: String?
        /// Epoch ms.
        public var since: Int
        public var lastViewedAt: Int?

        public enum CodingKeys: String, CodingKey {
            case id, name, picture, since
            case lastViewedAt = "last_viewed_at"
        }
    }

    public struct Student: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var name: String?
        public var picture: String?
        /// Epoch ms.
        public var since: Int
        /// Past events only, on the totals' rule.
        public var eventCount: Int
        public var lastEventDate: String?

        public enum CodingKeys: String, CodingKey {
            case id, name, picture, since
            case eventCount = "event_count"
            case lastEventDate = "last_event_date"
        }
    }

    /// An unused invite. Its link was shown once, at creation, and can't be again.
    public struct OpenInvite: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var createdAt: Int
        public var expiresAt: Int

        public enum CodingKeys: String, CodingKey {
            case id
            case createdAt = "created_at"
            case expiresAt = "expires_at"
        }
    }
}

/// `POST /api/coaching/invites` (Pro): the one time the link is shown.
public struct CoachInvite: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var url: String
    public var expiresAt: Int

    public enum CodingKeys: String, CodingKey {
        case id, url
        case expiresAt = "expires_at"
    }
}

/// The student an invite shares, as its preview and its acceptance name them.
public struct InviteStudent: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String?
    public var picture: String?
}

/// `GET /api/coaching/invites/:token`.
public struct InvitePreview: Codable, Hashable, Sendable {
    public var student: InviteStudent
    public var expiresAt: Int
    /// The caller's own invite: accepting is refused.
    public var own: Bool
    public var alreadyCoach: Bool

    public enum CodingKeys: String, CodingKey {
        case student, own
        case expiresAt = "expires_at"
        case alreadyCoach = "already_coach"
    }
}

/// `POST /api/coaching/invites/:token/accept`.
public struct InviteAccepted: Codable, Hashable, Sendable {
    public var student: InviteStudent
}
