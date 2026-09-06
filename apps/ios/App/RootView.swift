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
    @Environment(\.layout) private var layout

    @State private var router = AppRouter()

    /// The window's measurement arrives from `TrackEvolutionApp`, which applies
    /// `measuringLayoutClass()` around this view — a body cannot both install an
    /// environment value and read it.
    @ViewBuilder
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
        navigationShell
        .environment(router)
        // A recording must be visible from wherever you are in the app,
        // since navigating away deliberately doesn't stop it.
        //
        // Outside the shell, so at expanded width both banners span the **window**
        // rather than one pane (NS-34). A recording visible only above the detail
        // would be invisible exactly when the driver is looking at the list.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if recorder.isRecording {
                RecordingBanner()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { SyncBanner() }
        // The two routes that own the window rather than a pane. Over the banners
        // as well as the panes: the recorder *is* the recording, so it does not
        // need one above it, and the review inside it must not be dismissable by
        // anything but its own save or discard.
        .fullScreenCover(item: $router.fullWindow) { route in
            NavigationStack {
                destination(route)
            }
            .environment(router)
        }
        .onOpenURL { url in
            // A video handed over by Files or the share sheet is a file URL, not one
            // of our links — `DeepLink` doesn't know about it and shouldn't.
            if url.isFileURL {
                router.show(.importVideo(eventId: nil, incoming: url))
                return
            }
            router.open(url, signedIn: true)
        }
        // Cold start with a pending link, and the moment after signing in: both land
        // here, so the destination survives the auth detour either way.
        .task { router.applyPending() }
        #if DEBUG
        .task {
            // -importFixture <clip>: open NS-30's import on a committed fixture,
            // skipping only the system picker. See `DebugImportFixture`.
            if let url = DebugImportFixture.pendingURL {
                router.show(.importVideo(eventId: DebugImportFixture.pendingEventId, incoming: url))
            }
        }
        #endif
        .task {
            // Rows created offline are renumbered when the queue flushes; a screen
            // parked on a temp id has to follow. The web app does the same to
            // `location.hash` in `onSyncChange`.
            await followFlushedIds()
        }
    }

    /// One column, or two (NS-34).
    ///
    /// The split view is used only at **expanded** width, not handed the whole job
    /// and left to collapse itself. Its own collapsing follows the *size class*,
    /// and an iPad in portrait is `.regular` at 834pt — squarely in medium, where
    /// the spec wants the phone layout with its column capped, not two panes. So
    /// the class decides, as it does everywhere else in this spec.
    ///
    /// The cost is real and worth stating: crossing 840pt swaps one container for
    /// the other, and a screen's `@State` model goes with it — a half-typed event
    /// form would not survive being dragged across the breakpoint in Stage
    /// Manager. It survives rotation, Split View within a tier, and every ordinary
    /// resize; only crossing the boundary itself is destructive. Android has
    /// `SavedStateHandle` for this and iOS has nothing equivalent at this level,
    /// so the alternative is a scene-storage draft on the form — NS-34 ticket 4's
    /// fold audit is where that question belongs, on the platform that has it.
    @ViewBuilder
    private var navigationShell: some View {
        if layout.layoutClass == .expanded {
            splitShell
        } else {
            stackShell
        }
    }

    /// Today's shell, unchanged: the dashboard is the root and everything pushes.
    private var stackShell: some View {
        NavigationStack(path: $router.path) {
            DashboardScreen()
                .navigationDestination(for: Route.self) { route in
                    destination(route)
                }
        }
    }

    /// List and detail, sharing the one path.
    ///
    /// `router.path` means exactly what it meant before — the pushes on top of the
    /// root — and only the *root* differs: the dashboard in the stack shell, the
    /// empty state here, because the dashboard is already the pane beside it and
    /// showing it twice is the one thing the spec rules out by name. That is why a
    /// deep link needs no width check: `show(_:)` sets the path, and the path is
    /// the detail either way.
    private var splitShell: some View {
        NavigationSplitView {
            DashboardScreen()
                // Never narrower than a phone. The dashboard's own content sets
                // this floor — a hero card with a countdown, three stat tiles and
                // track cards carrying lap times were all drawn for ~390pt, and a
                // 320pt sidebar squeezes every one of them for the sake of a
                // detail pane that already has room to spare.
                .navigationSplitViewColumnWidth(min: 390, ideal: 420, max: 520)
                .measuringPaneWidth()
        } detail: {
            NavigationStack(path: $router.path) {
                DetailPlaceholder()
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
            }
            .measuringPaneWidth()
        }
        .navigationSplitViewStyle(.balanced)
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
        case .vehicle(let id):
            VehicleScreen(vehicleId: id)
        case .settings:
            SettingsScreen()
        case .record(let eventId):
            // Discarding leaves the recorder for the dashboard rather than popping one
            // step onto a Start button.
            RecordingScreen(eventId: eventId, onFinish: { router.popToRoot() })
        case .importVideo(let eventId, let incoming):
            ImportScreen(eventId: eventId, incoming: incoming)
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
        case .importVideo(let id, _): id
        case .track, .vehicle, .settings, .shared, .eventForm(.new): nil
        }
        guard let id, OfflineStore.isTemp(id) else { return nil }
        return id
    }

    private static func holdsTempId(_ route: Route) -> Bool {
        tempId(route) != nil
    }
}

#Preview {
    let auth = AuthController()
    RootView()
        .environment(ThemeStore())
        .environment(RecordingController())
        .environment(auth)
        .environment(StoreController(auth: auth))
}
