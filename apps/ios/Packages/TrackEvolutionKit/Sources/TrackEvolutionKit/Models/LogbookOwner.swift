import Foundation

/// Whose logbook a screen is showing (NS-38): your own, or a student's that you
/// coach — read-only, through `/api/students/<id>`.
///
/// The native counterpart of the web's three seams in `public/app.js`
/// (`viewing`, `L()` and `ent()`): the API client prefixes and refuses writes by
/// it (`APIClient.scoped(toStudent:)`), the app's links keep a student's pages
/// inside their logbook by it, and the channel panel's tier gates read
/// ``channelEntitlement(viewer:)`` — **the student's tier, not the viewer's**,
/// because the student is the one who paid for it. A free coach of a Pro
/// student sees the full panel the server already sent; a coach of a free
/// student sees the free half, the same as the student does.
public enum LogbookOwner: Hashable, Sendable {
    case me
    /// `pro` is the student's own tier, from their `/me/profile` under the
    /// coach mount — the one tier fact a coach is given.
    case student(id: Int, name: String?, pro: Bool)

    /// Whether writes are refused — every control that changes something hides.
    public var isReadOnly: Bool {
        if case .student = self { return true }
        return false
    }

    public var studentId: Int? {
        if case .student(let id, _, _) = self { return id }
        return nil
    }

    /// What a page calls the driver whose logbook this is.
    public var displayName: String {
        if case .student(_, let name, _) = self, let name, !name.isEmpty { return name }
        return isReadOnly ? "This driver" : "You"
    }

    /// The path every read goes through: `/students/<id>` for a student, nothing
    /// for your own. Paired with the student's own cache keys, which is what keeps
    /// a coach's copy of a student's logbook apart from their own offline.
    public var apiPrefix: String {
        if case .student(let id, _, _) = self { return Self.studentPrefix(id) }
        return ""
    }

    public static func studentPrefix(_ id: Int) -> String { "/students/\(id)" }

    /// The entitlement a tier gate reads here: the viewer's own for their own
    /// logbook, the student's for a student's — `ent()` in `public/app.js`.
    public func channelEntitlement(viewer: Entitlement?) -> Entitlement? {
        switch self {
        case .me: viewer
        case .student(_, _, let pro): Entitlement(tier: pro ? .pro : .free)
        }
    }

    /// `Entitlement.canViewChannels` under this owner's tier.
    public func canViewChannels(viewer: Entitlement?) -> Bool {
        Entitlement.canViewChannels(channelEntitlement(viewer: viewer))
    }

    /// What a coach is told where the student's channels stop at the free half —
    /// in place of the paywall, which is the student's to answer, not theirs.
    /// `studentFreeNote` in `public/app.js`, word for word.
    public var studentFreeNote: String {
        "\(displayName) is on the free plan, so you see their lap times, racing lines and the "
            + "speed, throttle and brake traces. Steering, RPM, lateral G, sector splits, the friction circle and the rest "
            + "of the analysis show here once they have Pro."
    }
}
