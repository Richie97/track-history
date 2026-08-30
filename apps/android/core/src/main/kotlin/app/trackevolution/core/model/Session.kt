package app.trackevolution.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/** One timed lap. [timeMs] is integer milliseconds, always. */
@Serializable
public data class Lap(
    val id: Int,
    @SerialName("session_id") val sessionId: Int,
    @SerialName("lap_num") val lapNum: Int,
    @SerialName("time_ms") val timeMs: Int,
)

/** A run group session within an event, with its laps. */
@Serializable
public data class Session(
    val id: Int,
    val label: String? = null,
    val notes: String? = null,
    val sort: Int,
    /**
     * Best-lap GPS trace in local meters, present only on imported/recorded
     * sessions (`sanitizeTrace` in `src/lib/validate.ts`).
     */
    val trace: List<TracePoint>? = null,
    /**
     * Per-lap channel data on a shared driven-distance grid, present only on
     * telemetry imports (`sanitizeChannels`).
     */
    val channels: SessionChannels? = null,
    val laps: List<Lap>,
)

/**
 * One `[x, y, v]` point of a stored trace: local meters east/north plus speed.
 * A bare array on the wire, matching `sanitizeTrace`.
 */
@Serializable(with = TracePointSerializer::class)
public data class TracePoint(
    val x: Double,
    val y: Double,
    val v: Double,
)

/** Reads and writes [TracePoint] as the three-element array the server stores. */
public object TracePointSerializer : KSerializer<TracePoint> {
    private val delegate = ListSerializer(Double.serializer())

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): TracePoint {
        val values = delegate.deserialize(decoder)
        require(values.size == 3) { "trace point must be [x, y, v], got ${values.size} values" }
        return TracePoint(values[0], values[1], values[2])
    }

    override fun serialize(encoder: Encoder, value: TracePoint) {
        delegate.serialize(encoder, listOf(value.x, value.y, value.v))
    }
}

/**
 * `sessions.channels` — every lap's channels resampled onto one driven-distance
 * grid. Produced by the *web* importer and (on iOS) NS-30's video import; this
 * client reads it and never writes it, since `.vbo`/video import is not part of
 * the Android programme.
 *
 * The keys really are camelCase on the wire — `sanitizeChannels` in
 * `src/lib/validate.ts` writes them that way, unlike every other API shape.
 */
@Serializable
public data class SessionChannels(
    /** Schema version; `sanitizeChannels` always writes 1. */
    val v: Int,
    /** Grid step in meters of driven distance. */
    val dStepM: Double,
    val laps: List<LapChannels>,
)

/**
 * One lap's channel series. All present channels share the same length —
 * `sanitizeChannels` rejects ragged data.
 *
 * Units follow `public/js/import/channels.js`: speed km/h, latG G,
 * throttle/brake percent (0–100), steering signed steering-wheel degrees.
 */
@Serializable
public data class LapChannels(
    /** Lap number within the session. */
    val n: Int,
    val timeMs: Int,
    val speed: List<Double>? = null,
    val rpm: List<Double>? = null,
    val latG: List<Double>? = null,
    val throttle: List<Double>? = null,
    val brake: List<Double>? = null,
    val steering: List<Double>? = null,
)
