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
    /**
     * Session conditions (#191). Weather rather than anything the driver wrote
     * down, so it is shared like the rest of the event's outcome.
     */
    @SerialName("ambient_lo_c") val ambientLoC: Double? = null,
    @SerialName("ambient_hi_c") val ambientHiC: Double? = null,
    @SerialName("elevation_m") val elevationM: Double? = null,
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

/**
 * Which kind of thing one share link carries: a whole track day or a single
 * session of one (NS-48), one lap, or two laps compared (NS-56).
 */
@Serializable
public enum class ItemShareKind(
    /** The one-letter path prefix: `/share/e/<token>`, `/share/s/<token>`, `/share/l/…`, `/share/c/…`. */
    public val prefix: String,
) {
    @SerialName("event") EVENT("e"),
    @SerialName("session") SESSION("s"),

    /** One lap (NS-56). */
    @SerialName("lap") LAP("l"),

    /** Two laps at one track, A against B (NS-56). Read as [SharedCompare], not [SharedItem]. */
    @SerialName("compare") COMPARE("c"),
    ;

    public companion object {
        /** `"e"` → [EVENT], `"s"` → [SESSION], `"l"` → [LAP], `"c"` → [COMPARE], anything else null. */
        public fun forPrefix(prefix: String): ItemShareKind? = entries.firstOrNull { it.prefix == prefix }
    }
}

/**
 * `POST` / `GET /api/events/:id/share`, `/api/sessions/:id/share`,
 * `/api/laps/:id/share` and `/api/laps/:id/compare/:otherId/share` — the one
 * link an item has (NS-48, NS-56). Separate from the logbook's [ShareSlug]: sharing one
 * day exposes nothing else.
 */
@Serializable
public data class ItemShareLink(
    val kind: ItemShareKind,
    /** 128 bits, base64url — `[A-Za-z0-9_-]{22}`. */
    val token: String,
    /** The absolute link to hand to someone: `https://<host>/share/e/<token>`. */
    val url: String,
    @SerialName("created_at") val createdAt: Long,
)

/**
 * `GET /api/share/(e|s|l)/:token` — **unauthenticated**: one shared event, one
 * shared session (NS-48) or one shared lap (NS-56).
 *
 * Unlike [ShareData], [event] is the ordinary [EventDetail] the event page
 * decodes: the server sends `GET /events/:id`'s shape with every hidden field —
 * notes, checklist, costs, setups, the garage link — null or `[]`, so a coach's
 * and a link's reads share one model. A session link's event carries that one
 * session, with the header's figures worked out from it alone; a lap link's
 * carries that session cut down to the one lap — its row, its own channel
 * entry, its clip — and `trace` only when it is the lap the line was drawn from.
 */
@Serializable
public data class SharedItem(
    val kind: ItemShareKind,
    /** The owner's display name. */
    val name: String? = null,
    /**
     * The **owner's** tier — what the channel panel and the video open to. The
     * server has already stripped `channels` and `clip` by it.
     */
    val pro: Boolean,
    /** The shared session's id, for a session link; null for an event link. */
    @SerialName("session_id") val sessionId: Int? = null,
    /** The shared lap's id, for a lap link (NS-56); null for an event or session link. */
    @SerialName("lap_id") val lapId: Int? = null,
    val event: EventDetail,
)

/**
 * One side of a shared comparison (NS-56): a lap link's payload without the
 * envelope. [event] carries the one session with the one lap, and that
 * session's `channels.laps` the lap's one entry — or `channels` null when the
 * lap stored no telemetry.
 */
@Serializable
public data class SharedLapSide(
    @SerialName("session_id") val sessionId: Int,
    @SerialName("lap_id") val lapId: Int,
    val event: EventDetail,
)

/**
 * `GET /api/share/c/:token` — **unauthenticated**: two of one driver's laps at
 * one track, [a] against [b] (NS-56). The laps may be from different days, and
 * nothing else of either day comes with them.
 */
@Serializable
public data class SharedCompare(
    val kind: ItemShareKind,
    /** The owner's display name. */
    val name: String? = null,
    /**
     * The **owner's** tier. The compare is a Pro view: with `false` the link
     * still resolves, and a client shows both lap times and one sentence.
     */
    val pro: Boolean,
    val a: SharedLapSide,
    val b: SharedLapSide,
)
