package app.trackevolution.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * From Play's offer list to the two cards on the paywall. The paywall shows
 * price and billing period from `ProductDetails` (spec requirement 7) — these
 * pin how an ISO period becomes words and which offer on a base plan is sold.
 */
class PaywallPlansTest {

    private fun phase(price: String, micros: Long, period: String) = OfferPhase(price, micros, period)

    private val monthlyBase = OfferInfo(
        basePlanId = BillingProducts.MONTHLY, offerId = null, offerToken = "m-base",
        phases = listOf(phase("$1.99", 1_990_000, "P1M")),
    )
    private val monthlyTrial = OfferInfo(
        basePlanId = BillingProducts.MONTHLY, offerId = "trial14", offerToken = "m-trial",
        phases = listOf(phase("Free", 0, "P14D"), phase("$1.99", 1_990_000, "P1M")),
    )
    private val yearlyBase = OfferInfo(
        basePlanId = BillingProducts.YEARLY, offerId = null, offerToken = "y-base",
        phases = listOf(phase("$19.99", 19_990_000, "P1Y")),
    )

    @Test
    fun `periods read as words`() {
        assertEquals("month", PaywallPlans.describePeriod("P1M"))
        assertEquals("year", PaywallPlans.describePeriod("P1Y"))
        assertEquals("week", PaywallPlans.describePeriod("P1W"))
        assertEquals("3 months", PaywallPlans.describePeriod("P3M"))
        assertEquals("7 days", PaywallPlans.describePeriod("P7D"))
        // Something Play never sends is shown as-is rather than crashing the sheet.
        assertEquals("PT1H", PaywallPlans.describePeriod("PT1H"))
    }

    @Test
    fun `trials read as words`() {
        assertEquals("14 days free", PaywallPlans.describeTrial("P14D"))
        assertEquals("1 week free", PaywallPlans.describeTrial("P1W"))
        assertEquals("1 month free", PaywallPlans.describeTrial("P1M"))
        assertNull(PaywallPlans.describeTrial("nonsense"))
    }

    @Test
    fun `monthly then yearly, from the base plans`() {
        val plans = PaywallPlans.plans(listOf(yearlyBase, monthlyBase))
        assertEquals(listOf("monthly", "yearly"), plans.map { it.basePlanId })
        assertEquals("$1.99", plans[0].price)
        assertEquals("month", plans[0].period)
        assertNull(plans[0].trial)
        assertEquals("$19.99", plans[1].price)
        assertEquals("year", plans[1].period)
        assertEquals("m-base", plans[0].offerToken)
    }

    @Test
    fun `an introductory trial is preferred over the bare base plan`() {
        val plan = PaywallPlans.plans(listOf(monthlyBase, monthlyTrial)).single()
        assertEquals("m-trial", plan.offerToken)
        assertEquals("14 days free", plan.trial)
        // The quoted price is what recurs after the trial, never the free phase.
        assertEquals("$1.99", plan.price)
        assertEquals("month", plan.period)
    }

    @Test
    fun `a base plan Play does not return is simply absent`() {
        val plans = PaywallPlans.plans(listOf(monthlyBase))
        assertEquals(listOf("monthly"), plans.map { it.basePlanId })
        assertEquals(emptyList<Plan>(), PaywallPlans.plans(emptyList()))
    }

    @Test
    fun `a base plan the paywall does not know is ignored`() {
        val weekly = monthlyBase.copy(basePlanId = "weekly", offerToken = "w")
        assertEquals(listOf("monthly"), PaywallPlans.plans(listOf(weekly, monthlyBase)).map { it.basePlanId })
    }

    @Test
    fun `an offer with no paid phase makes no card`() {
        val free = OfferInfo(BillingProducts.MONTHLY, "free", "f", listOf(phase("Free", 0, "P1M")))
        assertNull(PaywallPlans.plan(free))
    }

    @Test
    fun `the yearly card says what it saves against twelve months`() {
        val plans = PaywallPlans.plans(listOf(monthlyBase, yearlyBase))
        // 12 × 1.99 = 23.88; 19.99 is 16.3% less.
        assertEquals(16, PaywallPlans.savingsPercent(plans[0], plans[1]))
        assertNull(PaywallPlans.savingsPercent(null, plans[1]))
        val dearYear = plans[1].copy(priceMicros = 30_000_000)
        assertNull("no saving, no badge", PaywallPlans.savingsPercent(plans[0], dearYear))
    }

    @Test
    fun `titles`() {
        assertEquals("Monthly", PaywallPlans.plan(monthlyBase)!!.title)
        assertEquals("Yearly", PaywallPlans.plan(yearlyBase)!!.title)
    }
}
