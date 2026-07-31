import SwiftUI
import TrackEvolutionKit

/// The app shell: auth gate, navigation stack, and the two banners that have to be
/// visible from anywhere.
///
/// The banners are `safeAreaInset`s rather than content, deliberately. A recording
/// keeps running when you navigate away, and unsent writes keep waiting — both are
/// states you must be able to see from whatever screen you happen to be on, so
/// neither can live inside a single view.
struct RootView: View {
    @Environment(ThemeStore.self) private var theme
    @Environment(AuthController.self) private var auth
    @Environment(RecordingController.self) private var recorder

    @State private var router = AppRouter()

    var body: some View {
        #if DEBUG
        // Lets the gallery be opened without tapping through, for screenshots in
        // both appearances and at the largest text size:
        //   xcrun simctl launch <device> app.trackevolution -tokenGallery
        if ProcessInfo.processInfo.arguments.contains("-tokenGallery") {
            TokenGallery()
        } else if ProcessInfo.processInfo.arguments.contains("-recorder") {
            NavigationStack { RecordingScreen(eventId: nil) }
        } else if ProcessInfo.processInfo.arguments.contains("-channelGraphs") {
            // The lap overlay on synthetic channel data. Channels only ever come from
            // the *web* telemetry importer, so this is the one way to see the panel
            // without importing a real telemetry file first:
            //   xcrun simctl launch <device> app.trackevolution -channelGraphs
            LapChannelChart.demoScreen
        } else {
            shell
        }
        #else
        shell
        #endif
    }

    @ViewBuilder
    private var shell: some View {
        switch auth.state {
        case .unknown:
            ZStack {
                Color(.bgPage).ignoresSafeArea()
                ProgressView()
            }
        case .signedOut, .signingIn:
            SignInScreen()
                // A link that arrived while signed out is held, not dropped: tapping a
                // share link, signing in, and landing on that logbook is one flow.
                .onOpenURL { router.open($0, signedIn: false) }
        case .signedIn:
            signedIn
        }
    }

    private var signedIn: some View {
        NavigationStack(path: $router.path) {
            DashboardScreen()
                .navigationDestination(for: Route.self) { route in
                    destination(route)
                }
        }
        .environment(router)
        // A recording must be visible from wherever you are in the app,
        // since navigating away deliberately doesn't stop it.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if recorder.isRecording {
                RecordingBanner()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { SyncBanner() }
        .onOpenURL { router.open($0, signedIn: true) }
        // Cold start with a pending link, and the moment after signing in: both land
        // here, so the destination survives the auth detour either way.
        .task { router.applyPending() }
        .task {
            // Rows created offline are renumbered when the queue flushes; a screen
            // parked on a temp id has to follow. The web app does the same to
            // `location.hash` in `onSyncChange`.
            await followFlushedIds()
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .event(let id):
            EventScreen(eventId: id)
        case .eventForm(let target):
            EventFormScreen(target: target)
        case .track(let id):
            TrackScreen(trackId: id)
        case .settings:
            SettingsScreen()
        case .record(let eventId):
            RecordingScreen(eventId: eventId)
        case .shared(let slug):
            SharedLogbookScreen(slug: slug)
        }
    }

    /// Watch for the queue draining and remap any temp ids in the path.
    ///
    /// Polled on the same 3-second cadence as `SyncBanner`, and for the same reason:
    /// the store is an actor behind an async boundary, and a flush doesn't announce
    /// itself. The alternative — a notification from the store — would be a second
    /// mechanism for something already being watched.
    private func followFlushedIds() async {
        while !Task.isCancelled {
            if router.path.contains(where: Self.holdsTempId) {
                var resolved: [Int: Int] = [:]
                for id in router.path.compactMap(Self.tempId) {
                    if let real = await auth.api.resolveTempId(id) { resolved[id] = real }
                }
                if !resolved.isEmpty {
                    router.remapTempIds { resolved[$0] }
                }
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private static func tempId(_ route: Route) -> Int? {
        let id: Int? = switch route {
        case .event(let id): id
        case .eventForm(.edit(let id)): id
        case .record(let id): id
        case .track, .settings, .shared, .eventForm(.new): nil
        }
        guard let id, OfflineStore.isTemp(id) else { return nil }
        return id
    }

    private static func holdsTempId(_ route: Route) -> Bool {
        tempId(route) != nil
    }
}

#Preview {
    RootView()
        .environment(ThemeStore())
        .environment(RecordingController())
        .environment(AuthController())
}
