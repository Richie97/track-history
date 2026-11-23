import TrackEvolutionKit
import XCTest

@testable import TrackEvolution

/// Sharing one event or one session (NS-48) — and one lap, or two laps compared
/// (NS-56) — the app-side decisions: where a
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

    // MARK: - One lap, and two laps compared (NS-56)

    func testALapOrComparisonLinkOpensTheSharedItem() {
        for (letter, kind) in [("l", ItemShareKind.lap), ("c", ItemShareKind.compare)] {
            let router = AppRouter()
            router.show(.vehicle(3))
            XCTAssertTrue(router.open(URL(string: "https://trackevolution.app/share/\(letter)/\(token)")!, signedIn: true))
            XCTAssertEqual(router.tab, .events)
            XCTAssertEqual(router.path, [.sharedItem(kind: kind, token: token)])
            XCTAssertFalse(Route.sharedItem(kind: kind, token: token).ownsTheWindow)
        }
    }

    /// NS-56's words, the same on all three clients.
    func testTheLapAndComparisonSheetsSayTheSpecsWords() {
        XCTAssertEqual(
            ItemShareText.explanation(.lap),
            "Anyone with this link can see this lap — its time, racing line, telemetry and video. "
                + "The rest of the session, notes, costs and setup sheets stay private."
        )
        XCTAssertEqual(
            ItemShareText.explanation(.compare),
            "Anyone with this link can see these two laps compared — their times, telemetry and video. "
                + "Nothing else in your logbook is shared."
        )
        XCTAssertEqual(ItemShareText.byline(.lap, name: "Dev User"), "A lap shared by Dev User.")
        XCTAssertEqual(ItemShareText.byline(.compare, name: "Dev User"), "Two laps compared, shared by Dev User.")
        XCTAssertEqual(ItemShareText.byline(.compare, name: ""), "Two laps compared, shared by A driver.")
        XCTAssertEqual(
            ItemShareText.compareFreeNote(name: "Dev User"),
            "Dev User is on the free plan, so this link shows the two lap times. "
                + "The comparison shows while they have Pro."
        )
    }

    /// A lap link's header is the lap's own: one time, no count of one.
    func testALapLinkHasOneTile() throws {
        XCTAssertEqual(SharedItemScreen.tiles(try golden("shared-lap")).map(\.label), ["Lap time"])
    }

    /// The lap page shares its lap — never for a coach, never before it has
    /// synced, never a lap the event doesn't hold.
    func testTheLapPageSharesItsLap() throws {
        let item = try golden("shared-lap")
        let sessionId = try XCTUnwrap(item.sessionId)
        let lapId = try XCTUnwrap(item.lapId)
        XCTAssertEqual(
            LapDetailScreen.shareTarget(item.event, sessionId: sessionId, lapId: lapId, readOnly: false),
            .lap(lapId)
        )
        XCTAssertNil(LapDetailScreen.shareTarget(item.event, sessionId: sessionId, lapId: lapId, readOnly: true))
        XCTAssertNil(LapDetailScreen.shareTarget(item.event, sessionId: sessionId, lapId: -4, readOnly: false))
        XCTAssertNil(LapDetailScreen.shareTarget(item.event, sessionId: sessionId, lapId: lapId + 999, readOnly: false))
    }

    /// The session compare shares the first two lit laps, the first lit as A.
    func testTheSessionCompareSharesTheFirstTwoLitLaps() throws {
        func entry(_ n: Int, _ timeMs: Int) -> LapChannels {
            LapChannels(n: n, timeMs: timeMs, speed: [100, 120, 110])
        }
        func session(_ ids: [Int]) throws -> Session {
            let laps = ids.enumerated().map { index, id in
                #"{"id":\#(id),"session_id":9,"lap_num":\#(index + 1),"time_ms":\#(90_000 + index * 1_000)}"#
            }
            let json = #"{"id":9,"sort":0,"laps":[\#(laps.joined(separator: ","))]}"#
            return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        }
        let channels = SessionChannels(
            v: 1, dStepM: 20, laps: [entry(1, 90_000), entry(2, 91_000), entry(3, 92_000)]
        )
        let synced = try session([11, 12, 13])
        XCTAssertNil(SessionCompareScreen.shareTarget(session: synced, channels: channels, lit: [2]))
        XCTAssertEqual(
            SessionCompareScreen.shareTarget(session: synced, channels: channels, lit: [2, 0]),
            .compare(a: 13, b: 11)
        )
        XCTAssertEqual(
            SessionCompareScreen.shareTarget(session: synced, channels: channels, lit: [1, 2, 0]),
            .compare(a: 12, b: 13)
        )
        // A lap still waiting on its sync has no id the server knows.
        XCTAssertNil(
            SessionCompareScreen.shareTarget(session: try session([11, -2, 13]), channels: channels, lit: [0, 1])
        )
    }

    /// A comparison of laps with no telemetry — or a free owner's — has no pair
    /// to draw: the page shows the two times and a sentence.
    func testASharedComparisonWithoutTelemetryHasNoPair() throws {
        var shared = try goldenBody("shared-compare", as: SharedCompare.self)
        XCTAssertEqual(shared.kind, .compare)
        XCTAssertNil(SharedCompareScreen.pair(shared))
        XCTAssertEqual(SharedCompareScreen.faster(shared), .B)
        XCTAssertTrue(SharedCompareScreen.sideLabel(shared.a).hasSuffix("Lap 1"))
        XCTAssertTrue(SharedCompareScreen.sideLabel(shared.b).hasSuffix("Lap 2"))
        shared.pro = false
        XCTAssertNil(SharedCompareScreen.pair(shared))
    }

    /// The captured server response — `contracts/golden/`, read from the repo
    /// the way the Kit's golden tests read it.
    private func golden(_ name: String) throws -> SharedItem {
        try goldenBody(name, as: SharedItem.self)
    }

    private func goldenBody<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: dir.appending(path: "contracts/golden").path) {
            let parent = dir.deletingLastPathComponent()
            guard parent != dir else { throw XCTSkip("contracts/golden not found from \(#filePath)") }
            dir = parent
        }
        let data = try Data(contentsOf: dir.appending(path: "contracts/golden/\(name).json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let body = try JSONSerialization.data(withJSONObject: try XCTUnwrap(object["body"]))
        return try JSONDecoder().decode(type, from: body)
    }
}
