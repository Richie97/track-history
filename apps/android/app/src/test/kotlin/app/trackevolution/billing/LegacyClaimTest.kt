package app.trackevolution.billing

import app.trackevolution.billing.LegacyClaim.Outcome
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Whether the once-per-install claim is finished after each answer the server
 * can give (NS-32 requirement 6). A wrong "done" here is a paid user who never
 * gets grandfathered; a wrong "retry" is only one small request per launch.
 */
class LegacyClaimTest {

    @Test
    fun `a 200 grants and is done`() {
        assertEquals(Outcome.GRANTED, LegacyClaim.outcome(200))
    }

    @Test
    fun `a closed window and a conflict are final`() {
        assertEquals(Outcome.DONE, LegacyClaim.outcome(403))
        assertEquals(Outcome.DONE, LegacyClaim.outcome(409))
    }

    @Test
    fun `no answer, a lost session and a sick server all retry next launch`() {
        assertEquals("offline", Outcome.RETRY, LegacyClaim.outcome(null))
        assertEquals("session gone; the next sign-in re-runs it", Outcome.RETRY, LegacyClaim.outcome(401))
        assertEquals(Outcome.RETRY, LegacyClaim.outcome(500))
        assertEquals(Outcome.RETRY, LegacyClaim.outcome(503))
    }

    @Test
    fun `a 400 - the header missing - stays visible rather than being buried under a claimed flag`() {
        assertEquals(Outcome.RETRY, LegacyClaim.outcome(400))
    }
}
