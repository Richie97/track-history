package app.trackevolution.billing

/**
 * One Play purchase, as much of it as the sync rule needs. Our own type rather
 * than `com.android.billingclient.api.Purchase` (a final class built from a JSON
 * receipt) so the rule below is plain JUnit rather than a mocking exercise.
 */
data class PurchaseRecord(
    val token: String,
    val productIds: List<String>,
    /** Play's flag. An unacknowledged subscription is refunded after three days. */
    val acknowledged: Boolean,
    /** `PurchaseState.PURCHASED`. A `PENDING` purchase has not been paid for yet. */
    val purchased: Boolean,
)

/**
 * When to post a purchase to the server and when to acknowledge it with Play —
 * the pure half of [BillingController], and the part worth getting exactly right.
 *
 * The rule (NS-32 requirement 3): **acknowledge only after `POST /api/billing/google`
 * returns 200.** Play refunds an unacknowledged subscription after three days,
 * so acknowledging before the server has the token is how a paying user ends up
 * free, and never acknowledging is how they end up refunded. Both halves are
 * here: what to (re-)post on every cold start, and what to acknowledge once a
 * post has answered.
 */
object PurchaseSync {

    /**
     * What to post, given Play's current purchases and the tokens this install
     * has already had the server accept.
     *
     * Anything **unacknowledged** is posted regardless — the server may have it,
     * but until it has said so we cannot acknowledge, and until we acknowledge
     * the clock is running. Anything acknowledged but **not in [accepted]** is
     * posted too: a reinstall or a second device starts with an empty set, and
     * the upsert is idempotent. A `PENDING` purchase is neither posted nor
     * acknowledged — there is nothing to verify yet, and Play calls back when it
     * settles.
     */
    fun toPost(purchases: List<PurchaseRecord>, accepted: Set<String>): List<PurchaseRecord> =
        purchases.filter { it.purchased && (!it.acknowledged || it.token !in accepted) }

    /**
     * Whether to acknowledge now that the post has answered with [status]
     * (null: no answer at all). Only a 2xx, only a settled purchase, and only
     * if Play still wants it.
     */
    fun acknowledgeAfter(purchase: PurchaseRecord, status: Int?): Boolean =
        status != null && status in 200..299 && purchase.purchased && !purchase.acknowledged

    /** Whether the server now knows this token — the only thing that lands it in [toPost]'s `accepted`. */
    fun accepted(status: Int?): Boolean = status != null && status in 200..299

    /**
     * What to tell the user when a post did not land, in terms of what happens
     * next. Everything that is not a 409 is retried on the next cold start, so
     * the message says so rather than asking them to do anything.
     */
    fun failureMessage(status: Int?, serverMessage: String?): String = when (status) {
        null -> "Couldn't reach Track Evolution to confirm your purchase. It will be retried next time the app opens."
        409 -> "This purchase is linked to another Track Evolution account. Sign in with that account to use it."
        400 -> "Google Play hasn't confirmed this purchase yet. It will be retried next time the app opens."
        503 -> "Subscriptions aren't switched on for this server yet."
        else -> serverMessage ?: "Couldn't confirm your purchase ($status). It will be retried next time the app opens."
    }
}
