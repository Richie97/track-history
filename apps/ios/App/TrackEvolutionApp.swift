import SwiftUI
import TrackEvolutionKit

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
                // Measured on the *window*, above the root view, so `RootView`
                // itself can read the class and choose its shell (NS-34): a view
                // cannot both install an environment value and read it in the same
                // body. Everything below shares this one measurement.
                .measuringLayoutClass()
                .environment(theme)
                .environment(recorder)
                .environment(auth)
                .environment(store)
                // The account's unit system, as one environment *value*: the
                // charts read it without an `AuthController`, which the
                // `-channelGraphs` launch opens them without.
                .environment(\.unitSystem, auth.units)
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

// MARK: - The unit system

/// The account's unit system, for every view that shows a speed, a distance or a
/// temperature (`Units` in the Kit does the converting).
///
/// An environment *value* rather than a read of `AuthController`, because the
/// charts are also opened without one (the `-channelGraphs` launch argument), and
/// a missing `@Environment(AuthController.self)` traps where a missing value falls
/// back to imperial — what the app always showed, and the server's own default.
private struct UnitSystemKey: EnvironmentKey {
    static let defaultValue: UnitSystem = Units.DEFAULT_UNITS
}

extension EnvironmentValues {
    var unitSystem: UnitSystem {
        get { self[UnitSystemKey.self] }
        set { self[UnitSystemKey.self] = newValue }
    }
}

/// `SessionConditions` and `Health` name their two systems the stored one and the
/// US one — the channels' units against what the app showed before the preference
/// existed — so the account's choice maps onto that pair, as `condUnits()` does in
/// `public/app.js`.
extension SessionConditions.Units {
    init(_ units: UnitSystem) {
        self = units == .metric ? .metric : .us
    }
}

extension Health.Units {
    init(_ units: UnitSystem) {
        self = units == .metric ? .metric : .us
    }
}
