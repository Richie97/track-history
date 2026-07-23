import Foundation
import Capacitor

// Bridges the CarPlay scene (CarPlaySceneDelegate.swift) to the web app's lap
// recorder, in both directions:
//   - JS → car screen: the recorder pushes its state via updateState();
//     CarPlayRecorderState holds the latest snapshot and the scene delegate
//     re-renders on .carPlayStateChanged — including when CarPlay connects
//     after (or before) the web app booted.
//   - car screen → JS: template button taps post .carPlayCommand, forwarded to
//     JS as "command" events; overrides/native.js routes them into
//     platform.recorderRemote. Events are retained until the web app has a
//     listener, so a tap that cold-launches the app isn't lost.
// Registered on the bridge by ViewController.capacitorDidLoad().

extension Notification.Name {
    static let carPlayStateChanged = Notification.Name("TrackEvolutionCarPlayStateChanged")
    static let carPlayTelemetry = Notification.Name("TrackEvolutionCarPlayTelemetry")
    static let carPlayCommand = Notification.Name("TrackEvolutionCarPlayCommand")
}

// Last recorder state pushed from JS. Main-thread only (Capacitor plugin
// calls and the scene delegate's renders both land there via DispatchQueue).
final class CarPlayRecorderState {
    static let shared = CarPlayRecorderState()
    var recording = false
    var eventLabel: String?
    var startedAtMs: Double?
    var message: String? // error/help line shown while not recording
    // Live telemetry (fix rate, ~1 Hz) for the recording screen's traction
    // circle. GPS-derived in public/js/record/core.js — phone-orientation-free.
    var latG = 0.0
    var lonG = 0.0
    var speedMps = 0.0
}

@objc(CarPlayBridgePlugin)
public class CarPlayBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CarPlayBridgePlugin"
    public let jsName = "CarPlayBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateTelemetry", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(onCommand(_:)), name: .carPlayCommand, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onCommand(_ note: Notification) {
        guard let action = note.userInfo?["action"] as? String else { return }
        notifyListeners("command", data: ["action": action], retainUntilConsumed: true)
    }

    @objc func updateState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let state = CarPlayRecorderState.shared
            state.recording = call.getBool("recording") ?? false
            state.eventLabel = call.getString("eventLabel")
            state.startedAtMs = call.getDouble("startedAtMs")
            state.message = call.getString("message") ?? call.getString("error")
            if !state.recording {
                state.latG = 0
                state.lonG = 0
                state.speedMps = 0
            }
            NotificationCenter.default.post(name: .carPlayStateChanged, object: nil)
        }
        call.resolve()
    }

    @objc func updateTelemetry(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let state = CarPlayRecorderState.shared
            state.latG = call.getDouble("latG") ?? 0
            state.lonG = call.getDouble("lonG") ?? 0
            state.speedMps = call.getDouble("speedMps") ?? 0
            NotificationCenter.default.post(name: .carPlayTelemetry, object: nil)
        }
        call.resolve()
    }
}
