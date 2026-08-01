package app.trackevolution.ui.theme

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Which theme to use, mirroring `public/js/theme.js`: the web app follows the
 * device unless `<html data-theme>` forces one, and the choice is remembered.
 */
enum class ThemeChoice {
    System,
    Light,
    Dark,
    ;

    /** The value stored on disk. Stable — renaming an enum must not reset anyone. */
    val stored: String get() = name.lowercase()

    companion object {
        fun fromStored(value: String?): ThemeChoice =
            entries.firstOrNull { it.stored == value } ?: System
    }
}

private val Context.themeDataStore: DataStore<Preferences> by preferencesDataStore("settings")

private val THEME_KEY = stringPreferencesKey("theme")

/**
 * The persisted theme override, defaulting to following the device.
 *
 * DataStore rather than `SharedPreferences` because reading it is a suspending
 * flow: the first frame can render before disk I/O finishes, and [choice]
 * emitting later just re-composes the theme rather than blocking the launch.
 */
class ThemePreference(private val context: Context) {

    val choice: Flow<ThemeChoice> =
        context.themeDataStore.data.map { ThemeChoice.fromStored(it[THEME_KEY]) }

    suspend fun set(choice: ThemeChoice) {
        context.themeDataStore.edit { it[THEME_KEY] = choice.stored }
    }
}
