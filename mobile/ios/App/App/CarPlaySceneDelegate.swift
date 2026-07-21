import CarPlay
import UIKit

// The CarPlay "driving task" scene: a single information template mirroring
// the lap recorder — a status line plus one Start/Stop button, nothing to read
// or navigate while driving. Button taps and recorder state travel through
// CarPlayBridgePlugin.swift; the recording itself (GPS collection, lap
// derivation, saving) all stays in the web app on the phone.
//
// Info.plist's UIApplicationSceneManifest declares only this CarPlay scene
// role, so the iPhone app keeps its classic app-delegate lifecycle. The scene
// only ever attaches when the app is signed with Apple's
// com.apple.developer.carplay-driving-task entitlement — see the README's
// CarPlay section; without it this file is dormant.
class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?
    private var tickTimer: Timer?
    private lazy var template = CPInformationTemplate(
        title: "Track Evolution", layout: .leading, items: [], actions: [])

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        NotificationCenter.default.addObserver(
            self, selector: #selector(stateChanged), name: .carPlayStateChanged, object: nil)
        render()
        interfaceController.setRootTemplate(template, animated: false, completion: nil)
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        NotificationCenter.default.removeObserver(self)
        tickTimer?.invalidate()
        tickTimer = nil
        self.interfaceController = nil
    }

    @objc private func stateChanged() {
        DispatchQueue.main.async { self.render() }
    }

    private func elapsedText(since startedAtMs: Double) -> String {
        let s = max(0, Int((Date().timeIntervalSince1970 * 1000 - startedAtMs) / 1000))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    // Re-render the (persistent) template from the shared state. CarPlay
    // templates update in place when their items/actions are reassigned.
    private func render() {
        let state = CarPlayRecorderState.shared
        var items: [CPInformationItem] = []

        if state.recording {
            let elapsed = state.startedAtMs.map { elapsedText(since: $0) } ?? ""
            items.append(CPInformationItem(title: "● Recording \(elapsed)", detail: state.eventLabel))
            items.append(CPInformationItem(
                title: nil,
                detail: "Lock the phone and drive — stop back in the paddock, then review and save your laps on the phone."))
        } else {
            items.append(CPInformationItem(
                title: "Not recording",
                detail: "Start before you head out — laps are timed from the phone's GPS and reviewed on the phone afterwards."))
            if let message = state.message {
                items.append(CPInformationItem(title: nil, detail: message))
            }
        }
        template.items = items

        template.actions = [
            CPTextButton(
                title: state.recording ? "Stop recording" : "Start recording",
                textStyle: state.recording ? .cancel : .confirm
            ) { _ in
                let recording = CarPlayRecorderState.shared.recording
                NotificationCenter.default.post(
                    name: .carPlayCommand, object: nil,
                    userInfo: ["action": recording ? "stop" : "start"])
            }
        ]

        // Tick the elapsed line once a second while recording; items-only
        // updates so the button never flickers mid-tap.
        tickTimer?.invalidate()
        tickTimer = nil
        if state.recording {
            tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                guard let self = self, CarPlayRecorderState.shared.recording else { return }
                let st = CarPlayRecorderState.shared
                let elapsed = st.startedAtMs.map { self.elapsedText(since: $0) } ?? ""
                var ticked = self.template.items
                if !ticked.isEmpty {
                    ticked[0] = CPInformationItem(title: "● Recording \(elapsed)", detail: st.eventLabel)
                    self.template.items = ticked
                }
            }
        }
    }
}
