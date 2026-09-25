package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** `{ "id": 1 }` — what every create endpoint returns. */
@Serializable
public data class CreatedId(
    val id: Int,
)

/** `{ "ok": true }` — what every update/delete endpoint returns. */
@Serializable
public data class OkResponse(
    val ok: Boolean,
)

/**
 * `POST /api/tracks` — the row the server created (or found: tracks are
 * resolved by name, case-insensitively).
 */
@Serializable
public data class CreatedTrack(
    val id: Int,
    val name: String,
    @SerialName("catalog_id") val catalogId: Int? = null,
)

/**
 * `POST /api/parts/:id/refresh` — the new part, plus the id of the one it
 * replaced.
 */
@Serializable
public data class PartRefresh(
    val id: Int,
    @SerialName("retired_id") val retiredId: Int,
)

/**
 * `POST /api/parts/:id/equip` — the ids of the parts equipping it took off the
 * car (what shared its place: the other set of tires, the other pads).
 */
@Serializable
public data class PartEquip(
    val ok: Boolean,
    val unequipped: List<Int>,
)

/** The error body every failing endpoint returns. */
@Serializable
public data class ServerErrorBody(
    val error: String,
)
