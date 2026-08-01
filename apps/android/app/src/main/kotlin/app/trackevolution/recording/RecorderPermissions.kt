package app.trackevolution.recording

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat

/**
 * Why a recording cannot start. The messages are what the UI shows: a recording
 * that cannot produce usable fixes must fail loudly and immediately rather than
 * quietly capturing an empty trace.
 */
enum class RecorderBlocker(val message: String) {
    LOCATION_DENIED(
        "Location access is off for Track Evolution. Turn it on to record laps.",
    ),

    /**
     * The user granted location but toggled *precise* off. Coarse fixes are
     * hundreds of meters wide — a start/finish line is a few meters — so this is
     * refused rather than recorded badly.
     */
    APPROXIMATE_ONLY(
        "Precise location is off. Lap timing needs it — allow precise location to record.",
    ),

    LOCATION_SERVICES_OFF(
        "Location is switched off on this device. Turn it on to record laps.",
    ),

    /**
     * Android 13+ hides a foreground-service notification without this. The
     * recording would still run, but with nothing on screen saying so — which is
     * exactly the defect the Capacitor app ships.
     */
    NOTIFICATIONS_DENIED(
        "Notifications are off, so the recording won't show one. Turn them on to see it running.",
    ),
}

/**
 * Reads the permission state a recording needs. Requesting is the UI's job
 * (NS-18); this is the part worth keeping out of a composable and testable by
 * inspection.
 *
 * The staging matters and is not ours to choose: Android **rejects** a combined
 * fine + background request. Fine location comes first with a rationale, and
 * background ("allow all the time") is a separate, later ask — after which the
 * system may simply stop showing the dialog, and the only route left is Settings.
 */
object RecorderPermissions {

    fun hasFineLocation(context: Context): Boolean =
        granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasCoarseLocation(context: Context): Boolean =
        granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    /**
     * Not required to record while the app is foregrounded with a
     * location-typed foreground service, but required for the service to keep
     * receiving fixes once the app is no longer visible — which is the whole
     * point on a track day.
     */
    fun hasBackgroundLocation(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    fun hasNotifications(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            granted(context, Manifest.permission.POST_NOTIFICATIONS)

    fun locationServicesEnabled(context: Context): Boolean {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return false
        return LocationManagerCompat.isLocationEnabled(manager)
    }

    /**
     * The first thing standing between the user and a recording, or null when
     * nothing is. Ordered by what to fix first — there is no point telling
     * someone about notifications while location is off entirely.
     */
    fun blocker(context: Context): RecorderBlocker? = when {
        !locationServicesEnabled(context) -> RecorderBlocker.LOCATION_SERVICES_OFF
        !hasCoarseLocation(context) -> RecorderBlocker.LOCATION_DENIED
        !hasFineLocation(context) -> RecorderBlocker.APPROXIMATE_ONLY
        !hasNotifications(context) -> RecorderBlocker.NOTIFICATIONS_DENIED
        else -> null
    }

    /**
     * Whether the system will let this app run unrestricted in the background.
     *
     * Worth asking because a battery-optimized app's foreground service can
     * still be killed on some skins, and the fix is one system dialog away
     * (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). NS-18 owns the prompt.
     */
    fun ignoringBatteryOptimizations(context: Context): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * OEM skins that kill foreground services beyond what stock Android does,
     * and cannot be talked out of it by any API — the user has to allow
     * background activity in the vendor's own settings app. Detected so NS-18
     * can say something specific rather than leaving a mystery.
     *
     * A guess by manufacturer, deliberately: there is no API that reports "this
     * device has an aggressive task killer", and being wrong here costs one
     * extra hint rather than a broken recording.
     */
    val hasAggressiveBackgroundLimits: Boolean
        get() = Build.MANUFACTURER.lowercase() in AGGRESSIVE_VENDORS

    private val AGGRESSIVE_VENDORS = setOf(
        "xiaomi", "redmi", "poco", "huawei", "honor", "oneplus", "oppo", "realme",
        "vivo", "samsung", "meizu", "asus",
    )

    private fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
