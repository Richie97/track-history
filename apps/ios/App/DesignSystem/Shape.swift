import SwiftUI

/// Corner radii from `public/style.css` (`--radius-*`).
enum TERadius {
    static let xs: CGFloat = 7
    static let sm: CGFloat = 9
    static let md: CGFloat = 11
    static let lg: CGFloat = 14
    static let xl: CGFloat = 20
    /// `--radius-pill: 999px`.
    static let pill: CGFloat = 999

    static let all: [(name: String, value: CGFloat)] = [
        ("xs", xs), ("sm", sm), ("md", md), ("lg", lg), ("xl", xl), ("pill", pill)
    ]
}

/// Layout constants from the stylesheet, for the few places a native layout
/// wants the same rhythm as the web app.
enum TESpacing {
    /// `--card-pad`.
    static let cardPadding: CGFloat = 22
    /// `--grid-gap`.
    static let gridGap: CGFloat = 14
    /// `--page-gutter`, tightened for phones.
    static let pageGutter: CGFloat = 16
}

/// Motion: one standard curve, so transitions aren't hand-picked per screen.
///
/// `--ease-standard` is `cubic-bezier(0.22, 1, 0.36, 1)` — a decelerating ease
/// that reads as a light spring.
enum TEMotion {
    /// `--dur-fast: 130ms`.
    static let fast = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.13)
    /// `--dur-med: 220ms`.
    static let standard = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.22)
}

/// The app's flat depth: a hairline border plus **one** surface step, never
/// stacked shadows. `shadow-pop` exists for popovers only, which is why there is
/// no shadow here.
struct TECard<Content: View>: View {
    private let padding: CGFloat
    private let radius: CGFloat
    private let content: Content

    init(padding: CGFloat = TESpacing.cardPadding, radius: CGFloat = TERadius.lg, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.radius = radius
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.surfaceCard), in: .rect(cornerRadius: radius))
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color(.borderHairline), lineWidth: 1)
            )
    }
}

extension View {
    /// The popover-only elevation — `--shadow-pop`.
    func teShadowPop() -> some View {
        shadow(color: Color(.shadow), radius: 20, x: 0, y: 12)
    }
}
