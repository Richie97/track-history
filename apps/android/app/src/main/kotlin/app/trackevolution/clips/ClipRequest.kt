package app.trackevolution.clips

import android.net.Uri
import app.trackevolution.core.telemetry.LapClips

/**
 * One best-lap clip the review asked for (NS-45): cut [window] out of
 * [source] and upload it for the lap timed [timeMs] in session [sessionId].
 *
 * Built by `RecordingFlow` only **after** the session's `POST` has answered,
 * so [sessionId] is the server's id or, offline, the temp id the queue gave
 * it — never a guess. The cut and the upload happen elsewhere ([ClipSink]),
 * outside the save, so neither can fail it.
 */
data class ClipRequest(
    val sessionId: Int,
    val eventId: Int,
    val timeMs: Int,
    val source: Uri,
    val window: LapClips.ClipWindow,
)

/** Where the review hands its clips. `ClipUploads` in the app; a list in a test. */
fun interface ClipSink {
    fun enqueue(request: ClipRequest)
}
