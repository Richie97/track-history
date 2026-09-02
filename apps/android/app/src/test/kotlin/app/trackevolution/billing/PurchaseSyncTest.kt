package app.trackevolution.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The post-then-acknowledge rule (NS-32 requirement 3), which is the one part
 * of the purchase flow where a wrong answer costs money: acknowledging before
 * the server has the token makes a paying user free when the post fails, and
 * never acknowledging gets them refunded after three days.
 */
class PurchaseSyncTest {

    private val fresh = PurchaseRecord("tok-1", listOf(BillingProducts.PRO), acknowledged = false, purchased = true)
    private val acked = PurchaseRecord("tok-2", listOf(BillingProducts.PRO), acknowledged = true, purchased = true)
    private val pending = PurchaseRecord("tok-3", listOf(BillingProducts.PRO), acknowledged = false, purchased = false)

    // ---- what to post on a cold start --------------------------------------

    @Test
    fun `an unacknowledged purchase is posted even if the server has already accepted it`() {
        // The server may have it — but we can't acknowledge until *we* hear so.
        assertEquals(listOf(fresh), PurchaseSync.toPost(listOf(fresh), accepted = setOf("tok-1")))
    }

    @Test
    fun `an acknowledged purchase the server accepted is left alone`() {
        assertEquals(emptyList<PurchaseRecord>(), PurchaseSync.toPost(listOf(acked), accepted = setOf("tok-2")))
    }

    @Test
    fun `an acknowledged purchase this install never posted is posted - a reinstall or a second device`() {
        assertEquals(listOf(acked), PurchaseSync.toPost(listOf(acked), accepted = emptySet()))
    }

    @Test
    fun `a pending purchase is neither posted nor acknowledged`() {
        assertEquals(emptyList<PurchaseRecord>(), PurchaseSync.toPost(listOf(pending), accepted = emptySet()))
        assertFalse(PurchaseSync.acknowledgeAfter(pending, 200))
    }

    // ---- when to acknowledge -----------------------------------------------

    @Test
    fun `acknowledge only after a 2xx`() {
        assertTrue(PurchaseSync.acknowledgeAfter(fresh, 200))
        assertFalse("400: Play doesn't know the token yet", PurchaseSync.acknowledgeAfter(fresh, 400))
        assertFalse("409: another account's purchase", PurchaseSync.acknowledgeAfter(fresh, 409))
        assertFalse("503: billing not configured", PurchaseSync.acknowledgeAfter(fresh, 503))
        assertFalse("no answer at all", PurchaseSync.acknowledgeAfter(fresh, null))
    }

    @Test
    fun `an already acknowledged purchase is not acknowledged twice`() {
        assertFalse(PurchaseSync.acknowledgeAfter(acked, 200))
    }

    @Test
    fun `only a 2xx marks the token as accepted`() {
        assertTrue(PurchaseSync.accepted(200))
        assertFalse(PurchaseSync.accepted(409))
        assertFalse(PurchaseSync.accepted(null))
    }

    // ---- what to say -------------------------------------------------------

    @Test
    fun `a conflict names the cause and everything else promises a retry`() {
        assertTrue(PurchaseSync.failureMessage(409, "purchase belongs to another account").contains("another Track Evolution account"))
        assertTrue(PurchaseSync.failureMessage(null, null).contains("retried"))
        assertTrue(PurchaseSync.failureMessage(400, "unknown purchase token").contains("retried"))
        assertTrue(PurchaseSync.failureMessage(503, "billing not configured").contains("aren't switched on"))
        assertEquals("custom", PurchaseSync.failureMessage(500, "custom"))
    }
}
