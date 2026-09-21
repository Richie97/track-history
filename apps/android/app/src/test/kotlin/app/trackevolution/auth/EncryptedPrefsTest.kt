package app.trackevolution.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.AEADBadTagException

/**
 * The recovery half of [AuthStore], which is the half that decides whether a
 * device with an undecryptable token store launches or crash-loops.
 *
 * It is tested here rather than through `EncryptedSharedPreferences` itself
 * because Robolectric has no AndroidKeyStore provider, so the real store cannot
 * be opened on the JVM at all — and an emulator test of a *corrupt* keystore is
 * not something a CI job can stage. Splitting the decision out from the Jetpack
 * call is what makes it assertable: what is left to trust is one `create` call.
 */
class EncryptedPrefsTest {

    /** The exception the Play console actually reported. */
    private fun corruption() = AEADBadTagException("tag mismatch")

    @Test
    fun `opens without resetting when the store is readable`() {
        var resets = 0
        val value = EncryptedPrefs.openOrReset(open = { "prefs" }, reset = { resets++ })
        assertEquals("prefs", value)
        assertEquals(0, resets)
    }

    @Test
    fun `resets once and reopens when the store cannot be decrypted`() {
        var opens = 0
        var resets = 0
        val value = EncryptedPrefs.openOrReset(
            open = {
                opens++
                if (resets == 0) throw corruption()
                "fresh"
            },
            reset = { resets++ },
        )
        assertEquals("fresh", value)
        assertEquals(2, opens)
        assertEquals(1, resets)
    }

    /**
     * A wipe that does not fix it is a real fault, not something to loop on —
     * but the thrown exception has to name the corruption, or the crash report
     * says only that a freshly created store failed for no stated reason.
     */
    @Test
    fun `a second failure is thrown carrying the first`() {
        val first = corruption()
        val second = IllegalStateException("keyset still unusable")
        var resets = 0
        val thrown = runCatching {
            EncryptedPrefs.openOrReset<String>(
                open = { throw if (resets == 0) first else second },
                reset = { resets++ },
            )
        }.exceptionOrNull()
        assertSame(second, thrown)
        assertTrue(thrown!!.suppressed.contains(first))
        assertEquals(1, resets)
    }

    /**
     * A keystore that refuses `deleteEntry` must not mask the decryption failure
     * underneath it — deleting the prefs file may well have been enough.
     */
    @Test
    fun `a failing reset does not stop the retry`() {
        var opens = 0
        val value = EncryptedPrefs.openOrReset(
            open = {
                opens++
                if (opens == 1) throw corruption()
                "fresh"
            },
            reset = { throw IllegalStateException("keystore unavailable") },
        )
        assertEquals("fresh", value)
        assertEquals(2, opens)
    }
}
