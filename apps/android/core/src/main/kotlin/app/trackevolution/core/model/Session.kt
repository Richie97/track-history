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
 * grid. Produced by the web importer and by the native video importers — NS-30
 * on iOS, NS-32 here (`core/telemetry/LapChannels.kt` builds it) — and, since the
 * review flow became shared, by a saved phone recording too.
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
    /**
     * One value each for the whole session — ambient conditions, the track's
     * elevation range, and the car's own odometer reading. Absent when the
     * source carried none of them. Last in the list so the existing positional
     * `SessionChannels(1, 20.0, laps)` call sites keep working.
     */
    val meta: ChannelMeta? = null,
)

/**
 * Session-level numbers stored alongside the per-lap channels. [odometerKm] is
 * the car's lifetime odometer as the recorder saw it, not this session's
 * distance.
 */
@Serializable
public data class ChannelMeta(
    val ambientC: Double? = null,
    val intakeC: Double? = null,
    val elevationM: Double? = null,
    val odometerKm: Double? = null,
) {
    public operator fun get(name: String): Double? = when (name) {
        "ambientC" -> ambientC
        "intakeC" -> intakeC
        "elevationM" -> elevationM
        "odometerKm" -> odometerKm
        else -> null
    }

    public fun with(name: String, value: Double?): ChannelMeta = when (name) {
        "ambientC" -> copy(ambientC = value)
        "intakeC" -> copy(intakeC = value)
        "elevationM" -> copy(elevationM = value)
        "odometerKm" -> copy(odometerKm = value)
        else -> this
    }

    public val isEmpty: Boolean
        get() = ambientC == null && intakeC == null && elevationM == null && odometerKm == null
}

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
    /** Longitudinal G, signed — negative under braking. PDR imports only. */
    val longG: List<Double>? = null,
    /** Yaw rate in degrees per second, signed. */
    val yaw: List<Double>? = null,
    /** Selected gear 1–8; 0 is the clutch-in / no-gear state, not a gear. */
    val gear: List<Double>? = null,
    /** (driven − non-driven) wheelspeed as a percent: + wheelspin, − lockup. */
    val wheelSlip: List<Double>? = null,
    /** Manifold gauge pressure in kPa; negative under vacuum. */
    val boost: List<Double>? = null,
    /** Bitfield: ABS | traction control shl 1 | stability control shl 2. */
    val flags: List<Double>? = null,
    // Per-lap scalars: slow channels (0.5–1.4 Hz) reduced to one value per lap,
    // because at one real sample every 40–90 m an array on the 20 m grid would
    // be interpolation rather than data. `SCALAR_NAMES` in the JS.
    /** Peak oil temperature during the lap, °C. */
    val oilC: Double? = null,
    /** Lowest oil pressure during the lap, kPa. */
    val oilKpa: Double? = null,
    val coolantC: Double? = null,
    val transC: Double? = null,
    /** Fuel level as the lap finished, percent. */
    val fuelPct: Double? = null,
    val battV: Double? = null,
    /** Tyre pressures as the lap finished, kPa. */
    val tyreKpaLF: Double? = null,
    val tyreKpaRF: Double? = null,
    val tyreKpaLR: Double? = null,
    val tyreKpaRR: Double? = null,
    /** Peak tyre temperatures during the lap, °C. */
    val tyreCLF: Double? = null,
    val tyreCRF: Double? = null,
    val tyreCLR: Double? = null,
    val tyreCRR: Double? = null,
) {
    /**
     * A gridded channel by name — `entry[name]` in the JS, which writes into a
     * plain object. Keeping one lookup here is what lets `buildLapChannels` walk
     * `CHANNEL_NAMES` instead of repeating a branch per channel.
     */
    public fun channel(name: String): List<Double>? = when (name) {
        "speed" -> speed
        "rpm" -> rpm
        "latG" -> latG
        "throttle" -> throttle
        "brake" -> brake
        "steering" -> steering
        "longG" -> longG
        "yaw" -> yaw
        "gear" -> gear
        "wheelSlip" -> wheelSlip
        "boost" -> boost
        "flags" -> flags
        else -> null
    }

    public fun withChannel(name: String, values: List<Double>?): LapChannels = when (name) {
        "speed" -> copy(speed = values)
        "rpm" -> copy(rpm = values)
        "latG" -> copy(latG = values)
        "throttle" -> copy(throttle = values)
        "brake" -> copy(brake = values)
        "steering" -> copy(steering = values)
        "longG" -> copy(longG = values)
        "yaw" -> copy(yaw = values)
        "gear" -> copy(gear = values)
        "wheelSlip" -> copy(wheelSlip = values)
        "boost" -> copy(boost = values)
        "flags" -> copy(flags = values)
        else -> this
    }

    /** A per-lap scalar by name — the same idea for `SCALAR_NAMES`. */
    public fun scalar(name: String): Double? = when (name) {
        "oilC" -> oilC
        "oilKpa" -> oilKpa
        "coolantC" -> coolantC
        "transC" -> transC
        "fuelPct" -> fuelPct
        "battV" -> battV
        "tyreKpaLF" -> tyreKpaLF
        "tyreKpaRF" -> tyreKpaRF
        "tyreKpaLR" -> tyreKpaLR
        "tyreKpaRR" -> tyreKpaRR
        "tyreCLF" -> tyreCLF
        "tyreCRF" -> tyreCRF
        "tyreCLR" -> tyreCLR
        "tyreCRR" -> tyreCRR
        else -> null
    }

    public fun withScalar(name: String, value: Double?): LapChannels = when (name) {
        "oilC" -> copy(oilC = value)
        "oilKpa" -> copy(oilKpa = value)
        "coolantC" -> copy(coolantC = value)
        "transC" -> copy(transC = value)
        "fuelPct" -> copy(fuelPct = value)
        "battV" -> copy(battV = value)
        "tyreKpaLF" -> copy(tyreKpaLF = value)
        "tyreKpaRF" -> copy(tyreKpaRF = value)
        "tyreKpaLR" -> copy(tyreKpaLR = value)
        "tyreKpaRR" -> copy(tyreKpaRR = value)
        "tyreCLF" -> copy(tyreCLF = value)
        "tyreCRF" -> copy(tyreCRF = value)
        "tyreCLR" -> copy(tyreCLR = value)
        "tyreCRR" -> copy(tyreCRR = value)
        else -> this
    }
}
