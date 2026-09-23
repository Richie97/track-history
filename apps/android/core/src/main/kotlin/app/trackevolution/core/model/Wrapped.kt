package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /api/wrapped/:year` — Season Wrapped (NS-36): one calendar year's
 * numbers, past events only, computed on the server by `src/lib/wrapped.ts`.
 *
 * Read by `WrappedScreen` in `:app`, through [app.trackevolution.core.WrappedStory]'s
 * card rules. The computation is the server's, so nothing here is ported but the
 * presentation. Every card is nullable because the server skips a card with no
 * data rather than sending it empty.
 */
@Serializable
public data class Wrapped(
    val year: Int,
    /** Every year with a past event, newest first — the picker. */
    val years: List<Int>,
    /** Today, ISO `YYYY-MM-DD`, while the year is running; null once it has ended. */
    val through: String? = null,
    val name: String? = null,
    val totals: WrappedTotals,
    @SerialName("most_driven") val mostDriven: WrappedMostDriven? = null,
    val improvement: WrappedImprovement? = null,
    val fastest: WrappedFastest? = null,
    @SerialName("new_tracks") val newTracks: List<WrappedTrack>,
    val hottest: WrappedHottest? = null,
    /**
     * The one tier-dependent field: null for a free account (the client draws
     * the two Pro cards locked); for Pro, each card is null when there is no data.
     * Absent altogether from the public share (`GET /api/share/:slug/wrapped/:year`),
     * which carries the free card set only and decodes into this same model.
     */
    val pro: WrappedPro? = null,
)

@Serializable
public data class WrappedTotals(
    val events: Int,
    /** Fractional, like [Event.days]. */
    @SerialName("track_days") val trackDays: Double,
    val tracks: Int,
    val laps: Int,
    val hours: Double,
    val miles: Double,
    /** How many of [tracks] had a known lap length — "across N of M tracks". */
    @SerialName("miles_tracks_counted") val milesTracksCounted: Int,
)

@Serializable
public data class WrappedTrack(
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
)

@Serializable
public data class WrappedMostDriven(
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
    @SerialName("track_days") val trackDays: Double,
    val laps: Int,
    @SerialName("best_ms") val bestMs: Int? = null,
)

@Serializable
public data class WrappedImprovement(
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
    @SerialName("best_before") val bestBefore: Int,
    @SerialName("best_this_year") val bestThisYear: Int,
    @SerialName("gain_ms") val gainMs: Int,
    /** `"prior_years"`, or `"first_event"` for a first year at the track. */
    val baseline: String,
)

@Serializable
public data class WrappedFastest(
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
    @SerialName("best_ms") val bestMs: Int,
    @SerialName("event_id") val eventId: Int,
    val date: String,
)

@Serializable
public data class WrappedHottest(
    @SerialName("event_id") val eventId: Int,
    @SerialName("track_name") val trackName: String,
    val date: String,
    @SerialName("temp_c") val tempC: Double,
)

@Serializable
public data class WrappedPro(
    val tire: WrappedTire? = null,
    @SerialName("top_speed") val topSpeed: WrappedTopSpeed? = null,
)

/** The tyre with the most track days on it this year (garage consumables). */
@Serializable
public data class WrappedTire(
    @SerialName("part_id") val partId: Int,
    @SerialName("vehicle_id") val vehicleId: Int,
    @SerialName("vehicle_name") val vehicleName: String,
    val name: String,
    @SerialName("track_days") val trackDays: Double,
    val hours: Double,
)

/** The year's highest stored speed sample, km/h. */
@Serializable
public data class WrappedTopSpeed(
    val kph: Double,
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
    @SerialName("event_id") val eventId: Int,
    val date: String,
)
