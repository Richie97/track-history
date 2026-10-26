import SwiftUI

/// Which shape the lap stage takes (NS-51, *Layouts*).
///
/// Decided from the **pane's own content width** (`layout.contentWidth`) and
/// `sideColumnWidth`, never from the window's layout class — the NS-34 rule that
/// fixed the iPad-portrait overflow. An iPad with its sidebar showing has a
/// ~900pt detail pane in an expanded window, and that pane gets Medium.
///
/// Pure and static so the thresholds are pinned without a view:
/// `apps/ios/Tests/StageLayoutTests.swift`.
enum StageLayout: Equatable {
    /// Videos side by side with the transport under them, and a right column
    /// with the map card above the now-strip. The whole stage pins over the
    /// charts.
    case wide(sideWidth: CGFloat)
    /// Videos side by side, then the map card beside the now-strip, then the
    /// transport — which is the part that pins once it reaches the top.
    case medium
    /// A phone or the closed Duo: one edge-to-edge 16:9 player (B as an inset),
    /// the transport, the now-strip and the mode row, all pinned.
    case compact
    /// Half-open on a horizontal hinge: the picture above the crease, the
    /// transport and charts below it. `topShare` is the window's height above
    /// the split, from `Folds.tabletopTopShare`.
    case tabletop(topShare: Double)

    /// Content at or above this is wide enough for the stage's own right column.
    static let WIDE_MIN: CGFloat = 1000
    /// Below this the stage is the phone's.
    static let MEDIUM_MIN: CGFloat = 600
    /// The right column's share and bounds — the spec's `sideColumnWidth(0.24, 280, 360)`.
    static let SIDE_FRACTION: CGFloat = 0.24
    static let SIDE_MIN: CGFloat = 280
    static let SIDE_MAX: CGFloat = 360

    /// The layout for a pane of `contentWidth` points. `sideColumnWidth` is
    /// `LayoutMetrics.sideColumnWidth(fraction:minimum:maximum:)` with the
    /// constants above — nil where the pane has no room for a second column.
    static func choose(contentWidth: CGFloat, sideColumnWidth: CGFloat?, fold: FoldGeometry) -> StageLayout {
        if fold.posture == .tabletop {
            return .tabletop(topShare: Folds.tabletopTopShare(fold))
        }
        if contentWidth >= WIDE_MIN, let sideColumnWidth {
            return .wide(sideWidth: sideColumnWidth)
        }
        if contentWidth >= MEDIUM_MIN { return .medium }
        return .compact
    }

    /// Whether the stage should cover the window with its full-bleed video: a
    /// **phone turned to landscape** (UIKit's compact vertical size class, which
    /// no iPad and no open Duo window reports) while the stage has a video to
    /// show. With nothing but replay, rotation does nothing special.
    ///
    /// The vertical size class rather than width, for the reason NS-34 records:
    /// an iPhone Pro Max in landscape is 932pt wide — wider than the expanded
    /// breakpoint — and is still a phone on its side.
    static func goesFullBleed(verticalSizeClass: UserInterfaceSizeClass?, hasVideo: Bool) -> Bool {
        verticalSizeClass == .compact && hasVideo
    }

    /// The compact inset's width: 132pt on a phone, 160 on the closed Duo's
    /// wider cover display.
    static func insetWidth(contentWidth: CGFloat) -> CGFloat {
        contentWidth >= 440 ? 160 : 132
    }
}
