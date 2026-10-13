package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `POST /api/sessions/:id/clip` (NS-45): start, or resume, the upload of a
 * session's best-lap clip. Keyed on the session and the lap's time rather than
 * a lap id, because a session `POST` answers only the session's id.
 * [lapOffsetMs] is where the lap starts inside the cut — measured from the
 * cut, never assumed (a passthrough cut starts at the keyframe before the
 * requested window).
 */
@Serializable
public data class ClipCreate(
    @SerialName("time_ms") val timeMs: Int,
    @SerialName("size_bytes") val sizeBytes: Long,
    @SerialName("duration_ms") val durationMs: Int,
    @SerialName("lap_offset_ms") val lapOffsetMs: Int,
)

/**
 * The create's answer: which clip, how big each part is (`CLIP_PART_BYTES`,
 * 50 MiB — every part but the last is exactly this), how many there are, and
 * which the server already holds. A resume answers the same row with
 * [uploaded] filled in; a fresh create answers it empty.
 */
@Serializable
public data class ClipUpload(
    @SerialName("clip_id") val clipId: Int,
    @SerialName("part_bytes") val partBytes: Long,
    val parts: Int,
    val uploaded: List<Int> = emptyList(),
)

/**
 * `GET /api/clips/:id/url` — a signed URL that plays for an hour, outside the
 * API, with no session needed: which is what lets ExoPlayer (or a cast
 * receiver) fetch it with no header injection. [expiresAt] is epoch ms.
 */
@Serializable
public data class ClipUrl(
    val url: String,
    @SerialName("expires_at") val expiresAt: Long,
)
