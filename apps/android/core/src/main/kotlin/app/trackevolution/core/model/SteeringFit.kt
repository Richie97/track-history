package app.trackevolution.core.model

import app.trackevolution.core.Balance
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /api/vehicles/:id/steering-fit` (#223): the per-session steering fits
 * behind the vehicle form's "Measured from 6 sessions: 15.8:1" line —
 * `steeringFit` run server-side over the car's most recent channel-carrying
 * sessions, newest first, only the ones that fit. The client pools them with
 * [Balance.estimateSteeringRatio] against the wheelbase *in the form*, which
 * may not be the stored one yet, so the ratio itself is not in the response.
 * Pro, like the rest of the garage; a read, so it caches like any other.
 */
@Serializable
public data class SteeringFits(
    val fits: List<SteeringFit>,
)

/** One session's fit with where it came from. The four numbers are [Balance.Fit]'s. */
@Serializable
public data class SteeringFit(
    @SerialName("session_id") val sessionId: Int,
    @SerialName("event_id") val eventId: Int,
    /** The event's start date, ISO `YYYY-MM-DD`. */
    @SerialName("start_date") val startDate: String,
    val gain0: Double,
    @SerialName("K") val k: Double,
    val samples: Int,
    val r2: Double,
) {
    /** The fit as the pooling reads it. */
    val fit: Balance.Fit
        get() = Balance.Fit(gain0 = gain0, k = k, samples = samples, r2 = r2)
}
