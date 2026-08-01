package app.trackevolution.recording

import android.content.Context
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.LineReview
import app.trackevolution.core.RecorderCore
import app.trackevolution.core.Recording
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.SessionDraft
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import app.trackevolution.core.model.TracePoint as WireTracePoint

/**
 * Everything between "stopped recording" and "it's a session in the logbook".
 *
 * Held above the view tree, so rotating the phone or walking away from the
 * review screen doesn't lose a pick — and so a process death leaves the
 * recording exactly where it was, on disk, to be offered again.
 *
 * Note the two `TracePoint`s in play: `GeoTrace`'s carries a timestamp and is
 * what the picker works in, while the model's is the `[x, y, v]` wire format the
 * server stores. They are aliased apart deliberately rather than star-imported
 * into ambiguity.
 */
class RecordingFlow(
    private val scope: CoroutineScope,
    private val api: ApiClient,
) {
    private val _state = MutableStateFlow(ReviewUiState())
    val state: StateFlow<ReviewUiState> = _state.asStateFlow()

    /** The recording being reviewed, and the gate the picker is working against. */
    private var recording: Recording? = null

    /** True once a save has landed, so the caller can leave the screen. */
    private val _saved = MutableStateFlow(false)
    val saved: StateFlow<Boolean> = _saved.asStateFlow()

    /**
     * Loads a stopped (or recovered) recording for review.
     *
     * A recording too short or too stationary to be a session yields no trace —
     * `toParsed` refuses under 30 fixes or 60 seconds — and the screen shows an
     * empty picker rather than pretending.
     */
    fun begin(recording: Recording) {
        this.recording = recording
        val parsed = RecorderCore.toParsed(recording)
        val projected = parsed?.let { GeoTrace.projectTrace(it.gps) } ?: emptyList()
        _saved.value = false
        _state.value = ReviewUiState(trace = projected)
        loadEvents()
    }

    /**
     * The events a session can be saved onto.
     *
     * A recording is deliberately allowed to exist without one — Android Auto
     * can start it before the event does (NS-20) — so choosing the event is part
     * of *saving*, not of recording. Today's event is pre-selected, since that
     * is what it almost always is.
     */
    private fun loadEvents() {
        scope.launch {
            val events = runCatching { api.events() }.getOrNull() ?: return@launch
            val today = java.time.LocalDate.now().toString()
            val likely = events.firstOrNull { it.startDate <= today } ?: events.firstOrNull()
            _state.value = _state.value.copy(
                events = events,
                selectedEventId = _state.value.selectedEventId ?: likely?.id,
            )
        }
    }

    fun selectEvent(id: Int) {
        _state.value = _state.value.copy(selectedEventId = id, error = null)
    }

    /** A tap on the trace: build the gate, time the laps, show them at once. */
    fun pick(index: Int) {
        val trace = _state.value.trace
        _state.value = _state.value.copy(
            pickedIndex = index,
            review = LineReview.pick(trace, index),
            error = null,
        )
    }

    fun setLabel(label: String) {
        _state.value = _state.value.copy(label = label)
    }

    fun setNotes(notes: String) {
        _state.value = _state.value.copy(notes = notes)
    }

    /**
     * Saves the reviewed laps as a session on [eventId].
     *
     * **A failure must never lose the recording.** The journal is cleared only
     * once the server has accepted it, so a dead network in a paddock costs a
     * retry and nothing else. (NS-22 will make this queue and replay instead;
     * until then, failing safely is the requirement.)
     */
    fun save(context: Context) {
        val current = _state.value
        if (!current.review.hasLaps || current.saving) return
        val gate = current.review.gate ?: return
        val eventId = current.selectedEventId ?: run {
            _state.value = current.copy(error = "Pick an event to save this session onto.")
            return
        }

        _state.value = current.copy(saving = true, error = null)
        scope.launch {
            try {
                api.createSession(
                    eventId = eventId,
                    draft = SessionDraft(
                        label = current.label.ifBlank { null },
                        notes = current.notes.ifBlank { null },
                        laps = current.review.laps.map { it.timeMs },
                        trace = GeoTrace.bestLapTrace(current.trace, gate)
                            ?.map { WireTracePoint(x = it.x, y = it.y, v = it.v) },
                        // Explicitly null, not a half-formed shape: per-lap
                        // channels come from the telemetry importers, which are
                        // web-only, and `sanitizeChannels` rejects anything else
                        // with a 400. Same decision NS-17 made on iOS.
                        channels = null,
                    ),
                )
                // Only now is it safe to forget: the session exists server-side.
                Recorder.consumeFinished(context)
                recording = null
                _state.value = _state.value.copy(saving = false)
                _saved.value = true
            } catch (e: ApiException) {
                Haptics.warn(context)
                _state.value = _state.value.copy(saving = false, error = e.message)
            }
        }
    }

    /** Throws the recording away, journal and all. Confirmed by the screen first. */
    fun discard(context: Context) {
        Recorder.consumeFinished(context)
        recording = null
        _state.value = ReviewUiState()
        _saved.value = true
    }

    fun acknowledgeSaved() {
        _saved.value = false
    }
}
