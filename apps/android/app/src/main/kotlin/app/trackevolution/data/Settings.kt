package app.trackevolution.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore

/**
 * The app's one preferences store.
 *
 * Declared here and only here: DataStore throws if two instances are created for
 * the same file in one process, so the theme override, the server override and
 * the remembered provider list all read through this single delegate rather than
 * each declaring their own.
 *
 * Nothing secret goes in here — the bearer token and the in-flight PKCE verifier
 * live in the encrypted store (`auth/AuthStore.kt`).
 */
internal val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore("settings")
