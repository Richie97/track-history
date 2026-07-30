import SwiftUI
import TrackEvolutionKit

/// Placeholder shell. The real navigation lands with the core screens (NS-25);
/// this exists so the scaffold has something to launch into and so the Kit
/// dependency is exercised by the build.
struct RootView: View {
    var body: some View {
        ZStack {
            Color(.launchBackground)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                Text("Track Evolution")
                    .font(.system(.title, design: .rounded, weight: .semibold))
                Text(TrackEvolutionKit.defaultBaseURL.host() ?? "")
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .preferredColorScheme(.dark)
    }
}

#Preview {
    RootView()
}
