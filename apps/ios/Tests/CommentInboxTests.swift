import TrackEvolutionKit
import XCTest

@testable import TrackEvolution

/// Unread coach comments (NS-52) live in one place, `CommentInbox`, which the
/// dashboard's card, Settings' Coaching row and the Coaching page all read. At
/// expanded width the dashboard stays in the list pane while a thread is read
/// beside it; a feed it fetched for itself went on saying "3 new comments"
/// after they had been read. These pin the inbox's rules with no server.
@MainActor
final class CommentInboxTests: XCTestCase {
    /// A feed of `unread` unread rows, as the server would send it.
    private func feed(unread: Int) throws -> CommentFeed {
        let rows = (0..<unread).map { id in
            """
            {"id":\(id + 1),"coach_id":2,"session_id":10,"lap_id":null,"dist_m":null,"body":"c\(id)",
             "created_at":1000,"edited_at":null,"author":{"id":2,"name":"Sam Lee","picture":null},
             "mine":false,"seen":false,"student":null,"event_id":3,"track_name":"VIR",
             "start_date":"2026-05-01","session_label":"Session 2","lap_num":6}
            """
        }
        let json = #"{"unread":\#(unread),"comments":[\#(rows.joined(separator: ","))]}"#
        return try JSONDecoder().decode(CommentFeed.self, from: Data(json.utf8))
    }

    /// The server's answer, settable between calls.
    private final class Server: @unchecked Sendable {
        var feed: CommentFeed?
        var fails = false
        var reads = 0
    }

    private func inbox(_ server: Server) -> CommentInbox {
        CommentInbox {
            server.reads += 1
            if server.fails { throw APIError.transport("offline") }
            return server.feed!
        }
    }

    func testSeenLowersTheCountAndReadsTheFeedAgainSoTheCardClears() async throws {
        let server = Server()
        server.feed = try feed(unread: 3)
        let inbox = inbox(server)
        await inbox.refresh()
        XCTAssertEqual(inbox.unread, 3)
        XCTAssertEqual(Comments.unreadLine(inbox.feed), "3 new comments from Sam Lee")

        // The thread beside the dashboard is read: the server marks all three.
        server.feed = try feed(unread: 0)
        await inbox.seen(3)
        XCTAssertEqual(inbox.unread, 0)
        XCTAssertEqual(server.reads, 2, "a successful /seen reads the feed again")
        XCTAssertNil(Comments.unreadLine(inbox.feed), "so the dashboard's card has nothing left to say")
    }

    func testSeenLowersTheCountEvenWhenTheFeedCantBeRead() async throws {
        let server = Server()
        server.feed = try feed(unread: 3)
        let inbox = inbox(server)
        await inbox.refresh()
        server.fails = true
        await inbox.seen(2)
        XCTAssertEqual(inbox.unread, 1, "the count drops at once, without the round trip")
        await inbox.seen(5)
        XCTAssertEqual(inbox.unread, 0, "and never below zero")
    }

    func testNothingSeenReadsNothing() async throws {
        let server = Server()
        server.feed = try feed(unread: 1)
        let inbox = inbox(server)
        await inbox.seen(0)
        XCTAssertEqual(server.reads, 0)
    }

    func testTheAccountsCountAndSigningOut() async throws {
        let server = Server()
        server.feed = try feed(unread: 2)
        let inbox = inbox(server)
        inbox.setUnread(4)
        XCTAssertEqual(inbox.unread, 4, "/me's count stands until the feed is read")
        await inbox.refresh()
        XCTAssertEqual(inbox.unread, 2)
        inbox.clear()
        XCTAssertEqual(inbox.unread, 0)
        XCTAssertNil(inbox.feed, "a shared device doesn't keep the last account's comments")
    }
}
