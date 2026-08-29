package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** `GET /api/me` — the signed-in user plus their headline totals. */
@Serializable
public data class Me(
    val user: User,
    val totals: Totals,
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
)

/** Headline counts shown on the dashboard and the public share page. */
@Serializable
public data class Totals(
    val events: Int,
    @SerialName("track_days") val trackDays: Int,
)
