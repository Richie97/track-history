import Foundation

/// The app's long-lived objects, in one place.
///
/// This exists for CarPlay. A `CPTemplateApplicationScene` is built by UIKit, outside
/// the SwiftUI view tree, so it has no `@Environment` to read — and NS-19 is explicit
/// that the car screen must drive **the same recorder object the phone UI uses**, not
/// a copy kept in step. The Capacitor app needed a plugin, a notification centre and a
/// mirrored state struct to achieve that across the JS bridge; natively it is a shared
/// reference.
///
/// `TrackEvolutionApp` seeds its `@State` from here rather than constructing its own,
/// so there is exactly one recorder, one auth controller and one theme store however
/// many scenes are attached.
@MainActor
enum AppServices {
    static let theme = ThemeStore()
    /// One recorder for the whole app: navigating away, locking the phone, or
    /// plugging into a head unit must not end a recording.
    static let recorder = RecordingController()
    static let auth = AuthController()
    /// Start/stop for callers with no UI — today CarPlay, tomorrow anything else that
    /// has to record without a screen.
    static let remote = RemoteRecorder(recorder: recorder, auth: auth)
    /// The App Store (NS-32): one listener on `Transaction.updates` for the life of
    /// the process, started by `TrackEvolutionApp.init` rather than by any view.
    static let store = StoreController(auth: auth)
}
