package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A track in the user's logbook, with per-track aggregates. `tracksSummary` in
 * `src/db.ts` is the canonical shape.
 *
 * Tracks are per-user, but the name carries the layout — "Virginia International
 * Raceway (Full)" vs "(Patriot)" — so bests and goals never mix across layouts.
 * [catalogId] links to the seeded canonical catalog.
 */
@Serializable
public data class Track(
    val id: Int,
    val name: String,
    /** Target lap time the user is chasing here. */
    @SerialName("goal_ms") val goalMs: Int? = null,
    val notes: String? = null,
    @SerialName("catalog_id") val catalogId: Int? = null,
    @SerialName("updated_at") val updatedAt: Long,
    /** Past events only — `tracksSummary` filters `start_date <= today`. */
    @SerialName("event_count") val eventCount: Int,
    @SerialName("track_days") val trackDays: Int,
    @SerialName("best_ms") val bestMs: Int? = null,
    /** Start date of the most recent past event; null when there are none. */
    @SerialName("last_date") val lastDate: String? = null,
    /**
     * Chronological best-per-event series.
     *
     * Decoded and not drawn: the track cards' sparkline came off every client (a
     * track usually holds two or three events, and two points is not a trend).
     * The field stays because it is non-optional here and on iOS, so the server
     * cannot stop sending it while these builds are in the wild.
     */
    val series: List<TrackSeriesPoint>,
)

/**
 * One point of a track's progress series. [bestMs] is never null — the server
 * filters events without a best out of the series.
 */
@Serializable
public data class TrackSeriesPoint(
    val date: String,
    @SerialName("best_ms") val bestMs: Int,
)

/**
 * An entry of the seeded canonical track catalog (`GET /api/catalog`), which
 * backs the track-name suggestions in the event form.
 */
@Serializable
public data class CatalogTrack(
    val id: Int,
    val name: String,
)

/**
 * The per-track community leaderboard (`GET /api/tracks/:id/leaderboard`):
 * opted-in users' best laps at the same catalog track. [catalogId] is null for
 * a track the catalog doesn't know — no cross-user identity, so no leaderboard.
 * [optedIn] and [shareLaps] are the viewer's own flags, so the UI can offer both
 * consents without a second request.
 */
@Serializable
public data class TrackLeaderboard(
    @SerialName("catalog_id") val catalogId: Int? = null,
    @SerialName("opted_in") val optedIn: Boolean,
    /**
     * The viewer's own lap-sharing consent (NS-35). Defaulted rather than
     * required, so a response cached before the field existed still decodes.
     */
    @SerialName("share_laps") val shareLaps: Boolean = false,
    val entries: List<LeaderboardEntry>,
)

/** One leaderboard row. [you] marks the viewer's own entry. */
@Serializable
public data class LeaderboardEntry(
    val name: String? = null,
    @SerialName("best_ms") val bestMs: Int,
    val date: String,
    val you: Boolean,
    /**
     * The ranked lap, when its owner published the lap itself (NS-35) — null
     * otherwise, which is the normal case and means this row is a time rather
     * than a lap. Non-null is what makes a row openable; the server re-checks
     * every condition on the way in, so a null here is a refusal to offer the
     * tap, never the only thing standing between a viewer and the lap.
     */
    @SerialName("lap_id") val lapId: Int? = null,
)

/**
 * One shared leaderboard lap (`GET /api/tracks/:id/leaderboard/laps/:lapId`,
 * NS-35): the ranked lap another driver published, opened.
 *
 * Everything the server publishes is here, and the shape is the point — there is
 * no session, no event, no car and nothing else user-entered to decode, because
 * none of it is shared at any setting. [ambientC] and [elevationM] are the
 * recorder's own, the same two columns the logbook shows outside the Pro strip.
 * [channels] is the one Pro field and arrives null for a free account, exactly as
 * it does on a session; [trace] and the times do not.
 */
@Serializable
public data class LeaderboardLap(
    @SerialName("lap_id") val lapId: Int,
    val name: String? = null,
    val you: Boolean,
    @SerialName("time_ms") val timeMs: Int,
    val date: String,
    @SerialName("ambient_c") val ambientC: Double? = null,
    @SerialName("elevation_m") val elevationM: Double? = null,
    val trace: List<TracePoint>? = null,
    val channels: SessionChannels? = null,
) {
    /**
     * The single published entry, or null when the account is free (channels
     * stripped) or the lap stored no traces.
     */
    val entry: LapChannels? get() = channels?.laps?.firstOrNull()
}

/**
 * One row of "setup vs. lap times" for a track (`GET /api/tracks/:id/setups`):
 * a day's setup sheet paired with what the car did that day.
 */
@Serializable
public data class TrackSetupRow(
    @SerialName("event_id") val eventId: Int,
    @SerialName("start_date") val startDate: String,
    val day: Int,
    val car: String? = null,
    val conditions: Conditions? = null,
    @SerialName("temp_f") val tempF: Int? = null,
    @SerialName("best_ms") val bestMs: Int? = null,
    val consistency: Double? = null,
    val data: SetupSheet,
)
