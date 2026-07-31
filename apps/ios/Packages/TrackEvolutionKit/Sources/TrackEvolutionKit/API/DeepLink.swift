import Foundation

/// A link from outside the app, resolved to a place inside it.
///
/// Two sources, and only two:
///
/// - **Universal Links** for `https://<host>/share/*`, which is the only pattern
///   the association file advertises (`src/routes/wellKnown.ts`). Those URLs may
///   carry the web app's own hash route (`/share/eric#/track/7`).
/// - The `trackevolution://` custom scheme. `trackevolution://auth?code=…` is
///   **not** a route: it is the OAuth redirect, consumed by
///   `ASWebAuthenticationSession` before it ever reaches the app's URL handler.
///   Parsing it as navigation would race the sign-in flow for the code, so it is
///   rejected here explicitly rather than by accident.
///
/// Pure so the routing table is unit-tested rather than tapped through.
public enum DeepLink: Hashable, Sendable {
    case dashboard
    case event(Int)
    case editEvent(Int)
    case newEvent(presetTrack: String?)
    case track(Int)
    /// A car's garage page — `#/vehicle/3`, which the web app links to from its
    /// dashboard and event pages.
    case vehicle(Int)
    case settings
    /// Someone's public logbook — including your own, when you tap your own link.
    case shared(slug: String)

    /// The scheme's reserved host: the sign-in redirect, never a destination.
    private static let authHost = "auth"

    public static func parse(_ url: URL) -> DeepLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }

        if url.scheme == TrackEvolutionKit.callbackScheme {
            if components.host == Self.authHost { return nil }
            // trackevolution://event/5 — nothing generates these today, but the
            // scheme is registered, so they resolve rather than opening a blank app.
            let segments = ([components.host].compactMap { $0 }) + pathSegments(components.path)
            return route(segments) ?? hashRoute(components.fragment) ?? .dashboard
        }

        guard url.scheme == "https" || url.scheme == "http" else { return nil }
        let segments = pathSegments(components.path)
        // /share/<slug>, with anything deeper (the web app's hash routes live in the
        // fragment, not the path) resolving to the logbook's root.
        if segments.first == "share", segments.count >= 2, !segments[1].isEmpty {
            return .shared(slug: segments[1])
        }
        // The app's own web URLs: https://host/#/event/5.
        return hashRoute(components.fragment) ?? .dashboard
    }

    /// `#/event/5` → `.event(5)`. The web app's hash router, read from the outside.
    static func hashRoute(_ fragment: String?) -> DeepLink? {
        guard let fragment, !fragment.isEmpty else { return nil }
        var rest = Substring(fragment)
        if rest.hasPrefix("#") { rest = rest.dropFirst() }
        let (path, query) = split(String(rest))
        return route(pathSegments(path), query: query)
    }

    private static func route(_ segments: [String], query: [String: String] = [:]) -> DeepLink? {
        switch segments.first {
        case nil, "": return segments.isEmpty ? nil : .dashboard
        case "event":
            guard segments.count >= 2, let id = Int(segments[1]) else { return nil }
            // /event/5/record is NS-17's screen, reachable only from inside the app:
            // a link that started a GPS recording from outside would be a surprise.
            return segments.count >= 3 && segments[2] == "edit" ? .editEvent(id) : .event(id)
        case "track":
            guard segments.count >= 2, let id = Int(segments[1]) else { return nil }
            return .track(id)
        case "vehicle":
            guard segments.count >= 2, let id = Int(segments[1]) else { return nil }
            return .vehicle(id)
        case "new":
            return .newEvent(presetTrack: query["track"])
        case "settings":
            return .settings
        default:
            return nil
        }
    }

    private static func pathSegments(_ path: String) -> [String] {
        path.split(separator: "/").map {
            // A track name arrives percent-encoded in `#/new?track=…`; so can a slug.
            String($0).removingPercentEncoding ?? String($0)
        }
    }

    /// A hash route's own query string — `#/new?track=VIR%20(Full)`.
    private static func split(_ raw: String) -> (path: String, query: [String: String]) {
        guard let mark = raw.firstIndex(of: "?") else { return (raw, [:]) }
        let pairs = raw[raw.index(after: mark)...].split(separator: "&")
        var query: [String: String] = [:]
        for pair in pairs {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard let name = parts.first else { continue }
            let value = parts.count > 1 ? String(parts[1]) : ""
            query[String(name)] = value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
        }
        return (String(raw[..<mark]), query)
    }
}
