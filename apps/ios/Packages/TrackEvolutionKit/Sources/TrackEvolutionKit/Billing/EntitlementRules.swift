import Foundation

/// The client-side half of NS-32's tier table: the port of
/// `public/js/entitlement.js`, keeping its function and constant names so the two
/// diff by eye, and pinned against it case for case by
/// `contracts/logic/entitlement.json` (`EntitlementTests`). Android's `:core`
/// carries the same port; both are checked against the web implementation, never
/// against each other.
///
/// Every predicate takes the `entitlement` object `GET /api/me` returned and
/// **never consults the clock**: expiry is the server's call, made when it
/// answered, and offline the cached answer stands (rule 5) — a driver who was Pro
/// at the last sync records. Nothing here imports StoreKit; the store is the
/// app's business (`App/Billing/`), and this file is what lets `swift test` run
/// the tier logic on macOS.
public extension Entitlement {
    /// `FREE_ENTITLEMENT` — what a signed-out or never-fetched client has.
    static let FREE_ENTITLEMENT = Entitlement.free

    /// An entitlement, or nothing at all (not signed in, never fetched) — the
    /// latter is free, never Pro.
    static func isPro(_ entitlement: Entitlement?) -> Bool {
        entitlement?.tier == .pro
    }

    /// The GPS lap recorder, live timing and predictive delta (native only).
    static func canRecord(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }

    /// Telemetry import — video on the phones, video + `.vbo` on the web.
    static func canImport(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }

    /// Channel graphs, the lap delta chart, the two-lap compare and sector splits
    /// all read `channels`, which the server strips for a free account (rule 4);
    /// the client-side check only decides whether to show the paywall copy on the
    /// resulting empty state.
    static func canViewChannels(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }

    /// Garage consumables, the setup notebook and year in review.
    static func canUseGarage(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }
    static func canUseSetups(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }
    static func canViewYearInReview(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }

    /// The web's two-event lap overlay. Ported for name parity with
    /// `public/js/entitlement.js` and the shared fixture, though no native screen
    /// reads it — the overlay is web-only (`docs/specs/native/README.md`).
    static func canCompareEvents(_ entitlement: Entitlement?) -> Bool { isPro(entitlement) }

    /// Where "Manage subscription" goes, by the store that sold it.
    static let APPLE_MANAGE_URL = URL(string: "https://apps.apple.com/account/subscriptions")!
    static let GOOGLE_MANAGE_URL = URL(
        string: "https://play.google.com/store/account/subscriptions?package=app.trackevolution"
    )!

    /// Legacy has no subscription to manage; free has nothing yet — both nil. A
    /// lapsed subscriber keeps their store, so they can resubscribe where they
    /// left off.
    static func manageUrl(_ entitlement: Entitlement?) -> URL? {
        switch entitlement?.source {
        case .apple: APPLE_MANAGE_URL
        case .google: GOOGLE_MANAGE_URL
        case .legacy, nil: nil
        }
    }

    /// One line for Settings: "Pro · renews Mar 4, 2027", "Pro · ends Mar 4, 2027",
    /// "Pro · lifetime", "Free". `fmtDate` is injected, as in the JS, so the
    /// wording is pinned by the fixture without a locale — the fixture renders the
    /// date as `<ms>`.
    static func entitlementSummary(
        _ entitlement: Entitlement?,
        fmtDate: (Int) -> String = defaultFmtDate
    ) -> String {
        guard let entitlement, isPro(entitlement) else { return "Free" }
        guard entitlement.source != .legacy, let expiresAt = entitlement.expiresAt else {
            return "Pro · lifetime"
        }
        let when = fmtDate(expiresAt)
        return entitlement.autoRenew == false ? "Pro · ends \(when)" : "Pro · renews \(when)"
    }

    /// The JS default: `new Date(ms).toISOString().slice(0, 10)` — a UTC calendar
    /// date. Screens pass a locale-aware formatter instead.
    static func defaultFmtDate(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000)
            .formatted(.iso8601.year().month().day())
    }

    // MARK: - Gates

    /// On since phase D. Phases B and C shipped the purchase flow dark behind
    /// this one constant; flipping it is what turned the recorder-start and
    /// import gates on. The decision logic behind it (`ProGate`) is tested with
    /// the value injected, so both states stay covered.
    static let gatesEnabled = true

    // MARK: - The App Store

    /// The two auto-renewable products, in one subscription group. Pinned to
    /// `apps/ios/Configuration.storekit` by `EntitlementTests`, and what App Store
    /// Connect must carry under the same ids.
    static let APPLE_PRODUCT_IDS = ["app.trackevolution.pro.monthly", "app.trackevolution.pro.yearly"]
    static let APPLE_SUBSCRIPTION_GROUP = "Track Evolution Pro"

    /// The first build (`CFBundleVersion`) that shipped **free**. An install whose
    /// `AppTransaction.originalAppVersion` is below it paid for the app and is
    /// grandfathered (`POST /api/billing/apple/legacy`, NS-32 requirement 6).
    ///
    /// `nil` means the app is still a paid download, so *every* install bought
    /// it and every install claims — which is the state through phases B and C,
    /// since the price flips only at phase D. It cannot be filled in earlier: the
    /// build number is **Xcode Cloud's**, not `CURRENT_PROJECT_VERSION` in
    /// `project.yml` (see README → App version), so the value is only known once
    /// the free build has been archived. Phase D sets it here and in the Worker's
    /// `APPLE_FIRST_SUBSCRIPTION_BUILD` — the server enforces the same rule, so
    /// this is a pre-filter that saves the request, not the decision.
    static let APPLE_FIRST_SUBSCRIPTION_BUILD: String? = nil

    /// Whether an install with this `originalAppVersion` bought the app. Defaults
    /// to the constant above; the parameter exists so the rule is testable in
    /// both states.
    static func isLegacyInstall(
        originalAppVersion: String,
        firstSubscriptionBuild: String? = APPLE_FIRST_SUBSCRIPTION_BUILD
    ) -> Bool {
        guard let firstSubscriptionBuild else { return true }
        return compareVersions(originalAppVersion, firstSubscriptionBuild) < 0
    }

    /// Hosts the Worker treats as local development (`src/lib/dev.ts`).
    static let DEV_HOSTS: Set<String> = ["localhost", "127.0.0.1", "::1", "10.0.2.2"]

    /// Whether a legacy claim signed in this environment can be accepted by the
    /// server this app is pointed at — the client-side mirror of the Worker's
    /// rule in `POST /api/billing/apple/legacy`.
    ///
    /// A sandbox `AppTransaction` is signed by the same real Apple chain and
    /// always reports `originalAppVersion` "1.0", so the Worker refuses one
    /// unless the request arrived on a dev host; without that, every TestFlight
    /// tester would hold a lifetime entitlement for an app they never bought.
    /// Asking anyway is worse than not asking: the 400 is final, so the
    /// once-per-account flag would be set in TestFlight and a tester who
    /// *did* buy the app would never claim from their eventual App Store
    /// install. Restore Purchases still forces a retry either way.
    static func legacyClaimIsAccepted(isProductionReceipt: Bool, serverHost: String?) -> Bool {
        if isProductionReceipt { return true }
        guard let serverHost else { return false }
        return DEV_HOSTS.contains(serverHost)
    }

    /// Dotted build strings ("1.4.2" vs "2"), numerically per segment — the port
    /// of `compareVersions` in `src/routes/billing.ts`, so the app and the server
    /// draw the line in the same place. A segment that isn't a number reads as 0,
    /// as `parseInt(...) || 0` does.
    static func compareVersions(_ a: String, _ b: String) -> Int {
        let as_ = a.split(separator: ".", omittingEmptySubsequences: false).map(Self.leadingInt)
        let bs = b.split(separator: ".", omittingEmptySubsequences: false).map(Self.leadingInt)
        for i in 0..<max(as_.count, bs.count) {
            let d = (i < as_.count ? as_[i] : 0) - (i < bs.count ? bs[i] : 0)
            if d != 0 { return d }
        }
        return 0
    }

    /// `parseInt(s, 10) || 0`: the leading digits, or 0.
    private static func leadingInt(_ s: Substring) -> Int {
        let digits = s.drop(while: \.isWhitespace).prefix(while: \.isNumber)
        return Int(digits) ?? 0
    }
}

/// The recorder-start and video-import gates (NS-32 rule 5): a paywall sheet
/// rather than a disabled control, decided from the **cached** entitlement so a
/// driver who was Pro at the last sync records in a paddock with no signal.
///
/// The decision is separated from the constant that arms it so the logic is
/// tested in both states today, while the app ships with `gatesEnabled == false`.
public enum ProGate {
    public enum Feature: Hashable, Sendable {
        /// Starting the GPS lap recorder — from the record screen, or from CarPlay.
        case record
        /// Parsing a video for its telemetry, including one handed over by Files.
        case videoImport
    }

    public enum Decision: Hashable, Sendable {
        /// Go ahead.
        case proceed
        /// Show the paywall instead.
        case paywall
    }

    /// `entitlement` is what the last `/api/me` said — nil when nothing has been
    /// fetched, which is free. `gatesEnabled` defaults to the Kit constant and is
    /// injectable for the tests.
    public static func decide(
        _ feature: Feature,
        entitlement: Entitlement?,
        gatesEnabled: Bool = Entitlement.gatesEnabled
    ) -> Decision {
        guard gatesEnabled else { return .proceed }
        let allowed = switch feature {
        case .record: Entitlement.canRecord(entitlement)
        case .videoImport: Entitlement.canImport(entitlement)
        }
        return allowed ? .proceed : .paywall
    }
}
