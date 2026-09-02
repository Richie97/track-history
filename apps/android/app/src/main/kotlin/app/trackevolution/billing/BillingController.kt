package app.trackevolution.billing

import android.app.Activity
import android.content.Context
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Entitlement
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.acknowledgePurchase
import com.android.billingclient.api.queryPurchasesAsync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** What the paywall draws. */
data class BillingUiState(
    val plans: List<Plan> = emptyList(),
    val loadingPlans: Boolean = false,
    /** A purchase or restore is in flight. */
    val busy: Boolean = false,
    /** Something to tell the user, in one line. */
    val message: String? = null,
    /** Play itself is not reachable — no products, so no Subscribe button. */
    val unavailable: String? = null,
)

/**
 * The Android purchase terminal (NS-32 phase C): Play Billing on one side,
 * `POST /api/billing/google` on the other, and the server the only thing that
 * decides tier.
 *
 * Process-wide (held by [app.trackevolution.data.AppServices]) rather than
 * activity-scoped, because two of its jobs have nothing to do with a screen:
 * **`queryPurchasesAsync` runs on every cold start**, re-posting anything the
 * server doesn't yet know about and anything still unacknowledged, and a
 * purchase Play reports **with no signed-in user is held until sign-in, not
 * dropped** — `onSignedIn` flushes it. The pure decisions are in [PurchaseSync]
 * and [LegacyClaim]; this class is the plumbing around them.
 *
 * Three rules from the spec are load-bearing here:
 *
 *  - **Acknowledge only after the server's 200.** Play refunds an unacknowledged
 *    subscription after three days. Acknowledging first is how a paying user
 *    ends up free when the post fails; never acknowledging is how they end up
 *    refunded. A 409 — the token belongs to another account — is never
 *    acknowledged from this one.
 *  - **Reconnect on `SERVICE_DISCONNECTED`**, with [Backoff]. Play's service
 *    drops connections routinely (an update, memory pressure) and a client that
 *    stays disconnected silently never posts a renewal.
 *  - **The legacy claim runs from here on launch**, once per install
 *    ([BillingPrefs]) — thirty-day sessions mean an already-signed-in user never
 *    passes through the code exchange again.
 */
class BillingController(
    context: Context,
    private val api: ApiClient,
    /** Whether there is a session to post under — `AuthStore.isSignedIn`. */
    private val isSignedIn: () -> Boolean,
    private val prefs: BillingPrefs,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) : PurchasesUpdatedListener {

    private val _state = MutableStateFlow(BillingUiState())
    val state: StateFlow<BillingUiState> = _state.asStateFlow()

    /**
     * The latest entitlement any billing write answered with. `MainActivity`
     * forwards it to `AuthController`, which is where the gates read it — one
     * value, not a second copy the paywall could disagree with.
     */
    private val _entitlement = MutableStateFlow<Entitlement?>(null)
    val entitlement: StateFlow<Entitlement?> = _entitlement.asStateFlow()

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener(this)
        // Required by the library even for a subscriptions-only app; a PENDING
        // purchase is neither posted nor acknowledged until Play settles it.
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()

    private val connected = MutableStateFlow(false)
    private var connecting = false
    private var attempt = 0

    private var productDetails: ProductDetails? = null

    /** Purchases Play has told us about while there was no session to post under. */
    private var held: List<Purchase> = emptyList()

    /** One sync at a time: two replays of the same purchase list would double-post. */
    private val syncLock = Mutex()

    // ---- Lifecycle ---------------------------------------------------------

    /**
     * Cold start. Connect and ask Play what this Google account owns; post it if
     * there is a session, hold it if not. Called from `Application.onCreate`, so
     * it also runs when the app is launched by the recording notification and
     * never shows the logbook.
     */
    fun start() {
        scope.launch {
            val purchases = queryPurchases() ?: return@launch
            sync(purchases, force = false)
        }
    }

    /**
     * The app became signed in — at launch with a stored token, or after the
     * browser hop. The legacy claim first (it is the transitional build's whole
     * reason to exist), then anything held or newly owned.
     */
    fun onSignedIn() {
        scope.launch {
            claimLegacy()
            val purchases = held.ifEmpty { queryPurchases().orEmpty() }
            sync(purchases, force = false)
        }
    }

    // ---- The paywall -------------------------------------------------------

    fun refreshProducts() {
        scope.launch { loadProducts() }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    /**
     * Launches Play's purchase sheet for [plan]. The result arrives at
     * [onPurchasesUpdated]; nothing is granted here.
     */
    fun buy(activity: Activity, plan: Plan) {
        val details = productDetails
        if (details == null) {
            refreshProducts()
            return
        }
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(details)
                        .setOfferToken(plan.offerToken)
                        .build(),
                ),
            )
            .build()
        _state.update { it.copy(message = null, busy = true) }
        val result = client.launchBillingFlow(activity, params)
        if (result.responseCode != BillingResponseCode.OK) {
            _state.update { it.copy(busy = false, message = describe(result)) }
        }
    }

    /**
     * "Restore purchases": ask Play again and post everything it owns, whether
     * or not this install has posted it before — a new phone, or a purchase made
     * under another Track Evolution account the user has now signed into.
     */
    fun restore() {
        scope.launch {
            _state.update { it.copy(busy = true, message = null) }
            val purchases = queryPurchases()
            when {
                purchases == null -> _state.update { it.copy(busy = false, message = "Couldn't reach Google Play.") }
                purchases.isEmpty() -> _state.update {
                    it.copy(busy = false, message = "No Track Evolution Pro subscription on this Google account.")
                }
                else -> {
                    sync(purchases, force = true)
                    _state.update { it.copy(busy = false) }
                }
            }
        }
    }

    // ---- Play → server → Play ----------------------------------------------

    override fun onPurchasesUpdated(result: BillingResult, purchases: List<Purchase>?) {
        when (result.responseCode) {
            BillingResponseCode.OK -> {
                val fresh = purchases.orEmpty()
                scope.launch {
                    sync(fresh, force = false)
                    _state.update { it.copy(busy = false) }
                }
            }
            BillingResponseCode.USER_CANCELED -> _state.update { it.copy(busy = false) }
            // Already subscribed on this Google account (another install, say):
            // the thing to do is exactly what Restore does.
            BillingResponseCode.ITEM_ALREADY_OWNED -> restore()
            else -> _state.update { it.copy(busy = false, message = describe(result)) }
        }
    }

    /**
     * Post what the server needs, acknowledge what it accepted. [force] posts
     * every purchase regardless of what this install has posted before.
     *
     * With no session the list is **held**, not dropped, and [onSignedIn]
     * replays it; a 401 mid-way holds the rest the same way.
     */
    private suspend fun sync(purchases: List<Purchase>, force: Boolean) = syncLock.withLock {
        if (!isSignedIn()) {
            held = purchases
            return@withLock
        }
        val accepted = if (force) emptySet() else prefs.acceptedTokens()
        val records = purchases.map { it.toRecord() }
        for (record in PurchaseSync.toPost(records, accepted)) {
            val outcome = post(record)
            if (outcome is Post.Unauthorized) {
                held = purchases
                return@withLock
            }
            val status = (outcome as? Post.Answered)?.status
            if (PurchaseSync.accepted(status)) prefs.addAcceptedToken(record.token)
            if (PurchaseSync.acknowledgeAfter(record, status)) acknowledge(record.token)
            if (!PurchaseSync.accepted(status)) {
                _state.update {
                    it.copy(message = PurchaseSync.failureMessage(status, (outcome as? Post.Answered)?.message))
                }
            }
        }
        held = emptyList()
    }

    private sealed interface Post {
        data class Answered(val status: Int?, val message: String?) : Post
        data object Unauthorized : Post
    }

    private suspend fun post(record: PurchaseRecord): Post = try {
        val response = api.postGooglePurchase(
            purchaseToken = record.token,
            productId = record.productIds.firstOrNull() ?: BillingProducts.PRO,
        )
        _entitlement.value = response.entitlement
        Post.Answered(200, null)
    } catch (e: ApiException) {
        if (e.isUnauthorized) Post.Unauthorized else Post.Answered(e.status, e.message)
    }

    private suspend fun acknowledge(token: String) {
        if (!awaitConnection()) return
        val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()
        val result = client.acknowledgePurchase(params)
        if (result.responseCode != BillingResponseCode.OK) {
            // Not fatal: the next cold start finds the purchase still
            // unacknowledged, posts it again (idempotent) and retries this.
            _state.update { it.copy(message = describe(result)) }
        }
    }

    private suspend fun claimLegacy() {
        if (prefs.legacyClaimed()) return
        val status = try {
            _entitlement.value = api.claimGoogleLegacy().entitlement
            200
        } catch (e: ApiException) {
            e.status
        }
        when (LegacyClaim.outcome(status)) {
            LegacyClaim.Outcome.GRANTED, LegacyClaim.Outcome.DONE -> prefs.markLegacyClaimed()
            LegacyClaim.Outcome.RETRY -> Unit
        }
    }

    // ---- Play plumbing -----------------------------------------------------

    private suspend fun queryPurchases(): List<Purchase>? {
        if (!awaitConnection()) return null
        val params = QueryPurchasesParams.newBuilder().setProductType(ProductType.SUBS).build()
        val result = client.queryPurchasesAsync(params)
        return if (result.billingResult.responseCode == BillingResponseCode.OK) result.purchasesList else null
    }

    private suspend fun loadProducts() {
        _state.update { it.copy(loadingPlans = true, unavailable = null) }
        if (!awaitConnection()) {
            _state.update { it.copy(loadingPlans = false, unavailable = "Google Play isn't reachable right now.") }
            return
        }
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(BillingProducts.PRO)
                        .setProductType(ProductType.SUBS)
                        .build(),
                ),
            )
            .build()
        val (result, details) = suspendCancellableCoroutine<Pair<BillingResult, List<ProductDetails>>> { cont ->
            // 8.x hands back a QueryProductDetailsResult (fetched + unfetched
            // lists) where 7.x gave a bare list — hence the -ktx wrapper isn't
            // used here and the callback is bridged by hand.
            client.queryProductDetailsAsync(params) { billingResult, query ->
                cont.resume(billingResult to query.productDetailsList)
            }
        }
        if (result.responseCode != BillingResponseCode.OK) {
            _state.update { it.copy(loadingPlans = false, unavailable = describe(result)) }
            return
        }
        productDetails = details.firstOrNull { it.productId == BillingProducts.PRO }
        val plans = PaywallPlans.plans(productDetails?.offers().orEmpty())
        _state.update {
            it.copy(
                loadingPlans = false,
                plans = plans,
                unavailable = if (plans.isEmpty()) "Track Evolution Pro isn't available on Google Play yet." else null,
            )
        }
    }

    /**
     * Connected, or false after a bounded wait. Kicks a connection attempt if
     * none is under way, so a caller never has to remember to connect first.
     */
    private suspend fun awaitConnection(): Boolean {
        if (connected.value) return true
        connect()
        return withTimeoutOrNull(CONNECT_TIMEOUT_MS) { connected.first { it } } != null
    }

    private fun connect() {
        if (connecting || connected.value) return
        connecting = true
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                connecting = false
                if (result.responseCode == BillingResponseCode.OK) {
                    attempt = 0
                    connected.value = true
                } else if (result.responseCode in RETRYABLE) {
                    scheduleReconnect()
                }
                // Anything else — BILLING_UNAVAILABLE, DEVELOPER_ERROR — is not
                // going to change by itself; the next user action retries.
            }

            override fun onBillingServiceDisconnected() {
                connecting = false
                connected.value = false
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        val wait = Backoff.delayMs(attempt++)
        scope.launch {
            delay(wait)
            connect()
        }
    }

    private fun describe(result: BillingResult): String = when (result.responseCode) {
        BillingResponseCode.BILLING_UNAVAILABLE -> "Google Play billing isn't available on this device."
        BillingResponseCode.SERVICE_UNAVAILABLE, BillingResponseCode.SERVICE_DISCONNECTED,
        BillingResponseCode.NETWORK_ERROR,
        -> "Couldn't reach Google Play. Check your connection and try again."
        BillingResponseCode.ITEM_UNAVAILABLE -> "That plan isn't available right now."
        else -> result.debugMessage.ifBlank { "Google Play returned an error (${result.responseCode})." }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 15_000L

        val RETRYABLE = setOf(
            BillingResponseCode.SERVICE_DISCONNECTED,
            BillingResponseCode.SERVICE_UNAVAILABLE,
            BillingResponseCode.NETWORK_ERROR,
            BillingResponseCode.ERROR,
        )
    }
}

private fun Purchase.toRecord() = PurchaseRecord(
    token = purchaseToken,
    productIds = products,
    acknowledged = isAcknowledged,
    purchased = purchaseState == Purchase.PurchaseState.PURCHASED,
)

/** Play's offer list, reduced to what [PaywallPlans] picks from. */
private fun ProductDetails.offers(): List<OfferInfo> =
    subscriptionOfferDetails.orEmpty().map { offer ->
        OfferInfo(
            basePlanId = offer.basePlanId,
            offerId = offer.offerId,
            offerToken = offer.offerToken,
            phases = offer.pricingPhases.pricingPhaseList.map { phase ->
                OfferPhase(
                    formattedPrice = phase.formattedPrice,
                    priceMicros = phase.priceAmountMicros,
                    billingPeriod = phase.billingPeriod,
                )
            },
        )
    }
