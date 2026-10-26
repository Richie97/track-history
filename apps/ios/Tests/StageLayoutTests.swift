import SwiftUI
import XCTest
import TrackEvolutionKit

@testable import TrackEvolution

/// Which shape the lap stage takes (NS-51), pinned beside the breakpoints it
/// reads: the pane's content width, `sideColumnWidth`, the fold and — for
/// full-bleed — the vertical size class.
@MainActor
final class StageLayoutTests: XCTestCase {

    private func choose(_ width: CGFloat, fold: FoldGeometry = Folds.FLAT) -> StageLayout {
        let metrics = LayoutMetrics(layoutClass: LayoutClass.ofWidth(width), contentWidth: width)
        return StageLayout.choose(
            contentWidth: width,
            sideColumnWidth: metrics.sideColumnWidth(
                fraction: StageLayout.SIDE_FRACTION, minimum: StageLayout.SIDE_MIN, maximum: StageLayout.SIDE_MAX
            ),
            fold: fold
        )
    }

    func testTheThresholdsAreTheSpecs() {
        XCTAssertEqual(StageLayout.WIDE_MIN, 1000)
        XCTAssertEqual(StageLayout.MEDIUM_MIN, 600)
        XCTAssertEqual(StageLayout.SIDE_FRACTION, 0.24)
        XCTAssertEqual(StageLayout.SIDE_MIN, 280)
        XCTAssertEqual(StageLayout.SIDE_MAX, 360)
    }

    /// Each boundary and one point below it.
    func testCompactMediumAndWideByThePanesOwnWidth() {
        XCTAssertEqual(choose(402), .compact, "a phone")
        XCTAssertEqual(choose(599), .compact)
        XCTAssertEqual(choose(600), .medium)
        XCTAssertEqual(choose(999), .medium)
        XCTAssertEqual(choose(1000), .wide(sideWidth: 280), "0.24 × 1000 is under the floor")
        XCTAssertEqual(choose(1366), .wide(sideWidth: 1366 * 0.24))
        XCTAssertEqual(choose(2000), .wide(sideWidth: 360), "and the ceiling holds on a very wide window")
    }

    /// An iPad with its sidebar showing has a ~900pt detail pane in an expanded
    /// window: the pane decides, so it is Medium — the overflow NS-34 fixed.
    func testAnIPadDetailPaneBesideTheSidebarIsMedium() {
        let pane = LayoutMetrics(layoutClass: .expanded, contentWidth: 900)
        XCTAssertEqual(
            StageLayout.choose(
                contentWidth: pane.contentWidth,
                sideColumnWidth: pane.sideColumnWidth(fraction: 0.24, minimum: 280, maximum: 360),
                fold: Folds.FLAT
            ),
            .medium
        )
    }

    /// No side column — wide content but nowhere to put the map — is Medium.
    func testWideNeedsASideColumn() {
        XCTAssertEqual(StageLayout.choose(contentWidth: 1200, sideColumnWidth: nil, fold: Folds.FLAT), .medium)
    }

    /// A half-open Duo on its hinge is the tabletop at any width, split where
    /// the hinge is (held between a fifth and four fifths); a book fold is not.
    func testTabletopAtAnyWidthAndSplitAtTheHinge() {
        let tabletop = Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.55)
        XCTAssertEqual(choose(466, fold: tabletop), .tabletop(topShare: 0.55))
        XCTAssertEqual(choose(1133, fold: tabletop), .tabletop(topShare: 0.55))
        let book = Folds.geometry(halfOpened: true, horizontal: false, hingeFraction: 0.5)
        XCTAssertEqual(choose(1133, fold: book), .wide(sideWidth: 280), "0.24 × 1133 is under the floor")
    }

    /// Full-bleed is a phone on its side **with a video** — never replay alone,
    /// and never a regular-height window, which no iPad or open Duo leaves.
    func testFullBleedIsAPhoneOnItsSideWithAVideo() {
        XCTAssertTrue(StageLayout.goesFullBleed(verticalSizeClass: .compact, hasVideo: true))
        XCTAssertFalse(StageLayout.goesFullBleed(verticalSizeClass: .compact, hasVideo: false))
        XCTAssertFalse(StageLayout.goesFullBleed(verticalSizeClass: .regular, hasVideo: true))
        XCTAssertFalse(StageLayout.goesFullBleed(verticalSizeClass: nil, hasVideo: true))
    }

    func testTheInsetIsWiderOnTheClosedDuo() {
        XCTAssertEqual(StageLayout.insetWidth(contentWidth: 402), 132)
        XCTAssertEqual(StageLayout.insetWidth(contentWidth: 466), 160)
    }

    // MARK: - The preference

    func testTheSyncModeIsRememberedAndAnUnknownValueFallsBack() {
        let defaults = UserDefaults(suiteName: "StageLayoutTests")!
        defaults.removePersistentDomain(forName: "StageLayoutTests")
        XCTAssertEqual(SyncModeStore(defaults: defaults).mode, .place, "Same place is the first compare's mode")
        let store = SyncModeStore(defaults: defaults)
        store.mode = .time
        XCTAssertEqual(SyncModeStore(defaults: defaults).mode, .time, "the last mode picked is the next one")
        defaults.set("sideways", forKey: SyncModeStore.storageKey)
        XCTAssertEqual(SyncModeStore(defaults: defaults).mode, .place)
    }

    // MARK: - The panel's mark

    /// The panel's dots are keyed by **its** channel-lap indexes: in *Same
    /// time* each side's own place, the line at A's; out of the lap, nothing.
    func testThePlayheadMarksEachSideOnItsOwnTraceInThePanel() throws {
        let speedA = (0..<30).map { $0 >= 10 && $0 <= 14 ? 90.0 : 160 }
        let speedB = speedA.map { $0 - 10 }
        let a = StageSideInput(
            key: .A, entry: LapChannels(n: 1, timeMs: 15_000, speed: speedA), dStepM: 20, clip: nil, chIdx: 4,
            lapNum: 5, timeMs: 15_000, isBest: true
        )
        let b = StageSideInput(
            key: .B, entry: LapChannels(n: 2, timeMs: 16_000, speed: speedB), dStepM: 20, clip: nil, chIdx: 2,
            lapNum: 3, timeMs: 16_000, isBest: false
        )
        let sides = VideoSync.Sides(
            a: try XCTUnwrap(VideoSync.makeSide(.A, a.entry, 20, nil)),
            b: VideoSync.makeSide(.B, b.entry, 20, nil)
        )
        let time = VideoSync.playheadAt(sides, .A, 8, .time)
        let mark = try XCTUnwrap(LapStageModel.mark(time, inputs: [a, b]))
        XCTAssertEqual(mark.k, time.a.k)
        XCTAssertEqual(mark.dots[4], time.a.k)
        XCTAssertEqual(mark.dots[2], time.b?.k)
        XCTAssertNotEqual(mark.dots[2], mark.dots[4], "two dots apart: the gap")
        XCTAssertNil(LapStageModel.mark(VideoSync.playheadAt(sides, .A, -1, .place), inputs: [a, b]))
        XCTAssertEqual(a.chip, "Lap 5 · \(LapTime.fmtMs(15_000)) ★")
    }
}
