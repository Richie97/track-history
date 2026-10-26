package app.trackevolution.ui.stage

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import app.trackevolution.core.VideoSync
import app.trackevolution.data.settingsDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val SYNC_MODE_KEY = stringPreferencesKey("sync_mode")

/**
 * The two-lap stage's last sync mode, remembered per device (NS-51): the web's
 * `th-sync-mode`, iOS's `syncMode`. Not an account setting — nothing else about
 * viewing a chart is — and anything unreadable reads as *Same place*.
 * The [ui.theme.ThemePreference] arrangement, in the same one DataStore.
 */
class SyncModePreference(private val context: Context) {

    val mode: Flow<VideoSync.SyncMode> =
        context.settingsDataStore.data.map { VideoSync.SyncMode.fromKey(it[SYNC_MODE_KEY]) }

    suspend fun set(mode: VideoSync.SyncMode) {
        context.settingsDataStore.edit { it[SYNC_MODE_KEY] = mode.key }
    }
}
