import SwiftUI
import TrackEvolutionKit

/// Placeholder shell. The real navigation lands with the core screens (NS-25);
/// this exists so the scaffold has something to launch into, exercises the Kit
/// dependency, and — in debug builds — opens the design-token gallery.
struct RootView: View {
    @Environment(ThemeStore.self) private var theme
    @Environment(AuthController.self) private var auth

    var body: some View {
        #if DEBUG
        // Lets the gallery be opened without tapping through, for screenshots in
        // both appearances and at the largest text size:
        //   xcrun simctl launch <device> app.trackevolution -tokenGallery
        if ProcessInfo.processInfo.arguments.contains("-tokenGallery") {
            TokenGallery()
        } else if ProcessInfo.processInfo.arguments.contains("-recorder") {
            NavigationStack { RecordingScreen(eventId: nil) }
        } else {
            placeholder
        }
        #else
        placeholder
        #endif
    }

    @ViewBuilder
    private var placeholder: some View {
        switch auth.state {
        case .unknown:
            ZStack {
                Color(.bgPage).ignoresSafeArea()
                ProgressView()
            }
        case .signedOut, .signingIn:
            SignInScreen()
        case .signedIn(let me):
            signedIn(me)
        }
    }

    private func signedIn(_ me: Me?) -> some View {
        NavigationStack {
            ZStack {
                Color(.bgPage)
                    .ignoresSafeArea()

                VStack(spacing: 14) {
                    Text("Track Evolution")
                        .teStyle(.h1)
                        .foregroundStyle(Color(.textStrong))
                    Text(me?.user.email ?? auth.server.url.host() ?? "")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))

                    NavigationLink("Record laps") {
                        RecordingScreen(eventId: nil)
                    }
                    .teStyle(.bodyStrong)
                    .foregroundStyle(Color(.accentInk))
                    .padding(.top, 8)

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
        .environment(RecordingController())
        .environment(AuthController())
}
