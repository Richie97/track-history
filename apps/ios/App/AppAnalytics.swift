import FirebaseAnalytics
import FirebaseCore
import Foundation

/// Google Analytics for Firebase: which screens get used, and nothing else.
///
/// The native half of what `public/js/analytics.js` does for the web, under the
/// same rule: a screen is reported by its **shape** — `"/event/:id"`, never an
/// id, a share slug, an invite token or anything typed — and the shapes are the
/// web's own paths, so one report counts a screen on all three clients
/// (``Route/analyticsPath``). No user id or user property is ever set; Info.plist
/// switches off the IDFV, ad signals and the automatic screen report, and
/// AdSupport is not linked, so there is no IDFA and no tracking prompt.
///
/// Firebase is configured only in a release build (or a debug run launched with
/// `-FIRDebugEnabled`, which is also what turns on DebugView), so development,
/// the simulator, the unit tests' host and the UI tests never count. Without a
/// `GoogleService-Info.plist` in the bundle it stays off too, rather than letting
/// `FirebaseApp.configure()` trap.
@MainActor
enum AppAnalytics {
    private static var started = false
    private static var lastScreen: String?

    /// Whether this build sends anything.
    static var isEnabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-FIRDebugEnabled")
        #else
        true
        #endif
    }

    /// Called once, from `TrackEvolutionApp.init`.
    static func start() {
        guard !started, isEnabled,
              Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil
        else { return }
        FirebaseApp.configure()
        // Info.plist starts collection off; this is the one place it goes on.
        Analytics.setAnalyticsCollectionEnabled(true)
        started = true
    }

    /// Report the screen now showing, by its shape. A repeat of the screen
    /// already reported is dropped: a rotation, a shell swap or a tab bounce that
    /// lands on the same page is not a second view.
    static func screen(_ path: String) {
        guard started, path != lastScreen else { return }
        lastScreen = path
        Analytics.logEvent(AnalyticsEventScreenView, parameters: [
            AnalyticsParameterScreenName: path,
            // The class would only ever be a SwiftUI hosting controller; the
            // shape is the useful dimension, so it is both.
            AnalyticsParameterScreenClass: path,
        ])
    }
}
