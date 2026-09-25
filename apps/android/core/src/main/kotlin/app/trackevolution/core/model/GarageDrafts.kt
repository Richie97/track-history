package app.trackevolution.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonPrimitive

/**
 * Request bodies for the garage — vehicles, consumable parts and their wear
 * measurements.
 *
 * Separate from `Drafts.kt` only for size; the three-state [Patch] rule is
 * identical and applies for the same reason: `src/routes/vehicles.ts` writes
 * only the columns *present* in the body, so "leave it alone" and "clear it"
 * are different requests.
 */

// ---- Vehicles -------------------------------------------------------------

/**
 * `POST /api/vehicles`. Optional fields default to null and are **omitted**
 * from the body (`encodeDefaults = false`), which matters for the geometry: on
 * a create the server treats an absent `wheelbase_mm` / `steering_ratio` as
 * "fill from the catalog" and an explicit null as "clear", so a draft that only
 * names a [catalogId] gets both numbers pre-filled.
 */
@Serializable
public data class VehicleDraft(
    val name: String,
    val notes: String? = null,
    @SerialName("is_default") val isDefault: Boolean? = null,
    /** A car-catalog generation to pick (#221); null means a car typed by hand. */
    @SerialName("catalog_id") val catalogId: Int? = null,
    @SerialName("wheelbase_mm") val wheelbaseMm: Int? = null,
    @SerialName("steering_ratio") val steeringRatio: Double? = null,
)

@Serializable(with = VehiclePatchSerializer::class)
public data class VehiclePatch(
    val name: Patch<String> = Patch.Unchanged,
    val notes: Patch<String> = Patch.Unchanged,
    val isDefault: Patch<Boolean> = Patch.Unchanged,
    /**
     * The hot tire pressure the health strip's pressure loop aims at, in psi
     * (5–100, rounded to a tenth server-side). `Set(null)` clears it.
     */
    val targetHotPsi: Patch<Double> = Patch.Unchanged,
    /**
     * The car-catalog pick (#221). Setting a row re-pre-fills *both* geometry
     * numbers from it unless the same patch carries its own value for one —
     * including a null ratio, so a car swapped from one entry to another never
     * keeps the previous car's ratio. `Set(null)` unlinks and leaves the numbers
     * as they are.
     */
    val catalogId: Patch<Int> = Patch.Unchanged,
    /**
     * Wheelbase in whole millimetres (1500–4500) and the steering ratio (5–30,
     * two decimals server-side). `Set(null)` clears either.
     */
    val wheelbaseMm: Patch<Int> = Patch.Unchanged,
    val steeringRatio: Patch<Double> = Patch.Unchanged,
)

public object VehiclePatchSerializer : KSerializer<VehiclePatch> {
    override val descriptor: SerialDescriptor = patchDescriptor("VehiclePatch")

    override fun deserialize(decoder: Decoder): VehiclePatch = neverDecoded("VehiclePatch")

    override fun serialize(encoder: Encoder, value: VehiclePatch) {
        val out = jsonEncoder(encoder, "VehiclePatch")
        val body = PatchBody(out.json)
        body.put("name", value.name) { JsonPrimitive(it) }
        body.put("notes", value.notes) { JsonPrimitive(it) }
        body.put("is_default", value.isDefault) { JsonPrimitive(it) }
        body.put("target_hot_psi", value.targetHotPsi) { JsonPrimitive(it) }
        body.put("catalog_id", value.catalogId) { JsonPrimitive(it) }
        body.put("wheelbase_mm", value.wheelbaseMm) { JsonPrimitive(it) }
        body.put("steering_ratio", value.steeringRatio) { JsonPrimitive(it) }
        out.encodeJsonElement(body.build())
    }
}

// ---- Parts ----------------------------------------------------------------

/**
 * A new consumable.
 *
 * [expectedHours] is optional on purpose: with it left out the server defaults
 * it from retired lifecycles of the same kind, which is a better guess than
 * anything a driver would type on the first set.
 */
@Serializable
public data class PartDraft(
    val kind: PartKind,
    val name: String? = null,
    /** Free text, up to 40 characters ("255/40R17"); migration 0029. */
    val size: String? = null,
    @SerialName("installed_on") val installedOn: String,
    @SerialName("cost_cents") val costCents: Int? = null,
    @SerialName("expected_hours") val expectedHours: Double? = null,
    @SerialName("wear_limit") val wearLimit: Double? = null,
    val notes: String? = null,
    /**
     * `false` adds a spare straight to the shelf; omitted (or `true`) puts it
     * on the car from [installedOn], as every part was before migration 0029.
     */
    val equipped: Boolean? = null,
    /** With [equipped], also take off whatever shares its place, as equipping does. */
    val swap: Boolean? = null,
)

@Serializable(with = PartPatchSerializer::class)
public data class PartPatch(
    val kind: Patch<PartKind> = Patch.Unchanged,
    val name: Patch<String> = Patch.Unchanged,
    /** `Set(null)` clears the size. */
    val size: Patch<String> = Patch.Unchanged,
    val installedOn: Patch<String> = Patch.Unchanged,
    /** Setting this retires the part; clearing it puts it back in service. */
    val retiredOn: Patch<String> = Patch.Unchanged,
    val costCents: Patch<Int> = Patch.Unchanged,
    val expectedHours: Patch<Double> = Patch.Unchanged,
    val wearLimit: Patch<Double> = Patch.Unchanged,
    val notes: Patch<String> = Patch.Unchanged,
)

public object PartPatchSerializer : KSerializer<PartPatch> {
    override val descriptor: SerialDescriptor = patchDescriptor("PartPatch")

    override fun deserialize(decoder: Decoder): PartPatch = neverDecoded("PartPatch")

    override fun serialize(encoder: Encoder, value: PartPatch) {
        val out = jsonEncoder(encoder, "PartPatch")
        val body = PatchBody(out.json)
        body.put("kind", value.kind) { JsonPrimitive(it.rawValue) }
        body.put("name", value.name) { JsonPrimitive(it) }
        body.put("size", value.size) { JsonPrimitive(it) }
        body.put("installed_on", value.installedOn) { JsonPrimitive(it) }
        body.put("retired_on", value.retiredOn) { JsonPrimitive(it) }
        body.put("cost_cents", value.costCents) { JsonPrimitive(it) }
        body.put("expected_hours", value.expectedHours) { JsonPrimitive(it) }
        body.put("wear_limit", value.wearLimit) { JsonPrimitive(it) }
        body.put("notes", value.notes) { JsonPrimitive(it) }
        out.encodeJsonElement(body.build())
    }
}

/**
 * One-tap replacement. Every field is optional: the successor inherits the
 * retired part's spec, which is the whole point — swapping pads should not mean
 * re-entering what they are.
 *
 * On a part already *retired* it is "buy another set of those": nothing is
 * retired, and the copy goes on the car unless [equipped] is `false`, with
 * [swap] taking off whatever shares its place. On a part in service the
 * successor takes the old one's place, so both are ignored there.
 */
@Serializable
public data class PartRefreshDraft(
    @SerialName("installed_on") val installedOn: String? = null,
    val name: String? = null,
    @SerialName("cost_cents") val costCents: Int? = null,
    val equipped: Boolean? = null,
    val swap: Boolean? = null,
)

/**
 * The body of `POST /api/parts/:id/equip` and `/unequip`: the swap date,
 * today on the server when omitted.
 */
@Serializable
public data class PartEquipDraft(
    val on: String? = null,
)

// ---- Measurements ---------------------------------------------------------

@Serializable
public data class MeasurementDraft(
    @SerialName("measured_on") val measuredOn: String,
    val value: Double,
    val unit: String,
)
