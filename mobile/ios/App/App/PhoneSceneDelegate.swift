import UIKit
import Capacitor

// The iPhone window scene. Declaring any scene manifest in Info.plist (which
// the CarPlay scene requires) moves the whole app onto the scene lifecycle —
// UIKit then ignores the classic app-delegate window path, and launching
// without a window-scene configuration is a permanent black screen. So the
// phone UI is a scene too: UIKit instantiates Main.storyboard into `window`
// automatically (UISceneStoryboardFile in the manifest); this delegate only
// forwards URL opens and universal links to Capacitor, which stops receiving
// them through the AppDelegate callbacks under the scene lifecycle.
class PhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    // Cold start with a URL or universal link: the OAuth callback / share link
    // arrives here instead of in launchOptions. Forwarding now is safe even
    // though the WebView hasn't booted — @capacitor/app retains appUrlOpen
    // until the web app subscribes, and sets the proxy's lastURL so
    // native.js's getLaunchUrl fallback also sees it.
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // UIKit builds the window from the configuration's storyboard and
        // assigns it to `window` before this runs. If that didn't happen
        // (a configuration that lost its storyboard — e.g. one restored from
        // a stale persisted session), build it by hand: a scene without a
        // window is an unrecoverable black screen.
        if window == nil, let windowScene = scene as? UIWindowScene {
            let manual = UIWindow(windowScene: windowScene)
            manual.rootViewController = UIStoryboard(name: "Main", bundle: nil).instantiateInitialViewController()
            window = manual
        }
        window?.makeKeyAndVisible()

        if let urlContext = connectionOptions.urlContexts.first {
            forward(url: urlContext.url)
        }
        if let activity = connectionOptions.userActivities.first {
            forward(activity: activity)
        }
    }

    // Warm URL opens — the trackevolution://auth OAuth callback.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        forward(url: url)
    }

    // Warm universal links — https://trackevolution.app/share/*.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        forward(activity: userActivity)
    }

    private func forward(url: URL) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    private func forward(activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity) { _ in }
    }
}
