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

    /// The page gutter for a layout class.
    ///
    /// A phone keeps the tightened 16pt — 28pt of margin on each side of a
    /// 390pt screen is most of a column. Once there is width to spare the app
    /// uses the web's own `--page-gutter`, which is what makes a capped page on
    /// an iPad sit the way the same page does in Safari beside it.
    static func pageGutter(for layoutClass: LayoutClass) -> CGFloat {
        layoutClass == .compact ? pageGutter : LayoutTokens.PAGE_GUTTER
    }

    /// How wide a card in an auto-filling grid wants to be at minimum — the web's
    /// `.cards { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) }`.
    ///
    /// A phone is narrower than this, so the grid is one column there and the
    /// compact layout is unchanged by construction.
    static let cardGridMinimum: CGFloat = 280

    /// The width a full-bleed control stops growing at.
    ///
    /// A primary button is `frame(maxWidth: .infinity)` on a phone because the
    /// column *is* the button's natural width there. At 1120pt it is not: an
    /// 1120pt-wide "Save" reads as a banner, and the tap target it advertises is
    /// mostly empty lime. The web never had the problem — its buttons are
    /// `inline-flex` and size to their label — so this is the native reading of
    /// that, not a number from the stylesheet.
    static let controlMax: CGFloat = 420

    /// How wide a column of prose is allowed to get.
    ///
    /// Narrower than `PAGE_MAX`, because a page of cards and a page of sentences
    /// want different widths: the sign-in screen and the paywall are read left to
    /// right, and a 1120pt line is one the eye loses its place on. The sign-in
    /// card has capped itself at 420 since NS-08 for the same reason.
    static let readableMax: CGFloat = 560
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
