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
    /**
     * The target hot tire pressure (psi, all four corners) the web app's
     * pressure loop aims the next cold pressures at (#190). Set on the web,
     * decoded here so the response stays pinned; nothing native reads it yet.
     */
    @SerialName("target_hot_psi") val targetHotPsi: Double? = null,
    /**
     * The seeded car-catalog generation this car was picked from (#221), or
     * null for a car typed by hand. Identity, not ownership: the pick pre-filled
     * the two numbers below and the catalog is never consulted again.
     */
    @SerialName("catalog_id") val catalogId: Int? = null,
    /**
     * Wheelbase in millimetres and the steering ratio ("16.25:1" → 16.25), the
     * two spec-sheet constants the balance read-out needs (#208). Both optional;
     * a car with neither keeps the relative reading.
     */
    @SerialName("wheelbase_mm") val wheelbaseMm: Int? = null,
    @SerialName("steering_ratio") val steeringRatio: Double? = null,
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
    /** See [Vehicle.targetHotPsi]. */
    @SerialName("target_hot_psi") val targetHotPsi: Double? = null,
    @SerialName("updated_at") val updatedAt: Long,
    /** On-track hours accrued across the vehicle's events. */
    val hours: Double,
    @SerialName("event_count") val eventCount: Int,
    @SerialName("event_days") val eventDays: Int,
    /**
     * What the car has cost (#147), in cents: its past track days' entered
     * costs and every part ever fitted. Sums, so zero rather than null when
     * nothing was entered. Decoded so the contract stays pinned; nothing on
     * this platform shows them yet.
     */
    @SerialName("event_cost_cents") val eventCostCents: Int = 0,
    @SerialName("parts_cost_cents") val partsCostCents: Int = 0,
    /**
     * What the car's own odometer last said (#192), from video imports only;
     * null when no recorded session carries a reading. Worded by
     * [app.trackevolution.core.Garage.vehicleOdometerLine].
     */
    val odometer: VehicleOdometer? = null,
    val parts: List<Part>,
    /** See [Vehicle.catalogId] / [Vehicle.wheelbaseMm] / [Vehicle.steeringRatio]. */
    @SerialName("catalog_id") val catalogId: Int? = null,
    @SerialName("wheelbase_mm") val wheelbaseMm: Int? = null,
    @SerialName("steering_ratio") val steeringRatio: Double? = null,
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
        /** A full set — all four corners the same tire. */
        public val TIRES: PartKind = PartKind("tires")
        /** A front or rear pair, for a staggered car (its own size and wear). */
        public val TIRES_FRONT: PartKind = PartKind("tires_front")
        public val TIRES_REAR: PartKind = PartKind("tires_rear")
        public val ROTORS_FRONT: PartKind = PartKind("rotors_front")
        public val ROTORS_REAR: PartKind = PartKind("rotors_rear")
        public val BRAKE_FLUID: PartKind = PartKind("brake_fluid")
        public val OIL: PartKind = PartKind("oil")
        public val OTHER: PartKind = PartKind("other")

        public val all: List<PartKind> = listOf(
            PADS_FRONT, PADS_REAR, TIRES, TIRES_FRONT, TIRES_REAR, ROTORS_FRONT, ROTORS_REAR, BRAKE_FLUID, OIL, OTHER,
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
    /** A free-text size or spec ("255/40R17"), migration 0029. */
    val size: String? = null,
    @SerialName("installed_on") val installedOn: String,
    @SerialName("retired_on") val retiredOn: String? = null,
    /**
     * On the car right now (migration 0029). False and not retired means a
     * spare on the shelf, whose wear is frozen until it goes back on. Null
     * from a response cached before the field existed — read as on the car.
     */
    val equipped: Boolean? = null,
    /** The stretches the part was on the car; wear accrues across these only. */
    val mounts: List<PartMount> = emptyList(),
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
    /**
     * The distance the car's odometer covered across this part's recorded
     * sessions (#192) — reported beside [wear], never an input to it. Null
     * with fewer than two readings in its service window.
     */
    val odometer: PartOdometer? = null,
)

/**
 * The car's latest odometer reading (`vehicleOdometer` in `src/lib/odometer.ts`).
 * A reading below the running maximum is taken as another car's — a borrowed
 * or mislinked day — and counted in [otherCar] rather than treated as an error.
 */
@Serializable
public data class VehicleOdometer(
    /** Kilometres, as the car's recorder stored them. */
    val km: Double,
    /** The date of the event the reading was recorded at. */
    val on: String,
    val readings: Int,
    @SerialName("other_car") val otherCar: Int,
)

/** A part's recorded odometer span (`partOdometer` in `src/lib/odometer.ts`). */
@Serializable
public data class PartOdometer(
    /** Kilometres between the first and last reading in the service window. */
    val km: Double,
    val from: String,
    val to: String,
    val readings: Int,
)

/** One stretch a part was on the car (both ends inclusive). */
@Serializable
public data class PartMount(
    @SerialName("mounted_on") val mountedOn: String,
    /** Null while it is still fitted. */
    @SerialName("removed_on") val removedOn: String? = null,
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
    /** Event-days in the window ≈ heat cycles for tires. */
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
