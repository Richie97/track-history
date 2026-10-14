package app.trackevolution.clips

import androidx.compose.runtime.staticCompositionLocalOf
import app.trackevolution.core.clips.ClipJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf

/**
 * What the screens read about best-lap uploads (NS-45): the jobs, the part in
 * flight and the network, for the lap page's *Preparing* / *waiting for* /
 * *uploading · N%* / *interrupted* / *Couldn't save* states, and Settings'
 * cellular switch. `ClipUploads` is the real one; the default is inert, so a
 * screen composed without it (every Robolectric test) shows no pending clip
 * rather than failing.
 */
interface ClipStatus {
    val jobs: StateFlow<List<ClipJob>>

    /** Bytes sent so far of each job's part in flight, by job id. */
    val parts: StateFlow<Map<String, Long>>

    /** The network the uploads would use, as the last callback described it. */
    val network: StateFlow<ClipNetwork>

    val cellularAllowed: Flow<Boolean>

    suspend fun setCellularAllowed(allowed: Boolean)

    /** The lap page's *Retry now*: end this job's backoff and run it at once. */
    fun retryNow(jobId: String)

    /** The lap page has said this job's failure: forget it. */
    fun acknowledge(jobId: String)

    companion object {
        val NONE: ClipStatus = object : ClipStatus {
            override val jobs: StateFlow<List<ClipJob>> = MutableStateFlow(emptyList())
            override val parts: StateFlow<Map<String, Long>> = MutableStateFlow(emptyMap())
            override val network: StateFlow<ClipNetwork> = MutableStateFlow(ClipNetwork.UNKNOWN)
            override val cellularAllowed: Flow<Boolean> = flowOf(false)
            override suspend fun setCellularAllowed(allowed: Boolean) = Unit
            override fun retryNow(jobId: String) = Unit
            override fun acknowledge(jobId: String) = Unit
        }
    }
}

/** Whether there is a network at all, and whether it is metered (cellular, a hotspot). */
data class ClipNetwork(val online: Boolean, val metered: Boolean) {
    /** Whether an upload may use it under Settings' cellular switch. */
    fun usable(cellularAllowed: Boolean): Boolean = online && (cellularAllowed || !metered)

    companion object {
        /** Before the first callback: assume a connection, so nothing claims to be offline. */
        val UNKNOWN = ClipNetwork(online = true, metered = false)
    }
}

/** Published once by `MainActivity`, from `AppServices.clips`. */
val LocalClipStatus = staticCompositionLocalOf { ClipStatus.NONE }
