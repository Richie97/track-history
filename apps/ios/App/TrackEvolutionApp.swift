import SwiftUI

/// SwiftUI lifecycle, so the app is scene-based from birth — which is what makes
/// the CarPlay driving-task scene (NS-19) a pure addition rather than the
/// scene-manifest surgery the Capacitor shell needed.
@main
struct TrackEvolutionApp: App {
    /// The theme override (system/light/dark), persisted. Owned here because the
    /// root scene applies it and Settings writes it.
    @State private var theme = ThemeStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(theme)
                .preferredColorScheme(theme.preference.colorScheme)
        }
    }
}
