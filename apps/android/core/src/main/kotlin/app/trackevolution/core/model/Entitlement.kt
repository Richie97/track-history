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

    /** What a client-side gate decides: carry on, or show the paywall instead. */
    public enum class Gate { PROCEED, PAYWALL }

    /**
     * The tier predicates — the port of `public/js/entitlement.js`, under the
     * same names, pinned case for case by `contracts/logic/entitlement.json`
     * (the fixture the iOS Kit asserts against too, so the two ports are checked
     * against the web implementation rather than against each other).
     *
     * Every one of these takes the entitlement object and **never consults the
     * clock**: expiry is the server's call, made when it answered `/api/me`.
     * Offline, the cached answer stands — a driver who was Pro at the last sync
     * records (NS-32 rule 5) — which is why a cached `expires_at` already in the
     * past on the phone's clock is still Pro here.
     */
    public companion object {
        /** What a signed-out or never-fetched client has: free. */
        public val FREE: Entitlement = Entitlement(tier = Tier.FREE)

        /**
         * On since phase D. Phase C shipped the purchase flow, the paywall and
         * the Settings row dark behind this one constant; flipping it is what
         * turned the recorder and import gates on. The gates take the flag as a
         * parameter defaulting to this, so the tests exercise both values.
         */
        public const val GATES_ENABLED: Boolean = true

        public const val APPLE_MANAGE_URL: String = "https://apps.apple.com/account/subscriptions"
        public const val GOOGLE_MANAGE_URL: String =
            "https://play.google.com/store/account/subscriptions?package=app.trackevolution"

        /** An entitlement, or nothing at all (signed out, never fetched) — the latter is free, never Pro. */
        public fun isPro(entitlement: Entitlement?): Boolean = entitlement?.tier == Tier.PRO

        /** The GPS lap recorder, live timing and predictive delta. */
        public fun canRecord(entitlement: Entitlement?): Boolean = isPro(entitlement)

        // Telemetry import is **free** and has no predicate, on purpose: there
        // is no decision to make, and a `canImport` that always answered true
        // would read as a gate someone had forgotten to wire. An import yields
        // lap times, the racing line and the car metrics for free; the per-lap
        // channel arrays it also writes are the Pro half, withheld by the
        // server — see [canViewChannels].

        /**
         * Channel graphs, the lap delta chart, the two-lap compare and sector
         * splits all read `channels`, which the server strips for a free account
         * (rule 4); this only decides whether the resulting empty state carries
         * the paywall copy.
         */
        public fun canViewChannels(entitlement: Entitlement?): Boolean = isPro(entitlement)

        /** Garage consumables, the setup notebook and year in review. */
        public fun canUseGarage(entitlement: Entitlement?): Boolean = isPro(entitlement)
        public fun canUseSetups(entitlement: Entitlement?): Boolean = isPro(entitlement)
        public fun canViewYearInReview(entitlement: Entitlement?): Boolean = isPro(entitlement)

        /**
         * The web's two-event lap overlay. Ported for name parity with
         * `public/js/entitlement.js` and the shared fixture, though no Android
         * screen reads it — the overlay is web-only (docs/specs/native/README.md).
         */
        public fun canCompareEvents(entitlement: Entitlement?): Boolean = isPro(entitlement)

        /**
         * Where "Manage subscription" goes, by the store that sold it. Legacy has
         * no subscription to manage and free has nothing yet — both null. A lapsed
         * subscriber keeps their source, so Manage still targets the right store.
         */
        public fun manageUrl(entitlement: Entitlement?): String? = when (entitlement?.source) {
            Source.APPLE -> APPLE_MANAGE_URL
            Source.GOOGLE -> GOOGLE_MANAGE_URL
            Source.LEGACY, null -> null
        }

        /**
         * One line for Settings: "Pro · renews Mar 4, 2027", "Pro · ends …",
         * "Pro · lifetime", "Free". [fmtDate] is injected, as in the JS, so the
         * rule stays locale-free and the fixture can pin the wording without the
         * date text; the default matches the JS default (an ISO date, UTC).
         */
        public fun entitlementSummary(
            entitlement: Entitlement?,
            fmtDate: (Long) -> String = ::isoDate,
        ): String {
            if (!isPro(entitlement)) return "Free"
            val expiresAt = entitlement!!.expiresAt
            if (entitlement.source == Source.LEGACY || expiresAt == null) return "Pro · lifetime"
            val when_ = fmtDate(expiresAt)
            return if (entitlement.autoRenew == false) "Pro · ends $when_" else "Pro · renews $when_"
        }

        /**
         * The recorder's start gate (rule 5): a paywall sheet, never a disabled
         * button, and only when the gates are on. The only client-side gate
         * there is — importing is free. Pure so the decision stays tested with
         * the flag injected, whatever [GATES_ENABLED] currently is.
         */
        public fun recordGate(entitlement: Entitlement?, gatesEnabled: Boolean = GATES_ENABLED): Gate =
            if (!gatesEnabled || canRecord(entitlement)) Gate.PROCEED else Gate.PAYWALL

        /** `new Date(ms).toISOString().slice(0, 10)` — the JS module's default. */
        private fun isoDate(ms: Long): String =
            java.time.Instant.ofEpochMilli(ms).atOffset(java.time.ZoneOffset.UTC).toLocalDate().toString()
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
