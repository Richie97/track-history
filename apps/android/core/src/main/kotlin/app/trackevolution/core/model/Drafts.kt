package app.trackevolution.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A field in an update request, with three states rather than two.
 *
 * The server updates only the columns *present* in the body (`if ("notes" in
 * body)` in `src/routes/events.ts`), so "leave it alone" and "clear it" are
 * different requests. A plain `String?` can't say both — this can: [Unchanged]
 * omits the key, `Set(null)` sends an explicit null.
 */
public sealed interface Patch<out T> {
    /** Omit the key: the server leaves the column alone. */
    public data object Unchanged : Patch<Nothing>

    /** Write this value. `Set(null)` clears the field. */
    public data class Set<out T>(val value: T?) : Patch<T>
}

/**
 * Builds the JSON body of a patch request: a key appears only when its [Patch]
 * is [Patch.Set]. Insertion-ordered, so the body reads in field order.
 */
internal class PatchBody(private val json: Json) {
    private val fields = LinkedHashMap<String, JsonElement>()

    fun <T> put(key: String, patch: Patch<T>, encode: (T) -> JsonElement) {
        val set = patch as? Patch.Set ?: return
        fields[key] = set.value?.let(encode) ?: JsonNull
    }

    /** A patch field whose value is itself a serializable type. */
    fun <T> put(key: String, patch: Patch<T>, serializer: KSerializer<T>) {
        put(key, patch) { json.encodeToJsonElement(serializer, it) }
    }

    /** An always-present field, or one omitted by passing null. */
    fun put(key: String, value: JsonElement?) {
        if (value != null) fields[key] = value
    }

    fun build(): JsonObject = JsonObject(fields)
}

/** Patches are only ever sent, never received. */
internal fun patchDescriptor(name: String): SerialDescriptor = buildClassSerialDescriptor(name)

internal fun jsonEncoder(encoder: Encoder, name: String): JsonEncoder =
    encoder as? JsonEncoder ?: throw IllegalStateException("$name can only be encoded as JSON")

internal fun neverDecoded(name: String): Nothing =
    throw UnsupportedOperationException("$name is a request body; the server never sends one")

/**
 * `POST /api/events`. [startDate] is the only required field; the track is
 * resolved by [trackName] (find-or-create, case-insensitive) or by [trackId].
 *
 * A plain `@Serializable` class rather than a patch: creating a row has no
 * "leave it alone" state, and the client encodes request bodies with
 * `explicitNulls = false`, so a null field is simply absent.
 */
@Serializable
public data class EventDraft(
    @SerialName("start_date") val startDate: String,
    @SerialName("track_name") val trackName: String? = null,
    @SerialName("track_id") val trackId: Int? = null,
    /** Fractional — the column is `days REAL`. See [Event.days]. */
    val days: Double? = null,
    val club: String? = null,
    @SerialName("run_group") val runGroup: String? = null,
    val car: String? = null,
    val notes: String? = null,
    val conditions: Conditions? = null,
    @SerialName("temp_f") val tempF: Int? = null,
    val checklist: List<ChecklistItem>? = null,
    @SerialName("best_time_ms") val bestTimeMs: Int? = null,
    @SerialName("track_hours") val trackHours: Double? = null,
)

/**
 * `PUT /api/events/:id`. Every field defaults to [Patch.Unchanged], so an edit
 * sends only what the user actually touched.
 */
@Serializable(with = EventPatchSerializer::class)
public data class EventPatch(
    val trackName: Patch<String> = Patch.Unchanged,
    val trackId: Patch<Int> = Patch.Unchanged,
    val startDate: Patch<String> = Patch.Unchanged,
    val days: Patch<Double> = Patch.Unchanged,
    val club: Patch<String> = Patch.Unchanged,
    val runGroup: Patch<String> = Patch.Unchanged,
    val car: Patch<String> = Patch.Unchanged,
    val notes: Patch<String> = Patch.Unchanged,
    val conditions: Patch<Conditions> = Patch.Unchanged,
    val tempF: Patch<Int> = Patch.Unchanged,
    val checklist: Patch<List<ChecklistItem>> = Patch.Unchanged,
    val bestTimeMs: Patch<Int> = Patch.Unchanged,
    val trackHours: Patch<Double> = Patch.Unchanged,
)

public object EventPatchSerializer : KSerializer<EventPatch> {
    override val descriptor: SerialDescriptor = patchDescriptor("EventPatch")

    override fun deserialize(decoder: Decoder): EventPatch = neverDecoded("EventPatch")

    override fun serialize(encoder: Encoder, value: EventPatch) {
        val out = jsonEncoder(encoder, "EventPatch")
        val body = PatchBody(out.json)
        body.put("track_name", value.trackName) { JsonPrimitive(it) }
        body.put("track_id", value.trackId) { JsonPrimitive(it) }
        body.put("start_date", value.startDate) { JsonPrimitive(it) }
        body.put("days", value.days) { JsonPrimitive(it) }
        body.put("club", value.club) { JsonPrimitive(it) }
        body.put("run_group", value.runGroup) { JsonPrimitive(it) }
        body.put("car", value.car) { JsonPrimitive(it) }
        body.put("notes", value.notes) { JsonPrimitive(it) }
        body.put("conditions", value.conditions) { JsonPrimitive(it.rawValue) }
        body.put("temp_f", value.tempF) { JsonPrimitive(it) }
        body.put("checklist", value.checklist, ListSerializer(ChecklistItem.serializer()))
        body.put("best_time_ms", value.bestTimeMs) { JsonPrimitive(it) }
        body.put("track_hours", value.trackHours) { JsonPrimitive(it) }
        out.encodeJsonElement(body.build())
    }
}

/**
 * `POST /api/events/:id/sessions` — a session and, optionally, its laps in one
 * request. This is what the lap recorder saves (NS-18).
 */
@Serializable
public data class SessionDraft(
    val label: String? = null,
    val notes: String? = null,
    /** Lap times in integer milliseconds. */
    val laps: List<Int>? = null,
    /** Best-lap GPS trace in local meters. */
    val trace: List<TracePoint>? = null,
    /** Per-lap channel data, built by `TelemetryChannels.buildLapChannels` (NS-32). */
    val channels: SessionChannels? = null,
)

/**
 * `PUT /api/sessions/:id`. Not a patch: the server writes both columns
 * unconditionally (`SET label = ?, notes = ?` with `body.label ?? null`), so an
 * omitted field and an explicit null mean the same thing — cleared.
 */
@Serializable
public data class SessionPatch(
    val label: String? = null,
    val notes: String? = null,
)

/**
 * `PUT /api/tracks/:id` — rename, set a goal time, or edit notes.
 *
 * [name] is deliberately *not* a [Patch]: the server trims it unconditionally
 * when the key is present, so a null would fault with "name required". Null
 * here omits the key.
 */
@Serializable(with = TrackPatchSerializer::class)
public data class TrackPatch(
    val name: String? = null,
    val goalMs: Patch<Int> = Patch.Unchanged,
    val notes: Patch<String> = Patch.Unchanged,
)

public object TrackPatchSerializer : KSerializer<TrackPatch> {
    override val descriptor: SerialDescriptor = patchDescriptor("TrackPatch")

    override fun deserialize(decoder: Decoder): TrackPatch = neverDecoded("TrackPatch")

    override fun serialize(encoder: Encoder, value: TrackPatch) {
        val out = jsonEncoder(encoder, "TrackPatch")
        val body = PatchBody(out.json)
        body.put("name", value.name?.let { JsonPrimitive(it) })
        body.put("goal_ms", value.goalMs) { JsonPrimitive(it) }
        body.put("notes", value.notes) { JsonPrimitive(it) }
        out.encodeJsonElement(body.build())
    }
}
