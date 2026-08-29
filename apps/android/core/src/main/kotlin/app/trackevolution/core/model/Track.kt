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
    /** Chronological best-per-event series for the sparkline. */
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
 * [optedIn] is the viewer's own flag, so the UI can offer the opt-in without a
 * second request.
 */
@Serializable
public data class TrackLeaderboard(
    @SerialName("catalog_id") val catalogId: Int? = null,
    @SerialName("opted_in") val optedIn: Boolean,
    val entries: List<LeaderboardEntry>,
)

/** One leaderboard row. [you] marks the viewer's own entry. */
@Serializable
public data class LeaderboardEntry(
    val name: String? = null,
    @SerialName("best_ms") val bestMs: Int,
    val date: String,
    val you: Boolean,
)

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
