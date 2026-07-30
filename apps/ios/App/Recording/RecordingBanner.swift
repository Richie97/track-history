import SwiftUI
import TrackEvolutionKit

/// A recording in progress, visible from every screen.
///
/// The recorder is owned above the view tree, so navigating away doesn't stop it —
/// which makes it essential that you can always *see* that it's running, and get
/// back to it in one tap. Sits above the content like a now-playing bar.
struct RecordingBanner: View {
    @Environment(RecordingController.self) private var recorder
    @State private var showingRecorder = false

    var body: some View {
        Button {
            showingRecorder = true
        } label: {
            HStack(spacing: 10) {
                // A quiet pulse: this has to read as live without being a
                // distraction on every screen.
                Circle()
                    .fill(recorder.isStalled ? Color(.dangerInk) : Color(.accent))
                    .frame(width: 8, height: 8)
                    .symbolEffect(.pulse)

                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(statusText)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textBody))
                }

                Spacer()

                Text("Open")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.accentInk))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(.surfaceRaised))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color(.borderHairline))
                    .frame(height: 1)
            }
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showingRecorder) {
            NavigationStack {
                RecordingScreen(eventId: recorder.recording?.eventIdValue)
            }
        }
    }

    private var statusText: String {
        if recorder.isStalled {
            return "No GPS fixes — recording, but not moving data"
        }
        let elapsed = Int(recorder.elapsedS.rounded())
        return "Recording · \(elapsed / 60):\(String(format: "%02d", elapsed % 60)) · \(recorder.fixCount) fixes"
    }
}
