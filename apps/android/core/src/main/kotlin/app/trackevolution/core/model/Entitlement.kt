package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `entitlement` on `GET /api/me` — the server's answer to "is this account Pro"
 * (NS-32). The server owns it: the app never decides tier from a local
 * purchase, and offline the last fetched value stands.
 */
@Serializable
public data class Entitlement(
    val tier: Tier,
    /**
     * Where the entitlement came from: the store that sold it, `legacy` for the
     * paid-app grant, or null for an account that never had one. A lapsed
     * subscriber keeps their source so "Manage" can still target the right store.
     */
    val source: Source? = null,
    /** Epoch ms. Null for free and for legacy (which has no expiry). */
    @SerialName("expires_at") val expiresAt: Long? = null,
    /** Null when unknown (free, legacy); false when the store says it won't renew. */
    @SerialName("auto_renew") val autoRenew: Boolean? = null,
) {
    @Serializable
    public enum class Tier {
        @SerialName("free") FREE,
        @SerialName("pro") PRO,
    }

    @Serializable
    public enum class Source {
        @SerialName("legacy") LEGACY,
        @SerialName("apple") APPLE,
        @SerialName("google") GOOGLE,
    }

    public companion object {
        /** What a signed-out or never-fetched client has: free. */
        public val FREE: Entitlement = Entitlement(tier = Tier.FREE)
    }
}

/**
 * Every billing write (`POST /api/billing/apple`, `/google`, and the two legacy
 * claims) answers with the fresh entitlement so the client can update without a
 * second round trip.
 */
@Serializable
public data class BillingResponse(
    val ok: Boolean,
    val entitlement: Entitlement,
)
