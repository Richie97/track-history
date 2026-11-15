import Foundation

/// Coach comments on sessions and laps (NS-52): the pure half — how a thread is
/// grouped and ordered, where a placed comment is, and every fixed sentence, so
/// no client words one differently.
///
/// The port of `public/js/comments.js` under the same names, pinned by
/// `contracts/logic/comments.json` (`CommentsTests`) — the fixture Android's
/// `:core` asserts against too. Dateless in the way ported logic here is:
/// anything that says a calendar date takes the client's own formatter.
public enum Comments {
    /// Mirrors `COMMENT_MAX_CHARS` in `src/lib/comments.ts` — code points, after
    /// trimming.
    public static let COMMENT_MAX_CHARS = 1000

    public static let COMMENTS_HEADING = "Comments"
    public static let COMMENT_PLACEHOLDER = "Add a comment…"
    public static let REPLY_PLACEHOLDER = "Reply…"
    public static let WHOLE_SESSION = "Whole session"
    public static let COMMENT_OFFLINE = "Commenting needs a connection."
    public static let THREAD_CLOSED = "They no longer have access to your logbook, so this thread is closed."
    public static let REPORT_LABEL = "Report"
    public static let REPORT_EMAIL = "eric@speedshift.io"

    private static let MIN_MS = 60 * 1000
    private static let HOUR_MS = 60 * MIN_MS
    private static let DAY_MS = 24 * HOUR_MS

    private static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
        "\(n) \(n == 1 ? one : (many ?? "\(one)s"))"
    }

    /// JavaScript's `||` on a string: an empty one counts as absent.
    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    // MARK: - Length

    /// How many characters a draft is, the way the server counts them: code
    /// points, line endings normalised, trimmed.
    public static func commentLength(_ text: String?) -> Int {
        let normalised = (text ?? "")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        return normalised.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
    }

    // MARK: - Threads

    /// One coach's conversation on an event.
    public struct Thread: Hashable, Sendable {
        public var coachId: Int
        public var comments: [CoachComment]
        public init(coachId: Int, comments: [CoachComment]) {
            self.coachId = coachId
            self.comments = comments
        }
    }

    /// The comments on an event split into one thread per coach, in the order
    /// each coach first spoke.
    public static func commentThreads(_ comments: [CoachComment]?) -> [Thread] {
        var order: [Int] = []
        var byCoach: [Int: [CoachComment]] = [:]
        for c in comments ?? [] {
            if byCoach[c.coachId] == nil {
                order.append(c.coachId)
                byCoach[c.coachId] = []
            }
            byCoach[c.coachId]?.append(c)
        }
        return order.map { Thread(coachId: $0, comments: byCoach[$0] ?? []) }
    }

    private static func byTime(_ a: CoachComment, _ b: CoachComment) -> Bool {
        a.createdAt != b.createdAt ? a.createdAt < b.createdAt : a.id < b.id
    }

    /// A lap as `groupComments` reads it.
    public struct CommentLap: Hashable, Sendable {
        public var id: Int
        public var lapNum: Int
        public var timeMs: Int
        public init(id: Int, lapNum: Int, timeMs: Int) {
            self.id = id
            self.lapNum = lapNum
            self.timeMs = timeMs
        }
    }

    public struct LapGroup: Hashable, Sendable {
        public var lapId: Int
        public var lapNum: Int
        public var timeMs: Int
        public var comments: [CoachComment]
    }

    public struct Grouped: Hashable, Sendable {
        /// What was said about the whole session.
        public var session: [CoachComment]
        public var laps: [LapGroup]
    }

    /// One session's comments in reading order: what was said about the whole
    /// session first, then each lap's in lap order — a lap's own by place along
    /// the lap (an unplaced one last), then by time. A comment whose lap is no
    /// longer in the session is left out.
    public static func groupComments(_ comments: [CoachComment]?, sessionId: Int, laps: [CommentLap]) -> Grouped {
        let mine = (comments ?? []).filter { $0.sessionId == sessionId }
        var groups: [LapGroup] = []
        for lap in laps {
            let list = mine.filter { $0.lapId == lap.id }.sorted { a, b in
                let pa = a.distM.map(Double.init) ?? .infinity
                let pb = b.distM.map(Double.init) ?? .infinity
                return pa != pb ? pa < pb : byTime(a, b)
            }
            if !list.isEmpty {
                groups.append(LapGroup(lapId: lap.id, lapNum: lap.lapNum, timeMs: lap.timeMs, comments: list))
            }
        }
        return Grouped(session: mine.filter { $0.lapId == nil }.sorted(by: byTime), laps: groups)
    }

    /// ``groupComments(_:sessionId:laps:)`` over a session of the event detail.
    public static func groupComments(_ comments: [CoachComment]?, _ session: Session) -> Grouped {
        groupComments(
            comments, sessionId: session.id,
            laps: session.laps.map { CommentLap(id: $0.id, lapNum: $0.lapNum, timeMs: $0.timeMs) }
        )
    }

    // MARK: - Counts

    public struct Count: Hashable, Sendable, Codable {
        public var count: Int
        public var unread: Int
        public init(count: Int, unread: Int) {
            self.count = count
            self.unread = unread
        }
    }

    public struct Counts: Hashable, Sendable {
        public var bySession: [Int: Count]
        public var byLap: [Int: Count]
    }

    /// Counts for the markers: per session and per lap, each with how many the
    /// viewer has not read. A row the viewer wrote is never unread to them.
    public static func commentCounts(_ comments: [CoachComment]?) -> Counts {
        var out = Counts(bySession: [:], byLap: [:])
        func bump(_ into: inout [Int: Count], _ key: Int, _ c: CoachComment) {
            var at = into[key] ?? Count(count: 0, unread: 0)
            at.count += 1
            if !c.mine && !c.seen { at.unread += 1 }
            into[key] = at
        }
        for c in comments ?? [] {
            bump(&out.bySession, c.sessionId, c)
            if let lapId = c.lapId { bump(&out.byLap, lapId, c) }
        }
        return out
    }

    /// What a lap's marker says aloud: "2 comments, 1 unread".
    public static func commentCountText(_ count: Count?) -> String {
        guard let count, count.count > 0 else { return "" }
        return plural(count.count, "comment") + (count.unread > 0 ? ", \(count.unread) unread" : "")
    }

    // MARK: - Places

    /// Where a placed comment is, in the reader's units and the session's own
    /// corner numbering: "in T4 · 1.2 km". `corners` is
    /// `Corners.sessionCorners(channels)` — derived when it is drawn, never
    /// stored. The distance alone without corners; nil with no place.
    public static func commentPlace(
        _ distM: Double?, _ dStepM: Double?, _ corners: [Corners.Corner]?, _ units: UnitSystem
    ) -> String? {
        guard let distM, distM.isFinite else { return nil }
        let dist = Units.fmtDist(Double(JSMath.roundToInt(distM) ?? 0), units)
        let whereText: String? = if let dStepM, dStepM > 0 {
            VideoSync.cornerPlace(corners, distM / dStepM)
        } else {
            nil
        }
        if let whereText { return "\(whereText) · \(dist)" }
        return dist
    }

    /// The place a cursor at fractional grid index k is, as a comment stores
    /// it: whole metres from the line.
    public static func placeFromCursor(_ k: Double?, _ dStepM: Double?) -> Int? {
        guard let k, k.isFinite, let dStepM, dStepM > 0 else { return nil }
        return max(0, JSMath.roundToInt(k * dStepM) ?? 0)
    }

    public struct Marker: Hashable, Sendable {
        public var id: Int
        /// The fraction of the lap's own length, 0…1.
        public var frac: Double
        public var mine: Bool
        public init(id: Int, frac: Double, mine: Bool) {
            self.id = id
            self.frac = frac
            self.mine = mine
        }
    }

    /// A lap's placed comments as marks along it, clamped — a place past the
    /// end of a lap that was re-imported shorter still marks its end.
    public static func commentMarkers(_ comments: [CoachComment]?, _ lapId: Int, _ lapLengthM: Double?) -> [Marker] {
        guard let lapLengthM, lapLengthM > 0 else { return [] }
        return (comments ?? [])
            .compactMap { c -> Marker? in
                guard let distM = c.distM, c.lapId == lapId else { return nil }
                return Marker(id: c.id, frac: max(0, min(1, Double(distM) / lapLengthM)), mine: c.mine)
            }
            .sorted { $0.frac != $1.frac ? $0.frac < $1.frac : $0.id < $1.id }
    }

    // MARK: - Words

    /// A thread takes a reply only while its coach still has access.
    public static func canReply(_ coach: EventComments.Coach?) -> Bool {
        coach?.active ?? false
    }

    /// A thread's heading. The owner sees whose it is; the coach sees their own.
    public static func threadTitle(_ coach: EventComments.Coach?, _ isOwner: Bool) -> String {
        guard isOwner else { return "Your comments" }
        let name = nonEmpty(coach?.name) ?? "Your coach"
        if let coach, !coach.active { return "\(name) · no longer your coach" }
        return name
    }

    /// What a coach is told before the first comment: who reads it.
    public static func coachAudienceNote(_ studentName: String?) -> String {
        "Only you and \(nonEmpty(studentName) ?? "this driver") see what you write here."
    }

    public static func reportSubject(_ commentId: Int) -> String {
        "Report a comment (#\(commentId))"
    }

    public static func reportBody(_ commentId: Int) -> String {
        "I'd like to report comment #\(commentId) on Track Evolution.\n\nWhat's wrong with it:\n"
    }

    /// The `mailto:` a *Report* opens.
    public static func reportURL(_ commentId: Int) -> URL? {
        var parts = URLComponents()
        parts.scheme = "mailto"
        parts.path = REPORT_EMAIL
        parts.queryItems = [
            URLQueryItem(name: "subject", value: reportSubject(commentId)),
            URLQueryItem(name: "body", value: reportBody(commentId)),
        ]
        return parts.url
    }

    /// What a failed send says. `status` is the server's, nil when the request
    /// never got an answer.
    public static func commentError(_ status: Int?, _ message: String?) -> String {
        guard let status else { return COMMENT_OFFLINE }
        switch status {
        case 429: return "Too many comments at once — try again in a minute."
        case 409: return "This session has as many comments as it can hold."
        case 404: return "That can't be commented on any more — the session or the coaching link is gone."
        default: return nonEmpty(message) ?? "Couldn't send that comment."
        }
    }

    /// ``commentError(_:_:)`` for whatever the client threw.
    public static func commentError(_ error: Error) -> String {
        guard let api = error as? APIError else { return commentError(nil, nil) }
        switch api {
        case .transport: return commentError(nil, nil)
        case .readOnly, .decoding: return api.message
        default: return commentError(api.status, api.message)
        }
    }

    /// When a comment was written, in words while it is recent; nil once it is
    /// old enough that the client should say the date.
    public static func commentWhen(_ createdAt: Int, _ now: Int) -> String? {
        let ago = max(0, now - createdAt)
        if ago < MIN_MS { return "just now" }
        if ago < HOUR_MS { return "\(ago / MIN_MS) min ago" }
        if ago < DAY_MS { return "\(plural(ago / HOUR_MS, "hour")) ago" }
        if ago < 7 * DAY_MS { return "\(plural(ago / DAY_MS, "day")) ago" }
        return nil
    }

    /// What a feed row is about: "Lap 6 · VIR" or "Session 2 · VIR".
    public static func feedTarget(_ row: CommentFeed.Row) -> String {
        let what = row.lapNum.map { "Lap \($0)" } ?? nonEmpty(row.sessionLabel) ?? "a session"
        if let track = nonEmpty(row.trackName) { return "\(what) · \(track)" }
        return what
    }

    /// One feed row's line. On your own logbook a coach commented; on a
    /// student's, the student replied.
    public static func feedLine(_ row: CommentFeed.Row) -> String {
        let who = nonEmpty(row.author.name) ?? (row.student != nil ? "Your student" : "Your coach")
        return "\(who) \(row.student != nil ? "replied on" : "commented on") \(feedTarget(row))"
    }

    /// The dashboard card's one line over the feed, or nil with nothing unread:
    /// the comment itself when there is one, a count when there are more.
    public static func unreadLine(_ feed: CommentFeed?) -> String? {
        let unread = (feed?.comments ?? []).filter { !$0.seen }
        let n = max(feed?.unread ?? 0, unread.count)
        if n == 0 { return nil }
        if n == 1 && unread.count == 1 { return feedLine(unread[0]) }
        let people = Set(unread.map(\.author.id))
        let only = people.count == 1 ? nonEmpty(unread[0].author.name) : nil
        let from = only.map { " from \($0)" } ?? (people.count > 1 ? " from \(people.count) people" : "")
        return "\(n) new comments\(from)"
    }
}
