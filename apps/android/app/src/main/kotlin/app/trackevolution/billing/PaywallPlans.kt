package app.trackevolution.billing

/** The one subscription product and its two base plans, as configured in the Play Console. */
object BillingProducts {
    const val PRO = "app.trackevolution.pro"
    const val MONTHLY = "monthly"
    const val YEARLY = "yearly"
}

/** Where the paywall's two legal links go (App Store guideline 3.1.2's Play twin). */
object LegalLinks {
    const val PRIVACY = "https://docs.trackevolution.app/docs/privacy.html"
    const val TERMS = "https://docs.trackevolution.app/docs/terms.html"
}

/** One pricing phase of an offer: a free trial is a phase priced at zero. */
data class OfferPhase(
    val formattedPrice: String,
    val priceMicros: Long,
    /** ISO 8601, as Play reports it: `P1M`, `P1Y`, `P1W`, `P14D`. */
    val billingPeriod: String,
)

/**
 * One `SubscriptionOfferDetails`, reduced to what the paywall needs. Our own
 * type so the plan-picking is plain JUnit; [BillingController] builds these from
 * `ProductDetails`.
 */
data class OfferInfo(
    val basePlanId: String,
    /** Null for the base plan itself; set for an offer on it (an introductory trial, say). */
    val offerId: String?,
    val offerToken: String,
    val phases: List<OfferPhase>,
)

/** What one plan card shows and what tapping Subscribe launches. */
data class Plan(
    val basePlanId: String,
    val offerToken: String,
    /** The recurring price, localised by Play: "$1.99". */
    val price: String,
    val priceMicros: Long,
    /** "month" / "year". */
    val period: String,
    /** "14 days free", when the picked offer starts with a free phase. */
    val trial: String?,
) {
    val title: String
        get() = when (basePlanId) {
            BillingProducts.MONTHLY -> "Monthly"
            BillingProducts.YEARLY -> "Yearly"
            else -> basePlanId
        }
}

/**
 * From Play's offer list to the two cards on the paywall.
 *
 * Pure so the choice of *which* offer to sell is tested: a base plan can carry
 * several offers and the paywall shows one price per plan.
 */
object PaywallPlans {

    /** Monthly, then yearly. A base plan Play doesn't return is simply absent. */
    fun plans(offers: List<OfferInfo>): List<Plan> =
        listOf(BillingProducts.MONTHLY, BillingProducts.YEARLY).mapNotNull { base ->
            pick(offers.filter { it.basePlanId == base })?.let(::plan)
        }

    /**
     * Which offer on one base plan to sell: the one with the **longest free
     * phase** if any has one (an introductory trial is the best deal on the
     * table, and Play only returns offers this user is eligible for), else the
     * bare base plan, else whatever is left.
     */
    fun pick(offers: List<OfferInfo>): OfferInfo? {
        if (offers.isEmpty()) return null
        val withTrial = offers.filter { trialDays(it) > 0 }
        if (withTrial.isNotEmpty()) return withTrial.maxBy { trialDays(it) }
        return offers.firstOrNull { it.offerId == null } ?: offers.first()
    }

    /** The card for an offer, or null when it has no paid phase to quote. */
    fun plan(offer: OfferInfo): Plan? {
        val recurring = offer.phases.lastOrNull { it.priceMicros > 0 } ?: return null
        val trial = offer.phases.firstOrNull { it.priceMicros == 0L }?.let { describeTrial(it.billingPeriod) }
        return Plan(
            basePlanId = offer.basePlanId,
            offerToken = offer.offerToken,
            price = recurring.formattedPrice,
            priceMicros = recurring.priceMicros,
            period = describePeriod(recurring.billingPeriod),
            trial = trial,
        )
    }

    /** `P1M` → "month", `P1Y` → "year", `P3M` → "3 months", `P1W` → "week". */
    fun describePeriod(iso: String): String {
        val (count, unit) = parse(iso) ?: return iso
        return if (count == 1) unit else "$count ${unit}s"
    }

    /** `P14D` → "14 days free", `P1W` → "1 week free", `P1M` → "1 month free". */
    fun describeTrial(iso: String): String? {
        val (count, unit) = parse(iso) ?: return null
        return "$count ${if (count == 1) unit else "${unit}s"} free"
    }

    /**
     * "Save 16%" on the yearly card: what a year costs against twelve months,
     * or null when it isn't cheaper. Both prices are in the same currency —
     * Play localises a product's offers together.
     */
    fun savingsPercent(monthly: Plan?, yearly: Plan?): Int? {
        if (monthly == null || yearly == null || monthly.priceMicros <= 0) return null
        val twelve = monthly.priceMicros * 12
        val percent = ((twelve - yearly.priceMicros) * 100 / twelve).toInt()
        return percent.takeIf { it > 0 }
    }

    private fun trialDays(offer: OfferInfo): Int =
        offer.phases.firstOrNull { it.priceMicros == 0L }?.let { approximateDays(it.billingPeriod) } ?: 0

    private fun approximateDays(iso: String): Int {
        val (count, unit) = parse(iso) ?: return 0
        return count * when (unit) {
            "year" -> 365
            "month" -> 30
            "week" -> 7
            else -> 1
        }
    }

    /** One component of an ISO 8601 duration: the largest non-zero one. */
    private fun parse(iso: String): Pair<Int, String>? {
        val match = ISO_PERIOD.matchEntire(iso) ?: return null
        val units = listOf("year", "month", "week", "day")
        for ((index, unit) in units.withIndex()) {
            val count = match.groupValues[index + 1].toIntOrNull() ?: continue
            if (count > 0) return count to unit
        }
        return null
    }

    private val ISO_PERIOD = Regex("""^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$""")
}
