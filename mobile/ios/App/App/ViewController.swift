import UIKit
import WebKit
import Capacitor

// Main.storyboard instantiates this instead of CAPBridgeViewController directly
// so the WKWebView gets the standard iOS edge-swipe back/forward gestures — the
// hash router pushes a history entry per screen, so web history matches in-app
// navigation. Android's equivalent (the system back gesture/button) is handled
// in overrides/native.js via the App plugin's backButton event.
class ViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }

    // App-local plugins (no npm package) register here — Capacitor exposes
    // them to the web app as Capacitor.Plugins.<jsName>.
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CarPlayBridgePlugin())
    }
}
