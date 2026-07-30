import CarPlay
import UIKit

/// The CarPlay driving-task scene: one information template, one Start/Stop button.
///
/// Deliberately that small. This is a driving-task app and Apple's review bar for
/// driver distraction is unforgiving, so every extra template is both a review risk
/// and another thing to read at 70 mph.
///
/// It talks to `AppServices.recorder` and `AppServices.remote` **directly** — the same
/// objects the phone UI drives. The Capacitor app reached the recorder through a
/// plugin, a notification centre, a JS module and a mirrored state struct; all of that
/// existed only to cross the web-view boundary, and none of it survives here.
///
/// ## The entitlement is what makes it attach
///
/// The scene manifest in `Info.plist` declares this scene, but iOS only ever attaches
/// it to an app signed with `com.apple.developer.carplay-driving-task`. Apple has
/// granted it and the key is in `TrackEvolution.entitlements`; remove it and this file
/// still compiles and ships, silently never running. That failure is invisible to
/// every test — the phone app is unaffected — so CI asserts the key is present.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var tick: Timer?

    /// One template for the life of the connection. CarPlay updates an information
    /// template in place when its items and actions are reassigned, so re-pushing
    /// would only make the screen flicker.
    private lazy var template = CPInformationTemplate(
        title: "Track Evolution", layout: .leading, items: [], actions: []
    )

    /// The last refusal, shown until the next command replaces it. A tap that does
    /// nothing and says nothing is the failure worth avoiding here — the driver has no
    /// way to investigate.
    private var message: String?

    // MARK: - Scene lifecycle

    func templateApplicationScene(
        _ scene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        interfaceController.setRootTemplate(template, animated: false, completion: nil)

        MainActor.assumeIsolated {
            render()
            startTicking()
            // A head unit can be plugged in mid-recording; without this the event
            // that recording is attached to would show as unnamed.
            Task { await AppServices.remote.refreshEventNames() }
        }
    }

    func templateApplicationScene(
        _ scene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        // Only the screen goes away. The recording is owned by `AppServices.recorder`
        // and keeps running — unplugging in the paddock must not cost a session.
        tick?.invalidate()
        tick = nil
        self.interfaceController = nil
    }

    // MARK: - Rendering

    /// Re-render once a second while connected.
    ///
    /// A timer rather than `withObservationTracking`: the elapsed readout needs a tick
    /// regardless, so polling gives state mirroring — start on the phone and the head
    /// unit shows Stop within a second — for free, instead of two mechanisms doing
    /// half the job each. CarPlay is only connected while driving, so the cost is
    /// nothing.
    @MainActor
    private func startTicking() {
        tick?.invalidate()
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.render() }
        }
    }

    @MainActor
    private func render() {
        let recorder = AppServices.recorder
        var items: [CPInformationItem] = []

        if recorder.isRecording {
            let elapsed = Self.elapsed(recorder.elapsedS)
            items.append(
                CPInformationItem(
                    title: "● Recording \(elapsed)",
                    detail: AppServices.remote.attachedEventLabel ?? "No event — will attach later"
                )
            )
            // Silence is the failure that costs a session, so a stalled fix stream is
            // said out loud rather than left to an absent number.
            items.append(
                CPInformationItem(
                    title: recorder.isStalled ? "No GPS fixes arriving" : "\(recorder.fixCount) GPS fixes",
                    detail: recorder.isStalled
                        ? "Still recording — check the phone has a view of the sky."
                        : "Lock the phone and drive. Stop back in the paddock, then review and save on the phone."
                )
            )
        } else {
            items.append(
                CPInformationItem(
                    title: "Not recording",
                    detail: "Start before you head out — laps are timed from the phone's GPS and reviewed on the phone afterwards."
                )
            )
            if let message {
                // Title slot, not detail: a refusal has to be legible at a glance.
                items.append(CPInformationItem(title: message, detail: nil))
            }
        }
        template.items = items

        let recording = recorder.isRecording
        template.actions = [
            CPTextButton(
                title: recording ? "Stop recording" : "Start recording",
                textStyle: recording ? .cancel : .confirm
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.command(stop: recording) }
            }
        ]
    }

    @MainActor
    private func command(stop: Bool) {
        if stop {
            AppServices.remote.stop()
            message = nil
            render()
            return
        }
        Task {
            let outcome = await AppServices.remote.start()
            message = outcome.reason?.carPlayMessage
            render()
        }
    }

    private static func elapsed(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
