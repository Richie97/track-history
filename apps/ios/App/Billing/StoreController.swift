import Foundation
import OSLog
import StoreKit
import TrackEvolutionKit
import UIKit

/// The App Store side of Track Evolution Pro (NS-32 phase B): load the two
/// products, sell them, listen for everything the store has to say, and hand
/// every verified transaction to the server — which is the only thing that
/// decides whether an account is Pro.
///
/// Three rules here are load-bearing, all from the spec's requirement 8:
///
/// - **Finish after 200.** A transaction is `finish()`ed only once
///   `POST /api/billing/apple` has accepted it. Finishing first and posting
///   second is how a paying user ends up free: StoreKit stops redelivering a
///   finished transaction, so a failed post would be the last anyone heard of it.
///   Left unfinished, it comes back through `Transaction.updates` and
///   `Transaction.unfinished` on the next launch — the store is a better queue
///   than ours, since it survives a reinstall.
/// - **The listener lives as long as the process.** `Transaction.updates` is
///   started from `start()` at launch, not from a view's `.task`: renewals, Ask
///   to Buy approvals and purchases made on another device arrive whenever the
///   store feels like it, with no paywall on screen.
/// - **Nothing is dropped for want of a user.** A transaction that arrives signed
///   out is held — in memory here, and by StoreKit itself since it isn't finished
///   — and posted once someone signs in.
///
/// Nothing here decides tier. The entitlement the server returns is written into
/// `AuthController.me`, and the Kit's predicates (`Entitlement.isPro` and
/// friends) read that; the store never grants anything on its own.
@MainActor
@Observable
final class StoreController {
    private static let log = Logger(subsystem: "app.trackevolution", category: "billing")

    enum ProductsState: Equatable {
        case idle, loading, loaded
        case failed(String)
    }

    /// The two subscriptions, monthly first. Empty until `loadProducts()`.
    private(set) var products: [Product] = []
    private(set) var productsState: ProductsState = .idle
    /// Products this Apple ID is eligible for the introductory offer on.
    private(set) var introEligible: Set<String> = []
    private(set) var isPurchasing = false
    private(set) var isRestoring = false
    /// What went wrong with the last thing the user asked for — in the server's
    /// own words when it was the server. Cleared when the next attempt starts.
    var error: String?
    /// Something worth saying that isn't a failure: a purchase awaiting approval,
    /// a restore that found nothing.
    var notice: String?

    private let auth: AuthController
    private let legacyClaims: LegacyClaimRecord
    private var updatesTask: Task<Void, Never>?
    /// Verified transactions the server hasn't accepted yet. Keyed by transaction
    /// id so a redelivery replaces rather than duplicates.
    private var held: [UInt64: VerificationResult<Transaction>] = [:]
    private var started = false
    private var claimingLegacy = false
    private var flushing = false

    init(auth: AuthController, legacyClaims: LegacyClaimRecord = LegacyClaimRecord()) {
        self.auth = auth
        self.legacyClaims = legacyClaims
    }

    // MARK: - Launch

    /// Start listening. Called once, from `TrackEvolutionApp.init`, so the listener
    /// exists before the first view draws and outlives every view.
    func start() {
        guard !started else { return }
        started = true
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                await self.receive(result, source: "update")
            }
        }
        Task { await drainUnfinished() }
        observeAccount()
    }

    /// Whatever a previous run left unfinished — a post that never got its 200.
    private func drainUnfinished() async {
        for await result in Transaction.unfinished {
            await receive(result, source: "unfinished")
        }
    }

    /// Re-run the account-dependent work whenever who's signed in changes: post
    /// what's held, and make the legacy claim for the newly loaded account.
    private func observeAccount() {
        withObservationTracking {
            _ = auth.state
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.accountChanged()
                self.observeAccount()
            }
        }
    }

    private func accountChanged() async {
        guard auth.me != nil else { return }
        await flushHeld()
        await claimLegacyIfNeeded()
    }

    /// The app is back in the foreground: try again whatever is waiting on the
    /// server — a held transaction, a legacy claim that met no network at launch.
    func retryPending() async {
        await flushHeld()
        await claimLegacyIfNeeded()
    }

    // MARK: - Products

    func loadProducts() async {
        guard productsState != .loading else { return }
        productsState = .loading
        do {
            let loaded = try await Product.products(for: Entitlement.APPLE_PRODUCT_IDS)
            // In the order the ids are listed — the store returns them in none.
            products = Entitlement.APPLE_PRODUCT_IDS.compactMap { id in loaded.first { $0.id == id } }
            var eligible: Set<String> = []
            for product in products {
                if let subscription = product.subscription,
                   subscription.introductoryOffer != nil,
                   await subscription.isEligibleForIntroOffer {
                    eligible.insert(product.id)
                }
            }
            introEligible = eligible
            productsState = products.isEmpty
                ? .failed("The subscription isn't available from the App Store right now.")
                : .loaded
        } catch {
            productsState = .failed(error.localizedDescription)
        }
    }

    // MARK: - Purchase and restore

    /// Buy. Returns once the server has the transaction, or the attempt is over.
    func purchase(_ product: Product) async {
        guard !isPurchasing else { return }
        isPurchasing = true
        error = nil
        notice = nil
        defer { isPurchasing = false }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                await receive(verification, source: "purchase", userInitiated: true)
            case .userCancelled:
                break
            case .pending:
                // Ask to Buy, or a payment that needs confirming elsewhere. StoreKit
                // delivers the transaction through `Transaction.updates` when it
                // settles, and the listener is alive for exactly this.
                notice = "Your purchase is waiting for approval. Pro switches on as soon as it goes through."
            @unknown default:
                break
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Restore Purchases — guideline 3.1.2 makes the control mandatory.
    ///
    /// `AppStore.sync()` asks the store for everything this Apple ID owns, then
    /// every current entitlement is posted again; the server upserts by original
    /// transaction id, so a repeat is harmless. The legacy claim is retried too,
    /// past its once-only flag: this is the button a paid-app buyer whose claim
    /// never landed will press.
    func restore() async {
        guard !isRestoring else { return }
        isRestoring = true
        error = nil
        notice = nil
        defer { isRestoring = false }
        do {
            try await AppStore.sync()
        } catch {
            self.error = error.localizedDescription
            return
        }
        var posted = 0
        for await result in Transaction.currentEntitlements {
            if await receive(result, source: "restore", userInitiated: true) { posted += 1 }
        }
        let claimed = await claimLegacyIfNeeded(force: true)
        if posted == 0, !claimed, error == nil {
            notice = "No purchases to restore for this Apple ID."
        }
    }

    /// Manage: the system subscriptions sheet, where cancelling and switching
    /// between monthly and yearly live. Nothing of ours to draw.
    func showManageSubscriptions() async {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else {
            return
        }
        do {
            try await AppStore.showManageSubscriptions(in: scene)
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Transactions → server

    /// Every transaction, whatever brought it. Returns whether the server took it.
    @discardableResult
    private func receive(
        _ result: VerificationResult<Transaction>, source: String, userInitiated: Bool = false
    ) async -> Bool {
        switch result {
        case .unverified(let transaction, let verificationError):
            // StoreKit's own check failed. Deliberately *not* finished — acknowledging
            // a payload that didn't verify would be trusting it — and never posted.
            Self.log.error(
                "unverified transaction \(transaction.id) from \(source, privacy: .public): \(verificationError.localizedDescription, privacy: .public)"
            )
            if userInitiated { error = "The App Store couldn't verify that purchase." }
            return false
        case .verified(let transaction):
            guard Entitlement.APPLE_PRODUCT_IDS.contains(transaction.productID) else {
                // Not a product this app sells: nothing to record, and finishing is
                // what stops the redelivery.
                Self.log.notice("finishing a transaction for unknown product \(transaction.productID, privacy: .public)")
                await transaction.finish()
                return false
            }
            return await post(result, transaction, userInitiated: userInitiated)
        }
    }

    private func post(
        _ result: VerificationResult<Transaction>, _ transaction: Transaction, userInitiated: Bool
    ) async -> Bool {
        guard auth.isSignedIn else {
            held[transaction.id] = result
            Self.log.notice("holding transaction \(transaction.id) until sign-in")
            if userInitiated { error = "Sign in to attach this purchase to your account." }
            return false
        }
        let renewalJws = await renewalInfoJws(for: transaction)
        do {
            let response = try await auth.api.verifyAppleTransaction(
                jws: result.jwsRepresentation, renewalJws: renewalJws
            )
            // The server has the row. Now, and only now, the store may forget it.
            await transaction.finish()
            held[transaction.id] = nil
            auth.applyEntitlement(response.entitlement)
            Self.log.notice(
                "transaction \(transaction.id) recorded; tier \(response.entitlement.tier.rawValue, privacy: .public)"
            )
            // Refresh the cached /me too, so the offline gate reads the new tier in a
            // paddock without another round trip.
            await auth.refreshAccount()
            return true
        } catch let apiError as APIError {
            switch apiError {
            case .server(let status, _) where status == 400 || status == 409:
                // Definitive: a payload the server can't verify, or a purchase already
                // bound to another account. Neither changes on retry, so the
                // transaction is finished — StoreKit would otherwise redeliver it on
                // every launch — and the server's reason is shown.
                await transaction.finish()
                held[transaction.id] = nil
                if userInitiated { error = apiError.message } else { notice = apiError.message }
                Self.log.error("transaction \(transaction.id) rejected: \(apiError.message, privacy: .public)")
            default:
                // Transient: no network, a 5xx, billing not configured (503), a token
                // that expired. Held and retried; StoreKit holds it too.
                held[transaction.id] = result
                if userInitiated { error = apiError.message }
                Self.log.notice("transaction \(transaction.id) held: \(apiError.message, privacy: .public)")
            }
            return false
        } catch {
            held[transaction.id] = result
            if userInitiated { self.error = error.localizedDescription }
            return false
        }
    }

    /// The subscription's renewal info, when StoreKit has it — what tells the
    /// server `auto_renew` and the grace state without waiting for a notification.
    /// Best effort: a transaction with none still posts.
    private func renewalInfoJws(for transaction: Transaction) async -> String? {
        guard let status = try? await transaction.subscriptionStatus else { return nil }
        return status.renewalInfo.jwsRepresentation
    }

    private func flushHeld() async {
        guard !flushing, !held.isEmpty, auth.isSignedIn else { return }
        flushing = true
        defer { flushing = false }
        for (_, result) in held.sorted(by: { $0.key < $1.key }) {
            await receive(result, source: "held")
        }
    }

    // MARK: - Grandfathering

    /// Requirement 6: an install that bought the app is Pro for life.
    ///
    /// Once per account — the flag is per user id per server — and a 409 ("bound
    /// to another account") counts as done. So does a 400: the server applies the
    /// same cutoff and an unverifiable payload won't verify tomorrow. Everything
    /// else (offline, a 5xx) is retried at the next launch or foreground. Returns
    /// whether a grant was recorded on this call.
    @discardableResult
    private func claimLegacyIfNeeded(force: Bool = false) async -> Bool {
        guard !claimingLegacy, let me = auth.me else { return false }
        let key = LegacyClaimRecord.Key(server: auth.server.url, userId: me.user.id)
        if !force, legacyClaims.isClaimed(key) { return false }
        if me.entitlement?.source == .legacy {
            // Already granted — from another device, or a launch that didn't get as
            // far as writing the flag.
            legacyClaims.markClaimed(key)
            return false
        }
        claimingLegacy = true
        defer { claimingLegacy = false }

        let shared: VerificationResult<AppTransaction>
        do {
            shared = try await AppTransaction.shared
        } catch {
            // Needs the App Store reachable; offline at launch is ordinary.
            Self.log.notice("app transaction unavailable: \(error.localizedDescription, privacy: .public)")
            return false
        }
        guard case .verified(let app) = shared else {
            Self.log.error("app transaction failed StoreKit's verification")
            return false
        }
        if app.environment == .xcode {
            // Signed by Xcode's local store: the server can't verify it and would
            // answer 400 on every launch. The `.storekit` file exercises the
            // purchase UI; the claim needs sandbox or production.
            Self.log.notice("legacy claim skipped in the Xcode StoreKit environment")
            return false
        }
        guard Entitlement.isLegacyInstall(originalAppVersion: app.originalAppVersion) else {
            // First downloaded after the app went free: nothing to claim, ever.
            legacyClaims.markClaimed(key)
            return false
        }
        do {
            let response = try await auth.api.claimAppleLegacy(jws: shared.jwsRepresentation)
            legacyClaims.markClaimed(key)
            auth.applyEntitlement(response.entitlement)
            await auth.refreshAccount()
            Self.log.notice("legacy grant recorded for original version \(app.originalAppVersion, privacy: .public)")
            return true
        } catch let apiError as APIError {
            switch apiError {
            case .server(let status, _) where status == 400 || status == 409:
                legacyClaims.markClaimed(key)
                Self.log.notice("legacy claim closed: \(apiError.message, privacy: .public)")
            default:
                Self.log.notice("legacy claim deferred: \(apiError.message, privacy: .public)")
            }
            if force { error = apiError.message }
            return false
        } catch {
            Self.log.notice("legacy claim deferred: \(error.localizedDescription, privacy: .public)")
            if force { self.error = error.localizedDescription }
            return false
        }
    }
}
