import SwiftUI

/// SwiftUI lifecycle, so the app is scene-based from birth — which is what makes
/// the CarPlay driving-task scene (NS-19) a pure addition rather than the
/// scene-manifest surgery the Capacitor shell needed.
@main
struct TrackEvolutionApp: App {
    // Seeded from `AppServices` rather than constructed here, so the CarPlay scene —
    // built by UIKit, outside this view tree — drives the very same objects instead of
    // a copy kept in step. See `AppServices`.

    /// The theme override (system/light/dark), persisted. Owned here because the
    /// root scene applies it and Settings writes it.
    @State private var theme = AppServices.theme
    /// One recorder for the whole app: navigating away must not end a recording.
    @State private var recorder = AppServices.recorder
    @State private var auth = AppServices.auth

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(theme)
                .environment(recorder)
                .environment(auth)
                .preferredColorScheme(theme.preference.colorScheme)
                // A recording the app died on is offered back on next launch.
                .task { recorder.recoverIfNeeded() }
                .task { await auth.restore() }
        }
    }
}
