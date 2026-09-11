import SwiftUI

/// How much width the app has to lay out in (spec: NS-34).
///
/// The unit of decision is the **window**, never the device or the idiom: an
/// iPad in Split View, a phone in landscape and a Mac-sized Stage Manager window
/// all land in the same three rules, and none of them is asked what kind of
/// hardware it is. The names and the breakpoints are Material's window size
/// classes, which is what lets the Android port use the same two numbers —
/// `LayoutClass.kt` in `:app` — and lets a change to one fail the other's test.
///
/// Deliberately **not** in the Kit. Every value here is a fact about a window
/// rather than about the domain, and the Kit must stay free of UI frameworks;
/// the two platforms pin the breakpoints with a test each instead of sharing an
/// implementation.
enum LayoutClass: String, CaseIterable, Sendable {
    /// Under 600pt. Today's phone layout, unchanged — this spec adds classes
    /// above it and touches nothing in it.
    case compact
    /// 600–839pt. The phone layout with its column capped and centred, its grids
    /// filling by width, and its controls no longer stretching edge to edge.
    /// Half of a folded-open tablet and an iPad in portrait Split View live here.
    case medium
    /// 840pt and up. Two-pane list-detail, and analysis beside the track map.
    case expanded

    /// The Material breakpoint between a phone layout and a capped one.
    ///
    /// Named `_DP` on both platforms even though iOS counts in points: the value
    /// is the shared thing, and a Swift-flavoured name here would hide the fact
    /// that `MEDIUM_MIN_DP` in `ui/LayoutClass.kt` has to be the same number.
    static let MEDIUM_MIN_DP: CGFloat = 600
    /// The Material breakpoint at which a second pane earns its place.
    static let EXPANDED_MIN_DP: CGFloat = 840

    /// The class for a window of this width.
    ///
    /// The pure rule, and the one the Android port mirrors — the size class
    /// never reaches it.
    static func ofWidth(_ width: CGFloat) -> LayoutClass {
        if width >= EXPANDED_MIN_DP { return .expanded }
        if width >= MEDIUM_MIN_DP { return .medium }
        return .compact
    }

    /// The class for a window of this width in this horizontal size class.
    ///
    /// Both inputs are needed and neither is sufficient. The size class alone
    /// cannot tell a 13-inch iPad from a half-screen Split View pane on it —
    /// both are `.regular`. The width alone would call an iPhone 17 Pro Max in
    /// landscape (932pt) an expanded window and hand a phone in someone's hands
    /// a two-pane layout; UIKit already knows that device is a one-column
    /// proposition and says so with `.compact`, so a compact size class is the
    /// phone layout by definition, whatever the number.
    static func of(width: CGFloat, horizontalSizeClass: UserInterfaceSizeClass?) -> LayoutClass {
        if horizontalSizeClass == .compact { return .compact }
        return ofWidth(width)
    }

    /// Whether the phone layout applies as-is.
    var isCompact: Bool { self == .compact }
}

/// The window's layout class and the width of the column content is being laid
/// out in.
///
/// Two values rather than one because they answer different questions and change
/// at different times: the class is a fact about the *window* (and stays that,
/// so a narrow detail pane never redraws itself as a phone), while the content
/// width is a fact about the column the caller is inside — `TEPage` narrows it
/// when it caps the page, and a pane will narrow it again.
struct LayoutMetrics: Equatable, Sendable {
    var layoutClass: LayoutClass
    /// The usable width of the current column, gutters already deducted.
    var contentWidth: CGFloat

    /// How many columns of at least `minimum` points fit, with `gap` between
    /// them — the native reading of the web's
    /// `repeat(auto-fill, minmax(<minimum>, 1fr))`.
    ///
    /// Never fewer than one: a column narrower than the minimum gets one item
    /// per row and lets it be as narrow as it must be, exactly as CSS does.
    func columns(minimum: CGFloat, gap: CGFloat = TESpacing.gridGap) -> Int {
        guard contentWidth > 0, minimum > 0 else { return 1 }
        return max(1, Int((contentWidth + gap) / (minimum + gap)))
    }

    /// The same metrics for a narrower column.
    func narrowed(to width: CGFloat) -> LayoutMetrics {
        LayoutMetrics(layoutClass: layoutClass, contentWidth: min(contentWidth, width))
    }

    /// How wide a second column beside the page should be, or nil for one column.
    ///
    /// The three pages that split — the event's analysis, the track's lap
    /// compare, the vehicle's selected part — share this rule rather than each
    /// carrying its own pair of magic numbers, because the thing that goes wrong
    /// is the same on all three and went wrong on all three.
    ///
    /// It reads `contentWidth`, **never the layout class**, and that is the whole
    /// point. The class is a fact about the *window* and stays one, so a pane
    /// never decides it is a phone — but "is there room here for two columns" is
    /// a question about the container this page is actually in, and on an iPad in
    /// portrait with the sidebar showing those two answers disagree: an expanded
    /// window, and a detail pane with 627pt of usable width. Splitting that pane
    /// gave the side column 341pt of slot for the 445pt of content the window's
    /// width had asked for, and the difference ran off the side of the screen.
    ///
    /// `nil` below `EXPANDED_MIN_DP` is the same threshold the window uses to
    /// earn its second pane, applied one level down: a column too narrow to be a
    /// two-pane window is too narrow to hold two columns of its own.
    func sideColumnWidth(fraction: CGFloat, minimum: CGFloat, maximum: CGFloat) -> CGFloat? {
        guard contentWidth >= LayoutClass.EXPANDED_MIN_DP else { return nil }
        return min(max(contentWidth * fraction, minimum), maximum)
    }
}

private struct LayoutMetricsKey: EnvironmentKey {
    /// A phone, until `RootView` measures the window. Nothing renders before it
    /// does, and defaulting the other way would flash a two-pane layout.
    static let defaultValue = LayoutMetrics(layoutClass: .compact, contentWidth: 0)
}

extension EnvironmentValues {
    var layout: LayoutMetrics {
        get { self[LayoutMetricsKey.self] }
        set { self[LayoutMetricsKey.self] = newValue }
    }
}

extension View {
    /// Measure the window and publish its layout class to everything below.
    ///
    /// A `GeometryReader` rather than anything read once: Stage Manager, Split
    /// View and rotation all resize the window while the app is running, and a
    /// class captured at launch would be wrong for the rest of the session.
    /// (`onGeometryChange(for:)` would be tidier and is iOS 18; the deployment
    /// target is 17.)
    func measuringLayoutClass() -> some View {
        modifier(MeasureLayoutClass())
    }

    /// Republish the metrics for a container narrower than the window — a pane.
    ///
    /// The **class stays the window's**, which is the spec's rule and the right
    /// one: a pane must not decide it is a phone and start hiding things. What
    /// has to change is the *content width*, because everything that counts
    /// columns counts them against the column it is actually in. Without this a
    /// 360pt sidebar inherits the window's 1064pt content width and lays its
    /// track cards out three across, at 110pt each — which is how a list pane
    /// ends up far too narrow for what is in it.
    ///
    /// Measured rather than assumed: `NavigationSplitView` picks the sidebar's
    /// width itself, anywhere between the minimum and maximum it is offered, and
    /// the user can drag it.
    ///
    /// **It measures with a `GeometryReader`, so it is greedy**: it takes every
    /// point offered to it and reports that as its own size. Two consequences,
    /// both of which have bitten:
    ///
    /// - It goes **inside** a fixed frame, never outside one.
    ///   `column.frame(width: w).measuringPaneWidth()` puts the greedy reader
    ///   *around* the frame, so an `HStack` sees two fully flexible children and
    ///   splits the row in half — the fixed width stops deciding anything, and
    ///   whatever it was is either short of the half (a gap of dead background)
    ///   or over it (content off the side of the window). Write
    ///   `column.measuringPaneWidth().frame(width: w)`.
    /// - A pushed screen does not inherit it. Applied to a `NavigationStack`, it
    ///   publishes into the stack's own root and not into what
    ///   `navigationDestination` builds, so a detail screen went on reading the
    ///   *window's* width while being laid out in a 1025pt pane. `RootView`
    ///   therefore applies it to each destination, where the reader is inside the
    ///   container it is measuring and there is nothing left to inherit through.
    func measuringPaneWidth() -> some View {
        modifier(MeasurePaneWidth())
    }
}

private struct MeasureLayoutClass: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        GeometryReader { proxy in
            content.environment(\.layout, metrics(for: proxy.size.width))
        }
    }

    private func metrics(for width: CGFloat) -> LayoutMetrics {
        let layoutClass = LayoutClass.of(width: width, horizontalSizeClass: horizontalSizeClass)
        return LayoutMetrics(
            layoutClass: layoutClass,
            contentWidth: max(0, width - 2 * TESpacing.pageGutter(for: layoutClass))
        )
    }
}

private struct MeasurePaneWidth: ViewModifier {
    @Environment(\.layout) private var layout

    func body(content: Content) -> some View {
        GeometryReader { proxy in
            content.environment(
                \.layout,
                LayoutMetrics(
                    layoutClass: layout.layoutClass,
                    contentWidth: max(
                        0,
                        proxy.size.width - 2 * TESpacing.pageGutter(for: layout.layoutClass)
                    )
                )
            )
        }
    }
}
