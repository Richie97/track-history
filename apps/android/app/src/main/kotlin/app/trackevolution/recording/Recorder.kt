package app.trackevolution.recording

import android.content.Context
import android.content.Intent
import android.os.Build
import app.trackevolution.core.Recording
import app.trackevolution.core.RecordingJournal
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the recorder is doing, as the UI sees it. */
data class RecorderState(
    val isRecording: Boolean = false,
    /** The event this recording will attach to, or null for an unattached one. */
    val eventId: String? = null,
    val startedAtMs: Double = 0.0,
    val fixCount: Int = 0,
    /** Elapsed seconds, from the last fix rather than the wall clock. */
    val elapsedS: Double = 0.0,
    /** Speed of the last accepted fix, m/s, or null when the source reported none. */
    val lastSpeedMps: Double? = null,
    /** Reported accuracy of the last accepted fix, meters, or null. */
    val lastAccuracyM: Double? = null,
    /**
     * Epoch ms at which the last fix was *delivered*, wall clock — the one place
     * the wall clock is right, because the question it answers is "how long since
     * anything arrived", and a stalled stream has no fix time to ask.
     */
    val lastFixAtMs: Long = 0L,
    /** Set when the recorder stopped itself — the 4-hour cap or forgot-to-stop. */
    val autoStopped: Boolean = false,
    /** Why a recording could not start or had to end. */
    val blocker: RecorderBlocker? = null,
)

/**
 * The seam between the recording (which lives in a foreground service, so it
 * survives the UI being swiped away) and everything that wants to watch it.
 *
 * A process-wide object rather than a bound service because the relationship is
 * one-way and the state is tiny: the UI observes and sends intents, and never
 * needs a handle on the service. NS-18's screen and NS-20's Android Auto surface
 * both read from here.
 *
 * The finished recording is handed over through [finished] rather than through
 * the state, because it is potentially 20,000 fixes and the state is re-read on
 * every recomposition.
 */
object Recorder {

    private val _state = MutableStateFlow(RecorderState())
    val state: StateFlow<RecorderState> = _state.asStateFlow()

    private val _finished = MutableStateFlow<Recording?>(null)

    /**
     * The recording waiting to be reviewed and saved — either just stopped, or
     * recovered from a previous launch that died. Cleared once NS-18's review
     * flow has taken it.
     */
    val finished: StateFlow<Recording?> = _finished.asStateFlow()

    internal fun publish(state: RecorderState) {
        _state.value = state
    }

    internal fun publishFinished(recording: Recording?) {
        _finished.value = recording
    }

    /** NS-18 calls this once the recording has been saved or discarded. */
    fun consumeFinished(context: Context) {
        _finished.value = null
        RecordingJournal(RecordingService.journalFile(context)).clear()
    }

    /**
     * Offers back a recording a previous launch never finished — the phone died,
     * the process was force-stopped, the system reclaimed it.
     *
     * Called at launch. Skipped while a recording is actually running, since the
     * journal is then the live one and surfacing it as "finished" would invite
     * the user to save a session still in progress.
     */
    fun recoverPending(context: Context) {
        if (_state.value.isRecording || _finished.value != null) return
        val recovered = RecordingJournal(RecordingService.journalFile(context)).recover() ?: return
        _finished.value = recovered
    }

    /**
     * Starts recording, attached to [eventId] when there is one.
     *
     * `startForegroundService` rather than `startService`: the app may not be in
     * the foreground when Android Auto asks for this, and only the former is
     * allowed from the background — with the five-second deadline to call
     * `startForeground` that [RecordingService] is built around.
     */
    fun start(context: Context, eventId: String? = null) {
        val intent = Intent(context, RecordingService::class.java).apply {
            action = RecordingService.ACTION_START
            putExtra(RecordingService.EXTRA_EVENT_ID, eventId)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    fun stop(context: Context) {
        context.startService(
            Intent(context, RecordingService::class.java).apply {
                action = RecordingService.ACTION_STOP
            },
        )
    }
}
