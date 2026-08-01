package app.trackevolution.auth

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.AuthProviders
import app.trackevolution.data.settingsDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val SERVER_KEY = stringPreferencesKey("server_url")

/**
 * Which instance the app talks to — the hosted app by default, or a local
 * `wrangler dev` for testing.
 *
 * The equivalent of the Capacitor shell's server-settings panel. It earns its
 * keep on Android specifically: the server's `DEV_MODE` bypass answers on
 * `10.0.2.2`, the emulator's alias for the host machine, so pointing a debug
 * build at `http://10.0.2.2:8787` gives one-tap local sign-in with no Google
 * round trip. A physical device on the LAN reaches the dev server but *not* the
 * bypass, and needs real OAuth.
 */
class ServerPreference(private val context: Context) {

    val url: Flow<String> =
        context.settingsDataStore.data.map { it[SERVER_KEY] ?: ApiClient.DEFAULT_BASE_URL }

    suspend fun current(): String = url.first()

    suspend fun set(url: String) {
        context.settingsDataStore.edit { it[SERVER_KEY] = url.trim().trimEnd('/') }
    }
}

/**
 * What each server last advertised at `GET /auth/providers`, remembered across
 * launches.
 *
 * That endpoint is unauthenticated and cheap, but it can still fail — a phone
 * cold-starting without signal — and the sign-in screen asks for it exactly
 * where a wrong answer is unrecoverable: no Apple button locks out anyone whose
 * account is an Apple one, with relaunching the app the only way back.
 * Remembering the last answer makes a failed fetch a no-op instead of a silent
 * downgrade to Google-only.
 *
 * It only ever stores what a server advertised and never invents a provider, so
 * a self-hosted instance without the `APPLE_*` secrets still draws Google alone.
 * Keyed by server, because this is a property of the deployment: pointing a
 * debug build at `wrangler dev` and back must not carry one server's answer over
 * to the other.
 */
class AuthProvidersStore(private val context: Context) {

    fun providers(server: String): Flow<AuthProviders> =
        context.settingsDataStore.data.map { prefs ->
            when (prefs[key(server)]) {
                STORED_BOTH -> AuthProviders(google = true, apple = true)
                STORED_GOOGLE -> AuthProviders(google = true, apple = false)
                else -> AuthProviders.FALLBACK
            }
        }

    suspend fun save(providers: AuthProviders, server: String) {
        context.settingsDataStore.edit {
            it[key(server)] = if (providers.apple) STORED_BOTH else STORED_GOOGLE
        }
    }

    private fun key(server: String) = stringPreferencesKey("auth.providers.$server")

    private companion object {
        const val STORED_BOTH = "google,apple"
        const val STORED_GOOGLE = "google"
    }
}
