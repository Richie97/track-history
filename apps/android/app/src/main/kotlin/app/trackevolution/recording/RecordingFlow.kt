package app.trackevolution.recording

import android.content.Context
import app.trackevolution.core.Gate
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.LineReview
import app.trackevolution.core.RecorderCore
import app.trackevolution.core.Recording
import app.trackevolution.core.TracePoint
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.core.telemetry.Telemetry
import app.trackevolution.core.telemetry.asTelemetry
import app.trackevolution.videoimport.ImportedClip
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import app.trackevolution.core.model.TracePoint as WireTracePoint

/**
 * One thing being reviewed: a recording, or one clip out of an import.
 *
 * `ReviewItem` on iOS. [file] is empty for a phone recording, which has no file;
 * [error] is why a clip yielded nothing, shown by name rather than dropped.
 */
data class ReviewItem(
    val file: String,
    val parsed: ParsedTelemetry?,
    val error: String? = null,
    /** Whether it gets saved as a session. */
    val include: Boolean,
    /**
     * Whether the driver has changed [include] by hand. Until they do, a line
     * pick that produces laps re-checks the clip — the web app's rule, where a
     * disabled checkbox defaults back to checked once there is something to save.
     */
    val includeTouched: Boolean = false,
    val label: String,
) {
    val laps get() = parsed?.laps.orEmpty()
    val hasLaps get() = laps.isNotEmpty()
}

/**
 * What the review screen is showing. Hoisted out of the composable so the whole
 * flow survives rotation and can be reconstructed after process death — the
 * screen is a projection of this, never the owner of it.
 */
data class ReviewUiState(
    val items: List<ReviewItem> = emptyList(),
    /** Imported clips rather than a phone recording: several items, nothing to discard. */
    val isImport: Boolean = false,
    /**
     * The trace the picker draws — the longest one still waiting for a line, in
     * the batch's shared frame. Empty when nothing needs a line (a PDR clip with
     * beacons arrives with its laps and skips the picker entirely).
     */
    val pickTrace: List<TracePoint> = emptyList(),
    /** Events this session can be saved onto, newest first from the server. */
    val events: List<Event> = emptyList(),
    val selectedEventId: Int? = null,
    val pickedIndex: Int? = null,
    val gate: Gate? = null,
    /** Why the current pick yielded nothing, when it did. */
    val problem: LineReview.Problem? = null,
    /** Free-text notes, for a recording. An import's notes are written for it. */
    val notes: String = "",
    val saving: Boolean = false,
    /** The server's own message when a save failed. */
    val error: String? = null,
) {
    val needsLinePick: Boolean get() = pickTrace.isNotEmpty()

    /** Items that will actually be posted. */
    val selectedCount: Int get() = items.count { it.include && it.hasLaps }

    val canSave: Boolean get() = selectedCount > 0 && selectedEventId != null && !saving

    /** The recording's laps, for the single-item case the screen lays out simply. */
    val trace: List<TracePoint> get() = pickTrace
}

/**
 * Everything between "stopped recording" (or "picked some videos") and "it's a
 * session in the logbook".
 *
 * Held above the view tree, so rotating the phone or walking away from the
 * review screen doesn't lose a pick — and so a process death leaves a recording
 * exactly where it was, on disk, to be offered again.
 *
 * Generalised from a single [Recording] to a list of [ReviewItem]s over
 * [ParsedTelemetry] when video import landed, the way NS-30 generalised iOS's
 * `ReviewModel`: a PDR clip with beacons arrives with exact laps and skips the
 * picker, a GoPro clip needs a line, a phone recording converts into the same
 * shape — and the line picker, the lap list, the event choice and the save are
 * one code path. A side effect worth knowing: a *recorded* session now stores
 * per-lap channels too, since `buildLapChannels` exists natively.
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

    /** The recording being reviewed, when this is a recording. Null for an import. */
    private var recording: Recording? = null

    /**
     * The shared projection frame: one picked line applies to every trace in the
     * batch, which only means anything if they are all projected the same way.
     */
    private var origin: GpsPoint? = null

    /** True once a save has landed, so the caller can leave the screen. */
    private val _saved = MutableStateFlow(false)
    val saved: StateFlow<Boolean> = _saved.asStateFlow()

    /** Where the last save went, so an import can return to that event. */
    var savedEventId: Int? = null
        private set

    /**
     * Loads a stopped (or recovered) recording for review.
     *
     * A recording too short or too stationary to be a session yields no trace —
     * `toParsed` refuses under 30 fixes or 60 seconds — and the screen says so
     * rather than pretending.
     */
    fun begin(recording: Recording) {
        this.recording = recording
        val parsed = RecorderCore.toParsed(recording)?.asTelemetry()
        val item = ReviewItem(
            file = "",
            parsed = parsed,
            error = if (parsed == null) {
                "This recording is too short or too still to time laps from — under a minute, or the car never moved."
            } else {
                null
            },
            include = true,
            // "Recorded 14:32" — the same default the web app's review flow uses.
            label = "Recorded ${parsed?.time ?: ""}".trim(),
        )
        _saved.value = false
        savedEventId = null
        _state.value = ReviewUiState(items = listOf(item), selectedEventId = recording.eventId?.toIntOrNull())
        rebuildPickTrace()
        loadEvents()
    }

    /**
     * Loads parsed clips for review. [preferredEventId] is the event whose page
     * the import was started from, pre-selected in the event picker.
     */
    fun beginImport(clips: List<ImportedClip>, preferredEventId: Int?) {
        recording = null
        val items = clips.map { clip ->
            ReviewItem(
                file = clip.file,
                parsed = clip.parsed,
                error = clip.error,
                include = !clip.parsed?.laps.isNullOrEmpty(),
                label = clip.parsed?.let { Telemetry.defaultLabel(it, clip.file) } ?: clip.file,
            )
        }
        _saved.value = false
        savedEventId = null
        _state.value = ReviewUiState(items = items, isImport = true, selectedEventId = preferredEventId)
        rebuildPickTrace()
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

    /**
     * The trace the picker draws: the longest one still waiting for a line, in
     * the batch's shared frame. Ties keep the *first* candidate, as the JS does.
     */
    private fun rebuildPickTrace() {
        val candidates = _state.value.items.mapNotNull { it.parsed }.filter { it.needsLine && !it.gps.isNullOrEmpty() }
        val first = candidates.firstOrNull()
        if (first == null) {
            origin = null
            _state.value = _state.value.copy(pickTrace = emptyList())
            return
        }
        origin = first.gps?.firstOrNull()
        val longest = candidates.drop(1).fold(first) { best, p ->
            if ((p.gps?.size ?: 0) > (best.gps?.size ?: 0)) p else best
        }
        val gps = longest.gps
        _state.value = _state.value.copy(
            pickTrace = if (gps == null || origin == null) emptyList() else GeoTrace.projectTrace(gps, origin),
        )
    }

    fun selectEvent(id: Int) {
        _state.value = _state.value.copy(selectedEventId = id, error = null)
    }

    /** A tap on the trace: build the gate, time every waiting clip's laps, show them at once. */
    fun pick(index: Int) {
        val current = _state.value
        val gate = GeoTrace.buildGate(current.pickTrace, index)
        if (gate == null) {
            // The car wasn't moving there, so there's no direction of travel to
            // build a gate across.
            _state.value = applyGate(current, null).copy(
                pickedIndex = index,
                gate = null,
                problem = LineReview.Problem.STATIONARY_PICK,
                error = null,
            )
            return
        }
        val next = applyGate(current, gate)
        _state.value = next.copy(
            pickedIndex = index,
            gate = gate,
            problem = if (next.items.none { it.hasLaps }) LineReview.Problem.NO_CROSSINGS else null,
            error = null,
        )
    }

    /** Recompute every waiting clip's laps for a gate; null clears them. */
    private fun applyGate(state: ReviewUiState, gate: Gate?): ReviewUiState = state.copy(
        items = state.items.map { item ->
            val parsed = item.parsed
            if (parsed == null || !parsed.needsLine) return@map item
            val next = Telemetry.applyGate(parsed, origin, gate)
            item.copy(
                parsed = next,
                // A clip that only just produced laps becomes includable, and a
                // pick that took them away must not stay checked — unless the
                // driver has already made that choice themselves.
                include = if (item.includeTouched) item.include else next.laps.isNotEmpty(),
            )
        },
    )

    fun setLabel(index: Int, label: String) {
        updateItem(index) { it.copy(label = label) }
    }

    /** The single-item spelling, for the recording screen's one label field. */
    fun setLabel(label: String) = setLabel(0, label)

    fun setInclude(index: Int, include: Boolean) {
        updateItem(index) { it.copy(include = include, includeTouched = true) }
    }

    fun setNotes(notes: String) {
        _state.value = _state.value.copy(notes = notes)
    }

    private fun updateItem(index: Int, change: (ReviewItem) -> ReviewItem) {
        val items = _state.value.items
        if (index !in items.indices) return
        _state.value = _state.value.copy(items = items.mapIndexed { i, item -> if (i == index) change(item) else item })
    }

    /**
     * Saves every included item as a session on the selected event.
     *
     * **A failure must never lose the recording.** The journal is cleared only
     * once the server has accepted it, so a dead network in a paddock costs a
     * retry and nothing else. An import has nothing to lose — the clips are
     * still on the phone — but the same rule holds: a failed POST leaves the
     * review up with the server's message, and what was already saved stays.
     */
    fun save(context: Context) {
        val current = _state.value
        if (!current.canSave) return
        val eventId = current.selectedEventId ?: run {
            _state.value = current.copy(error = "Pick an event to save this session onto.")
            return
        }
        val selected = current.items.withIndex().filter { it.value.include && it.value.hasLaps }
        if (selected.isEmpty()) return

        _state.value = current.copy(saving = true, error = null)
        scope.launch {
            val previousBest = current.events.firstOrNull { it.id == eventId }?.bestMs
            var personalBest = false
            var remaining = current.items
            try {
                for ((index, item) in selected) {
                    val parsed = item.parsed ?: continue
                    val best = parsed.laps.minOf { it.timeMs }
                    if (previousBest == null || best < previousBest) personalBest = true
                    api.createSession(
                        eventId = eventId,
                        draft = SessionDraft(
                            label = item.label.trim().ifBlank { null },
                            notes = notesFor(item, parsed, current.notes),
                            laps = parsed.laps.map { it.timeMs },
                            // The best lap's downsampled polyline, drawn as the
                            // racing line on the event page, plus the per-lap
                            // channel arrays the lap overlay (NS-24) draws. Both
                            // come from the same pick that timed the laps.
                            trace = parsed.bestLapTrace?.map { WireTracePoint(x = it.x, y = it.y, v = it.v) },
                            channels = parsed.lapChannels,
                        ),
                    )
                    // Posted: a retry after a later failure must not post it twice.
                    remaining = remaining.mapIndexed { i, r -> if (i == index) r.copy(include = false, includeTouched = true) else r }
                }
                // Only now is it safe to forget: the session exists server-side.
                if (recording != null) Recorder.consumeFinished(context)
                recording = null
                savedEventId = eventId
                if (personalBest) Haptics.personalBest(context) else Haptics.confirm(context)
                _state.value = _state.value.copy(saving = false)
                _saved.value = true
            } catch (e: ApiException) {
                Haptics.warn(context)
                _state.value = _state.value.copy(items = remaining, saving = false, error = e.message)
            }
        }
    }

    /**
     * A recording's notes are whatever the driver typed; an import's are the
     * line the web importer writes, so the same file reads identically either
     * way.
     */
    private fun notesFor(item: ReviewItem, parsed: ParsedTelemetry, typed: String): String? {
        if (parsed.kind == ParsedTelemetry.Kind.LIVE) return typed.trim().ifBlank { null }
        return Telemetry.importNotes(parsed, item.file)
    }

    /**
     * Throws a recording away, journal and all — confirmed by the screen first.
     * For an import there is nothing on disk to clear; the review just closes.
     */
    fun discard(context: Context) {
        if (recording != null) Recorder.consumeFinished(context)
        recording = null
        _state.value = ReviewUiState()
        _saved.value = true
    }

    fun acknowledgeSaved() {
        _saved.value = false
        savedEventId = null
    }
}
