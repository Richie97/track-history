import SwiftUI

/// The app mark: the Speedshift double-bar on a lime disc.
///
/// The native port of `appLogoHtml`/`ssBars` in `public/app.js` — same viewBox,
/// same two rectangles, same rule that the bars are drawn in `--accent-contrast`
/// because dark ink is what sits on the lime fill. The web login card leads with
/// it and the sign-in screen had nothing at all, which read as a half-loaded
/// page rather than a deliberately spare one.
///
/// A `Shape` rather than a bundled image so it scales to any size and follows the
/// color tokens in both appearances; there is no logo asset in the catalog to
/// drift from.
struct BrandMark: View {
    /// Diameter of the disc. `.app-logo` is 26px in the web header, 56px (`.lg`)
    /// on the login card.
    var size: CGFloat = 56

    var body: some View {
        SpeedshiftBars()
            .fill(Color(.accentContrast))
            // `.app-logo svg { height: 54%; width: auto }` — the mark sits inside
            // the disc rather than spanning it.
            .frame(
                width: size * 0.54 * SpeedshiftBars.aspectRatio,
                height: size * 0.54
            )
            .frame(width: size, height: size)
            .background(Color(.accent), in: .circle)
            .accessibilityHidden(true)
    }
}

/// The two slashes of the Speedshift mark, straight from the SVG in
/// `public/app.js`: a rect apiece, each rotated about its own origin, laid out in
/// a 429×629 viewBox they fill exactly.
private struct SpeedshiftBars: Shape {
    private static let viewBox = CGSize(width: 429, height: 629)
    static let aspectRatio = viewBox.width / viewBox.height

    private static let bars: [(origin: CGPoint, size: CGSize, degrees: CGFloat)] = [
        (CGPoint(x: 0.589722, y: 115.848), CGSize(width: 163, height: 442.765), -44.9265),
        (CGPoint(x: 311.969, y: 198.246), CGSize(width: 163, height: 442.765), 44.5184)
    ]

    func path(in rect: CGRect) -> Path {
        // Aspect-fit the viewBox, as an <svg> does by default.
        let scale = min(rect.width / Self.viewBox.width, rect.height / Self.viewBox.height)
        let originX = rect.minX + (rect.width - Self.viewBox.width * scale) / 2
        let originY = rect.minY + (rect.height - Self.viewBox.height * scale) / 2

        var path = Path()
        for bar in Self.bars {
            let radians = bar.degrees * .pi / 180
            // SVG's `rotate(a cx cy)` turns the rect about (cx, cy) — which here is
            // the rect's own origin, so the corners rotate around it.
            let corners = [
                CGPoint(x: 0, y: 0),
                CGPoint(x: bar.size.width, y: 0),
                CGPoint(x: bar.size.width, y: bar.size.height),
                CGPoint(x: 0, y: bar.size.height)
            ].map { corner in
                CGPoint(
                    x: originX + (corner.x * cos(radians) - corner.y * sin(radians) + bar.origin.x) * scale,
                    y: originY + (corner.x * sin(radians) + corner.y * cos(radians) + bar.origin.y) * scale
                )
            }
            path.addLines(corners)
            path.closeSubpath()
        }
        return path
    }
}

#Preview {
    VStack(spacing: 24) {
        BrandMark()
        BrandMark(size: 26)
    }
    .padding()
    .background(Color(.bgPage))
}
