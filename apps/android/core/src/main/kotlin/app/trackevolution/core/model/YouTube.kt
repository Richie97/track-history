package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Publishing a best-lap video to YouTube (NS-46,
// docs/specs/native/NS-46-youtube-upload.md). The upload runs on the server; a
// client is a form and a status line, so these are the shapes it reads. The
// status and privacy are strings rather than enums so a value the server adds
// later degrades to "say nothing" instead of failing the whole event detail.

/**
 * A clip's upload as the event detail carries it (`lap.clip.youtube`). [url]
 * is `https://youtu.be/<id>` once [status] is `done`. Not on a coach's view:
 * `COACH_CLIP_FIELDS` leaves it out.
 */
@Serializable
public data class LapClipYouTube(
    val status: String,
    @SerialName("video_id") val videoId: String? = null,
    val url: String? = null,
    val privacy: String,
)

/**
 * `user.youtube` on `GET /api/me`. [available] is the one switch: false draws
 * nothing at all. [connected] is false for a revoked grant, whose [account]
 * stays so Settings can say which one to reconnect.
 */
@Serializable
public data class YouTubeAccount(
    val available: Boolean,
    val connected: Boolean,
    val account: String? = null,
    @SerialName("channel_title") val channelTitle: String? = null,
)

/** `GET /api/clips/:id/youtube/draft`: the form's pre-filled words (Pro). */
@Serializable
public data class YouTubeDraft(
    val title: String,
    val description: String,
    val privacy: String,
    val account: String? = null,
)

/**
 * `GET /api/clips/:id/youtube` (and the 202 from starting one): what the lap
 * page's status line draws. [progress] is 0…1 of the bytes YouTube has
 * acknowledged; [error] is the failure — or, while queued, a wait — in words.
 */
@Serializable
public data class YouTubeUpload(
    val status: String,
    val progress: Double,
    val privacy: String,
    val url: String? = null,
    val error: String? = null,
)
