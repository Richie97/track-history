package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /api/share/:slug` — the **unauthenticated** public share page.
 *
 * Deliberately separate types rather than optional-riddled variants of the
 * authed models: the server strips notes, email, per-lap data, checklists and
 * all garage/setup linkage (`src/routes/share.ts`). Modelling it separately is
 * what makes "did we leak a private field into the public payload?" a decode
 * failure rather than a silent null.
 */
@Serializable
public data class ShareData(
    /** Display name of the logbook's owner. */
    val name: String? = null,
    val totals: Totals,
    val events: List<SharedEvent>,
    val tracks: List<SharedTrack>,
)

/**
 * An event as seen by the public: stats and times, no notes, no checklist, no
 * vehicle linkage.
 */
@Serializable
public data class SharedEvent(
    val id: Int,
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
    @SerialName("start_date") val startDate: String,
    /** Fractional, like [Event.days] — see the note there. */
    val days: Double,
    val club: String? = null,
    @SerialName("run_group") val runGroup: String? = null,
    val car: String? = null,
    val conditions: Conditions? = null,
    @SerialName("temp_f") val tempF: Int? = null,
    @SerialName("best_time_ms") val bestTimeMs: Int? = null,
    @SerialName("updated_at") val updatedAt: Long,
    @SerialName("lap_best_ms") val lapBestMs: Int? = null,
    @SerialName("lap_count") val lapCount: Int,
    @SerialName("session_count") val sessionCount: Int,
    @SerialName("best_ms") val bestMs: Int? = null,
    val consistency: Double? = null,
    val hours: Double,
)

/** A track as seen by the public: aggregates and the progress series, no notes. */
@Serializable
public data class SharedTrack(
    val id: Int,
    val name: String,
    @SerialName("goal_ms") val goalMs: Int? = null,
    @SerialName("catalog_id") val catalogId: Int? = null,
    @SerialName("updated_at") val updatedAt: Long,
    @SerialName("event_count") val eventCount: Int,
    @SerialName("track_days") val trackDays: Int,
    @SerialName("best_ms") val bestMs: Int? = null,
    @SerialName("last_date") val lastDate: String? = null,
    val series: List<TrackSeriesPoint>,
)

/** `PUT /api/share` — the slug the server settled on. */
@Serializable
public data class ShareSlug(
    val slug: String,
)
