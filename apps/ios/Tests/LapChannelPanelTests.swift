import TrackEvolutionKit
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

    // MARK: - Tabs

    /// The tab enum is the web's `TABS`, through the Kit's port of it — which
    /// `LapAxisTests` pins to `contracts/logic/lap-axis.json`.
    func testTheTabsAreTheWebsTracesGripCar() {
        XCTAssertEqual(LapChannelPanel.Tab.allCases.map(\.rawValue), ChannelGraphs.TABS.map(\.key))
        XCTAssertEqual(LapChannelPanel.Tab.allCases.map(\.label), ChannelGraphs.TABS.map(\.label))
    }

    /// Every channel lands on the tab `TAB_OF` says — speed with the inputs.
    func testEveryChannelLandsWhereTabOfSays() {
        for channel in ChannelGraphs.Channel.allCases {
            XCTAssertEqual(
                LapChannelPanel.tab(of: channel).rawValue, ChannelGraphs.TAB_OF[channel.rawValue],
                "\(channel)"
            )
        }
        XCTAssertEqual(ChannelGraphs.TAB_OF["delta"], LapChannelPanel.Tab.traces.rawValue)
    }

    /// A remembered tab from before the merge (Time, Inputs) is not a tab any
    /// more: it reads as nil, which the panel shows as its first populated tab.
    func testARememberedTabThatNoLongerExistsReadsAsNone() {
        XCTAssertNil(LapChannelPanel.Tab(rawValue: "time"))
        XCTAssertNil(LapChannelPanel.Tab(rawValue: "inputs"))
        XCTAssertEqual(LapChannelPanel.Tab(rawValue: "grip"), .grip)
    }

    // MARK: - The axis

    /// The frame the charts draw on: k · step on distance, each lap's own
    /// elapsed time on time, and one extent for every chart.
    func testTheAxisFrameLaysLapsOutByDistanceOrTime() {
        let a = LapChannels(n: 1, timeMs: 10_000, speed: [100, 120, 140, 140, 120, 100, 110, 130, 150, 160, 160, 150])
        let b = LapChannels(n: 2, timeMs: 11_000, speed: [95, 110, 120, 120, 100, 90, 100, 120, 140, 150, 150])
        let channels = SessionChannels(v: 1, dStepM: 20, laps: [a, b])

        let distance = AxisFrame(channels, .distance)
        XCTAssertEqual(distance.x1, 220)
        XCTAssertEqual(distance.x(nil, 2.5), 50)

        let time = AxisFrame(channels, .time)
        XCTAssertEqual(time.x1, 11, accuracy: 1e-9)
        XCTAssertNil(time.x(nil, 2), "a time axis needs the lap")
        XCTAssertEqual(time.x(0, 11) ?? .nan, 10, accuracy: 1e-9)
        XCTAssertEqual(time.x(1, 10) ?? .nan, 11, accuracy: 1e-9)
    }
}
