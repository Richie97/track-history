import Foundation

/// The screen as Google Analytics sees it: the route's **shape** (``AppAnalytics``).
///
/// Spelled as the web app's own path for the same page — `analyticsPath` in
/// `public/js/analytics.js` reports `#/event/12` as `"/event/:id"` — so one GA
/// report counts a screen across the web, Android (`Route.analyticsPath`, under
/// the same name) and here. Every id becomes `:id`, a share page is
/// `/share/:slug`, a shared event or session `/share/e/:token` or
/// `/share/s/:token`, and an invite is `/coach`, never its token; the one value kept
/// is Wrapped's year, as on the web. The screens the web doesn't have — the
/// recorder, the importer, a lap — get paths in the same idiom.
///
/// Exhaustive switches, so a new route fails to compile until it is named here.
extension Route {
    var analyticsPath: String {
        switch self {
        case .event: "/event/:id"
        case .eventForm(.new): "/new"
        case .eventForm(.edit): "/event/:id/edit"
        case .track: "/track/:id"
        case .leaderboard: "/track/:id/leaderboard"
        case .vehicle: "/vehicle/:id"
        case .settings: "/settings"
        case .record: "/record"
        case .importVideo: "/import"
        case .shared: "/share/:slug"
        // The web's shape for the same page; the token is the link's whole
        // permission and never leaves the device.
        case .sharedItem(.event, _): "/share/e/:token"
        case .sharedItem(.session, _): "/share/s/:token"
        case .lap: "/event/:id/lap/:id"
        // Android's shape for the same screen; the web's is the event page.
        case .sessionCompare: "/event/:id/session/:id/compare"
        case .wrapped(let year): "/wrapped/\(year)"
        case .coaching: "/coaching"
        case .profile: "/profile"
        case .coachInvite: "/coach"
        case .student(_, let page): "/student/:id" + page.analyticsPath
        // A docs-site page, not a web-app route; named in the same idiom.
        case .trackDaysGuide: "/guide/track-days"
        // The web edits a sheet inline on the event page; the phones give it a
        // page, named in the same idiom. The day is a position, not a record id.
        case .setupForm: "/event/:id/setup/:day"
        }
    }

    /// The sign-in screen, which is not a route.
    static let signInAnalyticsPath = "/signin"
}

extension StudentPage {
    /// The tail after the web's `#/student/:id` prefix.
    fileprivate var analyticsPath: String {
        switch self {
        case .home: ""
        case .event: "/event/:id"
        case .track: "/track/:id"
        case .lap: "/event/:id/lap/:id"
        case .sessionCompare: "/event/:id/session/:id/compare"
        case .vehicle: "/vehicle/:id"
        }
    }
}

extension AppRouter {
    /// The screen on top: what owns the window if anything does, else the top of
    /// the visible tab's stack, else that tab's root.
    var analyticsPath: String {
        if let fullWindow { return fullWindow.analyticsPath }
        if let top = path.last { return top.analyticsPath }
        return switch tab {
        case .events: "/"
        case .garage: "/garage"
        }
    }
}
