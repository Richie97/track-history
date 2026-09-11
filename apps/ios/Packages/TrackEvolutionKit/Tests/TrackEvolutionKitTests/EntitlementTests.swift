import Foundation
import Testing

@testable import TrackEvolutionKit

/// The tier predicates and their agreement with the web app (NS-32).
///
/// The port carries the JS test cases with it (`test/unit/entitlement-client.test.js`)
/// and adds the cross-language fixture — `contracts/logic/entitlement.json`, run
/// through `public/js/entitlement.js` by `npm run contracts:logic` — so a predicate
/// that drifts on one client fails here rather than at a paywall.
struct EntitlementTests {
    // MARK: - Cross-language agreement

    @Test func matchesTheJavaScriptImplementationOnTheSharedFixture() throws {
        let fixture = try EntitlementFixture.load()
        // The fixture renders the date as <ms>, so the wording is pinned without a
        // locale.
        let fmt: (Int) -> String = { "<\($0)>" }

        for c in fixture.cases {
            let e = c.entitlement
            #expect(Entitlement.isPro(e) == c.expected.isPro, Comment(rawValue: c.name))
            #expect(Entitlement.canRecord(e) == c.expected.canRecord, Comment(rawValue: c.name))
            #expect(Entitlement.canViewChannels(e) == c.expected.canViewChannels, Comment(rawValue: c.name))
            #expect(Entitlement.canUseGarage(e) == c.expected.canUseGarage, Comment(rawValue: c.name))
            #expect(Entitlement.canUseSetups(e) == c.expected.canUseSetups, Comment(rawValue: c.name))
            #expect(Entitlement.canViewYearInReview(e) == c.expected.canViewYearInReview, Comment(rawValue: c.name))
            #expect(Entitlement.canCompareEvents(e) == c.expected.canCompareEvents, Comment(rawValue: c.name))
            #expect(Entitlement.manageUrl(e)?.absoluteString == c.expected.manageUrl, Comment(rawValue: c.name))
            #expect(Entitlement.entitlementSummary(e, fmtDate: fmt) == c.expected.summary, Comment(rawValue: c.name))
        }
        // Against the fixture silently emptying and the loop passing vacuously.
        #expect(fixture.cases.count >= 9)
        #expect(fixture.cases.contains { $0.entitlement == nil }, "the nothing-cached case must be in the fixture")
    }

    // MARK: - Ported JS cases

    private func pro(
        source: Entitlement.Source? = .apple, expiresAt: Int? = 1_800_000_000_000, autoRenew: Bool? = true
    ) -> Entitlement {
        Entitlement(tier: .pro, source: source, expiresAt: expiresAt, autoRenew: autoRenew)
    }

    @Test func onlyATierOfProIsPro() {
        #expect(Entitlement.isPro(pro()))
        #expect(!Entitlement.isPro(Entitlement.FREE_ENTITLEMENT))
        #expect(!Entitlement.isPro(nil))
    }

    @Test func everyProFeatureFollowsTheTierNotTheClock() {
        // Expired by the wall clock but still `pro` — the cached answer stands offline.
        let stale = pro(expiresAt: 1)
        let predicates: [(Entitlement?) -> Bool] = [
            Entitlement.canRecord, Entitlement.canViewChannels, Entitlement.canUseGarage
        ]
        for can in predicates {
            #expect(can(stale))
            #expect(!can(Entitlement.FREE_ENTITLEMENT))
            #expect(!can(nil))
        }
    }

    @Test func manageUrlTargetsTheStoreThatSoldTheSubscription() {
        #expect(Entitlement.manageUrl(pro()) == Entitlement.APPLE_MANAGE_URL)
        #expect(Entitlement.manageUrl(pro(source: .google)) == Entitlement.GOOGLE_MANAGE_URL)
        #expect(Entitlement.manageUrl(pro(source: .legacy, expiresAt: nil, autoRenew: nil)) == nil)
        #expect(Entitlement.manageUrl(Entitlement.FREE_ENTITLEMENT) == nil)
        #expect(Entitlement.manageUrl(nil) == nil)
        // A lapsed subscriber still gets their store.
        let lapsed = Entitlement(tier: .free, source: .google, expiresAt: 1, autoRenew: false)
        #expect(Entitlement.manageUrl(lapsed) == Entitlement.GOOGLE_MANAGE_URL)
    }

    @Test func theSummaryReadsTheTierTheSourceAndTheRenewalState() {
        let d: (Int) -> String = { "D\($0)" }
        #expect(Entitlement.entitlementSummary(Entitlement.FREE_ENTITLEMENT, fmtDate: d) == "Free")
        #expect(Entitlement.entitlementSummary(nil, fmtDate: d) == "Free")
        #expect(Entitlement.entitlementSummary(pro(), fmtDate: d) == "Pro · renews D1800000000000")
        #expect(Entitlement.entitlementSummary(pro(autoRenew: false), fmtDate: d) == "Pro · ends D1800000000000")
        #expect(Entitlement.entitlementSummary(pro(autoRenew: nil), fmtDate: d) == "Pro · renews D1800000000000")
        #expect(
            Entitlement.entitlementSummary(pro(source: .legacy, expiresAt: nil, autoRenew: nil), fmtDate: d)
                == "Pro · lifetime"
        )
    }

    @Test func theDefaultDateIsTheJavaScriptIsoDay() {
        // `new Date(1800000000000).toISOString().slice(0, 10)`.
        #expect(Entitlement.defaultFmtDate(1_800_000_000_000) == "2027-01-15")
    }

    // MARK: - Gates

    @Test func theGatesAreOn() {
        #expect(Entitlement.gatesEnabled, "phase D turned these on")
        // With the constant as shipped, a free account meets the paywall and a
        // Pro one doesn't — the default-argument path, which is what every
        // screen actually calls.
        #expect(ProGate.decide(.record, entitlement: nil) == .paywall)
        #expect(ProGate.decide(.record, entitlement: Entitlement.FREE_ENTITLEMENT) == .paywall)
        #expect(ProGate.decide(.record, entitlement: pro()) == .proceed)
    }

    @Test func gatesOffLetEveryoneThrough() {
        for feature in [ProGate.Feature.record] {
            #expect(ProGate.decide(feature, entitlement: nil, gatesEnabled: false) == .proceed)
            #expect(ProGate.decide(feature, entitlement: .FREE_ENTITLEMENT, gatesEnabled: false) == .proceed)
            #expect(ProGate.decide(feature, entitlement: pro(), gatesEnabled: false) == .proceed)
        }
    }

    @Test func gatesOnShowAFreeAccountThePaywall() {
        for feature in [ProGate.Feature.record] {
            #expect(ProGate.decide(feature, entitlement: nil, gatesEnabled: true) == .paywall)
            #expect(ProGate.decide(feature, entitlement: .FREE_ENTITLEMENT, gatesEnabled: true) == .paywall)
            let lapsed = Entitlement(tier: .free, source: .apple, expiresAt: 1, autoRenew: false)
            #expect(ProGate.decide(feature, entitlement: lapsed, gatesEnabled: true) == .paywall)
        }
    }

    @Test func gatesOnLetACachedProThroughEvenWhenTheClockSaysItExpired() {
        // Offline, the last /api/me stands: the phone's clock has no say (rule 5).
        let stale = pro(expiresAt: 1)
        for feature in [ProGate.Feature.record] {
            #expect(ProGate.decide(feature, entitlement: pro(), gatesEnabled: true) == .proceed)
            #expect(ProGate.decide(feature, entitlement: stale, gatesEnabled: true) == .proceed)
            #expect(
                ProGate.decide(feature, entitlement: pro(source: .legacy, expiresAt: nil, autoRenew: nil), gatesEnabled: true)
                    == .proceed
            )
        }
    }

    // MARK: - Grandfathering

    @Test func comparesBuildStringsLikeTheServer() {
        // `compareVersions` in src/routes/billing.ts, case for case.
        #expect(Entitlement.compareVersions("1", "2") < 0)
        #expect(Entitlement.compareVersions("2", "2") == 0)
        #expect(Entitlement.compareVersions("10", "9") > 0, "numeric, not lexical")
        #expect(Entitlement.compareVersions("1.4.2", "2") < 0)
        #expect(Entitlement.compareVersions("1.0", "1") == 0, "a missing segment is 0")
        #expect(Entitlement.compareVersions("1.0.1", "1") > 0)
        #expect(Entitlement.compareVersions("abc", "0") == 0, "garbage parses as 0, as parseInt || 0 does")
        #expect(Entitlement.compareVersions("47", "120") < 0)
    }

    @Test func whileTheAppIsStillPaidEveryInstallIsLegacy() {
        #expect(Entitlement.APPLE_FIRST_SUBSCRIPTION_BUILD == nil, "phase D sets this once the free build's number is known")
        #expect(Entitlement.isLegacyInstall(originalAppVersion: "1"))
        #expect(Entitlement.isLegacyInstall(originalAppVersion: "9999"))
        // Sandbox always reports "1.0"; TestFlight and the paid production builds
        // report Xcode Cloud's number — all of them bought it while nil.
        #expect(Entitlement.isLegacyInstall(originalAppVersion: "1.0"))
    }

    @Test func onceTheCutoffIsSetOnlyEarlierInstallsAreLegacy() {
        #expect(Entitlement.isLegacyInstall(originalAppVersion: "119", firstSubscriptionBuild: "120"))
        #expect(!Entitlement.isLegacyInstall(originalAppVersion: "120", firstSubscriptionBuild: "120"))
        #expect(!Entitlement.isLegacyInstall(originalAppVersion: "121", firstSubscriptionBuild: "120"))
        #expect(Entitlement.isLegacyInstall(originalAppVersion: "1.0", firstSubscriptionBuild: "120"))
    }

    @Test("a sandbox receipt is only claimable against a dev server")
    func legacyClaimEnvironment() {
        // Production always claims, wherever it is pointed.
        #expect(Entitlement.legacyClaimIsAccepted(isProductionReceipt: true, serverHost: "trackevolution.app"))
        #expect(Entitlement.legacyClaimIsAccepted(isProductionReceipt: true, serverHost: "localhost"))
        // Sandbox (TestFlight) against a deployed server must not ask: the
        // server refuses it, and the refusal is final.
        #expect(!Entitlement.legacyClaimIsAccepted(isProductionReceipt: false, serverHost: "trackevolution.app"))
        #expect(!Entitlement.legacyClaimIsAccepted(isProductionReceipt: false, serverHost: nil))
        // …but a dev server is exactly where exercising the flow is the point.
        #expect(Entitlement.legacyClaimIsAccepted(isProductionReceipt: false, serverHost: "localhost"))
        #expect(Entitlement.legacyClaimIsAccepted(isProductionReceipt: false, serverHost: "127.0.0.1"))
    }

    // MARK: - The StoreKit configuration file

    /// `apps/ios/Configuration.storekit` drives local testing; App Store Connect
    /// must carry the same products. Pinning the file to the Kit's constants means
    /// a renamed product id fails here rather than as an empty paywall.
    @Test func theStoreKitConfigurationCarriesTheTwoProducts() throws {
        let data = try Data(contentsOf: RepoRoot.path("apps/ios/Configuration.storekit"))
        let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let groups = try #require(root["subscriptionGroups"] as? [[String: Any]])
        #expect(groups.count == 1, "one group, so the store handles upgrade/downgrade")
        let group = try #require(groups.first)
        #expect(group["name"] as? String == Entitlement.APPLE_SUBSCRIPTION_GROUP)

        let subscriptions = try #require(group["subscriptions"] as? [[String: Any]])
        let ids = subscriptions.compactMap { $0["productID"] as? String }.sorted()
        #expect(ids == Entitlement.APPLE_PRODUCT_IDS.sorted())

        let byId = Dictionary(uniqueKeysWithValues: subscriptions.map { ($0["productID"] as! String, $0) })
        let monthly = try #require(byId["app.trackevolution.pro.monthly"])
        let yearly = try #require(byId["app.trackevolution.pro.yearly"])
        #expect(monthly["displayPrice"] as? String == "1.99")
        #expect(monthly["recurringSubscriptionPeriod"] as? String == "P1M")
        #expect(yearly["displayPrice"] as? String == "19.99")
        #expect(yearly["recurringSubscriptionPeriod"] as? String == "P1Y")
        for product in [monthly, yearly] {
            #expect(product["type"] as? String == "RecurringSubscription")
            let intro = try #require(product["introductoryOffer"] as? [String: Any])
            #expect(intro["paymentMode"] as? String == "free")
            #expect(intro["subscriptionPeriod"] as? String == "P2W", "the optional 14-day trial")
        }
    }
}

/// `contracts/logic/entitlement.json` — reference output captured from
/// `public/js/entitlement.js`.
struct EntitlementFixture: Decodable {
    struct Expected: Decodable {
        let isPro: Bool
        let canRecord: Bool
        let canViewChannels: Bool
        let canUseGarage: Bool
        let canUseSetups: Bool
        let canViewYearInReview: Bool
        let canCompareEvents: Bool
        let manageUrl: String?
        let summary: String
    }

    struct Case: Decodable {
        let name: String
        /// `null` in the fixture — nothing cached — decodes to nil.
        let entitlement: Entitlement?
        let expected: Expected
    }

    let cases: [Case]

    static func load() throws -> EntitlementFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/entitlement.json"))
        return try JSONDecoder().decode(EntitlementFixture.self, from: data)
    }
}
