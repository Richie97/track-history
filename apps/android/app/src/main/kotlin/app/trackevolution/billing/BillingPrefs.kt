package app.trackevolution.billing

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import app.trackevolution.data.settingsDataStore
import kotlinx.coroutines.flow.first

/**
 * What the purchase flow remembers between launches: whether this install has
 * made its legacy claim, and which purchase tokens the server has accepted.
 *
 * In the shared preferences DataStore rather than the encrypted token store — a
 * purchase token is not a credential (the server verifies it against the Play
 * Developer API with its own service account), and nothing here is secret. It is
 * **per install**, which is what NS-32 requirement 6 asks of the claim; signing
 * out does not clear it, since a second account on the same phone is not a
 * second purchase.
 */
class BillingPrefs(private val context: Context) {

    suspend fun legacyClaimed(): Boolean =
        context.settingsDataStore.data.first()[LEGACY_CLAIMED] ?: false

    suspend fun markLegacyClaimed() {
        context.settingsDataStore.edit { it[LEGACY_CLAIMED] = true }
    }

    /** Tokens `POST /api/billing/google` has answered 200 to from this install. */
    suspend fun acceptedTokens(): Set<String> =
        context.settingsDataStore.data.first()[ACCEPTED_TOKENS] ?: emptySet()

    suspend fun addAcceptedToken(token: String) {
        context.settingsDataStore.edit { it[ACCEPTED_TOKENS] = (it[ACCEPTED_TOKENS] ?: emptySet()) + token }
    }

    private companion object {
        val LEGACY_CLAIMED = booleanPreferencesKey("billing.legacy_claimed")
        val ACCEPTED_TOKENS = stringSetPreferencesKey("billing.accepted_tokens")
    }
}
