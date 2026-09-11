import SwiftUI
import XCTest

@testable import TrackEvolution

/// The layout breakpoints, pinned (spec: NS-34).
///
/// The two constants are duplicated on Android — `LayoutClass.kt` in `:app`,
/// with a matching `LayoutClassTest` — because the class is derived from each
/// platform's own window APIs and neither pure-logic module may import a UI
/// framework. Duplication is the accepted cost; this test and its Kotlin
/// counterpart are what stop it turning into drift, so a PR that changes 600 or
/// 840 here fails over there.
final class LayoutClassTests: XCTestCase {

    /// Material's window size class breakpoints. Changing either of these
    /// changes both apps, and both tests.
    func testBreakpointsAreMaterialsAndMatchAndroid() {
        XCTAssertEqual(LayoutClass.MEDIUM_MIN_DP, 600)
        XCTAssertEqual(LayoutClass.EXPANDED_MIN_DP, 840)
    }

    /// Each boundary, and one point below it: the off-by-one that matters is
    /// whether the breakpoint itself is in the class above.
    func testClassAtEachBoundary() {
        XCTAssertEqual(LayoutClass.ofWidth(0), .compact)
        XCTAssertEqual(LayoutClass.ofWidth(599), .compact)
        XCTAssertEqual(LayoutClass.ofWidth(600), .medium)
        XCTAssertEqual(LayoutClass.ofWidth(839), .medium)
        XCTAssertEqual(LayoutClass.ofWidth(840), .expanded)
        XCTAssertEqual(LayoutClass.ofWidth(1366), .expanded)
    }

    /// A compact horizontal size class is the phone layout whatever the width.
    ///
    /// An iPhone 17 Pro Max in landscape is 932pt wide — past both breakpoints —
    /// and is still a one-column device held in two hands. UIKit already knows
    /// that and says so; width alone would hand it a two-pane layout.
    func testCompactSizeClassStaysCompactAtAnyWidth() {
        XCTAssertEqual(LayoutClass.of(width: 932, horizontalSizeClass: .compact), .compact)
        XCTAssertEqual(LayoutClass.of(width: 1366, horizontalSizeClass: .compact), .compact)
    }

    /// …and a regular size class is classified by width, which is the half the
    /// size class cannot answer: a 13-inch iPad and a half-screen Split View
    /// pane on it are both `.regular`.
    func testRegularSizeClassIsClassifiedByWidth() {
        XCTAssertEqual(LayoutClass.of(width: 507, horizontalSizeClass: .regular), .compact)
        XCTAssertEqual(LayoutClass.of(width: 639, horizontalSizeClass: .regular), .medium)
        XCTAssertEqual(LayoutClass.of(width: 1032, horizontalSizeClass: .regular), .expanded)
    }

    /// No size class at all — a preview, or a scene that hasn't attached yet —
    /// falls back to the width rather than to a default class.
    func testUnknownSizeClassUsesWidth() {
        XCTAssertEqual(LayoutClass.of(width: 400, horizontalSizeClass: nil), .compact)
        XCTAssertEqual(LayoutClass.of(width: 900, horizontalSizeClass: nil), .expanded)
    }

    // MARK: - Column counts

    /// The native reading of `repeat(auto-fill, minmax(280px, 1fr))`, checked
    /// against what the browser does with the same numbers.
    func testColumnsMatchTheWebsAutoFillGrid() {
        func columns(_ width: CGFloat) -> Int {
            LayoutMetrics(layoutClass: .ofWidth(width), contentWidth: width)
                .columns(minimum: 280, gap: 14)
        }
        // A phone's column never fits two 280pt cards.
        XCTAssertEqual(columns(358), 1)
        // 280 + 14 + 280 = 574.
        XCTAssertEqual(columns(573), 1)
        XCTAssertEqual(columns(574), 2)
        // 3 × 280 + 2 × 14 = 868, so one point short of it is still two columns.
        XCTAssertEqual(columns(867), 2)
        XCTAssertEqual(columns(868), 3)
        // A capped page (1120 − 2 × 28) takes three, not four: four would need
        // 1162.
        XCTAssertEqual(columns(1064), 3)
    }

    /// A column narrower than one card still gets a card, as CSS does — never
    /// zero columns, and never a division by zero.
    func testColumnsNeverFallBelowOne() {
        let unmeasured = LayoutMetrics(layoutClass: .compact, contentWidth: 0)
        XCTAssertEqual(unmeasured.columns(minimum: 280), 1)
        let sliver = LayoutMetrics(layoutClass: .compact, contentWidth: 40)
        XCTAssertEqual(sliver.columns(minimum: 280), 1)
    }

    /// Narrowing carries the class through: a capped page is still in the
    /// window's class, which is what stops a narrow pane redrawing itself as a
    /// phone in the two-pane work to come.
    func testNarrowingKeepsTheWindowsClass() {
        let window = LayoutMetrics(layoutClass: .expanded, contentWidth: 1400)
        let page = window.narrowed(to: 1064)
        XCTAssertEqual(page.layoutClass, .expanded)
        XCTAssertEqual(page.contentWidth, 1064)
        // Narrowing only ever narrows.
        XCTAssertEqual(page.narrowed(to: 2000).contentWidth, 1064)
    }

    // MARK: - The second column

    /// The three splitting pages ask their **own column**, not the window.
    ///
    /// This is the iPad bug in one assertion. A 13-inch iPad in portrait is an
    /// expanded *window* — it has a sidebar — and its detail pane is 683pt, 627
    /// of it usable. Reading the class there said "two columns"; reading the
    /// column says one, which is the layout the pane has room for.
    func testASplitNeedsTheColumnsOwnWidthNotTheWindowsClass() {
        func width(_ contentWidth: CGFloat) -> CGFloat? {
            LayoutMetrics(layoutClass: .expanded, contentWidth: contentWidth)
                .sideColumnWidth(fraction: 0.46, minimum: 380, maximum: 620)
        }
        // The detail pane of an iPad in portrait with the sidebar showing.
        XCTAssertNil(width(627))
        // …and in landscape, where there is room for both.
        XCTAssertNotNil(width(969))
        // The threshold is the window's own, one level down.
        XCTAssertNil(width(LayoutClass.EXPANDED_MIN_DP - 1))
        XCTAssertNotNil(width(LayoutClass.EXPANDED_MIN_DP))
    }

    /// The floor and the ceiling, on the widths the hardware actually produces.
    func testTheSideColumnStaysBetweenItsFloorAndCeiling() throws {
        func width(_ contentWidth: CGFloat) throws -> CGFloat {
            try XCTUnwrap(
                LayoutMetrics(layoutClass: .expanded, contentWidth: contentWidth)
                    .sideColumnWidth(fraction: 0.46, minimum: 380, maximum: 620)
            )
        }
        // At the threshold the fraction is under the floor, so the floor holds.
        XCTAssertEqual(try width(840), 386.4, accuracy: 0.01)
        // A 13-inch iPad with the sidebar showing, landscape: the fraction.
        XCTAssertEqual(try width(969), 445.74, accuracy: 0.01)
        // …and with the sidebar hidden. This is the number the broken build used
        // at *every* width, which is why it fitted here and nowhere else.
        XCTAssertEqual(try width(1310), 602.6, accuracy: 0.01)
        // A very wide window spends the extra on the page, not on the chart.
        XCTAssertEqual(try width(2000), 620)
    }

    /// Whatever the width, the page keeps more of it than the column beside it.
    ///
    /// The failure this rules out is a floor that outgrows its container — the
    /// shape of the original bug, where a column sized for one width was laid
    /// into a narrower one and the difference went off the side of the screen.
    func testThePageKeepsTheLargerHalfAtEveryWidth() {
        for content in stride(from: CGFloat(840), through: 2400, by: 1) {
            let metrics = LayoutMetrics(layoutClass: .expanded, contentWidth: content)
            for (fraction, minimum, maximum) in [
                (CGFloat(0.46), CGFloat(380), CGFloat(620)),  // event, track
                (CGFloat(0.42), CGFloat(340), CGFloat(560)),  // vehicle
            ] {
                guard let side = metrics.sideColumnWidth(
                    fraction: fraction, minimum: minimum, maximum: maximum
                ) else {
                    XCTFail("no column at \(content)pt")
                    continue
                }
                XCTAssertGreaterThanOrEqual(side, minimum)
                XCTAssertLessThanOrEqual(side, maximum)
                XCTAssertGreaterThan(content - side, side, "page column squeezed at \(content)pt")
            }
        }
    }

    // MARK: - Tokens

    /// `PAGE_MAX` is generated from `--page-max`, so this is really a check that
    /// the generator ran: a stylesheet change with no `node
    /// apps/ios/Tools/generate-tokens.mjs` behind it fails here.
    func testPageMaxMatchesTheStylesheet() {
        XCTAssertEqual(LayoutTokens.PAGE_MAX, 1120)
        XCTAssertEqual(LayoutTokens.PAGE_GUTTER, 28)
    }

    /// A phone keeps its tightened gutter; everything wider takes the web's.
    func testPageGutterWidensAbovePhoneWidth() {
        XCTAssertEqual(TESpacing.pageGutter(for: .compact), TESpacing.pageGutter)
        XCTAssertEqual(TESpacing.pageGutter(for: .medium), LayoutTokens.PAGE_GUTTER)
        XCTAssertEqual(TESpacing.pageGutter(for: .expanded), LayoutTokens.PAGE_GUTTER)
    }
}
