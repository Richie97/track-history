package app.trackevolution.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** One item of an event's prep checklist. */
@Serializable
public data class ChecklistItem(
    val text: String,
    val done: Boolean,
)

/**
 * Track conditions for an event. Mirrors `CONDITIONS` in `src/lib/validate.ts`.
 *
 * Deliberately a value class over `String` rather than a Kotlin `enum`: a value
 * the server adds later must not fail the decode of a whole event on an app that
 * predates it. Use [Conditions.all] to drive a picker.
 */
@Serializable
@JvmInline
public value class Conditions(public val rawValue: String) {
    public companion object {
        public val DRY: Conditions = Conditions("dry")
        public val DAMP: Conditions = Conditions("damp")
        public val WET: Conditions = Conditions("wet")
        public val MIXED: Conditions = Conditions("mixed")

        public val all: List<Conditions> = listOf(DRY, DAMP, WET, MIXED)
    }
}

/**
 * A track day. The canonical shape is `ComputedEvent` in `src/lib/stats.ts`
 * (`EVENT_SELECT` in `src/db.ts` for the columns).
 *
 * Optionality here is load-bearing and mirrors `withComputed`:
 *  - [bestMs] is null when the event has neither a manual best nor any laps.
 *  - [consistency] is null below 3 laps — **not** zero.
 *  - [hours] is never null; the server already rounded it to 1dp.
 *  - [checklist] is null when absent *or* malformed (`parseChecklist` degrades
 *    rather than throwing).
 *
 * `lap_avg`/`lap_avg_sq` are stripped by `withComputed` and so are absent here.
 */
@Serializable
public data class Event(
    val id: Int,
    @SerialName("track_id") val trackId: Int,
    @SerialName("track_name") val trackName: String,
    /** ISO `yyyy-mm-dd`, the format every date column stores. */
    @SerialName("start_date") val startDate: String,
    /**
     * Track days, **fractional**: the column is `days REAL` and the web form's
     * input steps by 0.5, so a half-day event is 0.5 and a Saturday-plus-Sunday-
     * morning weekend is 1.5. Modelling this as `Int` fails the decode of the
     * entire events list for anyone who has ever logged one.
     */
    val days: Double,
    val club: String? = null,
    @SerialName("run_group") val runGroup: String? = null,
    val car: String? = null,
    @SerialName("vehicle_id") val vehicleId: Int? = null,
    val notes: String? = null,
    val conditions: Conditions? = null,
    /** Ambient temperature in °F — a whole number (`isValidTemp`). */
    @SerialName("temp_f") val tempF: Int? = null,
    val checklist: List<ChecklistItem>? = null,
    /** Manually entered best lap, independent of logged laps. */
    @SerialName("best_time_ms") val bestTimeMs: Int? = null,
    /** Manual override of the on-track hours estimate. */
    @SerialName("track_hours") val trackHours: Double? = null,
    /**
     * Epoch milliseconds, trigger-maintained (migration 0011) and the input to
     * the offline cache's staleness check. `Long`, not `Int`: Kotlin's `Int` is
     * 32 bits and an epoch-ms timestamp passed that in 1970. (Swift's `Int` is
     * 64-bit on every platform we ship, which is why NS-04 can spell it `Int`
     * and still mean the same thing.)
     */
    @SerialName("updated_at") val updatedAt: Long,
    @SerialName("lap_best_ms") val lapBestMs: Int? = null,
    @SerialName("lap_count") val lapCount: Int,
    @SerialName("session_count") val sessionCount: Int,
    /** `min(bestTimeMs, lapBestMs)` — the number the UI shows as *the* best. */
    @SerialName("best_ms") val bestMs: Int? = null,
    /** Coefficient of variation of lap times; null below 3 laps. */
    val consistency: Double? = null,
    /** On-track hours: the override, else `max(days × 2h, logged lap time)`. */
    val hours: Double,
)

/**
 * `GET /api/events/:id` — an event plus its sessions and per-day setup sheets.
 *
 * The server returns one flat object: the event's own columns sit alongside
 * `sessions` and `setups`. [EventDetailSerializer] splits them back apart so the
 * event fields are decoded by [Event] itself and the two can never drift.
 */
@Serializable(with = EventDetailSerializer::class)
public data class EventDetail(
    val event: Event,
    val sessions: List<Session>,
    val setups: List<Setup>,
)

/**
 * Flattens/unflattens [EventDetail] against the server's single object.
 *
 * JSON-only by construction: it reaches for [JsonDecoder]/[JsonEncoder] because
 * splitting a keyed object into "these keys are an Event, those two are not"
 * has no meaning in a non-JSON format, and this type only ever crosses the wire
 * as JSON.
 */
public object EventDetailSerializer : KSerializer<EventDetail> {
    private val sessionsSerializer = ListSerializer(Session.serializer())
    private val setupsSerializer = ListSerializer(Setup.serializer())

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("EventDetail") {
        element("event", Event.serializer().descriptor)
        element("sessions", sessionsSerializer.descriptor)
        element("setups", setupsSerializer.descriptor)
    }

    override fun deserialize(decoder: Decoder): EventDetail {
        val input = decoder as? JsonDecoder
            ?: throw IllegalStateException("EventDetail can only be decoded from JSON")
        val root = input.decodeJsonElement().jsonObject
        val eventFields = JsonObject(root.filterKeys { it != "sessions" && it != "setups" })
        return EventDetail(
            event = input.json.decodeFromJsonElement(Event.serializer(), eventFields),
            sessions = input.json.decodeFromJsonElement(
                sessionsSerializer,
                root["sessions"] ?: error("event detail has no sessions"),
            ),
            setups = input.json.decodeFromJsonElement(
                setupsSerializer,
                root["setups"] ?: error("event detail has no setups"),
            ),
        )
    }

    override fun serialize(encoder: Encoder, value: EventDetail) {
        val output = encoder as? JsonEncoder
            ?: throw IllegalStateException("EventDetail can only be encoded as JSON")
        val fields = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(
            output.json.encodeToJsonElement(Event.serializer(), value.event).jsonObject,
        )
        fields["sessions"] = output.json.encodeToJsonElement(sessionsSerializer, value.sessions)
        fields["setups"] = output.json.encodeToJsonElement(setupsSerializer, value.setups)
        output.encodeJsonElement(JsonObject(fields))
    }
}
