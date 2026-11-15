import Foundation
import Testing

@testable import TrackEvolutionKit

/// Coach comments (NS-52): the JS cases from `test/unit/comments-client.test.js`
/// ported with the code, plus agreement with `contracts/logic/comments.json` —
/// the fixture the Android port asserts against too.
struct CommentsTests {
    private static func c(
        _ id: Int, coachId: Int = 2, sessionId: Int = 10, lapId: Int? = nil, distM: Int? = nil,
        createdAt: Int? = nil, author: CommentAuthor = CommentAuthor(id: 2, name: "Sam Lee", picture: nil),
        mine: Bool = false, seen: Bool = false
    ) -> CoachComment {
        CoachComment(
            id: id, coachId: coachId, sessionId: sessionId, lapId: lapId, distM: distM, body: "c\(id)",
            createdAt: createdAt ?? id * 1000, editedAt: nil, author: author, mine: mine, seen: seen
        )
    }

    private static let laps = [
        Comments.CommentLap(id: 101, lapNum: 1, timeMs: 95000), Comments.CommentLap(id: 102, lapNum: 2, timeMs: 94000),
    ]

    private static func coach(_ name: String?, active: Bool) -> EventComments.Coach {
        EventComments.Coach(id: 2, name: name, picture: nil, active: active)
    }

    private static func row(
        _ comment: CoachComment, student: CommentFeed.Student? = nil, track: String? = "VIR",
        session: String? = "Session 2", lapNum: Int? = 6
    ) -> CommentFeed.Row {
        CommentFeed.Row(
            id: comment.id, coachId: comment.coachId, sessionId: comment.sessionId, lapId: comment.lapId,
            distM: comment.distM, body: comment.body, createdAt: comment.createdAt, editedAt: nil,
            author: comment.author, mine: comment.mine, seen: comment.seen, student: student, eventId: 3,
            trackName: track, startDate: "2026-05-01", sessionLabel: session, lapNum: lapNum
        )
    }

    // MARK: - The JS cases

    @Test func theLimitIsCountedTheServersWay() {
        #expect(Comments.COMMENT_MAX_CHARS == 1000)
        #expect(Comments.commentLength("  🏁🏁\r\n ok ") == 6)
        #expect(Comments.commentLength(nil) == 0)
    }

    @Test func commentThreadsSplitsByCoachInTheOrderEachFirstSpoke() {
        let out = Comments.commentThreads([Self.c(1, coachId: 7), Self.c(2), Self.c(3, coachId: 7)])
        #expect(out.map(\.coachId) == [7, 2])
        #expect(out.map { $0.comments.map(\.id) } == [[1, 3], [2]])
        #expect(Comments.commentThreads(nil).isEmpty)
    }

    @Test func groupCommentsPutsTheSessionsFirstThenLapsByPlaceThenTime() {
        let list = [
            Self.c(1, lapId: 102), Self.c(2, lapId: 102, distM: 900), Self.c(3), Self.c(4, lapId: 101),
            Self.c(5, lapId: 102, distM: 300), Self.c(6, sessionId: 11), Self.c(7, lapId: 999),
        ]
        let out = Comments.groupComments(list, sessionId: 10, laps: Self.laps)
        #expect(out.session.map(\.id) == [3])
        #expect(out.laps.map(\.lapNum) == [1, 2])
        #expect(out.laps.map { $0.comments.map(\.id) } == [[4], [5, 2, 1]])
    }

    @Test func commentCountsNeverCountsYourOwnAsUnread() {
        let out = Comments.commentCounts([
            Self.c(1), Self.c(2, lapId: 101, seen: true), Self.c(3, lapId: 101), Self.c(4, lapId: 101, mine: true),
        ])
        #expect(out.bySession[10] == .init(count: 4, unread: 2))
        #expect(out.byLap[101] == .init(count: 3, unread: 1))
        #expect(Comments.commentCountText(out.byLap[101]) == "3 comments, 1 unread")
        #expect(Comments.commentCountText(.init(count: 1, unread: 0)) == "1 comment")
        #expect(Comments.commentCountText(nil) == "")
    }

    @Test func placesSayTheCornerAndTheDistance() {
        let corners = [
            Corners.Corner(n: 1, k0: 10, k1: 20, peakG: 0, peakK: 0),
            Corners.Corner(n: 2, k0: 55, k1: 70, peakG: 0, peakK: 0),
        ]
        #expect(Comments.commentPlace(1240, 20, corners, .metric) == "in T2 · 1.2 km")
        #expect(Comments.commentPlace(600, 20, corners, .metric) == "after T1 · 600 m")
        #expect(Comments.commentPlace(600, 20, [], .metric) == "600 m")
        #expect(Comments.commentPlace(nil, 20, corners, .metric) == nil)
        #expect(Comments.placeFromCursor(62.04, 20) == 1241)
        #expect(Comments.placeFromCursor(-1, 20) == 0)
        #expect(Comments.placeFromCursor(.nan, 20) == nil)
        #expect(Comments.placeFromCursor(3, 0) == nil)
    }

    @Test func markersAreALapsPlacedCommentsClampedToTheLap() {
        let list = [
            Self.c(1, lapId: 101, distM: 2000, mine: true), Self.c(2, lapId: 101, distM: 500), Self.c(3, lapId: 101),
            Self.c(4, lapId: 102, distM: 5),
        ]
        #expect(Comments.commentMarkers(list, 101, 1000) == [
            .init(id: 2, frac: 0.5, mine: false), .init(id: 1, frac: 1, mine: true),
        ])
        #expect(Comments.commentMarkers(list, 101, 0).isEmpty)
    }

    @Test func theWords() {
        #expect(Comments.threadTitle(Self.coach("Sam Lee", active: true), true) == "Sam Lee")
        #expect(Comments.threadTitle(Self.coach("Sam Lee", active: false), true) == "Sam Lee · no longer your coach")
        #expect(Comments.threadTitle(nil, true) == "Your coach")
        #expect(Comments.threadTitle(Self.coach("Sam Lee", active: true), false) == "Your comments")
        #expect(Comments.canReply(Self.coach(nil, active: true)))
        #expect(!Comments.canReply(Self.coach(nil, active: false)))
        #expect(!Comments.canReply(nil))

        #expect(Comments.commentError(nil, nil) == "Commenting needs a connection.")
        #expect(Comments.commentError(429, nil).contains("minute"))
        #expect(Comments.commentError(409, nil).contains("as many comments"))
        #expect(Comments.commentError(404, nil).contains("any more"))
        #expect(Comments.commentError(400, "a comment can't be empty") == "a comment can't be empty")
        #expect(Comments.commentError(APIError.transport("gone")) == "Commenting needs a connection.")
        #expect(Comments.commentError(APIError.server(status: 429, message: "x")).contains("minute"))

        let now = 10 * 24 * 3600 * 1000
        #expect(Comments.commentWhen(now - 5000, now) == "just now")
        #expect(Comments.commentWhen(now - 5 * 60000, now) == "5 min ago")
        #expect(Comments.commentWhen(now - 3_600_000, now) == "1 hour ago")
        #expect(Comments.commentWhen(now - 3 * 86_400_000, now) == "3 days ago")
        #expect(Comments.commentWhen(now - 8 * 86_400_000, now) == nil)
    }

    @Test func theFeedsWords() {
        let mine = Self.row(Self.c(1))
        let alex = CommentAuthor(id: 9, name: "Alex R.", picture: nil)
        let theirs = Self.row(Self.c(2, author: alex), student: .init(id: 9, name: "Alex R."), lapNum: nil)
        #expect(Comments.feedLine(mine) == "Sam Lee commented on Lap 6 · VIR")
        #expect(Comments.feedLine(theirs) == "Alex R. replied on Session 2 · VIR")
        var seen = mine
        seen.seen = true
        #expect(Comments.unreadLine(CommentFeed(unread: 0, comments: [seen])) == nil)
        #expect(Comments.unreadLine(CommentFeed(unread: 1, comments: [mine])) == "Sam Lee commented on Lap 6 · VIR")
        var five = mine
        five.id = 5
        #expect(Comments.unreadLine(CommentFeed(unread: 2, comments: [mine, five])) == "2 new comments from Sam Lee")
        #expect(Comments.unreadLine(CommentFeed(unread: 2, comments: [mine, theirs])) == "2 new comments from 2 people")
        // More unread than the feed's page holds.
        #expect(Comments.unreadLine(CommentFeed(unread: 60, comments: [mine])) == "60 new comments from Sam Lee")
    }

    @Test func reportOpensAMailWithTheCommentsId() throws {
        let url = try #require(Comments.reportURL(42))
        #expect(url.scheme == "mailto")
        let parts = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(parts.path == "eric@speedshift.io")
        #expect(parts.queryItems?.first { $0.name == "subject" }?.value == "Report a comment (#42)")
        #expect(parts.queryItems?.first { $0.name == "body" }?.value?.contains("comment #42") == true)
    }

    // MARK: - The fixture

    private static func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/comments.json"))
        let object = try JSONSerialization.jsonObject(with: data)
        return try #require(object as? [String: Any])
    }

    /// Each row of a section: its argument list and what the JS answered.
    private static func rows(_ name: String) throws -> [(args: [Any], expected: Any)] {
        let all = try fixture()
        let list = try #require(all[name] as? [[String: Any]], "section \(name)")
        return try list.map { row in
            (try #require(row["args"] as? [Any]), row["expected"] ?? NSNull())
        }
    }

    /// One JSON value decoded as `T`, through the same decoder the API uses.
    private static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func string(_ value: Any) -> String? { value as? String }
    private static func int(_ value: Any) -> Int? { (value as? NSNumber).map(\.intValue) }
    private static func double(_ value: Any) -> Double? { (value as? NSNumber).map(\.doubleValue) }

    private struct FixtureCorner: Decodable {
        var n: Int, k0: Int, k1: Int
    }

    private struct FixtureSession: Decodable {
        var id: Int
        var laps: [FixtureLap]
        struct FixtureLap: Decodable {
            var id: Int
            var lap_num: Int
            var time_ms: Int
        }
    }

    private struct ExpectedThread: Decodable, Equatable {
        var coach_id: Int
        var comments: [CoachComment]
    }

    private struct ExpectedGrouped: Decodable, Equatable {
        var session: [CoachComment]
        var laps: [Lap]
        struct Lap: Decodable, Equatable {
            var lap_id: Int, lap_num: Int, time_ms: Int
            var comments: [CoachComment]
        }
    }

    private struct ExpectedCounts: Decodable {
        var bySession: [String: Comments.Count]
        var byLap: [String: Comments.Count]
    }

    private struct ExpectedMarker: Decodable, Equatable {
        var id: Int, frac: Double, mine: Bool
    }

    /// A coach as the fixture writes one: no id, sometimes no name.
    private struct FixtureCoach: Decodable {
        var name: String?
        var active: Bool
        var coach: EventComments.Coach { .init(id: 0, name: name, picture: nil, active: active) }
    }

    @Test func constantsMatchTheFixture() throws {
        let all = try Self.fixture()
        let k = try #require(all["constants"] as? [String: Any])
        #expect(Self.int(k["COMMENT_MAX_CHARS"]!) == Comments.COMMENT_MAX_CHARS)
        #expect(k["COMMENTS_HEADING"] as? String == Comments.COMMENTS_HEADING)
        #expect(k["COMMENT_PLACEHOLDER"] as? String == Comments.COMMENT_PLACEHOLDER)
        #expect(k["REPLY_PLACEHOLDER"] as? String == Comments.REPLY_PLACEHOLDER)
        #expect(k["WHOLE_SESSION"] as? String == Comments.WHOLE_SESSION)
        #expect(k["COMMENT_OFFLINE"] as? String == Comments.COMMENT_OFFLINE)
        #expect(k["THREAD_CLOSED"] as? String == Comments.THREAD_CLOSED)
        #expect(k["REPORT_LABEL"] as? String == Comments.REPORT_LABEL)
        #expect(k["REPORT_EMAIL"] as? String == Comments.REPORT_EMAIL)
    }

    @Test func commentLengthMatchesTheFixture() throws {
        for row in try Self.rows("commentLength") {
            #expect(Comments.commentLength(Self.string(row.args[0])) == Self.int(row.expected), "\(row.args)")
        }
    }

    @Test func commentThreadsMatchesTheFixture() throws {
        for row in try Self.rows("commentThreads") {
            let comments = try Self.decode([CoachComment].self, row.args[0])
            let expected = try Self.decode([ExpectedThread].self, row.expected)
            let got = Comments.commentThreads(comments).map { ExpectedThread(coach_id: $0.coachId, comments: $0.comments) }
            #expect(got == expected)
        }
    }

    @Test func groupCommentsMatchesTheFixture() throws {
        let rows = try Self.rows("groupComments")
        #expect(rows.count == 3)
        for row in rows {
            let comments = try Self.decode([CoachComment].self, row.args[0])
            let session = try Self.decode(FixtureSession.self, row.args[1])
            let expected = try Self.decode(ExpectedGrouped.self, row.expected)
            let got = Comments.groupComments(
                comments, sessionId: session.id,
                laps: session.laps.map { .init(id: $0.id, lapNum: $0.lap_num, timeMs: $0.time_ms) }
            )
            #expect(got.session == expected.session)
            #expect(got.laps.map { ExpectedGrouped.Lap(lap_id: $0.lapId, lap_num: $0.lapNum, time_ms: $0.timeMs, comments: $0.comments) }
                == expected.laps)
        }
    }

    @Test func commentCountsMatchesTheFixture() throws {
        for row in try Self.rows("commentCounts") {
            let got = Comments.commentCounts(try Self.decode([CoachComment].self, row.args[0]))
            let expected = try Self.decode(ExpectedCounts.self, row.expected)
            #expect(Dictionary(uniqueKeysWithValues: got.bySession.map { ("\($0.key)", $0.value) }) == expected.bySession)
            #expect(Dictionary(uniqueKeysWithValues: got.byLap.map { ("\($0.key)", $0.value) }) == expected.byLap)
        }
    }

    @Test func commentCountTextMatchesTheFixture() throws {
        for row in try Self.rows("commentCountText") {
            let count = row.args[0] is NSNull ? nil : try Self.decode(Comments.Count.self, row.args[0])
            #expect(Comments.commentCountText(count) == Self.string(row.expected), "\(row.args)")
        }
    }

    @Test func commentPlaceMatchesTheFixture() throws {
        let rows = try Self.rows("commentPlace")
        #expect(rows.count == 8)
        for row in rows {
            let corners = try Self.decode([FixtureCorner].self, row.args[2])
                .map { Corners.Corner(n: $0.n, k0: $0.k0, k1: $0.k1, peakG: 0, peakK: 0) }
            let units = try #require(UnitSystem(rawValue: Self.string(row.args[3]) ?? ""))
            let got = Comments.commentPlace(Self.double(row.args[0]), Self.double(row.args[1]), corners, units)
            #expect(got == Self.string(row.expected), "\(row.args)")
        }
    }

    @Test func placeFromCursorMatchesTheFixture() throws {
        for row in try Self.rows("placeFromCursor") {
            let got = Comments.placeFromCursor(Self.double(row.args[0]), Self.double(row.args[1]))
            #expect(got == Self.int(row.expected), "\(row.args)")
        }
    }

    @Test func commentMarkersMatchesTheFixture() throws {
        for row in try Self.rows("commentMarkers") {
            let comments = try Self.decode([CoachComment].self, row.args[0])
            let got = Comments.commentMarkers(comments, Self.int(row.args[1]) ?? -1, Self.double(row.args[2]))
                .map { ExpectedMarker(id: $0.id, frac: $0.frac, mine: $0.mine) }
            #expect(got == (try Self.decode([ExpectedMarker].self, row.expected)), "\(row.args[1...])")
        }
    }

    @Test func canReplyAndThreadTitleMatchTheFixture() throws {
        for row in try Self.rows("canReply") {
            let coach = row.args[0] is NSNull ? nil : try Self.decode(FixtureCoach.self, row.args[0]).coach
            #expect(Comments.canReply(coach) == (row.expected as? Bool))
        }
        for row in try Self.rows("threadTitle") {
            let coach = row.args[0] is NSNull ? nil : try Self.decode(FixtureCoach.self, row.args[0]).coach
            #expect(Comments.threadTitle(coach, row.args[1] as? Bool ?? false) == Self.string(row.expected))
        }
    }

    @Test func theFixedSentencesMatchTheFixture() throws {
        for row in try Self.rows("coachAudienceNote") {
            #expect(Comments.coachAudienceNote(Self.string(row.args[0])) == Self.string(row.expected))
        }
        for row in try Self.rows("reportSubject") {
            #expect(Comments.reportSubject(Self.int(row.args[0]) ?? 0) == Self.string(row.expected))
        }
        for row in try Self.rows("reportBody") {
            #expect(Comments.reportBody(Self.int(row.args[0]) ?? 0) == Self.string(row.expected))
        }
        for row in try Self.rows("commentError") {
            #expect(Comments.commentError(Self.int(row.args[0]), Self.string(row.args[1])) == Self.string(row.expected))
        }
        for row in try Self.rows("commentWhen") {
            let got = Comments.commentWhen(Self.int(row.args[0]) ?? 0, Self.int(row.args[1]) ?? 0)
            #expect(got == Self.string(row.expected), "\(row.args)")
        }
    }

    @Test func theFeedMatchesTheFixture() throws {
        for row in try Self.rows("feedLine") {
            #expect(Comments.feedLine(try Self.decode(CommentFeed.Row.self, row.args[0])) == Self.string(row.expected))
        }
        let rows = try Self.rows("unreadLine")
        #expect(rows.count == 7)
        for row in rows {
            let feed = row.args[0] is NSNull ? nil : try Self.decode(CommentFeed.self, row.args[0])
            #expect(Comments.unreadLine(feed) == Self.string(row.expected), "\(row.args)")
        }
    }
}

/// The comment routes on the API client: where each goes for each owner, that a
/// scoped (student) client hands them to the coach's own routes instead of
/// refusing them, and that none of them is ever queued.
struct CommentsAPITests {
    private struct Offline: Error {}

    private func client(
        offline: OfflineStore? = nil,
        respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://example.test")!,
            tokens: StaticToken("tok"),
            session: StubProtocol.session(respond),
            offline: offline
        )
    }

    private func json(_ data: Data?) throws -> [String: Any] {
        let bytes = try #require(data)
        let object = try JSONSerialization.jsonObject(with: bytes)
        return try #require(object as? [String: Any])
    }

    @Test func theOwnerReadsAndRepliesOnTheirOwnRoutes() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            if request.httpMethod == "GET" { return (200, try Goldens.body("comments-event")) }
            return (201, try Goldens.body("comment-create"))
        }
        let thread = try await api.eventComments(eventId: 3, owner: .me)
        #expect(seen.last?.url?.path == "/api/events/3/comments")
        #expect(thread.coaches != nil)

        _ = try await api.postComment(sessionId: 9, owner: .me, coachId: 4, body: "Thanks", lapId: 12, distM: 300)
        #expect(seen.last?.url?.path == "/api/sessions/9/comments")
        let body = try json(seen.lastBody)
        #expect(body["coach_id"] as? Int == 4)
        #expect(body["lap_id"] as? Int == 12)
        #expect(body["dist_m"] as? Int == 300)
        #expect(body["body"] as? String == "Thanks")
    }

    @Test func aCoachWritesThroughTheirOwnRoutesEvenFromAStudentsScopedClient() async throws {
        let seen = Recorder()
        let student = LogbookOwner.student(id: 7, name: "Alex", pro: false)
        let api = client { request in
            seen.record(request)
            if request.httpMethod == "GET" { return (200, try Goldens.body("comments-student-event")) }
            if request.url?.path.hasSuffix("/seen") == true { return (200, try Goldens.body("comments-seen-coach")) }
            return (201, try Goldens.body("comment-create-coach"))
        }.scoped(to: student)

        _ = try await api.eventComments(eventId: 3, owner: student)
        #expect(seen.last?.url?.path == "/api/coaching/students/7/events/3/comments")

        // The scoped client refuses every other write — but not this one.
        _ = try await api.postComment(sessionId: 9, owner: student, coachId: 99, body: "Brake later", lapId: nil, distM: 40)
        #expect(seen.last?.url?.path == "/api/coaching/students/7/sessions/9/comments")
        let body = try json(seen.lastBody)
        #expect(body["coach_id"] == nil, "the coach is the caller, never the body")
        #expect(body["dist_m"] == nil, "a place belongs to a lap")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")

        _ = try await api.markCommentsSeen(eventId: 3, owner: student)
        #expect(seen.last?.url?.path == "/api/coaching/students/7/events/3/comments/seen")
    }

    @Test func editAndDeleteGoToTheRowAndTheFeedIsOneRead() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            switch request.httpMethod {
            case "PUT": return (200, try Goldens.body("comment-update"))
            case "DELETE": return (200, Data(#"{"ok":true}"#.utf8))
            default: return (200, try Goldens.body("comments-feed"))
            }
        }.scoped(toStudent: 7)
        _ = try await api.updateComment(id: 5, body: "edited")
        #expect(seen.last?.httpMethod == "PUT")
        #expect(seen.last?.url?.path == "/api/comments/5")
        try await api.deleteComment(id: 5)
        #expect(seen.last?.url?.path == "/api/comments/5")
        let feed = try await api.commentFeed()
        #expect(seen.last?.url?.path == "/api/coaching/comments")
        #expect(feed.comments.count >= 1)
    }

    @Test func aCommentWrittenOfflineIsRefusedNotQueued() async throws {
        let store = try OfflineStore()
        // Even with the owner's own writes waiting, a comment never joins them.
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))
        _ = try await store.enqueue(
            method: "POST", path: "/events",
            body: try JSONSerialization.data(withJSONObject: ["start_date": "2026-05-01", "track_name": "VIR"])
        )
        let api = client(offline: store) { _ in throw Offline() }
        do {
            _ = try await api.postComment(sessionId: 9, owner: .me, coachId: 4, body: "hi", lapId: nil, distM: nil)
            Issue.record("a comment can't be sent offline")
        } catch {
            #expect(Comments.commentError(error) == Comments.COMMENT_OFFLINE)
        }
        #expect(try await store.pendingCount() == 1)
    }

    @Test func forgettingAStudentAlsoDropsTheCoachsThreadOnThem() async throws {
        let store = try OfflineStore()
        let body = Data("{}".utf8)
        try await store.cachePut("/events/3/comments", body: body)
        try await store.cachePut("/coaching/students/7/events/3/comments", body: body)
        try await store.cachePut("/coaching/students/70/events/3/comments", body: body)
        try await store.cachePut("/students/7/events", body: body)
        let api = client(offline: store) { _ in throw Offline() }
        await api.forgetStudent(7)
        #expect(try await store.cachedKeys() == ["/coaching/students/70/events/3/comments", "/events/3/comments"])
    }
}
