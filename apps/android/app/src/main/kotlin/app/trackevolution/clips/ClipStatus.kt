package app.trackevolution.clips

import androidx.compose.runtime.staticCompositionLocalOf
import app.trackevolution.core.clips.ClipJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf

/**
 * What the screens read about best-lap uploads (NS-45): the jobs, for the lap
 * page's *Video uploading* / *waiting for Wi-Fi* / *Couldn't save* states, and
 * Settings' cellular switch. `ClipUploads` is the real one; the default is
 * inert, so a screen composed without it (every Robolectric test) shows no
 * pending clip rather than failing.
 */
interface ClipStatus {
    val jobs: StateFlow<List<ClipJob>>
    val cellularAllowed: Flow<Boolean>

    suspend fun setCellularAllowed(allowed: Boolean)

    companion object {
        val NONE: ClipStatus = object : ClipStatus {
            override val jobs: StateFlow<List<ClipJob>> = MutableStateFlow(emptyList())
            override val cellularAllowed: Flow<Boolean> = flowOf(false)
            override suspend fun setCellularAllowed(allowed: Boolean) = Unit
        }
    }
}

/** Published once by `MainActivity`, from `AppServices.clips`. */
val LocalClipStatus = staticCompositionLocalOf { ClipStatus.NONE }
