package app.trackevolution.recording

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import app.trackevolution.core.LocationFix
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Fixes from the fused provider, shaped for `RecorderCore`.
 *
 * Configured for a car on a circuit, which is the opposite of what the
 * power-saving defaults assume:
 *
 *  - `PRIORITY_HIGH_ACCURACY` — GPS, not cell/wifi trilateration.
 *  - A 200 ms interval with `minUpdateIntervalMillis` matching, so the provider
 *    delivers as fast as it can rather than batching. At 100 mph a car covers
 *    9 m in 200 ms; a start/finish gate is 40 m wide, so this is the coarsest
 *    rate that still puts several fixes through the gate.
 *  - `minUpdateDistanceMeters = 0` — a stationary car in the pits still has to
 *    produce fixes, because the auto-stop rules are counted in fixes.
 *  - `waitForAccurateLocation = true` — better to start a beat late than to seed
 *    the trace with a cell-tower fix a kilometre wide.
 *
 * Deliberately **not** geofencing, passive location, or significant-change:
 * those are power-efficient and useless here. Lap timing needs dense fixes.
 */
class LocationSource(context: Context) {

    private val client: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context.applicationContext)

    private var callback: LocationCallback? = null

    /**
     * Starts delivery on [looperCallbacksOn]'s thread. The caller must hold
     * fine-location permission — [RecorderPermissions.blocker] is what decides
     * that, and this asserts nothing.
     */
    @SuppressLint("MissingPermission")
    fun start(onFix: (LocationFix) -> Unit) {
        stop()
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
            .setMinUpdateIntervalMillis(INTERVAL_MS)
            .setMinUpdateDistanceMeters(0f)
            .setWaitForAccurateLocation(true)
            .build()

        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                // A batched result carries several fixes with their own
                // timestamps; each is passed through separately so the
                // recorder's monotonic-time check sees real spacing rather than
                // one instant.
                result.locations.forEach { onFix(it.toFix()) }
            }
        }
        callback = cb
        client.requestLocationUpdates(request, cb, android.os.Looper.getMainLooper())
    }

    fun stop() {
        callback?.let { client.removeLocationUpdates(it) }
        callback = null
    }

    private companion object {
        const val INTERVAL_MS = 200L
    }
}

/**
 * A platform fix, normalized.
 *
 * The two `null`s are the point. Android reports 0 for speed and accuracy when
 * it has none, and a 0 that means "unknown" is indistinguishable from a 0 that
 * means "stationary" or "perfect" once it is in the trace — which would make the
 * auto-stop rules and the accuracy filter read noise as data. `hasSpeed()` and
 * `hasAccuracy()` are the only way to tell the two apart.
 *
 * `time` is the fix's own timestamp, not the clock at delivery: a batched
 * delivery would otherwise collapse to one instant and be rejected wholesale by
 * `Recording.addFix`'s monotonic check.
 */
internal fun Location.toFix(): LocationFix = LocationFix(
    timeMs = time.toDouble(),
    lat = latitude,
    lon = longitude,
    speed = if (hasSpeed()) speed.toDouble() else null,
    accuracy = if (hasAccuracy()) accuracy.toDouble() else null,
)
