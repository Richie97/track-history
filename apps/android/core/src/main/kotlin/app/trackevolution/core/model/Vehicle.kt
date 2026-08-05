package app.trackevolution.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * SQLite has no boolean type, so `is_default` crosses the wire as 0 or 1. This
 * decodes it to `Boolean` and writes it back as the integer the server sent, so
 * a round-trip is byte-identical.
 */
public object IntAsBooleanSerializer : KSerializer<Boolean> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("IntAsBoolean", PrimitiveKind.INT)

    override fun deserialize(decoder: Decoder): Boolean = decoder.decodeInt() != 0

    override fun serialize(encoder: Encoder, value: Boolean) {
        encoder.encodeInt(if (value) 1 else 0)
    }
}

/**
 * A garage vehicle (`GET /api/vehicles`). At most one row per user has
 * [isDefault] set; it pre-fills new events.
 */
@Serializable
public data class Vehicle(
    val id: Int,
    val name: String,
    val notes: String? = null,
    @SerialName("is_default")
    @Serializable(with = IntAsBooleanSerializer::class)
    val isDefault: Boolean,
)

/**
 * A vehicle in the garage logbook (`GET /api/garage`): accrued hours plus its
 * consumable parts, each with measurements and a computed wear estimate.
 *
 * Every part arrives with its [WearEstimate] **already computed by the server**
 * (`src/lib/wear.ts`). No client recomputes it — see `Garage` for the half that
 * is ported, which is only how to say what arrived.
 */
@Serializable
public data class GarageVehicle(
    val id: Int,
    val name: String,
    val notes: String? = null,
    @SerialName("is_default")
    @Serializable(with = IntAsBooleanSerializer::class)
    val isDefault: Boolean,
    @SerialName("updated_at") val updatedAt: Long,
    /** On-track hours accrued across the vehicle's events. */
    val hours: Double,
    @SerialName("event_count") val eventCount: Int,
    @SerialName("event_days") val eventDays: Int,
    val parts: List<Part>,
)

/**
 * What kind of consumable a part is. Mirrors `PART_KINDS` in
 * `src/lib/validate.ts`; a value class rather than an `enum` for the same reason
 * as [Conditions] — a kind added server-side must not break decoding on an
 * older app.
 */
@Serializable
@JvmInline
public value class PartKind(public val rawValue: String) {
    public companion object {
        public val PADS_FRONT: PartKind = PartKind("pads_front")
        public val PADS_REAR: PartKind = PartKind("pads_rear")
        public val TIRES: PartKind = PartKind("tires")
        public val ROTORS_FRONT: PartKind = PartKind("rotors_front")
        public val ROTORS_REAR: PartKind = PartKind("rotors_rear")
        public val BRAKE_FLUID: PartKind = PartKind("brake_fluid")
        public val OIL: PartKind = PartKind("oil")
        public val OTHER: PartKind = PartKind("other")

        public val all: List<PartKind> = listOf(
            PADS_FRONT, PADS_REAR, TIRES, ROTORS_FRONT, ROTORS_REAR, BRAKE_FLUID, OIL, OTHER,
        )
    }
}

/** A consumable fitted to a vehicle, with its wear measurements and estimate. */
@Serializable
public data class Part(
    val id: Int,
    @SerialName("vehicle_id") val vehicleId: Int,
    val kind: PartKind,
    val name: String? = null,
    @SerialName("installed_on") val installedOn: String,
    @SerialName("retired_on") val retiredOn: String? = null,
    /**
     * Expected service life in on-track hours; defaulted from retired lifecycles
     * of the same kind when the user doesn't supply one.
     */
    @SerialName("expected_hours") val expectedHours: Double? = null,
    /** The measurement value at which the part is considered used up. */
    @SerialName("wear_limit") val wearLimit: Double? = null,
    @SerialName("cost_cents") val costCents: Int? = null,
    val notes: String? = null,
    val measurements: List<Measurement>,
    val wear: WearEstimate,
)

/** A logged wear measurement (pad thickness, tread depth, …). */
@Serializable
public data class Measurement(
    val id: Int,
    @SerialName("part_id") val partId: Int,
    @SerialName("measured_on") val measuredOn: String,
    val value: Double,
    val unit: String,
)

/**
 * How much of a part is used up and how much life is left. Mirrors
 * `WearEstimate` in `src/lib/wear.ts`.
 */
@Serializable
public data class WearEstimate(
    /** Accrued on-track hours in the part's service window. */
    val hours: Double,
    val events: Int,
    /** Event-days in the window ≈ heat cycles for tyres. */
    val cycles: Int,
    @SerialName("expected_hours") val expectedHours: Double? = null,
    @SerialName("remaining_hours") val remainingHours: Double? = null,
    /** 0…1, clamped. */
    @SerialName("pct_used") val pctUsed: Double? = null,
    val source: WearSource? = null,
    /** In the measurement's unit; only for a measured projection. */
    @SerialName("wear_per_hour") val wearPerHour: Double? = null,
    @SerialName("last_value") val lastValue: Double? = null,
    val unit: String? = null,
)

/**
 * How much to trust a remaining-life projection: `measured` — fitted from 2+
 * wear measurements; `expected` — plain `expectedHours` minus accrued. Absent
 * means there was no basis for one.
 */
@Serializable
@JvmInline
public value class WearSource(public val rawValue: String) {
    public companion object {
        public val MEASURED: WearSource = WearSource("measured")
        public val EXPECTED: WearSource = WearSource("expected")
    }
}
