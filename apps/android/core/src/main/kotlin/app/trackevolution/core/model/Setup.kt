package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A per-event-day setup sheet. Mirrors `SetupSheet` / `sanitizeSetup` in
 * `src/lib/validate.ts` field for field — every field optional, because
 * applicability varies by car.
 *
 * The phones write sheets since NS-40, so **every key the server accepts must
 * be here**: a key this model lacks is dropped on decode and erased on the next
 * save. The golden `event-detail` carries a sheet with every key, which
 * `GoldenContractTest`'s strict decode and `OfflineStoreTest` both read.
 */
@Serializable
public data class SetupSheet(
    /** Tire pressures, psi. */
    @SerialName("tp_cold") val tpCold: CornerValues? = null,
    @SerialName("tp_hot") val tpHot: CornerValues? = null,
    /** Degrees. */
    val camber: AxleValues? = null,
    /** The user's unit (degrees or inches). */
    val toe: AxleValues? = null,
    val caster: AxleValues? = null,
    /** Damper clicks. */
    val rebound: AxleValues? = null,
    val compression: AxleValues? = null,
    /** Bar position / hole. */
    val sway: AxleValues? = null,
    /** Gallons at session start. */
    val fuel: Double? = null,
    /**
     * `parts.id` references — which consumables were on the car: a full set of
     * tires, or a front / rear pair (`tires_front` / `tires_rear` parts).
     */
    @SerialName("tires_id") val tiresId: Int? = null,
    @SerialName("tires_f_id") val tiresFId: Int? = null,
    @SerialName("tires_r_id") val tiresRId: Int? = null,
    @SerialName("pads_f_id") val padsFId: Int? = null,
    @SerialName("pads_r_id") val padsRId: Int? = null,
    val notes: String? = null,
)

/** Per-corner values: front-left, front-right, rear-left, rear-right. */
@Serializable
public data class CornerValues(
    val fl: Double? = null,
    val fr: Double? = null,
    val rl: Double? = null,
    val rr: Double? = null,
)

/** Per-axle values: front, rear. */
@Serializable
public data class AxleValues(
    val f: Double? = null,
    val r: Double? = null,
)

/** One day's setup sheet as returned inside an event's detail. */
@Serializable
public data class Setup(
    /** 1-based day within the event. */
    val day: Int,
    val data: SetupSheet,
)

/**
 * `GET /api/events/:id/setups/prefill` — the copy-forward prefill for a blank
 * setup form. [data] is null when there is nothing to copy forward.
 */
@Serializable
public data class SetupPrefill(
    val data: SetupSheet? = null,
)
