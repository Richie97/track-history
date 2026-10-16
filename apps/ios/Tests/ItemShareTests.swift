import TrackEvolutionKit
import XCTest

@testable import TrackEvolution

/// Sharing one event or one session (NS-48), the app-side decisions: where a
/// link lands, what the sheet promises, and what the page it opens says. The
/// Kit's `ItemShareAPITests` and `DeepLinkTests` pin the routes and the parse.
@MainActor
final class ItemShareTests: XCTestCase {
    private let token = "AAAAAAAAAAAAAAAAAAAAAA"

    /// Opened signed out, the link waits for the sign-in like any other —
    /// the way a shared logbook does — and opens the shared item after it.
    func testALinkOpenedSignedOutIsParkedUntilSignIn() {
        let router = AppRouter()
        let url = URL(string: "https://trackevolution.app/share/e/\(token)")!
        XCTAssertTrue(router.open(url, signedIn: false))
        XCTAssertEqual(router.path, [])

        router.applyPending()
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.path, [.sharedItem(kind: .event, token: token)])
    }

    func testALinkOpenedSignedInReplacesWhereverYouWere() {
        let router = AppRouter()
        router.show(.vehicle(3))
        XCTAssertTrue(router.open(URL(string: "https://trackevolution.app/share/s/\(token)")!, signedIn: true))
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.path, [.sharedItem(kind: .session, token: token)])
    }

    /// A pane like any page — never a cover — and nothing a student's logbook
    /// can link into.
    func testTheSharedItemIsAnOrdinaryPage() {
        let route = Route.sharedItem(kind: .event, token: token)
        XCTAssertFalse(route.ownsTheWindow)
        XCTAssertEqual(route.tab, .events)
        XCTAssertEqual(route.resolved(runsOnMac: true), route)
        XCTAssertEqual(
            LogbookOwner.student(id: 7, name: "Alex", pro: true).link(route),
            .student(id: 7, page: .home)
        )
    }

    func testTheSheetPromisesWhatTheLinkShowsAndKeepsPrivate() {
        XCTAssertEqual(
            ItemShareText.explanation(.session),
            "Anyone with this link can see this session — its laps, racing line, telemetry and video. "
                + "Notes, costs and setup sheets stay private."
        )
        XCTAssertTrue(ItemShareText.explanation(.event).hasPrefix("Anyone with this link can see this track day — "))
    }

    /// Offline is the transport's failure, said in the sheet's own words; a
    /// server refusal keeps the server's.
    func testFailuresAreWorded() {
        XCTAssertEqual(ItemShareText.words(for: APIError.transport("The Internet connection appears to be offline.")),
                       "Sharing needs a connection.")
        XCTAssertEqual(ItemShareText.words(for: APIError.server(status: 404, message: "not found")), "not found")
    }

    func testThePageNamesItsOwnerAndNeverOffersAnUpsell() {
        XCTAssertEqual(ItemShareText.byline(.event, name: "Dev User"), "A track day shared by Dev User — read-only.")
        XCTAssertEqual(ItemShareText.byline(.session, name: nil), "A session shared by A driver — read-only.")
        XCTAssertTrue(ItemShareText.freeNote(name: "Dev User").hasPrefix("Dev User is on the free plan"))
        XCTAssertFalse(ItemShareText.freeNote(name: nil).localizedCaseInsensitiveContains("pro"))
    }

    /// A session link's header is that session's, and a session has no days.
    func testASessionLinkHasNoDaysTile() throws {
        let item = try golden("shared-session")
        XCTAssertEqual(SharedItemScreen.tiles(item).map(\.label), ["Best time", "Laps recorded", "Consistency"])
        let event = try golden("shared-event")
        XCTAssertEqual(SharedItemScreen.tiles(event).map(\.label), ["Best time", "Days", "Laps recorded", "Consistency"])
    }

    /// The captured server response — `contracts/golden/`, read from the repo
    /// the way the Kit's golden tests read it.
    private func golden(_ name: String) throws -> SharedItem {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: dir.appending(path: "contracts/golden").path) {
            let parent = dir.deletingLastPathComponent()
            guard parent != dir else { throw XCTSkip("contracts/golden not found from \(#filePath)") }
            dir = parent
        }
        let data = try Data(contentsOf: dir.appending(path: "contracts/golden/\(name).json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let body = try JSONSerialization.data(withJSONObject: try XCTUnwrap(object["body"]))
        return try JSONDecoder().decode(SharedItem.self, from: body)
    }
}
