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
    case settings
    /// NS-17's recorder. Deliberately not reachable from a link — see `DeepLink`.
    case record(eventId: Int?)
    /// Someone's public logbook, read-only.
    case shared(slug: String)
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
    var path: [Route] = []

    /// A link that arrived before there was a stack to put it on — at cold start,
    /// or while signed out. Applied by `applyPending()` once the app is signed in,
    /// so tapping a share link, signing in, and landing on that logbook is one
    /// uninterrupted flow.
    private var pending: Route?

    func push(_ route: Route) {
        path.append(route)
    }

    func popToRoot() {
        path.removeAll()
    }

    /// Replace the stack with a single destination — what a deep link should do,
    /// rather than burying the dashboard under an arbitrary history.
    func show(_ route: Route) {
        path = [route]
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
        if let route { show(route) } else { popToRoot() }
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
        path = path.map { route in
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
            case .track, .settings, .shared, .eventForm(.new):
                return route
            }
        }
    }
}
