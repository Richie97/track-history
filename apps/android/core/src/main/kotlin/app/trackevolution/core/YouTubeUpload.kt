package app.trackevolution.core

import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.LapClipYouTube
import app.trackevolution.core.model.YouTubeAccount
import kotlin.math.floor
import app.trackevolution.core.model.YouTubeUpload as Upload

/**
 * Publish a best-lap video to YouTube (NS-46,
 * `docs/specs/native/NS-46-youtube-upload.md`): the client's pure half — which
 * control a lap's video offers, the status line under it, and every sentence
 * the feature says. The port of `public/js/youtube.js` under the same names,
 * pinned row for row by `contracts/logic/youtube.json` (`YouTubeUploadTest`).
 *
 * The upload itself runs on the server; a client is a form and a status line,
 * and the form's title and description are the server's draft, so nothing here
 * builds them.
 *
 * Not to be confused with `model.YouTubeUpload`, the `GET /api/clips/:id/youtube`
 * response — the two share a name because the JS module and the route do, as
 * `Coaching` and `model.Coaching` do.
 */
public object YouTubeUpload {

    /** A visibility the form offers: the value sent, and the word shown. */
    public data class Privacy(val value: String, val label: String)

    /** One of the two documents Google's API terms require the consent text to link. */
    public data class Link(val label: String, val url: String)

    public val YOUTUBE_PRIVACY: List<Privacy> = listOf(
        Privacy("private", "Private"),
        Privacy("unlisted", "Unlisted"),
        Privacy("public", "Public"),
    )

    /**
     * Unlisted: the setting that matches sharing a link with a club or an
     * instructor. Public is a choice the driver makes.
     */
    public const val YOUTUBE_DEFAULT_PRIVACY: String = "unlisted"

    /** The consent explanation, above Connect on every client, word for word. */
    public const val YOUTUBE_CONNECT_TEXT: String =
        "Track Evolution will ask Google for permission to upload videos to your YouTube channel. " +
            "It uploads only the videos you choose, and can't see, change or delete anything else on your channel. " +
            "Uses YouTube API Services: YouTube Terms of Service · Google Privacy Policy."

    public val YOUTUBE_LINKS: List<Link> = listOf(
        Link("YouTube Terms of Service", "https://www.youtube.com/t/terms"),
        Link("Google Privacy Policy", "https://policies.google.com/privacy"),
    )

    /** Where a driver revokes the grant at Google's end. */
    public const val GOOGLE_PERMISSIONS_URL: String = "https://myaccount.google.com/permissions"

    /**
     * Fixed on the form rather than asked: in-car track footage isn't directed
     * at children, and the uploader is responsible for saying so.
     */
    public const val YOUTUBE_KIDS_TEXT: String = "Not made for kids"
    public const val YOUTUBE_DELETE_NOTE: String = "The copy on YouTube stays. Delete it in YouTube Studio."
    public const val YOUTUBE_DISCONNECT_NOTE: String = "Videos you've uploaded stay on YouTube."
    public const val YOUTUBE_OFFLINE: String = "Uploading to YouTube needs a connection."

    /** A connect's outcome, by the redirect's `result`. */
    public val YOUTUBE_RESULT_TEXT: Map<String, String> = mapOf(
        "connected" to "YouTube is connected.",
        "denied" to "YouTube wasn't connected — Google's permission was declined.",
        "error" to "Couldn't connect YouTube. Try again.",
    )

    /**
     * The control a lap's video offers — the JS's strings, as [value]:
     *
     *  - [NONE]: nothing — the feature is off for this account, there's no ready
     *    clip, or it's a coach's read-only view (whatever the upload's state: the
     *    link is the driver's to hand out)
     *  - [LOCKED]: nothing beyond NS-45's locked player (a free account)
     *  - [CONNECT]: Connect YouTube… (no live grant; a revoked one too)
     *  - [UPLOAD]: Upload to YouTube…
     *  - [PENDING]: the status line, polled
     *  - [DONE]: On YouTube · <privacy>, and Open
     *  - [FAILED]: the error, and Try again
     */
    public enum class Offer(public val value: String) {
        NONE("none"),
        LOCKED("locked"),
        CONNECT("connect"),
        UPLOAD("upload"),
        PENDING("pending"),
        DONE("done"),
        FAILED("failed"),
    }

    /**
     * A lapsed owner keeps [Offer.DONE] (the link isn't Pro) and
     * [Offer.PENDING] (a lapse doesn't stop an upload already queued);
     * everything that starts one is Pro, through `canSaveLapVideo` — the same
     * decision about the same clip as downloading it.
     *
     * [youtube] is `me.youtube` on the JS side: null with no `/me`, or one
     * cached before the field.
     */
    public fun youtubeOffer(
        clip: LapClip?,
        entitlement: Entitlement?,
        youtube: YouTubeAccount?,
        readOnly: Boolean,
    ): Offer {
        if (readOnly) return Offer.NONE
        if (youtube?.available != true) return Offer.NONE
        if (clip == null) return Offer.NONE
        val status = clip.youtube?.status
        if (status == "done") return Offer.DONE
        if (status == "queued" || status == "uploading") return Offer.PENDING
        if (!Entitlement.canSaveLapVideo(entitlement)) return Offer.LOCKED
        if (!youtube.connected) return Offer.CONNECT
        if (status == "failed") return Offer.FAILED
        return Offer.UPLOAD
    }

    public fun youtubePrivacyLabel(value: String?): String =
        YOUTUBE_PRIVACY.firstOrNull { it.value == value }?.label ?: "Private"

    private const val GENERIC_FAILURE = "YouTube didn't accept the upload. Try again."

    /**
     * The line under the player. A queued or uploading row's [error] is a
     * waiting note ("…uploads continue tomorrow") and wins. The percentage is
     * floored and held under 100, so it never says 100% before YouTube has
     * said done.
     */
    public fun youtubeStatusLine(status: String?, privacy: String?, progress: Double?, error: String?): String =
        when (status) {
            "done" -> "On YouTube · ${youtubePrivacyLabel(privacy)}"
            "failed" -> error?.takeIf { it.isNotEmpty() } ?: GENERIC_FAILURE
            "queued" -> error?.takeIf { it.isNotEmpty() } ?: "Waiting to upload to YouTube"
            "uploading" -> error?.takeIf { it.isNotEmpty() } ?: run {
                val p = progress?.takeIf { !it.isNaN() } ?: 0.0
                val pct = floor(p * 100).coerceIn(0.0, 99.0).toInt()
                "Uploading to YouTube · $pct%"
            }
            else -> ""
        }

    /** From `GET /api/clips/:id/youtube` (or the 202 that started one). */
    public fun youtubeStatusLine(upload: Upload?): String =
        if (upload == null) "" else youtubeStatusLine(upload.status, upload.privacy, upload.progress, upload.error)

    /** From the event detail's `clip.youtube`, which carries no progress. */
    public fun youtubeStatusLine(upload: LapClipYouTube?): String =
        if (upload == null) "" else youtubeStatusLine(upload.status, upload.privacy, null, null)

    /** Keep polling while this is true (every 5 s, while the page is visible). */
    public fun youtubeIsPending(status: String?): Boolean = status == "queued" || status == "uploading"

    public fun youtubeIsPending(upload: Upload?): Boolean = youtubeIsPending(upload?.status)

    /**
     * The server's refusals of `POST /api/clips/:id/youtube`, said as the form
     * says them. Anything else (a 400's named rule) is shown as the server
     * worded it.
     */
    public fun youtubeRequestError(message: String?): String = when (message) {
        "youtube upload limit" -> "You can upload 10 videos to YouTube a day."
        "youtube not connected" -> "Connect YouTube in Settings first."
        "already on youtube" -> "This video is already on YouTube."
        "youtube upload in progress" -> "This video is already uploading to YouTube."
        "clip not ready" -> "This video is still uploading to Track Evolution."
        "pro required" -> "Uploading to YouTube is part of Pro."
        else -> message?.takeIf { it.isNotEmpty() } ?: GENERIC_FAILURE
    }

    /** Settings' line for the connection on `GET /api/me`'s `user.youtube`. */
    public fun youtubeAccountLine(yt: YouTubeAccount?): String {
        if (yt?.available != true) return ""
        val account = yt.account?.takeIf { it.isNotEmpty() }
        if (!yt.connected) {
            return if (account != null) {
                "YouTube access for $account was removed. Reconnect to upload again."
            } else {
                "Not connected."
            }
        }
        val who = if (account != null) "Connected as $account" else "Connected"
        val channel = yt.channelTitle?.takeIf { it.isNotEmpty() }
        return if (channel != null) "$who · $channel" else who
    }
}
