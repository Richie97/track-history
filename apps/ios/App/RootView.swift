import SwiftUI
import TrackEvolutionKit

/// Placeholder shell. The real navigation lands with the core screens (NS-25);
/// this exists so the scaffold has something to launch into, exercises the Kit
/// dependency, and — in debug builds — opens the design-token gallery.
struct RootView: View {
    @Environment(ThemeStore.self) private var theme

    var body: some View {
        #if DEBUG
        // Lets the gallery be opened without tapping through, for screenshots in
        // both appearances and at the largest text size:
        //   xcrun simctl launch <device> app.trackevolution -tokenGallery
        if ProcessInfo.processInfo.arguments.contains("-tokenGallery") {
            TokenGallery()
        } else {
            placeholder
        }
        #else
        placeholder
        #endif
    }

    private var placeholder: some View {
        NavigationStack {
            ZStack {
                Color(.bgPage)
                    .ignoresSafeArea()

                VStack(spacing: 14) {
                    Text("Track Evolution")
                        .teStyle(.h1)
                        .foregroundStyle(Color(.textStrong))
                    Text(TrackEvolutionKit.defaultBaseURL.host() ?? "")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))

                    #if DEBUG
                    NavigationLink("Design tokens") {
                        TokenGallery()
                    }
                    .teStyle(.bodyStrong)
                    .foregroundStyle(Color(.accentInk))
                    .padding(.top, 8)
                    #endif

                    Picker("Theme", selection: Binding(get: { theme.preference }, set: { theme.preference = $0 })) {
                        ForEach(ThemePreference.allCases) { preference in
                            Text(preference.label).tag(preference)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 260)
                    .padding(.top, 8)
                }
                .padding(TESpacing.pageGutter)
            }
        }
    }
}

#Preview {
    RootView()
        .environment(ThemeStore())
}
