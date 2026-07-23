import CarPlay
import UIKit

// The CarPlay "driving task" scene, one screen per recorder state:
//  - idle: an information template — a status line plus one Start button;
//  - recording: a list template — a live status row (traction-circle image
//    redrawn from the GPS-derived g telemetry, elapsed time, speed) above a
//    full-width Stop row. Driving-task apps are limited to Apple's templates
//    (no custom drawing surface), so the g circle rides along as a list-item
//    image, which CarPlay lets us update in place at runtime.
// Button taps and recorder state/telemetry travel through
// CarPlayBridgePlugin.swift; the recording itself (GPS collection, lap
// derivation, saving) all stays in the web app on the phone.
//
// The scene only ever attaches when the app is signed with Apple's
// com.apple.developer.carplay-driving-task entitlement — see the README's
// CarPlay section; without it this file is dormant.
class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?
    private var tickTimer: Timer?
    private var showingRecording = false

    // Idle screen. CarPlay templates update in place when their items/actions
    // are reassigned, so both templates persist for the scene's lifetime.
    private lazy var idleTemplate = CPInformationTemplate(
        title: "Track Evolution", layout: .leading, items: [], actions: [])

    // Recording screen rows.
    private lazy var statusItem = CPListItem(
        text: "● Recording", detailText: nil, image: Self.gCircleImage(latG: 0, lonG: 0))
    private lazy var stopItem: CPListItem = {
        let item = CPListItem(text: "Stop recording", detailText: "Laps are reviewed and saved on your phone")
        item.handler = { _, completion in
            NotificationCenter.default.post(name: .carPlayCommand, object: nil, userInfo: ["action": "stop"])
            completion()
        }
        return item
    }()
    private lazy var recordingTemplate = CPListTemplate(
        title: "Track Evolution", sections: [CPListSection(items: [statusItem, stopItem])])

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        NotificationCenter.default.addObserver(
            self, selector: #selector(stateChanged), name: .carPlayStateChanged, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(telemetryChanged), name: .carPlayTelemetry, object: nil)
        showingRecording = CarPlayRecorderState.shared.recording
        render()
        interfaceController.setRootTemplate(
            showingRecording ? recordingTemplate : idleTemplate, animated: false, completion: nil)
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

    @objc private func telemetryChanged() {
        DispatchQueue.main.async { self.updateStatusRow() }
    }

    private func elapsedText(since startedAtMs: Double) -> String {
        let s = max(0, Int((Date().timeIntervalSince1970 * 1000 - startedAtMs) / 1000))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    private func render() {
        let state = CarPlayRecorderState.shared

        if state.recording != showingRecording {
            showingRecording = state.recording
            interfaceController?.setRootTemplate(
                state.recording ? recordingTemplate : idleTemplate, animated: true, completion: nil)
        }

        tickTimer?.invalidate()
        tickTimer = nil

        if state.recording {
            updateStatusRow()
            // Tick the elapsed clock between telemetry pushes (there are none
            // while waiting for the first GPS fix).
            tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                guard CarPlayRecorderState.shared.recording else { return }
                self?.updateStatusRow()
            }
            return
        }

        var items = [
            CPInformationItem(
                title: "Not recording",
                detail: "Start before you head out — laps are timed from the phone's GPS and reviewed on the phone afterwards.")
        ]
        if let message = state.message {
            // Title slot, not detail — refusals must be legible at a glance.
            items.append(CPInformationItem(title: message, detail: nil))
        }
        idleTemplate.items = items
        idleTemplate.actions = [
            CPTextButton(title: "Start recording", textStyle: .confirm) { _ in
                NotificationCenter.default.post(
                    name: .carPlayCommand, object: nil, userInfo: ["action": "start"])
            }
        ]
    }

    private func updateStatusRow() {
        let state = CarPlayRecorderState.shared
        let elapsed = state.startedAtMs.map { elapsedText(since: $0) } ?? ""
        statusItem.setText("● Recording \(elapsed)")
        let mph = Int((state.speedMps * 2.23694).rounded())
        statusItem.setDetailText("\(mph) mph" + (state.eventLabel.map { " · \($0)" } ?? ""))
        statusItem.setImage(Self.gCircleImage(latG: state.latG, lonG: state.lonG))
    }

    // The traction circle: rings at 0.5 g and 1 g with a crosshair, and a dot
    // at the current g vector (right = turning right, up = accelerating),
    // clamped just past the 1 g ring. Drawn light-on-transparent for CarPlay's
    // dark list rows.
    private static func gCircleImage(latG: Double, lonG: Double) -> UIImage {
        let side: CGFloat = 88
        let oneG: CGFloat = 30 // px radius of the 1 g ring
        let center = CGPoint(x: side / 2, y: side / 2)
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { ctx in
            let cg = ctx.cgContext
            cg.setLineWidth(1)
            for g: CGFloat in [0.5, 1.0] {
                let r = oneG * g
                cg.setStrokeColor(UIColor.white.withAlphaComponent(g == 1.0 ? 0.6 : 0.3).cgColor)
                cg.strokeEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
            }
            cg.setStrokeColor(UIColor.white.withAlphaComponent(0.25).cgColor)
            cg.move(to: CGPoint(x: center.x - oneG, y: center.y))
            cg.addLine(to: CGPoint(x: center.x + oneG, y: center.y))
            cg.move(to: CGPoint(x: center.x, y: center.y - oneG))
            cg.addLine(to: CGPoint(x: center.x, y: center.y + oneG))
            cg.strokePath()

            var x = CGFloat(latG)
            var y = CGFloat(lonG)
            let magnitude = sqrt(x * x + y * y)
            if magnitude > 1.3 {
                x *= 1.3 / magnitude
                y *= 1.3 / magnitude
            }
            let dot = CGPoint(x: center.x + x * oneG, y: center.y - y * oneG)
            cg.setFillColor(UIColor.systemOrange.cgColor)
            cg.fillEllipse(in: CGRect(x: dot.x - 5, y: dot.y - 5, width: 10, height: 10))
        }
    }
}
