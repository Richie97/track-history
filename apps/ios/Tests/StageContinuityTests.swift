import SwiftUI
import XCTest
import TrackEvolutionKit

@testable import TrackEvolution

/// The lap stage keeps playing across a resize (NS-51): unfolding an iPhone Duo
/// held sideways, rotating it open, or an iPad mini turning — anything that
/// crosses 840 pt and swaps the shell, rebuilding the page. Three rules make
/// that work, pinned here without a device: the router holds the page's models
/// while its route is on a stack, a stage that disappears pauses only if it
/// doesn't come straight back, and only `.background` pauses.
@MainActor
final class StageContinuityTests: XCTestCase {

    private final class Probe: HeldOnRouter {
        var releases = 0
        func released() { releases += 1 }
    }

    func testTheRouterHoldsAPagesObjectsWhileItsRouteIsOnAStack() {
        let router = AppRouter(runsOnMac: false)
        let lap = Route.lap(eventId: 1, sessionId: 2, lapId: 3)
        router.push(.event(1))
        router.push(lap)

        let first = router.held(lap, "stage") { Probe() }
        let again = router.held(lap, "stage") { Probe() }
        XCTAssertTrue(first === again, "the rebuilt page gets the same object")
        XCTAssertFalse(router.held(lap, "event") { Probe() } === first, "keys are separate")

        // Pushing over the page keeps it held; going back past it releases it.
        router.push(.sessionCompare(eventId: 1, sessionId: 2, lapId: 3))
        XCTAssertEqual(first.releases, 0)
        router.path.removeLast()
        XCTAssertEqual(first.releases, 0, "the lap page is back on top, not gone")
        router.path.removeLast()
        XCTAssertEqual(first.releases, 1, "Back off the lap page stops it for good")
        XCTAssertFalse(router.held(lap, "stage") { Probe() } === first)
    }

    func testARouteOnNoStackGetsAFreshObjectThatIsNotHeld() {
        let router = AppRouter(runsOnMac: false)
        let lap = Route.lap(eventId: 1, sessionId: 2, lapId: 3)
        let one = router.held(lap, "stage") { Probe() }
        let two = router.held(lap, "stage") { Probe() }
        XCTAssertFalse(one === two)
    }

    func testHeldObjectsFollowATempIdToItsRealOne() {
        let router = AppRouter(runsOnMac: false)
        let temp = Route.lap(eventId: -1, sessionId: 2, lapId: 3)
        router.show(.event(-1))
        router.push(temp)
        let held = router.held(temp, "stage") { Probe() }
        router.remapTempIds { [-1: 41][$0] }
        XCTAssertTrue(router.held(.lap(eventId: 41, sessionId: 2, lapId: 3), "stage") { Probe() } === held)
        XCTAssertEqual(held.releases, 0)
    }

    func testOnlyTheBackgroundPauses() {
        XCTAssertTrue(LapStageModel.pausesFor(.background))
        XCTAssertFalse(LapStageModel.pausesFor(.inactive), "a fold or a rotation passes through inactive")
        XCTAssertFalse(LapStageModel.pausesFor(.active))
    }

    /// A stage rebuilt within the grace keeps playing; one that stays gone
    /// pauses. Replay sides, so no player is involved.
    func testAStageThatComesStraightBackKeepsPlaying() async throws {
        let model = LapStageModel(mode: .place, store: nil) { _ in throw CancellationError() }
        let speed = (0..<40).map { _ in 120.0 }
        model.configure(
            [
                StageSideInput(
                    key: .A, entry: LapChannels(n: 1, timeMs: 60_000, speed: speed), dStepM: 20, clip: nil,
                    chIdx: 0, lapNum: 1, timeMs: 60_000, isBest: true
                ),
            ],
            trace: nil, corners: []
        )
        model.viewerAppeared()
        model.play()
        XCTAssertTrue(model.playing)

        // The shell swap: the old stage goes, the new one arrives at once.
        model.viewerDisappeared()
        model.viewerAppeared()
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertTrue(model.playing, "a rebuilt page must not stop the video")

        // A page pushed over it: gone for good, so it pauses after the grace.
        model.viewerDisappeared()
        XCTAssertTrue(model.playing, "not on the spot")
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertFalse(model.playing)

        model.released()
    }
}
