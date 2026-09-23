import Foundation
import TrackEvolutionKit

/// Where you can be in the app, as a value.
///
/// A typed `NavigationStack` path rather than the web app's hash router: the stack
/// *is* the history, so "back" is the system gesture and a screen's state survives
/// a push instead of being re-rendered from a template string.
enum Route: Hashable {
    case event(Int)
    case eventForm(EventFormTarget)
    case track(Int)
    /// A track's leaderboard, behind the track page's button. Keyed by the
    /// viewer's own track, because that is what the server keys the board on.
    case leaderboard(trackId: Int)
    /// A car's garage page: its logbook for everyone, and for Pro its
    /// consumables and wear (NS-37).
    case vehicle(Int)
    case settings
    /// NS-17's recorder. Deliberately not reachable from a link — see `DeepLink`.
    case record(eventId: Int?)
    /// NS-30's video import. `incoming` is set when Files or the share sheet handed
    /// the app a clip directly, so the picker is skipped.
    ///
    /// `forNewEvent` is the New Event form's door: there is no event to save onto
    /// yet, so the review hands its session drafts back to the form through
    /// ``AppRouter/stagedSessions`` instead of posting them, and the form posts
    /// them itself once the event exists. Same chooser, same review — only where
    /// the sessions go differs.
    case importVideo(eventId: Int?, incoming: URL?, forNewEvent: Bool = false)
    /// Someone's public logbook, read-only.
    case shared(slug: String)
    /// One lap of one session, from its row on the event page (#267). Carries the
    /// event id because the screen reads the event detail — the same cached read
    /// the page made — and finds the session and lap in it. Not a `DeepLink`:
    /// a lap id means nothing away from the page it came from.
    case lap(eventId: Int, sessionId: Int, lapId: Int)
    /// Season Wrapped (NS-36): one calendar year as a story of cards, opened from
    /// the dashboard's November banner. Not a `DeepLink` — the web's
    /// `#/wrapped/:year` is a web route, and the app's door is the banner.
    case wrapped(year: Int)
}

extension Route {
    /// Whether this destination needs the **whole window** rather than a pane
    /// (NS-34).
    ///
    /// Three of them do, for the same reason rather than three: each is a task you
    /// are doing *instead of* reading the logbook, not alongside it. Season Wrapped
    /// is the third — a story told one full-screen card at a time, which a pane
    /// would make a postcard of. The record screen
    /// is a phone-in-a-mount layout meant to be read at a glance, and half an iPad
    /// is a worse version of it rather than a bigger one; the importer ends in the
    /// review, which is modal by nature and which NS-26 keeps above the graph on
    /// Android for exactly this reason.
    ///
    /// Below expanded width this changes nothing — the stack already fills the
    /// window, so a push is full-window and keeps the back gesture.
    var ownsTheWindow: Bool {
        switch self {
        case .record, .importVideo, .wrapped: true
        case .event, .eventForm, .track, .leaderboard, .vehicle, .settings, .shared, .lap: false
        }
    }
}

extension Route {
    /// This route on a machine that may have no recorder (epic #230), or nil for
    /// the dashboard.
    ///
    /// On a Mac the record route goes to the event it was for, or to the dashboard
    /// when it had none — never to `RecordingScreen`, whose Start would be dead
    /// over Wi-Fi location. Every other route is itself; the importer included,
    /// since Finder is a better import door than a phone. `AppRouter` applies this
    /// to every push, show and presentation, so a stale path, a banner or a door
    /// `Platform`'s two surface rules missed cannot reach the recorder either.
    /// Off the Mac it is the identity, which is what keeps the phone byte-for-byte
    /// unchanged.
    func resolved(runsOnMac: Bool) -> Route? {
        guard runsOnMac, case .record(let eventId) = self else { return self }
        return eventId.map { .event($0) }
    }
}

/// The two halves of the app (NS-37): the logbook and the garage, one tab each.
/// Each keeps its own navigation path, so switching tabs never loses your place
/// in the other.
enum AppTab: Hashable {
    case events
    case garage
}

extension Route {
    /// The tab a route belongs to when it is **opened** — a deep link, the list
    /// pane, `show` — or nil for one that belongs to neither and opens wherever
    /// you already are (Settings, reached from either tab's account button).
    ///
    /// A *push* ignores this on purpose: an event page linking to its car keeps
    /// the car on the Events stack, so Back returns to the event you came from
    /// rather than to a different tab.
    var tab: AppTab? {
        switch self {
        case .vehicle: .garage
        case .settings: nil
        case .event, .eventForm, .track, .leaderboard, .record, .importVideo, .shared, .lap, .wrapped: .events
        }
    }
}

/// A route identifies itself, so it can drive a `fullScreenCover(item:)` without
/// a wrapper type. Safe because `Route` is already `Hashable` and carries no
/// mutable state — two equal routes *are* the same destination.
extension Route: Identifiable {
    var id: Self { self }
}

/// New or existing, in one value so the form has a single input.
enum EventFormTarget: Hashable {
    /// A new event, optionally starting at a known track (the track page's
    /// "+ Add event at …").
    case new(presetTrack: String?)
    case edit(Int)
}

/// Owns the navigation path, and turns outside links into pushes.
@MainActor
@Observable
final class AppRouter {
    /// Which tab is showing (NS-37).
    var tab: AppTab = .events
    /// Each tab's own stack. Bound one to each tab's `NavigationStack`; everything
    /// else goes through ``path``, the stack of the tab on screen.
    var eventsPath: [Route] = []
    var garagePath: [Route] = []

    /// The stack of the tab on screen — what every screen means by "the path".
    var path: [Route] {
        get { self.path(for: tab) }
        set { setPath(newValue, for: tab) }
    }

    func path(for tab: AppTab) -> [Route] {
        switch tab {
        case .events: eventsPath
        case .garage: garagePath
        }
    }

    private func setPath(_ routes: [Route], for tab: AppTab) {
        switch tab {
        case .events: eventsPath = routes
        case .garage: garagePath = routes
        }
    }

    /// Every route on either stack — what the temp-id follower watches.
    var allRoutes: [Route] { eventsPath + garagePath }

    /// The Garage tab's badge: maintenance reminders (due or low) across the
    /// cars, for Pro. Written by whichever screen last read `GET /api/garage` —
    /// the dashboard on launch, the Garage and a car's page after that — and read
    /// by nothing but the tab item, so the count costs no request of its own.
    var garageAlertCount = 0

    /// Bumped by every garage write a car's page makes (NS-37). The Garage list
    /// watches it: beside the detail at expanded width the list never leaves the
    /// screen, so "reload when it reappears" would never fire and a deleted or
    /// renamed car would stay listed.
    var garageRevision = 0

    /// Whether the iPad build is running on a Mac (epic #230). Injected so the
    /// tests can drive both answers; the app passes `Platform.runsOnMac`.
    let runsOnMac: Bool

    init(runsOnMac: Bool = Platform.runsOnMac) {
        self.runsOnMac = runsOnMac
    }

    /// A route that must own the **whole window** rather than a pane (NS-34).
    ///
    /// Only two things are ever put here, and both for the same reason: the record
    /// screen is a phone-in-a-mount layout that a half-width detail pane would
    /// ruin, and the importer ends in the review, which is modal by nature. At
    /// compact and medium width this stays nil and both are ordinary pushes — the
    /// stack already fills the window there.
    var fullWindow: Route?

    /// Session drafts an import staged for the New Event form — the outcome of a
    /// review begun with `importVideo(forNewEvent: true)`, handed back along the
    /// path the way Android's `RecordingFlow.staged` does it. The form takes them
    /// the moment it is back on screen and empties this; nothing else reads it.
    var stagedSessions: [SessionDraft] = []

    /// What the list pane has selected: the detail's root, or nil for its empty
    /// state.
    ///
    /// `path.first` rather than a second stored property, so there is one source
    /// of truth for where the app is. A deep link that calls ``show(_:)`` moves
    /// the selection with it for free, and nothing can get out of step.
    var selection: Route? { path.first }

    /// A link that arrived before there was a stack to put it on — at cold start,
    /// or while signed out. Applied by `applyPending()` once the app is signed in,
    /// so tapping a share link, signing in, and landing on that logbook is one
    /// uninterrupted flow.
    private var pending: Route?

    func push(_ route: Route) {
        guard let route = route.resolved(runsOnMac: runsOnMac) else { popToRoot(); return }
        path.append(route)
    }

    func popToRoot() {
        path.removeAll()
    }

    /// Replace the stack with a single destination — what a deep link should do,
    /// rather than burying the dashboard under an arbitrary history. On the tab
    /// the route belongs to (NS-37), so a link to a car lands in the Garage.
    func show(_ route: Route) {
        guard let route = route.resolved(runsOnMac: runsOnMac) else {
            // The dashboard: the Events tab's root.
            tab = .events
            eventsPath = []
            return
        }
        if let home = route.tab { tab = home }
        path = [route]
    }

    /// Open a route **from the list pane** (NS-34).
    ///
    /// Replaces the detail rather than deepening it: the dashboard is beside the
    /// detail at expanded width, not behind it, so picking a second track from it
    /// means "show me this one", never "push this on top of the last one".
    ///
    /// At compact and medium width this is indistinguishable from ``push(_:)``,
    /// and not by coincidence — the dashboard is the stack's *root* there, so its
    /// cards are only ever tapped while the path is empty, and appending to an
    /// empty path is the same operation. That is what lets one dashboard serve
    /// both shells with no width check in it.
    func open(_ route: Route) {
        show(route)
    }

    /// Present a route over the whole window, at any width. See ``fullWindow``.
    ///
    /// On a Mac the recorder resolves to its event, and an event is a detail, not
    /// a cover — so it is opened where the list pane would have opened it.
    func presentFullWindow(_ route: Route) {
        guard let route = route.resolved(runsOnMac: runsOnMac) else { popToRoot(); return }
        if route.ownsTheWindow {
            fullWindow = route
        } else {
            open(route)
        }
    }

    func dismissFullWindow() {
        fullWindow = nil
    }

    /// Handle a URL from the OS. Returns false when it isn't ours, so the caller
    /// can leave it alone (the OAuth redirect is the case that matters: consuming
    /// it here would race the sign-in flow).
    @discardableResult
    func open(_ url: URL, signedIn: Bool) -> Bool {
        guard let link = DeepLink.parse(url) else { return false }
        let route = Self.route(for: link)
        guard signedIn else {
            // Held rather than dropped: the destination outlives the sign-in detour.
            pending = route
            return true
        }
        if let route { show(route) } else { tab = .events; eventsPath = [] }
        return true
    }

    /// Apply a link that arrived while signed out. Called once auth settles.
    func applyPending() {
        guard let route = pending else { return }
        pending = nil
        show(route)
    }

    /// nil means the dashboard, which is the empty path rather than a destination.
    private static func route(for link: DeepLink) -> Route? {
        switch link {
        case .dashboard: nil
        case .event(let id): .event(id)
        case .editEvent(let id): .eventForm(.edit(id))
        case .newEvent(let track): .eventForm(.new(presetTrack: track))
        case .track(let id): .track(id)
        case .vehicle(let id): .vehicle(id)
        case .settings: .settings
        case .shared(let slug): .shared(slug: slug)
        }
    }

    /// Rewrite temp ids in the path once their creates have flushed.
    ///
    /// The web app does the same to `location.hash` (`onSyncChange` in `app.js`): an
    /// event created offline is `-3` until the queue drains, and a screen parked on
    /// it has to follow the row to its real id or it starts 404ing against the
    /// server the moment connectivity returns.
    func remapTempIds(_ resolve: (Int) -> Int?) {
        eventsPath = Self.remapped(eventsPath, resolve)
        garagePath = Self.remapped(garagePath, resolve)
    }

    private static func remapped(_ routes: [Route], _ resolve: (Int) -> Int?) -> [Route] {
        routes.map { route in
            switch route {
            case .event(let id):
                guard OfflineStore.isTemp(id), let real = resolve(id) else { return route }
                return .event(real)
            case .eventForm(.edit(let id)):
                guard OfflineStore.isTemp(id), let real = resolve(id) else { return route }
                return .eventForm(.edit(real))
            case .record(let id):
                guard let id, OfflineStore.isTemp(id), let real = resolve(id) else { return route }
                return .record(eventId: real)
            case .importVideo(let id, let incoming, let forNewEvent):
                guard let id, OfflineStore.isTemp(id), let real = resolve(id) else { return route }
                return .importVideo(eventId: real, incoming: incoming, forNewEvent: forNewEvent)
            case .lap(let eventId, let sessionId, let lapId):
                // Three ids, any of which can be temp: an event, a session and a
                // lap can each be created offline. Each follows its own row.
                return .lap(
                    eventId: Self.followed(eventId, resolve),
                    sessionId: Self.followed(sessionId, resolve),
                    lapId: Self.followed(lapId, resolve)
                )
            // A vehicle id is never temp: garage writes don't queue offline, so a
            // vehicle only ever exists once the server has given it a real id.
            case .track, .leaderboard, .vehicle, .settings, .shared, .eventForm(.new), .wrapped:
                return route
            }
        }
    }

    /// A temp id's real one when the store has it; any other id as it is.
    private static func followed(_ id: Int, _ resolve: (Int) -> Int?) -> Int {
        guard OfflineStore.isTemp(id), let real = resolve(id) else { return id }
        return real
    }
}
