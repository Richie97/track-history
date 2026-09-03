import StoreKit
import SwiftUI
import TrackEvolutionKit

/// The paywall (NS-32 rule 5; App Store guideline 3.1.2): what Pro is, what it
/// costs per term in the store's own localised price, how it renews, Restore
/// Purchases, and the privacy policy and terms — every one of which review looks
/// for. A sheet, not a disabled control: it names the price and lets you buy on
/// the spot.
///
/// Presented from a *button* — the record screen's Start, Settings' Subscribe —
/// never from a screen's root. Those screens already carry
/// a modal, and two presentations on one view is a documented way to wedge
/// SwiftUI here (`apps/ios/README.md`).
///
/// Nothing in this file decides tier. It reads `auth.entitlement`, which the
/// server wrote, and asks `StoreController` to sell.
struct PaywallSheet: View {
    /// What brought the sheet up, for the headline.
    enum Context {
        case general
        case record
    }

    var context: Context = .general

    @Environment(StoreController.self) private var store
    @Environment(AuthController.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @State private var selectedId: String?

    static let privacyURL = URL(string: "https://docs.trackevolution.app/docs/privacy.html")!
    static let termsURL = URL(string: "https://docs.trackevolution.app/docs/terms.html")!

    private var isPro: Bool { Entitlement.isPro(auth.entitlement) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TESpacing.gridGap) {
                    header
                    tiersCard
                    if isPro {
                        proCard
                    } else {
                        purchaseCard
                    }
                    legal
                }
                .padding(TESpacing.pageGutter)
            }
            .background(Color(.bgPage))
            .navigationTitle("Track Evolution Pro")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("paywallDone")
                }
            }
        }
        .task {
            if store.productsState != .loaded { await store.loadProducts() }
            if selectedId == nil { selectedId = store.products.first?.id }
        }
        .onChange(of: store.products) { _, products in
            if selectedId == nil { selectedId = products.first?.id }
        }
        .onChange(of: isPro) { _, pro in
            if pro { Haptics.confirm() }
        }
    }

    // MARK: - Copy

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            BrandMark(size: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(headline)
                    .teStyle(.h2)
                    .foregroundStyle(Color(.textStrong))
                Text("Free is the logbook. Pro is the analysis.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }

    private var headline: String {
        switch context {
        case .general: "Turn lap times into analysis"
        case .record: "Recording laps is a Pro feature"
        }
    }

    private var tiersCard: some View {
        TECard {
            VStack(alignment: .leading, spacing: 14) {
                tier("Free", items: [
                    "Tracks, events, sessions and lap times — unlimited",
                    "Lap times out of PDR and GoPro video, with the racing line",
                    "Best laps, progress charts and consistency",
                    "Public share pages and leaderboards",
                    "Works offline, on every device"
                ])
                Divider().overlay(Color(.borderHairline))
                tier("Pro", accent: true, items: [
                    "GPS lap recorder with live timing and predictive delta",
                    "Channel graphs: speed, throttle, brake, steering, RPM",
                    "Sector splits, theoretical best and two-lap compare",
                    "Garage consumables: pad, tire and fluid wear"
                ])
            }
        }
    }

    private func tier(_ name: String, accent: Bool = false, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(name)
                .teStyle(.eyebrow)
                .foregroundStyle(accent ? Color(.accentInk) : Color(.textMuted))
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: accent ? "checkmark.circle.fill" : "circle")
                        .teStyle(.xs)
                        .foregroundStyle(accent ? Color(.accentInk) : Color(.textFaint))
                    Text(item)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textBody))
                }
            }
        }
    }

    // MARK: - Buying

    @ViewBuilder
    private var purchaseCard: some View {
        TECard {
            VStack(alignment: .leading, spacing: 12) {
                switch store.productsState {
                case .idle, .loading:
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading prices from the App Store…")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                    }
                case .failed(let message):
                    TEErrorBanner(message: message)
                    Button("Try again") { Task { await store.loadProducts() } }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                case .loaded:
                    ForEach(store.products, id: \.id) { product in
                        productRow(product)
                    }
                    subscribeButton
                }

                Button(store.isRestoring ? "Restoring…" : "Restore Purchases") {
                    Task { await store.restore() }
                }
                .buttonStyle(TEButtonStyle(kind: .quiet))
                .disabled(store.isRestoring || store.isPurchasing)
                .accessibilityIdentifier("paywallRestore")

                if let error = store.error {
                    TEErrorBanner(message: error)
                }
                if let notice = store.notice {
                    Text(notice)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }

                Text("""
                    Payment is charged to your Apple ID account when you confirm the purchase. The \
                    subscription renews automatically at the same price and term unless you cancel \
                    at least 24 hours before the current period ends. Manage or cancel it any time \
                    in your App Store account settings.
                    """)
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
            }
        }
    }

    private func productRow(_ product: Product) -> some View {
        let selected = product.id == selectedId
        return Button {
            selectedId = product.id
            Haptics.select()
        } label: {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.textStrong))
                    Text(Self.termLine(product, introEligible: store.introEligible.contains(product.id)))
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
                Spacer(minLength: 8)
                Text(product.displayPrice)
                    .teStyle(.lapTime)
                    .foregroundStyle(Color(.textStrong))
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color(.accentInk) : Color(.textFaint))
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: TERadius.md)
                    .strokeBorder(selected ? Color(.accent) : Color(.borderHairline), lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("paywallProduct-\(product.id)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var selectedProduct: Product? {
        store.products.first { $0.id == selectedId }
    }

    @ViewBuilder
    private var subscribeButton: some View {
        if let product = selectedProduct {
            Button(store.isPurchasing ? "Purchasing…" : "Subscribe for \(product.displayPrice) \(Self.perTerm(product))") {
                Task { await store.purchase(product) }
            }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .disabled(store.isPurchasing || store.isRestoring)
            .accessibilityIdentifier("paywallSubscribe")
        }
    }

    // MARK: - Already Pro

    private var proCard: some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                Text("You're Pro")
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                Text(Entitlement.entitlementSummary(auth.entitlement, fmtDate: Self.fmtDate))
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                    .accessibilityIdentifier("paywallSummary")
                switch auth.entitlement?.source {
                case .legacy:
                    Text("You bought the app before subscriptions — Pro is yours for life. Thank you.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                case .apple:
                    Button("Manage subscription") { Task { await store.showManageSubscriptions() } }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                case .google:
                    if let url = Entitlement.manageUrl(auth.entitlement) {
                        Link("Manage on Google Play", destination: url)
                            .buttonStyle(TEButtonStyle(kind: .quiet))
                    }
                case nil:
                    EmptyView()
                }
                if let error = store.error {
                    TEErrorBanner(message: error)
                }
            }
        }
    }

    // MARK: - Legal (guideline 3.1.2)

    private var legal: some View {
        HStack(spacing: 18) {
            Link("Privacy policy", destination: Self.privacyURL)
                .accessibilityIdentifier("paywallPrivacy")
            Link("Terms of use", destination: Self.termsURL)
                .accessibilityIdentifier("paywallTerms")
        }
        .teStyle(.xs)
        .foregroundStyle(Color(.accentInk))
        .frame(maxWidth: .infinity)
    }

    // MARK: - Formatting

    /// "per month", "per year" — the term as the store defines it.
    static func perTerm(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return "" }
        return "per \(periodLabel(period))"
    }

    /// "Billed monthly" / "Billed yearly", led by the trial when this Apple ID is
    /// eligible: "2 weeks free, then billed monthly".
    static func termLine(_ product: Product, introEligible: Bool) -> String {
        guard let subscription = product.subscription else { return "" }
        let billed = "billed \(adverb(subscription.subscriptionPeriod))"
        if introEligible, let offer = subscription.introductoryOffer, offer.paymentMode == .freeTrial {
            return "\(periodLabel(offer.period, plural: true)) free, then \(billed)"
        }
        return billed.prefix(1).uppercased() + billed.dropFirst()
    }

    /// "month", "2 weeks", "year".
    static func periodLabel(_ period: Product.SubscriptionPeriod, plural: Bool = false) -> String {
        let unit: String = switch period.unit {
        case .day: "day"
        case .week: "week"
        case .month: "month"
        case .year: "year"
        @unknown default: "period"
        }
        return period.value == 1 ? (plural ? "1 \(unit)" : unit) : "\(period.value) \(unit)s"
    }

    private static func adverb(_ period: Product.SubscriptionPeriod) -> String {
        switch (period.unit, period.value) {
        case (.month, 1): "monthly"
        case (.year, 1): "yearly"
        case (.week, 1): "weekly"
        case (.day, 1): "daily"
        default: "every \(periodLabel(period))"
        }
    }

    static func fmtDate(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .omitted)
    }
}
