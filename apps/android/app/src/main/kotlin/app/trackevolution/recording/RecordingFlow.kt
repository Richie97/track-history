package app.trackevolution.recording

import android.content.Context
import android.net.Uri
import app.trackevolution.clips.ClipRequest
import app.trackevolution.clips.ClipSink
import app.trackevolution.core.Units
import app.trackevolution.core.Gate
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.LineReview
import app.trackevolution.core.NewEventDates
import app.trackevolution.core.RecorderCore
import app.trackevolution.core.Recording
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TrackLocate
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.CatalogTrack
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.Track
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.ClipStorage
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.telemetry.LapClips
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
    /**
     * The source file, kept so its best lap can be cut at save time (NS-45).
     * A picked `content://` URI stays readable for the activity's task, which
     * outlives the review. Null for a recording, which has no video.
     */
    val uri: Uri? = null,
    /** The source file's size, for the clip's size estimate. */
    val fileBytes: Long? = null,
    /**
     * The event this item's session was saved onto, in a grouped review
     * (NS-57): a saved item leaves the cards, and a retry never posts it twice.
     */
    val savedTo: Int? = null,
    /**
     * The event created for this item's group on an attempt whose session then
     * failed (NS-57), so a retry posts onto it rather than making a second.
     */
    val eventId: Int? = null,
) {
    val laps get() = parsed?.laps.orEmpty()
    val hasLaps get() = laps.isNotEmpty()

    /** This item as `clipOffer` reads it: included only if it would be saved. */
    val offerItem: LapClips.OfferItem get() = LapClips.OfferItem(parsed, include && hasLaps && savedTo == null, fileBytes)
}

/**
 * One start/finish picker of a grouped review (NS-57): the files waiting for a
 * line at one venue, in a projection frame of their own. `auto.js`'s `picker`.
 */
data class VenuePicker(
    val place: TrackLocate.Place?,
    /** Indexes into [ReviewUiState.items]. */
    val itemIndexes: List<Int>,
    val origin: GpsPoint,
    /** The longest of those traces, in this picker's frame. */
    val pickTrace: List<TracePoint>,
    val pickedIndex: Int? = null,
    val gate: Gate? = null,
    val problem: LineReview.Problem? = null,
    /**
     * The track whose known line timed these files (phase 3) — "Start/finish
     * from your last session at …". Null once the driver picks their own.
     */
    val lineFrom: String? = null,
)

/** A group a grouped review has saved: where it went, for the "Saved:" line. */
data class SavedGroup(val eventId: Int, val name: String, val start: String, val days: Int)

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
    /**
     * The import was started from the New Event form (`Route.Import.forNewEvent`):
     * there is no event to save onto, so the event picker stands down and
     * "save" hands the drafts back to the form through [RecordingFlow.staged].
     */
    val forNewEvent: Boolean = false,
    /** Whether [events] is the server's answer, rather than the empty list it starts as. */
    val eventsLoaded: Boolean = false,
    /**
     * Why the events didn't load — "Couldn't load your events: …", iOS's
     * wording — shown in the save card with a Try again rather than an empty
     * picker and a Save that can never enable. Null once they have.
     */
    val eventsError: String? = null,
    /**
     * *Save to a new event* (#344) has handed the drafts to the New Event form
     * and the review is waiting underneath it — closed, not reset, so backing
     * out of the form comes back to it with nothing lost.
     */
    val awaitingNewEvent: Boolean = false,
    val saving: Boolean = false,
    /** The server's own message when a save failed. */
    val error: String? = null,
    /**
     * *Save best-lap video* (NS-45). **On for every review** — a fresh state
     * starts it true, and nothing remembers it off — so the default the
     * driver asked for always holds. Read only when the row is `ON`.
     */
    val saveClips: Boolean = true,
    /**
     * The row's Best lap / Every lap choice (NS-50). **Best lap in every
     * review** — a fresh state starts here and nothing remembers Every lap, so
     * nobody fills their storage by accident. Held here, above the view tree,
     * so a rotation keeps the pick. Read through [effectiveClipScope], which
     * falls back to Best lap whenever Every lap isn't on offer.
     */
    val clipScope: LapClips.ClipScope = LapClips.ClipScope.BEST,
    /**
     * An import with no event picked (NS-57): each file is placed by where it
     * was driven and the batch is grouped into events by track and run of
     * dates. The event picker stands down for [groups], one card each.
     */
    val auto: Boolean = false,
    /** `TrackLocate.groupImports` over the items that have laps and aren't saved. */
    val groups: List<TrackLocate.Group> = emptyList(),
    /** The driver's own answer per item index — a track name — which outranks the match. */
    val choices: Map<Int, String> = emptyMap(),
    /** Group keys whose track picker is open (*Change*). */
    val editing: Set<String> = emptySet(),
    /** Whether the tracks, the catalog and the events the matching reads have arrived. */
    val placesLoaded: Boolean = false,
    /** Why they didn't — shown with a Try again in the cards' place. */
    val placesError: String? = null,
    /** One start/finish picker per venue with files waiting for a line. */
    val venuePickers: List<VenuePicker> = emptyList(),
    /** The server's message per group key, for a group whose save failed. */
    val groupErrors: Map<String, String> = emptyMap(),
    val savedGroups: List<SavedGroup> = emptyList(),
    /** The driver's own tracks' names and the catalog's, offered when naming a track. */
    val trackNames: List<String> = emptyList(),
    /**
     * The track whose known line timed this review's files with no pick
     * (phase 3) — on an event's own review, where [pickTrace] is the picker.
     */
    val lineFrom: String? = null,
) {
    val needsLinePick: Boolean get() = pickTrace.isNotEmpty()

    /** Items that will actually be posted. */
    val selectedCount: Int get() = items.count { it.include && it.hasLaps && it.savedTo == null }

    /** The groups a grouped save would post: a track, and at least one included file. */
    val saveableGroups: List<TrackLocate.Group>
        get() = groups.filter { g -> g.track != null && g.itemIds.any { items.getOrNull(it)?.include == true } }

    val canSave: Boolean
        get() = if (auto) {
            saveableGroups.isNotEmpty() && !saving
        } else {
            selectedCount > 0 && (forNewEvent || selectedEventId != null) && !saving
        }

    /**
     * Whether *Save to a new event* takes the save button's place (#344): the
     * events came back and there are none. Not before they answer — offline,
     * that is no answer about the logbook — and not for an import begun from
     * the form, whose event is the one being typed.
     */
    val offersNewEvent: Boolean get() = !auto && !forNewEvent && eventsLoaded && events.isEmpty()

    /** The recording's laps, for the single-item case the screen lays out simply. */
    val trace: List<TracePoint> get() = pickTrace

    /**
     * Which state the *Save best-lap video* row is in (NS-45): `clipOffer`
     * over the items as they would be saved, the account's tier and its
     * storage — both off the cached `/me`.
     */
    fun clipOffer(
        entitlement: Entitlement?,
        clips: ClipStorage?,
        scope: LapClips.ClipScope = LapClips.ClipScope.BEST,
    ): LapClips.ClipOffer = LapClips.clipOffer(offerItems, entitlement, clips, scope)

    private val offerItems: List<LapClips.OfferItem> get() = items.map { it.offerItem }

    /**
     * The Every lap choice's state (NS-50), or `NONE` when the row draws no
     * choice: Best lap must be on offer (`ON` — the choice is never drawn
     * locked or full) and some included PDR session must have more than one
     * windowed lap. `ON` is the choice enabled; `FULL` is it drawn disabled,
     * with `everyLapFullText`.
     */
    fun everyLapOffer(entitlement: Entitlement?, clips: ClipStorage?): LapClips.ClipOffer {
        if (clipOffer(entitlement, clips) != LapClips.ClipOffer.ON || !LapClips.offersEveryLap(offerItems)) return LapClips.ClipOffer.NONE
        return clipOffer(entitlement, clips, LapClips.ClipScope.EVERY)
    }

    /** The scope a save uses: [clipScope], unless Every lap isn't on offer (any more), then Best lap. */
    fun effectiveClipScope(entitlement: Entitlement?, clips: ClipStorage?): LapClips.ClipScope =
        if (clipScope == LapClips.ClipScope.EVERY && everyLapOffer(entitlement, clips) == LapClips.ClipOffer.ON) {
            LapClips.ClipScope.EVERY
        } else {
            LapClips.ClipScope.BEST
        }

    /** How many clips [scope] saves, a GoPro's best lap in the same review included — the Every lap sentence's count. */
    fun clipCount(scope: LapClips.ClipScope): Int = LapClips.reviewClipCount(offerItems, scope)

    /** Their estimated total — the Every lap sentence's "about N in all". */
    fun clipBytes(scope: LapClips.ClipScope): Long = LapClips.reviewClipBytes(offerItems, scope)

    /**
     * The row's "about N MB each": the largest candidate's estimate, so the
     * sentence never undersells a batch.
     */
    val clipEstimateBytes: Long?
        get() = items.filter { it.include && it.hasLaps }.mapNotNull { item ->
            LapClips.clipCandidate(item.parsed)?.let { LapClips.estimateClipBytes(it.lap, item.fileBytes, item.parsed?.durationS) }
        }.maxOrNull()
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
    /**
     * Where best-lap clips go once their session is saved (NS-45) —
     * `ClipUploads`, which cuts and uploads them outside the save. Null in a
     * test that isn't about clips.
     */
    private val clips: ClipSink? = null,
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

    /**
     * What a grouped review matches against (NS-57): the driver's own tracks,
     * the seeded catalog, and the default car a new event starts on. Also read
     * by an event's own review, for the line its track already has (phase 3).
     */
    private var ownTracks: List<Track> = emptyList()
    private var catalog: List<CatalogTrack> = emptyList()
    private var defaultCar: String? = null

    /** Whether the driver has picked a line by hand: a known line never replaces one. */
    private var pickedByHand = false

    /** True once a save has landed, so the caller can leave the screen. */
    private val _saved = MutableStateFlow(false)
    val saved: StateFlow<Boolean> = _saved.asStateFlow()

    /** Where the last save went, so an import can return to that event. */
    var savedEventId: Int? = null
        private set

    /**
     * Session drafts an import staged for the New Event form, waiting for it
     * to take them ([takeStaged]). Filled instead of posting when the review
     * was begun with `forNewEvent`; the form posts them after `POST /events`.
     */
    private val _staged = MutableStateFlow<List<SessionDraft>>(emptyList())
    val staged: StateFlow<List<SessionDraft>> = _staged.asStateFlow()

    fun takeStaged(): List<SessionDraft> = _staged.value.also {
        _staged.value = emptyList()
        stagedSpan = null
    }

    /**
     * The dates *Save to a new event* hands the form with its drafts — the
     * sessions' own span ([NewEventDates.span]). Null for the form's own "Add
     * laps" import, which must not move a date the driver may have typed, and
     * when no clip carried a date. Set before [staged], so the form reading it
     * as the drafts arrive always sees the pair.
     */
    var stagedSpan: NewEventDates.Span? = null
        private set

    /** What *Save to a new event* handed the form, to know whether it was posted. */
    private var handedToNewEvent: List<SessionDraft> = emptyList()

    /**
     * Clips for drafts staged on the New Event form (NS-45), waiting for the
     * form to post their sessions: a clip needs a session to attach to, and
     * the form is what creates it. Matched by the draft itself, which the form
     * posts unchanged; dropped with the drafts if the form never posts them.
     */
    private var stagedClips: List<Pair<SessionDraft, List<PendingClip>>> = emptyList()

    /**
     * A clip whose session hasn't been posted yet. [lapNum] is the lap's place
     * in that session (NS-50), sent with the time so a tie reaches the right lap.
     */
    private data class PendingClip(val timeMs: Int, val lapNum: Int, val source: Uri, val window: LapClips.ClipWindow)

    /**
     * Loads a stopped (or recovered) recording for review.
     *
     * A recording too short or too stationary to be a session yields no trace —
     * `toParsed` refuses under 30 fixes or 60 seconds — and the screen says so
     * rather than pretending.
     */
    fun begin(recording: Recording) {
        this.recording = recording
        pickedByHand = false
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
     * the import was started from, pre-selected in the event picker. With
     * [forNewEvent] there is no event yet: the picker is not shown, no event
     * list is fetched, and saving stages the drafts for the form instead.
     */
    fun beginImport(
        clips: List<ImportedClip>,
        preferredEventId: Int?,
        forNewEvent: Boolean = false,
        /**
         * No event was picked (NS-57): place each file by where it was driven
         * and group the batch into events. Never with [forNewEvent].
         */
        auto: Boolean = false,
    ) {
        recording = null
        pickedByHand = false
        val items = clips.map { clip ->
            ReviewItem(
                file = clip.file,
                parsed = clip.parsed,
                error = clip.error,
                include = !clip.parsed?.laps.isNullOrEmpty(),
                label = clip.parsed?.let { Telemetry.defaultLabel(it, clip.file) } ?: clip.file,
                uri = clip.uri,
                fileBytes = clip.fileBytes,
            )
        }
        _saved.value = false
        savedEventId = null
        _state.value = ReviewUiState(
            items = items,
            isImport = true,
            selectedEventId = preferredEventId,
            forNewEvent = forNewEvent,
            auto = auto && !forNewEvent,
        )
        if (_state.value.auto) {
            buildVenuePickers()
            loadPlaces()
            return
        }
        rebuildPickTrace()
        if (!forNewEvent) loadEvents()
    }

    // ---- a grouped review: no event picked (NS-57) ---------------------------------

    /**
     * One picker per venue with files waiting for a line: a line picked at one
     * place means nothing at another, so each venue's files share a frame of
     * their own. `auto.js`'s `pickers`.
     */
    private fun buildVenuePickers() {
        data class Building(val place: TrackLocate.Place?, val origin: GpsPoint, val indexes: MutableList<Int>)
        val items = _state.value.items
        val building = mutableListOf<Building>()
        items.forEachIndexed { i, item ->
            val parsed = item.parsed ?: return@forEachIndexed
            val gps = parsed.gps
            if (!parsed.needsLine || gps.isNullOrEmpty()) return@forEachIndexed
            val place = TrackLocate.recordingPlace(gps)
            val at = if (place != null) {
                building.firstOrNull { it.place != null && TrackLocate.distanceM(it.place, place) <= TrackLocate.VENUE_RADIUS_M }
            } else {
                null
            }
            (at ?: Building(place, gps[0], mutableListOf()).also { building.add(it) }).indexes.add(i)
        }
        _state.value = _state.value.copy(
            venuePickers = building.map { b ->
                val longest = b.indexes.map { items[it].parsed!!.gps!! }.reduce { best, g -> if (g.size > best.size) g else best }
                VenuePicker(b.place, b.indexes.toList(), b.origin, GeoTrace.projectTrace(longest, b.origin))
            },
        )
    }

    /** The tracks, the catalog, the events and the default car, then the cards. */
    private fun loadPlaces() {
        scope.launch {
            try {
                ownTracks = api.tracks()
                catalog = api.catalog()
                val events = api.events()
                // A default car is a convenience; not having one is not a failure.
                defaultCar = runCatching { api.vehicles().firstOrNull { it.isDefault }?.name }.getOrNull()
                _state.value = _state.value.copy(
                    events = events,
                    eventsLoaded = true,
                    placesLoaded = true,
                    placesError = null,
                    trackNames = (ownTracks.map { it.name } + catalog.map { it.name }).distinct(),
                )
            } catch (e: ApiException) {
                _state.value = _state.value.copy(placesError = "Couldn't load your tracks: ${e.message}")
                return@launch
            }
            // A venue the driver has been to already has a line (phase 3).
            _state.value.venuePickers.indices.forEach { applyKnownLine(it) }
            regroup()
        }
    }

    /** The cards' Try again after the tracks failed to load. */
    fun reloadPlaces() {
        if (_state.value.auto) loadPlaces()
    }

    /** `TrackLocate.groupImports` over what is left to save. */
    private fun regroup() {
        val current = _state.value
        if (!current.auto || !current.placesLoaded) return
        val located = current.items.mapIndexedNotNull { i, item ->
            val parsed = item.parsed
            if (parsed == null || !item.hasLaps || item.savedTo != null) return@mapIndexedNotNull null
            val place = TrackLocate.recordingPlace(parsed)
            TrackLocate.Item(i, parsed.date, parsed.time, place, TrackLocate.locateTrack(place, ownTracks, catalog))
        }
        _state.value = current.copy(
            groups = TrackLocate.groupImports(
                located,
                current.events,
                choices = current.choices,
                ownTracks = ownTracks,
                today = java.time.LocalDate.now().toString(),
            ),
        )
    }

    /** Recompute one venue's files for its picker's gate. */
    private fun applyVenueGate(state: ReviewUiState, picker: VenuePicker, gate: Gate?): ReviewUiState = state.copy(
        items = state.items.mapIndexed { i, item ->
            val parsed = item.parsed
            if (i !in picker.itemIndexes || parsed == null || item.savedTo != null) return@mapIndexed item
            val next = Telemetry.applyGate(parsed, picker.origin, gate)
            item.copy(parsed = next, include = if (item.includeTouched) item.include else next.laps.isNotEmpty())
        },
    )

    /**
     * Time a venue's files from a line the driver already has there, keeping
     * the first whose laps turn out to be that track's. Leaves the picker as it
     * was — no line, no laps — when none fits.
     */
    private fun applyKnownLine(pickerIndex: Int) {
        val picker = _state.value.venuePickers.getOrNull(pickerIndex) ?: return
        if (picker.pickedIndex != null) return
        for (line in TrackLocate.knownLines(picker.place, ownTracks)) {
            val gate = TrackLocate.gateFromSf(line.sf, TraceGeo(picker.origin.lat, picker.origin.lon)) ?: continue
            val tried = applyVenueGate(_state.value, picker, gate)
            val places = picker.itemIndexes.map { i -> tried.items[i].takeIf { it.hasLaps }?.let { TrackLocate.recordingPlace(it.parsed) } }
            if (TrackLocate.lineFits(line.id, places, ownTracks, catalog)) {
                _state.value = tried.copy(
                    venuePickers = tried.venuePickers.mapIndexed { n, p -> if (n == pickerIndex) p.copy(gate = gate, lineFrom = line.name) else p },
                )
                return
            }
        }
    }

    /** A tap on a venue's trace: its line, and its files' laps, at once. */
    fun pickVenue(pickerIndex: Int, index: Int) {
        val current = _state.value
        val picker = current.venuePickers.getOrNull(pickerIndex) ?: return
        val gate = GeoTrace.buildGate(picker.pickTrace, index)
        val next = applyVenueGate(current, picker, gate)
        val problem = when {
            gate == null -> LineReview.Problem.STATIONARY_PICK
            picker.itemIndexes.none { next.items[it].hasLaps } -> LineReview.Problem.NO_CROSSINGS
            else -> null
        }
        _state.value = next.copy(
            venuePickers = next.venuePickers.mapIndexed { n, p ->
                if (n == pickerIndex) p.copy(pickedIndex = index, gate = gate, problem = problem, lineFrom = null) else p
            },
            error = null,
        )
        regroup()
    }

    /**
     * The driver names a group's track. An unanswered place is answered once:
     * every other date at the same place takes the name too (a group's key is
     * "<track or place>@<date>").
     */
    fun chooseTrack(groupKey: String, name: String) {
        val chosen = name.trim()
        val current = _state.value
        val group = current.groups.firstOrNull { it.key == groupKey } ?: return
        if (chosen.isEmpty()) return
        val place = groupKey.substringBeforeLast("@")
        val same = if (group.track != null) {
            listOf(group)
        } else {
            current.groups.filter { it.track == null && it.key.substringBeforeLast("@") == place }
        }
        _state.value = current.copy(
            choices = current.choices + same.flatMap { g -> g.itemIds.map { it to chosen } },
            editing = current.editing - groupKey,
            groupErrors = current.groupErrors - groupKey,
        )
        regroup()
    }

    /** *Change* on a card: open its track picker. */
    fun editGroup(groupKey: String) {
        _state.value = _state.value.copy(editing = _state.value.editing + groupKey)
    }

    /**
     * Saves a grouped review: per group, `POST /events` (unless it joins one)
     * and then each included session — the New Event form's order, so it
     * queues offline the same way. A group that fails keeps its card and the
     * server's message; the others still save. Done when nothing with laps is
     * left unsaved.
     */
    private fun saveGroups(context: Context, units: UnitSystem, withClips: Boolean, clipScope: LapClips.ClipScope) {
        val start = _state.value
        val groups = start.saveableGroups
        _state.value = start.copy(saving = true, error = null)
        scope.launch {
            for (g in groups) {
                val indexes = g.itemIds.filter { _state.value.items[it].include }
                if (indexes.isEmpty()) continue
                try {
                    // A group whose event was created on an earlier, failed
                    // attempt posts its remaining sessions onto that event.
                    var eventId = g.eventId ?: indexes.firstNotNullOfOrNull { _state.value.items[it].eventId }
                    if (eventId == null) {
                        val created = api.createEvent(TrackLocate.eventBodyFor(g, defaultCar))
                        eventId = created
                        patchItems { i, item -> if (i in g.itemIds) item.copy(eventId = created) else item }
                    }
                    for (i in indexes) {
                        val item = _state.value.items[i]
                        val parsed = item.parsed ?: continue
                        val sessionId = api.createSession(eventId = eventId, draft = draftFor(item, parsed, "", units))
                        patchItems { n, it -> if (n == i) it.copy(savedTo = eventId) else it }
                        if (withClips) clipsFor(item, clipScope).forEach { enqueueClip(it, sessionId = sessionId, eventId = eventId) }
                    }
                    _state.value = _state.value.copy(
                        groupErrors = _state.value.groupErrors - g.key,
                        savedGroups = _state.value.savedGroups + SavedGroup(eventId, g.track!!.name, g.start, g.days),
                    )
                } catch (e: ApiException) {
                    _state.value = _state.value.copy(groupErrors = _state.value.groupErrors + (g.key to (e.message ?: "Couldn't save this event.")))
                }
            }
            regroup()
            val after = _state.value
            val left = after.items.any { it.hasLaps && it.include && it.savedTo == null }
            if (!left && after.groups.isEmpty()) {
                // One event: land on it. Several: the dashboard lists them.
                savedEventId = after.savedGroups.map { it.eventId }.distinct().singleOrNull()
                Haptics.confirm(context)
                _state.value = after.copy(saving = false)
                _saved.value = true
            } else {
                if (after.groupErrors.isNotEmpty()) Haptics.warn(context)
                _state.value = after.copy(saving = false)
            }
        }
    }

    private fun patchItems(change: (Int, ReviewItem) -> ReviewItem) {
        _state.value = _state.value.copy(items = _state.value.items.mapIndexed(change))
    }

    // ---- an event's own review -----------------------------------------------------

    /**
     * On an event whose track the driver has timed before, the line is known:
     * the one their last session there used (NS-57 phase 3). Kept only when the
     * laps it cuts are that track's; a tap on the map replaces it as always.
     */
    private fun applyEventLine() {
        val current = _state.value
        if (current.auto || pickedByHand || current.gate != null || !current.needsLinePick) return
        val event = current.events.firstOrNull { it.id == current.selectedEventId } ?: return
        val track = ownTracks.firstOrNull { it.id == event.trackId } ?: return
        val from = origin ?: return
        val gate = TrackLocate.gateFromSf(track.geo?.sf, TraceGeo(from.lat, from.lon)) ?: return
        val tried = applyGate(current, gate)
        val places = tried.items.map { item ->
            item.takeIf { it.parsed?.needsLine == true && it.hasLaps }?.let { TrackLocate.recordingPlace(it.parsed) }
        }
        if (TrackLocate.lineFits(track.id, places, ownTracks, catalog)) {
            _state.value = tried.copy(gate = gate, lineFrom = track.name, problem = null)
        }
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
            val events = try {
                api.events()
            } catch (e: ApiException) {
                // Said, with a retry ([reloadEvents]) — swallowing it left an
                // empty card and a Save that could never enable.
                _state.value = _state.value.copy(eventsError = "Couldn't load your events: ${e.message}")
                return@launch
            }
            val today = java.time.LocalDate.now().toString()
            val likely = events.firstOrNull { it.startDate <= today } ?: events.firstOrNull()
            _state.value = _state.value.copy(
                events = events,
                eventsLoaded = true,
                eventsError = null,
                selectedEventId = _state.value.selectedEventId ?: likely?.id,
            )
            // Something here is waiting for a line, and the event's track may
            // already have one. Best effort: without the tracks, the picker asks.
            if (_state.value.needsLinePick && _state.value.gate == null) {
                runCatching {
                    ownTracks = api.tracks()
                    catalog = api.catalog()
                }.onSuccess { applyEventLine() }
            }
        }
    }

    /** The save card's Try again after the events failed to load. */
    fun reloadEvents() {
        if (_state.value.forNewEvent) return
        loadEvents()
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
        pickedByHand = true
        val current = _state.value.copy(lineFrom = null)
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

    /** The *Save best-lap video* switch (NS-45). */
    fun setSaveClips(on: Boolean) {
        _state.value = _state.value.copy(saveClips = on)
    }

    /** The row's Best lap / Every lap choice (NS-50). */
    fun setClipScope(scope: LapClips.ClipScope) {
        _state.value = _state.value.copy(clipScope = scope)
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
    fun save(
        context: Context,
        units: UnitSystem = Units.DEFAULT_UNITS,
        /**
         * The *Save best-lap video* row's state as the screen drew it (NS-45).
         * Clips are cut only when it was `ON` and the switch was left on.
         */
        clipOffer: LapClips.ClipOffer = LapClips.ClipOffer.NONE,
        /**
         * Which laps get a clip (NS-50) — [ReviewUiState.effectiveClipScope]
         * as the screen drew it. Best lap unless Every lap was picked and on offer.
         */
        clipScope: LapClips.ClipScope = LapClips.ClipScope.BEST,
    ) {
        val current = _state.value
        if (!current.canSave) return
        val withClips = clipOffer == LapClips.ClipOffer.ON && current.saveClips
        if (current.auto) {
            saveGroups(context, units, withClips, clipScope)
            return
        }
        if (current.forNewEvent) {
            // Nothing to post onto yet. The same drafts the loop below would
            // send go to the form, which sends them once the event exists —
            // and their clips wait for it with them ([sessionsPosted]).
            val drafts = draftsFor(current, units)
            if (withClips) holdClips(current, drafts, clipScope)
            _staged.value = drafts
            Haptics.confirm(context)
            _state.value = current.copy(saving = false, error = null)
            _saved.value = true
            return
        }
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
                    val sessionId = api.createSession(eventId = eventId, draft = draftFor(item, parsed, current.notes, units))
                    // Posted: a retry after a later failure must not post it twice.
                    remaining = remaining.mapIndexed { i, r -> if (i == index) r.copy(include = false, includeTouched = true) else r }
                    // Only now, with the session posted (or queued), are its clips
                    // asked for — handed off, never awaited, so a cut or an
                    // upload that fails can't cost the session (NS-45). One job
                    // per lap, in lap order (NS-50).
                    if (withClips) {
                        clipsFor(item, clipScope).forEach { clip -> enqueueClip(clip, sessionId = sessionId, eventId = eventId) }
                    }
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
     * The clips to cut from [item] under [scope], in lap order: its usable best
     * lap, or (NS-50) every windowed lap of a PDR session. Empty for anything
     * that isn't a video.
     */
    private fun clipsFor(item: ReviewItem, scope: LapClips.ClipScope): List<PendingClip> {
        val source = item.uri ?: return emptyList()
        return LapClips.clipCandidates(item.parsed, scope).mapNotNull { candidate ->
            val window = LapClips.clipWindow(candidate.lap, item.parsed?.durationS) ?: return@mapNotNull null
            PendingClip(timeMs = candidate.lap.timeMs, lapNum = candidate.lapNum, source = source, window = window)
        }
    }

    private fun enqueueClip(clip: PendingClip, sessionId: Int, eventId: Int) {
        // A sink that throws must not reach the save: the session is posted.
        runCatching { clips?.enqueue(ClipRequest(sessionId, eventId, clip.timeMs, clip.source, clip.window, lapNum = clip.lapNum)) }
    }

    /**
     * Staged drafts' clips, held until the New Event form posts the drafts
     * ([sessionsPosted]). [drafts] is [draftsFor]'s output, one per included
     * item, in order.
     */
    private fun holdClips(current: ReviewUiState, drafts: List<SessionDraft>, scope: LapClips.ClipScope) {
        val included = current.items.filter { it.include && it.hasLaps && it.parsed != null }
        stagedClips = stagedClips + included.zip(drafts).mapNotNull { (item, draft) ->
            clipsFor(item, scope).takeIf { it.isNotEmpty() }?.let { draft to it }
        }
    }

    /**
     * The New Event form posted [posted] onto [eventId] as sessions
     * [sessionIds] (NS-45): each that carried a staged clip has it cut and
     * uploaded now. Told of every event the form creates; a draft that held
     * no clip matches nothing.
     */
    fun sessionsPosted(eventId: Int, posted: List<SessionDraft>, sessionIds: List<Int>) {
        if (stagedClips.isEmpty()) return
        for ((draft, sessionId) in posted.zip(sessionIds)) {
            val match = stagedClips.firstOrNull { it.first === draft } ?: stagedClips.firstOrNull { it.first == draft } ?: continue
            stagedClips = stagedClips - match
            match.second.forEach { enqueueClip(it, sessionId = sessionId, eventId = eventId) }
        }
    }

    /** The included items as the bodies of `POST /events/:id/sessions`, in order. */
    private fun draftsFor(current: ReviewUiState, units: UnitSystem): List<SessionDraft> = current.items
        .filter { it.include && it.hasLaps }
        .mapNotNull { item -> item.parsed?.let { draftFor(item, it, current.notes, units) } }

    /**
     * *Save to a new event* (#344): the drafts go to the New Event form through
     * [staged] — the hand-off a new-event import already uses — and the review
     * waits, intact, while the form is open. The caller navigates to the form.
     */
    fun stageForNewEvent(
        units: UnitSystem = Units.DEFAULT_UNITS,
        clipOffer: LapClips.ClipOffer = LapClips.ClipOffer.NONE,
        clipScope: LapClips.ClipScope = LapClips.ClipScope.BEST,
    ) {
        val current = _state.value
        if (!current.offersNewEvent || current.selectedCount == 0) return
        val drafts = draftsFor(current, units)
        if (clipOffer == LapClips.ClipOffer.ON && current.saveClips) holdClips(current, drafts, clipScope)
        handedToNewEvent = drafts
        stagedSpan = NewEventDates.span(current.items.filter { it.include && it.hasLaps }.map { it.parsed?.date })
        _staged.value = drafts
        _state.value = current.copy(awaitingNewEvent = true, error = null)
    }

    /**
     * The form created the event and posted [posted] onto it. A recording is
     * forgotten only if its session was among them — the driver may have
     * removed it on the form — and otherwise stays here, journalled, for the
     * banner to offer again with the new event to save it onto.
     */
    fun newEventCreated(context: Context, posted: List<SessionDraft>) {
        if (!_state.value.awaitingNewEvent) return
        val delivered = posted.any { it in handedToNewEvent }
        handedToNewEvent = emptyList()
        if (recording != null && !delivered) {
            _state.value = _state.value.copy(awaitingNewEvent = false)
            loadEvents()
            return
        }
        if (recording != null) Recorder.consumeFinished(context)
        recording = null
        _state.value = ReviewUiState()
    }

    /**
     * Back out of the form without creating the event: the review comes back as
     * it was. The events are read again, since a session failing after the
     * event was created leaves an event to save onto rather than to make twice.
     */
    fun newEventAbandoned() {
        if (!_state.value.awaitingNewEvent) return
        // Staged again on the next Save to a new event, with the switch as it is then.
        stagedClips = stagedClips.filterNot { (draft, _) -> handedToNewEvent.any { it === draft } }
        handedToNewEvent = emptyList()
        _staged.value = emptyList()
        stagedSpan = null
        _state.value = _state.value.copy(awaitingNewEvent = false)
        loadEvents()
    }

    /** One reviewed item as the body of `POST /events/:id/sessions`. */
    private fun draftFor(item: ReviewItem, parsed: ParsedTelemetry, typed: String, units: UnitSystem) = SessionDraft(
        label = item.label.trim().ifBlank { null },
        notes = notesFor(item, parsed, typed, units),
        laps = parsed.laps.map { it.timeMs },
        // The best lap's downsampled polyline, drawn as the racing line on the
        // event page, plus the per-lap channel arrays the lap overlay (NS-24)
        // draws. Both come from the same pick that timed the laps.
        trace = parsed.bestLapTrace?.map { WireTracePoint(x = it.x, y = it.y, v = it.v) },
        channels = parsed.lapChannels,
        // Where that line lies (NS-53), so the map viewer can lay it on the
        // circuit. Only with a trace: an anchor describes one.
        traceGeo = if (parsed.bestLapTrace != null) parsed.traceGeo else null,
    )

    /**
     * A recording's notes are whatever the driver typed; an import's are the
     * line the web importer writes, so the same file reads identically either
     * way.
     */
    private fun notesFor(item: ReviewItem, parsed: ParsedTelemetry, typed: String, units: UnitSystem): String? {
        if (parsed.kind == ParsedTelemetry.Kind.LIVE) return typed.trim().ifBlank { null }
        // The top speed in the notes is in the system chosen at import time, and
        // stays that way — as on the web.
        return Telemetry.importNotes(parsed, item.file, units)
    }

    /**
     * Throws a recording away, journal and all — confirmed by the screen first.
     * For an import there is nothing on disk to clear; the review just closes.
     */
    fun discard(context: Context) {
        if (recording != null) Recorder.consumeFinished(context)
        recording = null
        // The flag survives the reset: the scaffold reads it to decide where a
        // closed review lands, and a cancelled new-event import must land back
        // on the half-typed form rather than on the dashboard.
        _state.value = ReviewUiState(forNewEvent = _state.value.forNewEvent)
        _saved.value = true
    }

    fun acknowledgeSaved() {
        _saved.value = false
        savedEventId = null
    }
}
