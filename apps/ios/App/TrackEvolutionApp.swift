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
    @State private var store = AppServices.store
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // The `Transaction.updates` listener has to exist before the first view and
        // outlive every view: renewals and Ask to Buy approvals arrive with no
        // paywall on screen, and a transaction nobody is listening for is a
        // transaction that waits until the next launch to reach the server.
        AppServices.store.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(theme)
                .environment(recorder)
                .environment(auth)
                .environment(store)
                .preferredColorScheme(theme.preference.colorScheme)
                // A recording the app died on is offered back on next launch.
                .task { recorder.recoverIfNeeded() }
                .task { await auth.restore() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Back in the foreground: a purchase that met no network, or a legacy
            // claim that couldn't reach the App Store at launch, gets another go.
            if phase == .active {
                Task { await store.retryPending() }
            }
        }
    }
}
