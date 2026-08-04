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

@Serializable
public data class VehicleDraft(
    val name: String,
    val notes: String? = null,
    @SerialName("is_default") val isDefault: Boolean? = null,
)

@Serializable(with = VehiclePatchSerializer::class)
public data class VehiclePatch(
    val name: Patch<String> = Patch.Unchanged,
    val notes: Patch<String> = Patch.Unchanged,
    val isDefault: Patch<Boolean> = Patch.Unchanged,
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
    @SerialName("installed_on") val installedOn: String,
    @SerialName("cost_cents") val costCents: Int? = null,
    @SerialName("expected_hours") val expectedHours: Double? = null,
    @SerialName("wear_limit") val wearLimit: Double? = null,
    val notes: String? = null,
)

@Serializable(with = PartPatchSerializer::class)
public data class PartPatch(
    val kind: Patch<PartKind> = Patch.Unchanged,
    val name: Patch<String> = Patch.Unchanged,
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
 */
@Serializable
public data class PartRefreshDraft(
    @SerialName("installed_on") val installedOn: String? = null,
    val name: String? = null,
    @SerialName("cost_cents") val costCents: Int? = null,
)

// ---- Measurements ---------------------------------------------------------

@Serializable
public data class MeasurementDraft(
    @SerialName("measured_on") val measuredOn: String,
    val value: Double,
    val unit: String,
)
