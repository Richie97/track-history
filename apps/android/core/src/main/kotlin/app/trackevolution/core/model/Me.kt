package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** `GET /api/me` — the signed-in user plus their headline totals. */
@Serializable
public data class Me(
    val user: User,
    val totals: Totals,
    /**
     * The account's tier (NS-32). Defaults to free so a cached response from a
     * server that predates subscriptions still decodes.
     */
    val entitlement: Entitlement = Entitlement.FREE,
)

@Serializable
public data class User(
    val id: Int,
    val email: String,
    val name: String? = null,
    /** Avatar URL from the identity provider. */
    val picture: String? = null,
    /** The public share slug, when the user has claimed one. */
    @SerialName("share_slug") val shareSlug: String? = null,
    /**
     * The user's own prep-checklist template, or null when they haven't made one
     * and the client's built-in default applies. Strings, not [ChecklistItem]s:
     * a template is what a checklist starts *from*, so it carries no done flags.
     */
    @SerialName("checklist_template") val checklistTemplate: List<String>? = null,
    /**
     * Whether the user appears on per-track community leaderboards. Defaults to
     * false so a cached response from an older server still decodes.
     */
    @SerialName("leaderboard_opt_in") val leaderboardOptIn: Boolean = false,
    /**
     * Whether the user's *ranked lap itself* — its racing line and telemetry —
     * is open to other drivers ranked at the same track (NS-35). A second,
     * separate consent stacked on [leaderboardOptIn], never implied by it.
     * Defaulted for the same reason: an older cached response has no such key.
     */
    @SerialName("leaderboard_share_laps") val leaderboardShareLaps: Boolean = false,
    /**
     * The unit system the user sees the logbook in (`PUT /api/me/units`).
     * Display-only: the server stores and returns the same numbers either way —
     * temperatures whole °F, channel speeds km/h, setup pressures psi, fuel
     * gallons. The server always answers one of the two; nullable here only so a
     * `/me` cached before the field existed still decodes, with null read as
     * [UnitSystem.IMPERIAL] (what the app always showed) via [effectiveUnits].
     */
    val units: UnitSystem? = null,
) {
    val effectiveUnits: UnitSystem get() = units ?: UnitSystem.IMPERIAL
}

/** Mirrors `UNIT_SYSTEMS` in `src/lib/validate.ts` and `public/js/units.js`. */
@Serializable
public enum class UnitSystem {
    @SerialName("imperial") IMPERIAL,
    @SerialName("metric") METRIC,
}

/** Headline counts shown on the dashboard and the public share page. */
@Serializable
public data class Totals(
    val events: Int,
    @SerialName("track_days") val trackDays: Int,
)
