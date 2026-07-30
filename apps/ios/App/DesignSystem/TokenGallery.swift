#if DEBUG
import SwiftUI

/// Debug-only gallery of the design system: every color token in both themes, the
/// type scale, and the radii.
///
/// This is how the port from `public/style.css` gets reviewed — run it beside
/// https://trackevolution.app in Safari rather than diffing hex codes by eye.
/// Excluded from release builds by the `#if DEBUG` around the file.
struct TokenGallery: View {
    @State private var forcedScheme: ColorScheme?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    fonts
                    colors
                    typeScale
                    radii
                }
                .padding(TESpacing.pageGutter)
            }
            .background(Color(.bgPage))
            .navigationTitle("Design tokens")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Picker("Theme", selection: $forcedScheme) {
                        Text("System").tag(ColorScheme?.none)
                        Text("Light").tag(ColorScheme?.some(.light))
                        Text("Dark").tag(ColorScheme?.some(.dark))
                    }
                    .pickerStyle(.segmented)
                }
            }
        }
        .preferredColorScheme(forcedScheme)
    }

    private var fonts: some View {
        VStack(alignment: .leading, spacing: 6) {
            section("Fonts")
            Text(Typography.usesGeist ? "Geist / Geist Mono (bundled)" : "SF Pro / SF Mono (Geist not bundled)")
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
        }
    }

    private var colors: some View {
        VStack(alignment: .leading, spacing: 10) {
            section("Colors — \(ColorTokens.all.count) tokens")
            ForEach(ColorTokens.all) { token in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: TERadius.xs)
                        .fill(token.color)
                        .frame(width: 56, height: 32)
                        .overlay(
                            RoundedRectangle(cornerRadius: TERadius.xs)
                                .strokeBorder(Color(.borderHairline), lineWidth: 1)
                        )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(token.name)
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.textStrong))
                        Text(token.css)
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                    Spacer()
                }
            }
        }
    }

    private var typeScale: some View {
        VStack(alignment: .leading, spacing: 12) {
            section("Type scale")
            ForEach(TETextStyle.all, id: \.name) { entry in
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.style.monospaced ? "1:58.204" : "Virginia International Raceway")
                        .teStyle(entry.style)
                        .foregroundStyle(Color(.textStrong))
                    Text("\(entry.name) · \(entry.style.size, specifier: "%g")pt")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                }
            }
        }
    }

    private var radii: some View {
        VStack(alignment: .leading, spacing: 10) {
            section("Radii")
            HStack(spacing: 10) {
                ForEach(TERadius.all, id: \.name) { entry in
                    VStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: min(entry.value, 24))
                            .fill(Color(.surfaceRaised))
                            .overlay(
                                RoundedRectangle(cornerRadius: min(entry.value, 24))
                                    .strokeBorder(Color(.borderStrong), lineWidth: 1)
                            )
                            .frame(width: 48, height: 48)
                        Text(entry.name)
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textMuted))
                    }
                }
            }
        }
    }

    private func section(_ title: String) -> some View {
        Text(title)
            .teStyle(.eyebrow)
            .foregroundStyle(Color(.textMuted))
    }
}

#Preview("Dark") {
    TokenGallery().preferredColorScheme(.dark)
}

#Preview("Light") {
    TokenGallery().preferredColorScheme(.light)
}

#Preview("Accessibility XXXL") {
    TokenGallery().dynamicTypeSize(.accessibility5)
}
#endif
