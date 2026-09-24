import Foundation
import TrackEvolutionKit
import XCTest

@testable import TrackEvolution

/// The event form's draft outliving the shell swap across 840pt (epic #277,
/// ticket 1).
///
/// The swap itself is layout, and `TwoPaneUITests` rotates an iPad mini across
/// it; what is pinned here is the rule under that — that a draft round-trips
/// through the model, restores only into its own form, is dropped once its route
/// has gone, and that a load finishing after a restore cannot overwrite it
/// (Android's `hydrated` flag).
@MainActor
final class EventFormDraftTests: XCTestCase {

    private func typed(_ target: EventFormTarget) -> EventFormDraft {
        var draft = EventFormDraft(target: target)
        draft.trackName = "Virginia International Raceway (Patriot)"
        draft.startDate = Date(timeIntervalSince1970: 1_790_000_000)
        draft.days = 1.5
        draft.trackHours = "3.5"
        draft.club = "VIR Club"
        draft.runGroup = "High Speed"
        draft.car = "Z06"
        draft.conditions = .damp
        draft.temp = "71"
        draft.bestTime = "2:01.24"
        draft.notes = "Wind from the south"
        draft.sessionLabel = "Day 1 — Session 2"
        draft.sessionLaps = "2:03.55, 2:01.24"
        draft.sessionNotes = "Traffic in T1"
        draft.stagedSessions = [SessionDraft(label: "Imported", laps: [121_240, 122_000])]
        draft.createdId = 41
        return draft
    }

    // MARK: - Round trip

    /// Every field the form edits goes into the draft and comes back out — the
    /// staged sessions and the retry's created id included, since losing either
    /// loses laps or makes a second event.
    func testEveryFieldRoundTripsThroughTheModel() {
        let draft = typed(.new(presetTrack: nil))
        let model = EventFormModel(api: APIClient(), target: draft.target, units: .imperial, restoring: draft)
        XCTAssertEqual(model.draft, draft)
        XCTAssertTrue(model.hydrated)
        XCTAssertEqual(model.submitTitle, "Add the laps", "the restored created id still means retry, not create")
    }

    func testAFormOpenedWithoutADraftIsNotHydrated() {
        let model = EventFormModel(api: APIClient(), target: .new(presetTrack: nil), units: .imperial)
        XCTAssertFalse(model.hydrated)
        XCTAssertNil(model.heldDraft, "nothing is held before the form is ready")
    }

    // MARK: - Which form

    func testADraftRestoresOnlyIntoItsOwnForm() {
        let edit = typed(.edit(7))
        XCTAssertEqual(EventFormDraft.restorable(edit, for: .edit(7)), edit)
        XCTAssertNil(EventFormDraft.restorable(edit, for: .edit(8)), "another event's edit")
        XCTAssertNil(EventFormDraft.restorable(edit, for: .new(presetTrack: nil)), "a new event")
        XCTAssertNil(EventFormDraft.restorable(nil, for: .edit(7)))

        let new = typed(.new(presetTrack: "Summit Point"))
        XCTAssertNil(
            EventFormDraft.restorable(new, for: .new(presetTrack: nil)),
            "the track page's preset form is a different form from the dashboard's"
        )
        // The model refuses a mismatched draft too, whoever hands it one.
        let model = EventFormModel(api: APIClient(), target: .edit(8), units: .imperial, restoring: edit)
        XCTAssertFalse(model.hydrated)
    }

    // MARK: - Discard

    /// The shell swap leaves the path alone, so the draft stays; leaving the
    /// form removes its route, so the draft goes with it.
    func testTheRouterHoldsTheDraftUntilItsRouteLeaves() {
        let router = AppRouter(runsOnMac: false)
        router.show(.event(3))
        router.push(.eventForm(.edit(3)))
        router.eventFormDraft = typed(.edit(3))

        router.push(.importVideo(eventId: nil, incoming: nil))
        XCTAssertNotNil(router.eventFormDraft, "a push on top of the form keeps it")
        router.path.removeLast()
        XCTAssertNotNil(router.eventFormDraft)

        router.tab = .garage
        XCTAssertNotNil(router.eventFormDraft, "switching tab keeps the other tab's stack")
        router.tab = .events

        router.path.removeLast()
        XCTAssertNil(router.eventFormDraft, "back out of the form is a discard")
    }

    func testSavingOverTheFormDropsTheDraft() {
        let router = AppRouter(runsOnMac: false)
        router.push(.eventForm(.new(presetTrack: nil)))
        router.eventFormDraft = typed(.new(presetTrack: nil))
        router.path = [.event(9)]
        XCTAssertNil(router.eventFormDraft)
    }

    /// An edit form parked on an offline-created event follows the flush, and
    /// its draft follows with it rather than being orphaned by the rewrite.
    func testATempIdFlushCarriesTheDraftWithTheRoute() {
        let router = AppRouter(runsOnMac: false)
        router.show(.event(-2))
        router.push(.eventForm(.edit(-2)))
        router.eventFormDraft = typed(.edit(-2))

        router.remapTempIds { $0 == -2 ? 55 : nil }

        XCTAssertEqual(router.path, [.event(55), .eventForm(.edit(55))])
        XCTAssertEqual(router.eventFormDraft?.target, .edit(55))
        XCTAssertEqual(router.eventFormDraft?.trackName, "Virginia International Raceway (Patriot)")
    }

    // MARK: - Hydrated

    /// A new form restored from a draft keeps the typed track and car when its
    /// load lands, rather than taking the preset track and the default car.
    func testALoadAfterARestoreDoesNotOverwriteANewForm() async {
        var draft = typed(.new(presetTrack: "Summit Point"))
        draft.car = "Miata"
        let api = APIClient(baseURL: URL(string: "https://example.test")!, session: FormStub.session())
        let model = EventFormModel(api: api, target: draft.target, units: .imperial, restoring: draft)

        await model.load()

        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(model.trackName, "Virginia International Raceway (Patriot)")
        XCTAssertEqual(model.car, "Miata", "not the garage's default car")
        XCTAssertEqual(model.carOptions, ["Z06"], "the suggestion lists still load")
    }

    /// A restored edit form never asks for the event: the stub fails that read,
    /// so a load that made it would not reach `.ready`.
    func testARestoredEditFormDoesNotRefetchTheEvent() async {
        let draft = typed(.edit(12))
        let api = APIClient(baseURL: URL(string: "https://example.test")!, session: FormStub.session())
        let model = EventFormModel(api: api, target: draft.target, units: .imperial, restoring: draft)

        await model.load()

        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(model.draft, draft)
    }

    /// The control: without a draft the same load does fill the new form.
    func testAnUnrestoredNewFormTakesTheDefaults() async {
        let api = APIClient(baseURL: URL(string: "https://example.test")!, session: FormStub.session())
        let model = EventFormModel(api: api, target: .new(presetTrack: "Summit Point"), units: .imperial)

        await model.load()

        XCTAssertEqual(model.trackName, "Summit Point")
        XCTAssertEqual(model.car, "Z06")
        XCTAssertEqual(model.heldDraft?.trackName, "Summit Point")
    }
}

/// The three suggestion reads the form makes, answered locally; anything else —
/// the event detail above all — is a 500.
private final class FormStub: URLProtocol {
    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FormStub.self]
        return URLSession(configuration: config)
    }

    private static let vehicle = """
        {"id":1,"name":"Z06","notes":null,"is_default":1,"target_hot_psi":null,\
        "wheelbase_mm":null,"steering_ratio":null,"catalog_id":null,\
        "created_at":0,"updated_at":0}
        """

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body): (Int, String) = switch request.url?.path {
        case "/api/tracks", "/api/catalog": (200, "[]")
        case "/api/vehicles": (200, "[\(Self.vehicle)]")
        default: (500, #"{"error":"not stubbed"}"#)
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The short typed fields on other pages, held the same way (`heldFields`).
@MainActor
final class HeldFieldsTests: XCTestCase {
    func testTextIsHeldWhileItsRouteIsOnAStackAndDroppedAfter() {
        let router = AppRouter(runsOnMac: false)
        router.show(.event(4))
        router.hold("2:01.24, 2:02.9", "sessionLaps", .event(4))
        XCTAssertEqual(router.heldText(.event(4), "sessionLaps"), "2:01.24, 2:02.9")

        router.push(.track(2))
        XCTAssertEqual(router.heldText(.event(4), "sessionLaps"), "2:01.24, 2:02.9", "a push keeps the page below")

        router.popToRoot()
        XCTAssertEqual(router.heldText(.event(4), "sessionLaps"), "", "leaving the page drops its typing")
        XCTAssertTrue(router.heldFields.isEmpty)
    }

    func testEmptyTextLetsGoAndAnAbsentRouteHoldsNothing() {
        let router = AppRouter(runsOnMac: false)
        router.show(.event(4))
        router.hold("Traffic", "sessionNotes", .event(4))
        router.hold("", "sessionNotes", .event(4))
        XCTAssertTrue(router.heldFields.isEmpty, "clearing a field releases it")

        router.hold("stray", "sessionNotes", .event(99))
        XCTAssertTrue(router.heldFields.isEmpty, "a page on neither stack would be held forever")
    }

    func testHeldTextFollowsATempIdFlush() {
        let router = AppRouter(runsOnMac: false)
        router.show(.event(-5))
        router.hold("2:03.1", "appendLaps.-7", .event(-5))
        router.remapTempIds { $0 == -5 ? 50 : nil }
        XCTAssertEqual(router.heldText(.event(50), "appendLaps.-7"), "2:03.1")
    }
}
