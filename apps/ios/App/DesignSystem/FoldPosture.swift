import SwiftUI

/// How the device is folded (epic #277, ticket 3) — the port of Android's
/// `ui/FoldPosture.kt` (NS-34 ticket 4), under the same names.
///
/// Posture is **not** width, and this is deliberately not part of
/// `LayoutMetrics`. A half-open iPhone Duo standing on a dash is the same number
/// of points as one held flat; what changed is that there is now a crease across
/// the middle of it. Width says how much room there is, posture says where the
/// room *is not*.
///
/// In the app target beside `LayoutClass` rather than in the Kit, for the same
/// reason: it is a fact about a window, and the Kit forbids UI-framework reads.
enum FoldPosture: Equatable {
    /// Flat, closed, or no fold at all — every device, most of the time.
    case flat
    /// Half-open with a horizontal hinge: the laptop-on-a-desk shape.
    case tabletop
    /// Half-open with a vertical hinge: the open-book shape.
    case book
}

/// The posture, and where the crease falls.
///
/// `hingeFraction` is the hinge's centre as a fraction of the window — down it
/// for `.tabletop`, across it for `.book` — so a layout can put the split where
/// the hardware actually is instead of halving the window and hoping. nil when
/// there is nothing to avoid.
struct FoldGeometry: Equatable {
    var posture: FoldPosture
    var hingeFraction: Double?
}

/// Turning a fold into a posture, with no window types in sight.
///
/// The reading half is a few lines at the edge (`publishingFoldGeometry()`);
/// everything decidable lives here, so it is testable in `apps/ios/Tests` with no
/// device and no simulator fold control — the split Android makes, and
/// `FoldsTests` carries `FoldsTest.kt`'s cases.
enum Folds {
    static let FLAT = FoldGeometry(posture: .flat, hingeFraction: nil)

    /// How far from a half of the window a hinge may sit and still be usable.
    static let HINGE_LIMIT = 0.35

    /// A posture from the two facts a fold carries, plus where the hinge is.
    ///
    /// Only a **half-opened** fold is a posture worth laying out for: flat is an
    /// ordinary screen and a closed Duo is the cover display, which is its own
    /// window with its own width. A hinge nowhere near the middle is ignored too
    /// — splitting a screen 5/95 gives one half nothing can be read in, and a
    /// device like that is better served by the layout every other device gets.
    static func geometry(halfOpened: Bool, horizontal: Bool, hingeFraction: Double?) -> FoldGeometry {
        guard halfOpened else { return FLAT }
        let fraction = hingeFraction ?? 0.5
        // A hair of tolerance on the inclusive limits: 0.5 - 0.35 is not exactly
        // 0.15 in binary, and the limits themselves are postures (Android's
        // `Float` arithmetic happens to land inside them).
        let slack = 1e-9
        guard fraction >= 0.5 - HINGE_LIMIT - slack, fraction <= 0.5 + HINGE_LIMIT + slack else { return FLAT }
        return FoldGeometry(posture: horizontal ? .tabletop : .book, hingeFraction: fraction)
    }

    /// The same decision from iOS's own signal: the **division reserved region**
    /// in a window of `size` (iOS 27.1's `reservedRegions(kind: .division)`).
    ///
    /// Apple's split, which this follows: the region is the layout signal and the
    /// hinge *angle* is for effects. The region is active — non-empty — only while
    /// the device is partially folded, so "half-opened" is "there is a region";
    /// a region wider than it is tall is a horizontal hinge; and its centre
    /// against the window's height (or width) is the fraction. Still pure, so the
    /// arithmetic is tested even though the reading is not.
    static func geometry(division: CGRect?, in size: CGSize) -> FoldGeometry {
        guard let division, !division.isEmpty, size.width > 0, size.height > 0 else { return FLAT }
        let horizontal = division.width >= division.height
        let fraction = horizontal ? division.midY / size.height : division.midX / size.width
        return geometry(halfOpened: true, horizontal: horizontal, hingeFraction: fraction)
    }

    /// How much of a tabletop window goes **above** the crease: the hinge's own
    /// position, kept between a fifth and four fifths so neither half is ever a
    /// sliver — Android's `coerceIn(0.2f, 0.8f)`.
    static func tabletopTopShare(_ geometry: FoldGeometry) -> Double {
        min(max(geometry.hingeFraction ?? 0.5, 0.2), 0.8)
    }
}

private struct FoldGeometryKey: EnvironmentKey {
    static let defaultValue = Folds.FLAT
}

extension EnvironmentValues {
    /// What the window is folded like right now; `.flat` everywhere but a
    /// half-open foldable on iOS 27.1 or later.
    var foldGeometry: FoldGeometry {
        get { self[FoldGeometryKey.self] }
        set { self[FoldGeometryKey.self] = newValue }
    }
}

extension View {
    /// Publish the window's posture to this view's subtree.
    ///
    /// Applied to the **record route only**, which owns the window at every width
    /// (`Route.ownsTheWindow`), so the reader sees the whole window and the hinge
    /// fraction is against the right height. The logbook screens need nothing:
    /// standard containers already lay out around reserved regions.
    func publishingFoldGeometry() -> some View {
        modifier(FoldGeometryReader())
    }
}

private struct FoldGeometryReader: ViewModifier {
    func body(content: Content) -> some View {
        #if DEBUG
        // `-tabletop <fraction>` forces the posture, which is how the layout is
        // looked at on a desk and on any simulator — the fold itself can only be
        // produced by the hardware or Xcode 27.1's Device Hub:
        //   xcrun simctl launch <device> app.trackevolution -recorder -tabletop 0.55
        if let forced = Self.forcedTabletop {
            content.environment(\.foldGeometry, forced)
        } else {
            reading(content)
        }
        #else
        reading(content)
        #endif
    }

    /// The live reading. Live rather than once, like the layout class: folding a
    /// Duo does not relaunch the app.
    private func reading(_ content: Content) -> some View {
        GeometryReader { proxy in
            content.environment(
                \.foldGeometry,
                Folds.geometry(division: Self.division(in: proxy), in: proxy.size)
            )
        }
    }

    /// The hinge's frame in `proxy`'s space while partially folded, else nil.
    ///
    /// **The one read the posture needs, and not yet made.** On iOS 27.1 it is
    /// `proxy.reservedRegions(kind: .division)` behind `#available(iOS 27.1, *)`,
    /// which needs the iOS 27.1 SDK to compile — Xcode 27.1, which neither CI nor
    /// the machines this was written on carry yet (epic #277, ticket 2). Until
    /// then it answers nil, so every device is `.flat` and `RecordingScreen` is
    /// exactly what it was; everything downstream of this line is built and
    /// tested, and filling it in is the whole of what is left.
    private static func division(in proxy: GeometryProxy) -> CGRect? {
        nil
    }

    #if DEBUG
    private static let forcedTabletop: FoldGeometry? = {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "-tabletop") else { return nil }
        let fraction = args.indices.contains(flag + 1) ? Double(args[flag + 1]) : nil
        return Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: fraction ?? 0.5)
    }()
    #endif
}
