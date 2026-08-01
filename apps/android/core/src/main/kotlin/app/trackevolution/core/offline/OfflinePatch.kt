package app.trackevolution.core.offline

import app.trackevolution.core.model.ChecklistItem
import app.trackevolution.core.model.Conditions
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.Setup
import app.trackevolution.core.model.SetupSheet
import app.trackevolution.core.model.Track
import app.trackevolution.core.model.TracePoint
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

// Optimistic patching: a queued mutation edits the cached responses it affects, so
// the UI shows the change immediately and every view agrees — the dashboard, the
// event page and the track page are three different cache entries describing the
// same rows.
//
// Patches are best-effort *display* state. A missing cache entry is skipped, never
// created: the queue is the source of truth until it flushes. Every patch is
// idempotent, because `reapplyQueue` runs them again over a fresh server response.
//
// Port of `applyLocal` in `public/js/offline.js`, function for function. Unlike
// that mirror, which surgically edits plain JSON, this decodes into the typed
// models and re-encodes — see `OfflineJson` for why that is safe.

/**
 * Apply one queued mutation to the cache, inside the caller's transaction.
 *
 * A path this doesn't recognise is simply not mirrored; the queueable whitelist
 * in [OfflineStore] is what decides whether it should have been queued at all.
 */
internal suspend fun applyLocal(item: QueuedWrite, txn: OfflineTransaction) {
    val s = item.path.split("/").filter { it.isNotEmpty() }
    val method = item.method
    when {
        method == "POST" && s == listOf("events") ->
            createEvent(item, txn)

        method == "PUT" && s.size == 2 && s[0] == "events" ->
            updateEvent(s[1], item, txn)

        method == "DELETE" && s.size == 2 && s[0] == "events" ->
            deleteEvent(s[1], txn)

        s.size == 4 && s[0] == "events" && s[2] == "setups" && (method == "PUT" || method == "DELETE") ->
            patchSetup(s[1], s[3], item, txn)

        method == "POST" && s.size == 3 && s[0] == "events" && s[2] == "sessions" ->
            addSession(s[1], item, txn)

        s.size == 2 && s[0] == "sessions" && (method == "PUT" || method == "DELETE") ->
            patchSession(s[1], item, txn)

        method == "POST" && s.size == 3 && s[0] == "sessions" && s[2] == "laps" ->
            appendLaps(s[1], item, txn)

        method == "DELETE" && s.size == 2 && s[0] == "laps" ->
            deleteLap(s[1], txn)

        method == "PUT" && s.size == 2 && s[0] == "tracks" ->
            patchTrack(s[1], item, txn)
    }
}

// ---- Events ---------------------------------------------------------------

private suspend fun createEvent(item: QueuedWrite, txn: OfflineTransaction) {
    val tempId = item.tempId ?: return
    val body = item.bodyObject() ?: return
    val startDate = body.string("start_date") ?: return
    val trackId = body.int("track_id")

    // The track name is unknown offline unless the tracks list is cached; the
    // server resolves the real one (and the vehicle link) on flush.
    val trackName = trackId?.let { id ->
        txn.tracks()?.firstOrNull { it.id == id }?.name
    } ?: body.string("track_name") ?: "(new track)"

    val detail = OfflineMirrors.recomputeDetail(
        EventDetail(
            event = Event(
                id = tempId,
                trackId = trackId ?: 0,
                trackName = trackName,
                startDate = startDate,
                days = body.double("days") ?: 1.0,
                club = body.string("club"),
                runGroup = body.string("run_group"),
                car = body.string("car"),
                // Matched server-side from the car name on flush.
                vehicleId = null,
                notes = body.string("notes"),
                conditions = body.string("conditions")?.let(::Conditions),
                tempF = body.int("temp_f"),
                checklist = body.decode("checklist", checklistSerializer),
                bestTimeMs = body.int("best_time_ms"),
                trackHours = body.double("track_hours"),
                updatedAt = 0,
                lapBestMs = null,
                lapCount = 0,
                sessionCount = 0,
                bestMs = null,
                consistency = null,
                hours = 0.0,
            ),
            sessions = emptyList(),
            setups = emptyList(),
        ),
    )

    txn.putDetail("/events/$tempId", detail)
    txn.patchEventLists { list, key ->
        // Track-filtered lists are left alone: offline, we may not know which
        // track this event belongs to.
        if (key != "/events") return@patchEventLists null
        val rest = list.filter { it.id != tempId }.toMutableList()
        val at = rest.indexOfFirst { it.startDate <= detail.event.startDate }
        rest.add(if (at == -1) rest.size else at, detail.event)
        rest
    }
}

private suspend fun updateEvent(id: String, item: QueuedWrite, txn: OfflineTransaction) {
    val body = item.bodyObject() ?: return
    val path = "/events/$id"
    val cached = txn.detail(path)
    if (cached != null) {
        val patched = OfflineMirrors.recomputeDetail(cached.copy(event = cached.event.patched(body)))
        txn.putDetail(path, patched)
        txn.syncLists(patched)
    } else {
        // No detail cached: patch the list rows directly so the dashboard still
        // shows the edit.
        txn.patchEventLists { list, _ ->
            list.map { row -> if (row.id.toString() == id) row.patched(body) else row }
        }
    }
}

/**
 * Only the fields the request actually carried — the server updates just those
 * (`if ("notes" in body)` in `src/routes/events.ts`), so a patch that filled in
 * the rest would invent data.
 */
private fun Event.patched(body: JsonObject): Event {
    var next = this
    if (body.has("track_name")) body.string("track_name")?.let { next = next.copy(trackName = it) }
    if (body.has("start_date")) body.string("start_date")?.let { next = next.copy(startDate = it) }
    if (body.has("days")) body.double("days")?.let { next = next.copy(days = it) }
    if (body.has("club")) next = next.copy(club = body.string("club"))
    if (body.has("run_group")) next = next.copy(runGroup = body.string("run_group"))
    if (body.has("car")) next = next.copy(car = body.string("car"))
    if (body.has("notes")) next = next.copy(notes = body.string("notes"))
    if (body.has("conditions")) {
        next = next.copy(conditions = body.string("conditions")?.let(::Conditions))
    }
    if (body.has("temp_f")) next = next.copy(tempF = body.int("temp_f"))
    if (body.has("checklist")) {
        next = next.copy(checklist = body.decode("checklist", checklistSerializer))
    }
    if (body.has("best_time_ms")) next = next.copy(bestTimeMs = body.int("best_time_ms"))
    if (body.has("track_hours")) next = next.copy(trackHours = body.double("track_hours"))
    return next
}

private suspend fun deleteEvent(id: String, txn: OfflineTransaction) {
    txn.responseDelete("/events/$id")
    txn.patchEventLists { list, _ -> list.filter { it.id.toString() != id } }
}

// ---- Setup sheets (inside the event detail) -------------------------------

private suspend fun patchSetup(
    eventId: String,
    day: String,
    item: QueuedWrite,
    txn: OfflineTransaction,
) {
    val dayNumber = day.toIntOrNull() ?: return
    val path = "/events/$eventId"
    val detail = txn.detail(path) ?: return

    val setups = detail.setups.filterNot { it.day == dayNumber }.toMutableList()
    if (item.method == "PUT") {
        val sheet = item.body?.let {
            runCatching { OfflineJson.decode.decodeFromString(SetupSheet.serializer(), it) }.getOrNull()
        }
        if (sheet != null) setups.add(Setup(day = dayNumber, data = sheet))
    }
    txn.putDetail(path, detail.copy(setups = setups.sortedBy { it.day }))
}

// ---- Sessions and laps ----------------------------------------------------

private suspend fun addSession(eventId: String, item: QueuedWrite, txn: OfflineTransaction) {
    val tempId = item.tempId ?: return
    val path = "/events/$eventId"
    val detail = txn.detail(path) ?: return
    // Re-apply dedupe.
    if (detail.sessions.any { it.id == tempId }) return

    val body = item.bodyObject()
    val laps = OfflineMirrors.cleanLaps(body.doubleList("laps"))
    val session = Session(
        id = tempId,
        label = body?.string("label"),
        notes = body?.string("notes"),
        sort = (detail.sessions.maxOfOrNull { it.sort } ?: 0) + 1,
        trace = body?.decode("trace", traceSerializer),
        channels = body?.decode("channels", SessionChannels.serializer()),
        laps = laps.mapIndexed { index, ms ->
            Lap(
                id = tempLapId(seed = tempId, lapNum = index + 1),
                sessionId = tempId,
                lapNum = index + 1,
                timeMs = ms,
            )
        },
    )

    val patched = OfflineMirrors.recomputeDetail(detail.copy(sessions = detail.sessions + session))
    txn.putDetail(path, patched)
    txn.syncLists(patched)
}

private suspend fun patchSession(id: String, item: QueuedWrite, txn: OfflineTransaction) {
    txn.eachEventDetail { detail ->
        val index = detail.sessions.indexOfFirst { it.id.toString() == id }
        if (index == -1) return@eachEventDetail null
        val sessions = detail.sessions.toMutableList()
        if (item.method == "PUT") {
            // The route writes both columns unconditionally (`body.label ?? null`),
            // so mirror that rather than merging.
            val body = item.bodyObject()
            sessions[index] = sessions[index].copy(
                label = body?.string("label"),
                notes = body?.string("notes"),
            )
        } else {
            sessions.removeAt(index)
        }
        detail.copy(sessions = sessions)
    }
}

private suspend fun appendLaps(sessionId: String, item: QueuedWrite, txn: OfflineTransaction) {
    // Seeded off the queue id, and offset clear of the temp-id range, so a
    // re-apply mints the same lap ids and dedupes instead of duplicating.
    val seed = item.qid.toInt() + LAP_SEED_OFFSET
    txn.eachEventDetail { detail ->
        val index = detail.sessions.indexOfFirst { it.id.toString() == sessionId }
        if (index == -1) return@eachEventDetail null

        // Re-apply dedupe. Lap numbers continue from whatever the session already
        // had, so the question is "does any lap belong to this queue entry?" —
        // every id this entry mints falls in its own 1000-wide band, which is the
        // typed equivalent of the web mirror's `q{qid}-l` marker.
        val band = seed * LAP_BAND
        val session = detail.sessions[index]
        val alreadyApplied = session.laps.any { it.id < 0 && -it.id > band && -it.id < band + LAP_BAND }
        if (alreadyApplied) return@eachEventDetail detail

        var lapNum = session.laps.maxOfOrNull { it.lapNum } ?: 0
        val added = OfflineMirrors.cleanLaps(item.bodyObject().doubleList("laps")).map { ms ->
            lapNum += 1
            Lap(
                id = tempLapId(seed = seed, lapNum = lapNum),
                sessionId = session.id,
                lapNum = lapNum,
                timeMs = ms,
            )
        }
        val sessions = detail.sessions.toMutableList()
        sessions[index] = session.copy(laps = session.laps + added)
        detail.copy(sessions = sessions)
    }
}

private suspend fun deleteLap(id: String, txn: OfflineTransaction) {
    txn.eachEventDetail { detail ->
        val index = detail.sessions.indexOfFirst { session ->
            session.laps.any { it.id.toString() == id }
        }
        if (index == -1) return@eachEventDetail null
        val sessions = detail.sessions.toMutableList()
        sessions[index] = sessions[index].copy(
            laps = sessions[index].laps.filterNot { it.id.toString() == id },
        )
        detail.copy(sessions = sessions)
    }
}

/** Local ids for rows the server hasn't seen; negative, like every temp id. */
private fun tempLapId(seed: Int, lapNum: Int): Int = -(kotlin.math.abs(seed) * LAP_BAND + lapNum)

private const val LAP_BAND = 1000

/** Keeps appended-lap seeds clear of the session temp ids, which start at 1. */
private const val LAP_SEED_OFFSET = 100_000

// ---- Tracks ---------------------------------------------------------------

private suspend fun patchTrack(id: String, item: QueuedWrite, txn: OfflineTransaction) {
    val body = item.bodyObject() ?: return
    val tracks = txn.tracks() ?: return
    val patched = tracks.map { track ->
        if (track.id.toString() != id) {
            track
        } else {
            var next = track
            if (body.has("name")) body.string("name")?.let { next = next.copy(name = it) }
            if (body.has("notes")) next = next.copy(notes = body.string("notes"))
            if (body.has("goal_ms")) next = next.copy(goalMs = body.int("goal_ms"))
            next
        }
    }
    txn.responsePut("/tracks", OfflineJson.encode.encodeToString(trackListSerializer, patched))
}

// ---- Cache plumbing -------------------------------------------------------

private suspend fun OfflineTransaction.detail(path: String): EventDetail? {
    val raw = responseGet(path) ?: return null
    return runCatching { OfflineJson.decode.decodeFromString(EventDetail.serializer(), raw) }.getOrNull()
}

private suspend fun OfflineTransaction.putDetail(path: String, detail: EventDetail) {
    responsePut(path, OfflineJson.encode.encodeToString(EventDetail.serializer(), detail))
}

private suspend fun OfflineTransaction.tracks(): List<Track>? {
    val raw = responseGet("/tracks") ?: return null
    return runCatching { OfflineJson.decode.decodeFromString(trackListSerializer, raw) }.getOrNull()
}

/** Every cached events list — the unfiltered one and any track-filtered ones. */
private suspend fun OfflineTransaction.patchEventLists(
    transform: (List<Event>, String) -> List<Event>?,
) {
    for (key in responsePaths()) {
        if (key != "/events" && !key.startsWith("/events?")) continue
        val raw = responseGet(key) ?: continue
        val list = runCatching { OfflineJson.decode.decodeFromString(eventListSerializer, raw) }
            .getOrNull() ?: continue
        val next = transform(list, key) ?: continue
        responsePut(key, OfflineJson.encode.encodeToString(eventListSerializer, next))
    }
}

/**
 * Keep the list rows in step with a patched detail: the same event appears in the
 * dashboard list and on the track page, and they must agree.
 */
private suspend fun OfflineTransaction.syncLists(detail: EventDetail) {
    val row = OfflineMirrors.listRow(detail)
    patchEventLists { list, _ -> list.map { if (it.id == row.id) row else it } }
}

/**
 * Walk cached event details until [transform] claims one, then recompute it,
 * persist it, and re-sync the lists. Sessions and laps are addressed by their own
 * ids, so which event holds them isn't knowable from the path.
 */
private suspend fun OfflineTransaction.eachEventDetail(
    transform: (EventDetail) -> EventDetail?,
) {
    for (key in responsePaths()) {
        if (!key.startsWith("/events/") || key.contains("?")) continue
        if (key.split("/").filter { it.isNotEmpty() }.size != 2) continue
        val detail = detail(key) ?: continue
        val next = transform(detail) ?: continue
        val recomputed = OfflineMirrors.recomputeDetail(next)
        putDetail(key, recomputed)
        syncLists(recomputed)
        return
    }
}

// ---- Request-body reading -------------------------------------------------
//
// A queued body is the raw request JSON, so "was this key present?" — the
// distinction the server's update routes turn on — is answerable directly, which
// is a good deal simpler than the iOS port, where it takes a second parse.

private fun QueuedWrite.bodyObject(): JsonObject? = body?.let {
    runCatching { OfflineJson.decode.parseToJsonElement(it).jsonObject }.getOrNull()
}

private fun JsonObject.has(key: String): Boolean = containsKey(key)

private fun JsonObject.value(key: String): JsonElement? = this[key]?.takeIf { it !is JsonNull }

private fun JsonObject.string(key: String): String? =
    (value(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.int(key: String): Int? = (value(key) as? JsonPrimitive)?.intOrNull

private fun JsonObject.double(key: String): Double? = (value(key) as? JsonPrimitive)?.doubleOrNull

private fun <T> JsonObject.decode(
    key: String,
    serializer: kotlinx.serialization.KSerializer<T>,
): T? = value(key)?.let {
    runCatching { OfflineJson.decode.decodeFromJsonElement(serializer, it) }.getOrNull()
}

/**
 * Lap times as sent, before [OfflineMirrors.cleanLaps] gets them: anything that
 * isn't a number becomes NaN and is dropped there, exactly as `Number(v)` does in
 * the web mirror.
 */
private fun JsonObject?.doubleList(key: String): List<Double> {
    val array = this?.value(key) as? JsonArray ?: return emptyList()
    return array.map { element -> (element as? JsonPrimitive)?.doubleOrNull ?: Double.NaN }
}

private val checklistSerializer = ListSerializer(ChecklistItem.serializer())
private val traceSerializer = ListSerializer(TracePoint.serializer())
private val eventListSerializer = ListSerializer(Event.serializer())
private val trackListSerializer = ListSerializer(Track.serializer())
