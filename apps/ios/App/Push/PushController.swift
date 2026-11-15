import FirebaseCore
import FirebaseMessaging
import Foundation
import Observation
import TrackEvolutionKit
import UIKit
import UserNotifications

/// Coach-comment notifications (NS-54, docs/specs/native/NS-54-comment-push.md).
///
/// The Worker sends a new comment to the other person in its thread through
/// Firebase Cloud Messaging, which delivers to this phone through APNs. This
/// object is the phone's half: it holds the FCM token, registers it with
/// `PUT /api/push/device` for the signed-in session, asks for permission when
/// it means something, and turns a tapped notification into a place in the app.
///
/// Four rules:
/// - **Firebase is configured only where `AppAnalytics` configures it** — a
///   release build, or a debug run with `-FIRDebugEnabled`. Everywhere else
///   (the simulator, the UI tests, an ordinary debug run) `isAvailable` is
///   false: nothing is asked, registered or shown, and Settings says so.
/// - **Never asked on launch.** The system prompt follows a tap on the card
///   under a comment thread (`PushAskCard`) or on Settings' toggle. *Not now*
///   is remembered for the install and the card does not come back.
/// - **A registration belongs to the session**, server-side: signing out
///   deletes it there, so this object only has to register again after each
///   sign-in. It re-registers on every arrival into the signed-in state and on
///   every token change; the PUT is idempotent.
/// - **Nothing here decides what was read.** The badge mirrors
///   `AuthController.commentsUnread`, which `/me` and `/seen` keep.
@MainActor
@Observable
final class PushController: NSObject {
    enum Permission: Equatable {
        /// Not read yet, or Firebase isn't configured in this build.
        case unknown
        case notDetermined
        case denied
        case granted
    }

    private(set) var permission: Permission = .unknown
    /// Settings' *Comment notifications*, per install. On by default: the OS
    /// permission is the real opt-in, and this is only the way back out.
    private(set) var enabled: Bool {
        didSet { defaults.set(enabled, forKey: Self.enabledKey) }
    }
    /// Whether the in-context card has had its answer (either one).
    private(set) var asked: Bool {
        didSet { defaults.set(asked, forKey: Self.askedKey) }
    }
    /// A notification the user tapped, waiting for the router. `RootView`
    /// takes it — at once when signed in, parked across a sign-in otherwise.
    var tappedLink: DeepLink?

    @ObservationIgnored private let auth: AuthController
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var fcmToken: String?
    /// The token last sent for the current session; nil after a sign-in, so
    /// the next sync sends it again.
    @ObservationIgnored private var registered: String?
    @ObservationIgnored private var wasSignedIn = false
    @ObservationIgnored private var started = false

    static let enabledKey = "push.comments.enabled"
    static let askedKey = "push.comments.asked"

    init(auth: AuthController, defaults: UserDefaults = .standard) {
        self.auth = auth
        self.defaults = defaults
        enabled = defaults.object(forKey: Self.enabledKey) as? Bool ?? true
        asked = defaults.bool(forKey: Self.askedKey)
        super.init()
    }

    /// Whether this build talks to FCM at all.
    var isAvailable: Bool { AppAnalytics.firebaseStarted }

    /// Whether to offer the card under a thread: never asked, never answered by
    /// the OS either, and not switched off in Settings.
    var shouldAsk: Bool {
        isAvailable && !asked && enabled && permission == .notDetermined
    }

    /// What Settings' toggle shows.
    var isOn: Bool { enabled && permission == .granted }

    /// Called once from `TrackEvolutionApp.init`, after `AppAnalytics.start()`.
    func start() {
        guard !started else { return }
        started = true
        // The delegate is set whatever the build, so a notification tapped on a
        // phone that has one (a release build that was updated to a debug one)
        // still lands somewhere rather than nowhere.
        UNUserNotificationCenter.current().delegate = self
        guard isAvailable else { return }
        Messaging.messaging().delegate = self
        wasSignedIn = auth.isSignedIn
        observeAccount()
        Task { await refreshPermission() }
    }

    // MARK: - Permission

    /// Read the OS's answer — at start, and each time the app comes back,
    /// since iOS Settings can change it behind our back.
    func refreshPermission() async {
        guard isAvailable else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        permission = switch settings.authorizationStatus {
        case .notDetermined: .notDetermined
        case .denied: .denied
        default: .granted
        }
        if permission == .granted, enabled { turnOn() }
    }

    /// The system prompt, from the card or the toggle. Either answer is final
    /// for the card.
    func ask() async {
        asked = true
        guard isAvailable else { return }
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        permission = granted ? .granted : .denied
        if granted {
            enabled = true
            turnOn()
        }
    }

    /// The card's *Not now*.
    func decline() {
        asked = true
    }

    enum ToggleResult {
        case done
        /// iOS has said no; only its Settings app can change that.
        case openSystemSettings
    }

    /// Settings' toggle.
    func setEnabled(_ on: Bool) async -> ToggleResult {
        guard on else {
            enabled = false
            registered = nil
            // Best effort: a failure leaves the server's row, and the next
            // successful sign-in or toggle settles it. A sign-out deletes it
            // anyway.
            try? await auth.api.unregisterPushDevice()
            return .done
        }
        switch permission {
        case .denied:
            return .openSystemSettings
        case .notDetermined, .unknown:
            await ask()
            return permission == .denied ? .openSystemSettings : .done
        case .granted:
            enabled = true
            turnOn()
            return .done
        }
    }

    /// Let Messaging make its token, and ask APNs for ours.
    private func turnOn() {
        guard isAvailable else { return }
        Messaging.messaging().isAutoInitEnabled = true
        UIApplication.shared.registerForRemoteNotifications()
        Task { await sync() }
    }

    // MARK: - Tokens

    /// The APNs device token, from the app delegate. Messaging needs it before
    /// it can mint an FCM token on a real device.
    func apnsToken(_ token: Data) {
        guard isAvailable else { return }
        Messaging.messaging().apnsToken = token
    }

    fileprivate func received(fcmToken token: String?) {
        guard token != fcmToken else { return }
        fcmToken = token
        registered = nil
        Task { await sync() }
    }

    /// Send the token for this session if it hasn't been yet.
    private func sync() async {
        guard isAvailable, enabled, permission == .granted, auth.isSignedIn,
              let token = fcmToken, token != registered
        else { return }
        do {
            try await auth.api.registerPushDevice(platform: .ios, token: token)
            registered = token
        } catch {
            // Offline, or the server is down: the next foreground or sign-in
            // tries again.
        }
    }

    /// The app is in front again.
    func becameActive() async {
        await refreshPermission()
        await sync()
    }

    private func observeAccount() {
        withObservationTracking {
            _ = auth.state
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let signedIn = self.auth.isSignedIn
                // A fresh session (a sign-in, or launch restoring one) has no
                // registration on the server yet.
                if signedIn, !self.wasSignedIn { self.registered = nil }
                self.wasSignedIn = signedIn
                if signedIn { await self.sync() } else { self.registered = nil }
                self.observeAccount()
            }
        }
    }

    // MARK: - Badge

    /// The app icon's badge: what is waiting to be read. Set from the inbox's
    /// count whenever it changes, which is every `/me` and every `/seen`.
    func setBadge(_ count: Int) {
        guard isAvailable, permission == .granted else { return }
        UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }

    // MARK: - Taps

    fileprivate func tapped(_ data: [String: String]) {
        guard let link = DeepLink.commentPush(data) else { return }
        tappedLink = link
    }

    /// A comment arrived while the app was in front: the inbox's count and
    /// feed are stale.
    fileprivate func arrivedInForeground() {
        Task { await auth.inbox.refresh() }
    }

    /// FCM's `data` arrives in `userInfo` beside `aps` and Firebase's own keys;
    /// only string values are ours.
    nonisolated static func data(_ userInfo: [AnyHashable: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in userInfo {
            if let key = key as? String, let value = value as? String { out[key] = value }
        }
        return out
    }
}

extension PushController: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in self.received(fcmToken: fcmToken) }
    }
}

extension PushController: UNUserNotificationCenterDelegate {
    /// In front: show it as a banner anyway — the thread it is about is usually
    /// not the page on screen — and bring the inbox up to date.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let data = Self.data(notification.request.content.userInfo)
        if data["kind"] == "comment" {
            await MainActor.run { self.arrivedInForeground() }
        }
        return [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let data = Self.data(response.notification.request.content.userInfo)
        await MainActor.run { self.tapped(data) }
    }
}
