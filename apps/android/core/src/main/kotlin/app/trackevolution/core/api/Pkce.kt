package app.trackevolution.core.api

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * A PKCE verifier/challenge pair for the native sign-in flow.
 *
 * The server's contract (`src/routes/auth.ts`, with the failure modes spelled
 * out in `test/api/native-auth.test.ts`) is unforgiving in three ways worth
 * stating here, because each produces a confusing error rather than an obvious
 * one:
 *
 *  - The challenge is `base64url(SHA-256(verifier))` **without padding**. Get the
 *    encoding wrong and the exchange fails with `401 PKCE verification failed`.
 *    On Android the classic trap is `android.util.Base64.encodeToString`, whose
 *    default flags append a newline; this uses `java.util.Base64`'s URL encoder
 *    with padding stripped, which has no such surprise and needs no emulator.
 *  - The one-time code the browser redirects back with lives for **60 seconds**.
 *    Exchange it immediately; never stash it.
 *  - That code is **burned on first use, before verification**, so a failed
 *    exchange cannot be retried with the same code — recover by restarting the
 *    whole flow with a fresh verifier.
 */
public class Pkce private constructor(public val verifier: String) {

    /** `base64url(SHA-256(verifier))`, unpadded. */
    public val challenge: String
        get() = base64Url(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)),
        )

    public companion object {
        /**
         * 43 characters from the unreserved set — the RFC 7636 minimum, from 32
         * bytes of [SecureRandom] entropy.
         */
        public fun generate(random: SecureRandom = SecureRandom()): Pkce {
            val bytes = ByteArray(32)
            random.nextBytes(bytes)
            return Pkce(base64Url(bytes))
        }

        /**
         * Rebuilds a pair from a stored verifier — the flow leaves the process
         * when the browser opens, so the verifier has to come back from disk
         * (see `PendingSignIn` in `:app`), and for the RFC's worked example in
         * the tests.
         */
        public fun of(verifier: String): Pkce = Pkce(verifier)

        private val encoder: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()

        private fun base64Url(bytes: ByteArray): String = encoder.encodeToString(bytes)
    }
}
