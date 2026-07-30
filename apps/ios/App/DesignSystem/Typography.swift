import SwiftUI
import UIKit

/// The type scale from `public/style.css`, mapped onto Dynamic Type.
///
/// The web scale is fixed pixels; a native app that ignores accessibility text
/// sizes isn't a native app, so every style declares the system text style it
/// scales with (`relativeTo:`) and grows from there.
///
/// Tracking in the stylesheet is in `em`; SwiftUI's `.tracking` is in points, so
/// it is multiplied by the *scaled* size at render time.
struct TETextStyle: Sendable, Hashable {
    let size: CGFloat
    let weight: Font.Weight
    /// In `em`, exactly as the stylesheet's `--tracking-*` tokens.
    let trackingEm: CGFloat
    let relativeTo: Font.TextStyle
    let monospaced: Bool
    let uppercased: Bool

    init(
        size: CGFloat,
        weight: Font.Weight = .regular,
        trackingEm: CGFloat = 0,
        relativeTo: Font.TextStyle,
        monospaced: Bool = false,
        uppercased: Bool = false
    ) {
        self.size = size
        self.weight = weight
        self.trackingEm = trackingEm
        self.relativeTo = relativeTo
        self.monospaced = monospaced
        self.uppercased = uppercased
    }

    // Tracking tokens: tight -0.02em · snug -0.01em · wide 0.08em

    /// 34px — the big number on a stat tile.
    static let hero = TETextStyle(size: 34, weight: .medium, trackingEm: -0.02, relativeTo: .largeTitle)
    /// 26px page title.
    static let h1 = TETextStyle(size: 26, weight: .semibold, trackingEm: -0.02, relativeTo: .title)
    /// 17px section heading.
    static let h2 = TETextStyle(size: 17, weight: .semibold, trackingEm: -0.01, relativeTo: .title3)
    /// 15px card heading.
    static let h3 = TETextStyle(size: 15, weight: .semibold, relativeTo: .headline)
    static let body = TETextStyle(size: 14.5, relativeTo: .body)
    static let bodyStrong = TETextStyle(size: 14.5, weight: .medium, relativeTo: .body)
    static let sm = TETextStyle(size: 13.5, relativeTo: .subheadline)
    static let xs = TETextStyle(size: 12.5, relativeTo: .footnote)
    static let xxs = TETextStyle(size: 11, relativeTo: .caption2)
    /// The uppercase label above a stat — `--fs-2xs` with `--tracking-wide`.
    static let eyebrow = TETextStyle(
        size: 11, weight: .medium, trackingEm: 0.08, relativeTo: .caption2, uppercased: true
    )

    /// A lap time: monospaced with tabular figures, so a column of times aligns
    /// on the decimal point. Non-negotiable in a lap list.
    static let lapTime = TETextStyle(size: 14.5, weight: .medium, relativeTo: .body, monospaced: true)
    /// The headline lap time on an event or session.
    static let lapTimeHero = TETextStyle(
        size: 34, weight: .medium, trackingEm: -0.02, relativeTo: .largeTitle, monospaced: true
    )

    /// Every style, for the debug gallery.
    static let all: [(name: String, style: TETextStyle)] = [
        ("hero", .hero), ("h1", .h1), ("h2", .h2), ("h3", .h3),
        ("body", .body), ("bodyStrong", .bodyStrong), ("sm", .sm), ("xs", .xs), ("xxs", .xxs),
        ("eyebrow", .eyebrow), ("lapTime", .lapTime), ("lapTimeHero", .lapTimeHero)
    ]
}

/// Font-family resolution and Dynamic Type scaling.
///
/// The web loads **Geist** and **Geist Mono** from Google Fonts. Bundling them
/// natively needs the font binaries, which are not in this repo — so until they
/// are added to `App/Fonts/` and listed under `UIAppFonts` in `Info.plist`, this
/// falls back to the system faces (SF Pro / SF Mono). A deliberate, visible seam:
/// `usesGeist` reports which is in play and the token gallery displays it.
enum Typography {
    static let sansFamily = "Geist"
    static let monoFamily = "GeistMono"

    /// Whether the Geist faces are registered in this build.
    static var usesGeist: Bool { UIFont(name: sansFamily, size: 12) != nil }

    /// The font and point-based tracking for a style at the given text size.
    static func resolve(_ style: TETextStyle, typeSize: DynamicTypeSize) -> (font: Font, tracking: CGFloat) {
        let scaled = scaledSize(style.size, relativeTo: style.relativeTo, typeSize: typeSize)
        let font: Font =
            usesGeist
            // `Font.custom(_:size:relativeTo:)` scales for us, so it takes the
            // unscaled size.
            ? .custom(style.monospaced ? monoFamily : sansFamily, size: style.size, relativeTo: style.relativeTo)
                .weight(style.weight)
            : .system(size: scaled, weight: style.weight, design: style.monospaced ? .monospaced : .default)
        return (font, style.trackingEm * scaled)
    }

    /// `UIFontMetrics`, resolved against an explicit content-size category so a
    /// `.dynamicTypeSize(...)` override in a preview or test is honored rather
    /// than the device-wide setting.
    private static func scaledSize(
        _ size: CGFloat, relativeTo style: Font.TextStyle, typeSize: DynamicTypeSize
    ) -> CGFloat {
        UIFontMetrics(forTextStyle: uiTextStyle(style)).scaledValue(
            for: size,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: contentSizeCategory(typeSize))
        )
    }

    private static func uiTextStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .body: .body
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }

    private static func contentSizeCategory(_ typeSize: DynamicTypeSize) -> UIContentSizeCategory {
        switch typeSize {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}

extension View {
    /// Apply a design-system text style: font, tracking, casing, and tabular
    /// figures for the monospaced styles.
    func teStyle(_ style: TETextStyle) -> some View {
        modifier(TETextStyleModifier(style: style))
    }
}

private struct TETextStyleModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    let style: TETextStyle

    func body(content: Content) -> some View {
        let resolved = Typography.resolve(style, typeSize: typeSize)
        content
            .font(resolved.font)
            .tracking(resolved.tracking)
            .textCase(style.uppercased ? .uppercase : nil)
            .modifier(TabularFigures(enabled: style.monospaced))
    }
}

private struct TabularFigures: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled { content.monospacedDigit() } else { content }
    }
}
