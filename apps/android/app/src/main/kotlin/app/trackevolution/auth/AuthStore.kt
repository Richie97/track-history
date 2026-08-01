package app.trackevolution.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.trackevolution.core.api.AuthProvider
import app.trackevolution.core.api.TokenProvider

/**
 * Everything secret the sign-in flow holds: the bearer token, and the PKCE
 * verifier while a flow is in the air. Also the [TokenProvider] `ApiClient`
 * reads the token through — which is how `:core` stays free of Android keystore
 * APIs (NS-05 defines the interface, NS-09 implements it).
 *
 * **Readable while the device is locked, on purpose.** The master key is created
 * without `setUserAuthenticationRequired`, so it is available after the first
 * unlock following a boot rather than only while the screen is on. That is not
 * laziness: the lap recorder runs for hours with the phone locked in a pocket,
 * and a token it cannot read is a session it cannot sync. The tradeoff is stated
 * rather than hidden — an attacker with a locked, running device and a keystore
 * exploit could reach the token; the alternative loses the feature the app
 * exists for.
 *
 * The verifier is here rather than in a ViewModel because **the flow leaves the
 * process**: opening the browser can let Android kill the activity, and coming
 * back to a verifier that no longer exists means a sign-in that can never
 * complete. It is encrypted for the same reason as the token — for the sixty
 * seconds it matters, it is the other half of the credential.
 *
 * Note `androidx.security:security-crypto` has had no stable release since 1.0.0
 * and Jetpack's guidance around it has softened. If it is ever pulled, the
 * replacement is a Keystore-wrapped AES/GCM key with the ciphertext in DataStore,
 * and this class is the only thing that would change.
 */
class AuthStore(context: Context) : TokenProvider {

    private val app = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(app)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            app,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /**
     * Suspending by interface, but a synchronous read: `EncryptedSharedPreferences`
     * caches in memory after the first load, and every `/api` request calls this.
     */
    override suspend fun currentToken(): String? = token

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().run {
            if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            apply()
        }

    val isSignedIn: Boolean get() = token != null

    /** The flow currently in the browser, if any. */
    fun pendingSignIn(): PendingSignIn? {
        val verifier = prefs.getString(KEY_VERIFIER, null) ?: return null
        val provider = AuthProvider.fromStored(prefs.getString(KEY_PROVIDER, null)) ?: return null
        return PendingSignIn(verifier = verifier, provider = provider)
    }

    fun startPending(pending: PendingSignIn) {
        prefs.edit()
            .putString(KEY_VERIFIER, pending.verifier)
            .putString(KEY_PROVIDER, pending.provider.stored)
            .apply()
    }

    /**
     * Clears the in-flight flow. Called on success *and* on every failure: the
     * server burns the one-time code before verifying it, so a verifier that has
     * been used once can never be used again and keeping it only invites a
     * confusing second failure.
     */
    fun clearPending() {
        prefs.edit().remove(KEY_VERIFIER).remove(KEY_PROVIDER).apply()
    }

    /** Sign-out, or a 401. The caller still has to drop cached data (NS-22). */
    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val FILE_NAME = "auth"
        const val KEY_TOKEN = "token"
        const val KEY_VERIFIER = "pkce_verifier"
        const val KEY_PROVIDER = "pkce_provider"
    }
}

/** A sign-in that is out in the browser, waiting for its redirect. */
data class PendingSignIn(
    val verifier: String,
    val provider: AuthProvider,
)
