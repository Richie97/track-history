import CoreLocation
import SwiftUI
import TrackEvolutionKit

/// Start and stop a recording, and watch it run.
///
/// This is the NS-15 face of the recorder — enough to drive and verify the
/// location service. The full flow (line picker, lap review, saving to a session)
/// is NS-17 and lands on top of this.
struct RecordingScreen: View {
    @Environment(RecordingController.self) private var recorder

    /// The event a saved session will hang off, when it's already known.
    let eventId: Int?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TESpacing.gridGap) {
                if let recovered = recorder.recovered {
                    recoveryCard(recovered)
                }
                // One card at a time: a stopped recording is waiting to be
                // reviewed, and offering "start" beside it only invites the
                // question of what happens to the one on screen.
                if let reason = stopReason {
                    stoppedCard(reason)
                } else {
                    liveCard
                }
                permissionNote
            }
            .padding(TESpacing.pageGutter)
        }
        .background(Color(.bgPage))
        .navigationTitle("Record laps")
        .task {
            recorder.prepare()
            #if DEBUG
            // Test hook: lets a simulated drive be recorded without a tap.
            //   xcrun simctl location <device> start --speed=30 <waypoints…>
            //   xcrun simctl launch <device> app.trackevolution -recorder -autoRecord
            if ProcessInfo.processInfo.arguments.contains("-autoRecord"), recorder.recording == nil {
                try? recorder.start(eventId: eventId)
            }
            #endif
        }
        .alert(
            "Can't record",
            isPresented: Binding(get: { recorder.error != nil }, set: { if !$0 { recorder.error = nil } }),
            presenting: recorder.error
        ) { _ in
            Button("OK", role: .cancel) { recorder.error = nil }
            if recorder.error == .permissionDenied || recorder.error == .reducedAccuracy {
                Button("Open Settings") { openSettings() }
            }
        } message: { error in
            Text(error.localizedDescription)
        }
    }

    // MARK: - Cards

    private var liveCard: some View {
        TECard {
            VStack(alignment: .leading, spacing: 14) {
                Text(recorder.isRecording ? "Recording" : "Ready")
                    .teStyle(.eyebrow)
                    .foregroundStyle(recorder.isRecording ? Color(.accentInk) : Color(.textMuted))

                // TimelineView rather than a timer in the controller: the elapsed
                // readout is a view concern, and it stops ticking when the view
                // goes away instead of keeping a timer alive all session.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(Self.elapsed(recorder.elapsedS))
                        .teStyle(.lapTimeHero)
                        .foregroundStyle(Color(.textStrong))
                        .contentTransition(.numericText())
                }

                HStack(spacing: 24) {
                    stat("Fixes", value: "\(recorder.fixCount)")
                    stat("Speed", value: Self.speed(recorder.lastSpeedMps))
                }

                if recorder.isRecording {
                    Button("Stop recording") { recorder.stop() }
                        .buttonStyle(TEButtonStyle(kind: .danger))
                } else {
                    Button("Start recording") { try? recorder.start(eventId: eventId) }
                        .buttonStyle(TEButtonStyle(kind: .accent))
                }
            }
        }
    }

    private func stoppedCard(_ reason: RecordingController.StopReason) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Stopped")
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textMuted))
                Text(Self.explain(reason))
                    .teStyle(.body)
                    .foregroundStyle(Color(.textBody))
                HStack(spacing: 24) {
                    stat("Fixes", value: "\(recorder.fixCount)")
                    stat("Length", value: Self.elapsed(recorder.elapsedS))
                }
                if let parsed = recorder.parsed() {
                    Text("\(parsed.gps.count) fixes over \(Self.elapsed(parsed.durationS)) — ready to review")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                } else {
                    Text("Too little data to time laps from.")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                }
                // Review and save arrive with NS-17; until then the only way out
                // is to discard, and the recording stays on disk if you don't.
                Button("Discard") { recorder.discard() }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            }
        }
    }

    private func recoveryCard(_ recovered: Recording) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 8) {
                Text("Unsaved recording")
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                Text("The app closed during a recording. \(recovered.fixes.count) fixes were kept.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }

    @ViewBuilder
    private var permissionNote: some View {
        if recorder.location.authorizationStatus == .authorizedWhenInUse {
            Text("Recording keeps running with the screen locked while the location indicator is showing.")
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
        } else if recorder.location.accuracyAuthorization == .reducedAccuracy {
            Button("Allow precise location") {
                Task { await recorder.location.requestTemporaryFullAccuracy() }
            }
            .buttonStyle(TEButtonStyle(kind: .quiet))
        }
    }

    private func stat(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .teStyle(.eyebrow)
                .foregroundStyle(Color(.textFaint))
            Text(value)
                .teStyle(.lapTime)
                .foregroundStyle(Color(.textBody))
        }
    }

    private var stopReason: RecordingController.StopReason? {
        if case .stopped(let reason) = recorder.phase { return reason }
        return nil
    }

    // MARK: - Formatting

    private static func elapsed(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private static func speed(_ mps: Double?) -> String {
        guard let mps else { return "—" }
        return String(format: "%.0f mph", mps * 2.236936)
    }

    private static func explain(_ reason: RecordingController.StopReason) -> String {
        switch reason {
        case .user: "Recording stopped."
        case .forgotToStop: "Stopped automatically: the car had been driven and then sat still for 15 minutes."
        case .durationCap: "Stopped automatically at the four-hour limit."
        case .locationFailure(let error): error.localizedDescription
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// The two button shapes the app needs so far: the lime call-to-action, a danger
/// variant, and a quiet text button. The accent is used sparingly on purpose.
struct TEButtonStyle: ButtonStyle {
    enum Kind {
        case accent, danger, quiet
    }

    let kind: Kind
    /// A custom style has to dim itself: `.disabled()` alone leaves a lime button
    /// looking perfectly tappable.
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .teStyle(.bodyStrong)
            .foregroundStyle(foreground)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity)
            .background(background, in: .rect(cornerRadius: TERadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: TERadius.md)
                    .strokeBorder(kind == .quiet ? Color(.borderHairline) : .clear, lineWidth: 1)
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.4)
            .animation(TEMotion.fast, value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .accent: Color(.accentContrast)
        case .danger: Color(.dangerInk)
        case .quiet: Color(.textBody)
        }
    }

    private var background: Color {
        switch kind {
        case .accent: Color(.accent)
        case .danger: Color(.dangerTint)
        case .quiet: .clear
        }
    }
}
