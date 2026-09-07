import XCTest

@testable import TrackEvolution

/// Stepping the highlighted lap from the keyboard (spec: NS-34 ticket 5).
///
/// `[` and `]` are the one panel shortcut with a rule behind them rather than a
/// destination — the tabs just select a tab — so the rule is pure and tested here
/// instead of being tapped through on a simulator with a keyboard attached.
final class LapChannelPanelTests: XCTestCase {
    /// Four laps of a session, all of them carrying channels.
    private let available = [0, 1, 2, 3]

    /// The *newest* slot moves and the rest stay put. That is what makes the key
    /// worth having: pin the laps you are comparing against, scrub a third.
    func testStepsTheNewestLapAndLeavesThePinsAlone() {
        XCTAssertEqual(LapChannelPanel.stepped([2, 0], by: 1, over: available), [2, 1])
        XCTAssertEqual(LapChannelPanel.stepped([2, 0], by: -1, over: available), [2, 3])
    }

    /// A lap already lit is skipped over: two slots showing one lap is a
    /// selection with a hole in it.
    func testSkipsLapsAlreadyLit() {
        XCTAssertEqual(LapChannelPanel.stepped([0, 1], by: -1, over: available), [0, 3])
    }

    /// The walk wraps, so neither key is ever dead at the ends of the session.
    func testWrapsAtBothEnds() {
        XCTAssertEqual(LapChannelPanel.stepped([3], by: 1, over: available), [0])
        XCTAssertEqual(LapChannelPanel.stepped([0], by: -1, over: available), [3])
    }

    /// With nothing lit, a key lights the end it points at rather than nothing.
    func testLightsAnEndWhenNothingIsLit() {
        XCTAssertEqual(LapChannelPanel.stepped([], by: 1, over: available), [0])
        XCTAssertEqual(LapChannelPanel.stepped([], by: -1, over: available), [3])
    }

    /// Every lap lit, or no laps at all: the selection is returned unchanged, so
    /// the caller can tell nothing happened and skip the haptic.
    func testNowhereToStepLeavesTheSelectionAlone() {
        XCTAssertEqual(LapChannelPanel.stepped([0, 1, 2, 3], by: 1, over: available), [0, 1, 2, 3])
        XCTAssertEqual(LapChannelPanel.stepped([0], by: 1, over: []), [0])
        XCTAssertEqual(LapChannelPanel.stepped([0], by: 0, over: available), [0])
    }

    /// A session whose lit lap isn't in the list — a stale selection after the
    /// channels changed under it — starts again from an end rather than crashing
    /// or standing still.
    func testASelectionThatIsNoLongerAvailableStartsOver() {
        XCTAssertEqual(LapChannelPanel.stepped([9], by: 1, over: available), [0])
    }
}
