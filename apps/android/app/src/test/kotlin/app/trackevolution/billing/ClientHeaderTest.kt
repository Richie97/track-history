package app.trackevolution.billing

import app.trackevolution.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transitional build's identification (NS-32 requirement 6). The server's
 * `parseClientHeader` wants exactly `android/<digits>`; a build that spells it
 * any other way gets a 400 on its legacy claim and grandfathers nobody.
 */
class ClientHeaderTest {

    @Test
    fun `the header is android slash versionCode`() {
        assertEquals("X-TE-Client", ClientHeader.NAME)
        assertEquals("android/42", ClientHeader.value(42))
    }

    @Test
    fun `this build's own value parses`() {
        val value = ClientHeader.value(BuildConfig.VERSION_CODE)
        assertTrue(value, Regex("""^android/\d+$""").matches(value))
        assertTrue("a version code Play would accept", BuildConfig.VERSION_CODE > 0)
    }

    @Test
    fun `reconnect backoff doubles from a second and caps at a minute`() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L), (0..7).map(Backoff::delayMs))
    }
}
