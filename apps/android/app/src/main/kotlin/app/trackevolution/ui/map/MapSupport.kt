package app.trackevolution.ui.map

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import app.trackevolution.BuildConfig
import app.trackevolution.core.MapViewer
import app.trackevolution.data.settingsDataStore
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * What the map viewer (NS-53) can draw on this device, and how.
 *
 * [available] is "a map at all": a Maps key in this build **and** Google Play
 * services present and current. [online] is asked at the moment the viewer
 * opens — offline, the viewer keeps to the line with *"Map imagery needs a
 * connection."*, the web's `loadFailed`. [drawMap] is the map itself.
 *
 * The seam exists because the Maps SDK cannot run under Robolectric: the
 * screen's tests provide a [MapSupport] whose [drawMap] is a stand-in, so the
 * plan, the controls, the read-out and every sentence are tested on the JVM
 * while the Google half stays four lines of SDK calls.
 */
data class MapSupport(
    val available: Boolean,
    val online: () -> Boolean = { true },
    val drawMap: @Composable (MapDraw) -> Unit = { GoogleTrackMap(it) },
)

/**
 * The seam. Null — the ordinary state — asks the device ([deviceMapSupport]);
 * a test provides its own.
 */
val LocalMapAvailable = staticCompositionLocalOf<MapSupport?> { null }

/** The device's answer: the key, Play services, and the network right now. */
fun deviceMapSupport(context: Context): MapSupport {
    val gms = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    } catch (_: Throwable) {
        // No Play services at all on this device (or a stubbed one): the line alone.
        false
    }
    return MapSupport(
        available = BuildConfig.MAPS_KEY_SET && gms,
        online = { isOnline(context) },
    )
}

private fun isOnline(context: Context): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return true
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}

private val MAP_TYPE_KEY = stringPreferencesKey("map_type")

/**
 * The viewer's last map type, remembered per device (NS-53): the web's
 * `th-map-type`, iOS's `mapType`. Anything unreadable reads as Satellite. The
 * [app.trackevolution.ui.stage.SyncModePreference] arrangement, in the same
 * one DataStore.
 */
class MapTypePreference(private val context: Context) {

    val type: Flow<MapViewer.MapType> =
        context.settingsDataStore.data.map { MapViewer.MapType.of(it[MAP_TYPE_KEY]) ?: MapViewer.DEFAULT_MAP_TYPE }

    suspend fun set(type: MapViewer.MapType) {
        context.settingsDataStore.edit { it[MAP_TYPE_KEY] = type.key }
    }
}
