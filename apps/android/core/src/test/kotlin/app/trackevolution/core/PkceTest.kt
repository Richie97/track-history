package app.trackevolution.core

import app.trackevolution.core.api.Pkce
import java.security.SecureRandom
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The encoding here is the difference between signing in and a
 * `401 PKCE verification failed`, and the server computes the other half
 * (`sha256Base64Url` in `src/lib/session.ts`), so these pin it against the
 * specification rather than against our own implementation.
 */
class PkceTest {

    /**
     * RFC 7636 appendix B's worked example — the one vector every PKCE
     * implementation is expected to reproduce.
     */
    @Test
    fun `matches the RFC 7636 worked example`() {
        val pkce = Pkce.of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.challenge)
    }

    @Test
    fun `challenge is unpadded base64url`() {
        val challenge = Pkce.generate().challenge
        assertEquals(43, challenge.length, "SHA-256 is 32 bytes → 43 unpadded base64 chars")
        assertTrue(challenge.none { it == '=' || it == '+' || it == '/' }, "was $challenge")
        // The classic Android trap: Base64.encodeToString's default flags append
        // a newline, and the server compares strings.
        assertEquals(challenge.trim(), challenge)
    }

    @Test
    fun `verifier is 43 unreserved characters`() {
        val verifier = Pkce.generate().verifier
        assertEquals(43, verifier.length, "RFC 7636 minimum, from 32 bytes of entropy")
        assertTrue(verifier.all { it.isLetterOrDigit() || it == '-' || it == '_' }, "was $verifier")
    }

    @Test
    fun `each flow gets its own verifier`() {
        assertNotEquals(Pkce.generate().verifier, Pkce.generate().verifier)
    }

    /**
     * The verifier has to survive the browser hop, so it round-trips through
     * disk. Rebuilding from the stored string must give the same challenge, or
     * the exchange fails after the user has already signed in.
     */
    @Test
    fun `rebuilding from a stored verifier gives the same challenge`() {
        val original = Pkce.generate(SecureRandom())
        assertEquals(original.challenge, Pkce.of(original.verifier).challenge)
    }
}
