package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.YouTubeUpload
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.navigation.SavedState
import app.trackevolution.ui.LoadState
import app.trackevolution.youtube.YouTubeFormValues
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import app.trackevolution.core.model.YouTubeUpload as Upload

/**
 * The *Upload to YouTube* form (NS-46) — the web's `<dialog>` as a destination
 * of its own, never a dialog (a text field in an `AlertDialog` never lets
 * Robolectric idle).
 *
 * The words it opens with are the server's draft
 * (`GET /api/clips/:id/youtube/draft`), so nothing here builds a title; what was
 * [lastSent] for this clip — a failed upload's *Try again* — lies over it. The
 * fields live in the [SavedStateHandle] under the event form's rule: once
 * [hydrated], a later load never overwrites what the driver typed, so a
 * rotation, a fold or the system killing the app mid-title keeps it.
 *
 * The visibility is the driver's choice of `YouTubeUpload.YOUTUBE_PRIVACY` —
 * Private, Unlisted or Public — starting where the draft says (Unlisted).
 */
class YouTubeUploadModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val clipId: Int,
    private val lastSent: YouTubeFormValues? = null,
    saved: SavedStateHandle? = null,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var title by SavedState(saved, "ytTitle", "")
    var description by SavedState(saved, "ytDescription", "")
    var privacy by SavedState(saved, "ytPrivacy", YouTubeUpload.YOUTUBE_DEFAULT_PRIVACY)

    /** The Google account the upload goes to, for the line above the button. */
    var account by SavedState<String?>(saved, "ytAccount", null)
        private set
    private var hydrated by SavedState(saved, "hydrated", false)

    var error by mutableStateOf<String?>(null)
        private set

    var sending by mutableStateOf(false)
        private set

    /** The 202's row once the upload is queued — the screen notes it and pops. */
    var sent by mutableStateOf<Upload?>(null)
        private set

    /** The title's length as the server counts it: code points, of [TITLE_MAX]. */
    val titleCount: Int get() = title.codePointCount(0, title.length)

    /** What the form would send, as it stands. */
    val values: YouTubeFormValues get() = YouTubeFormValues(title, description, privacy)

    fun load() {
        // A restored draft needs no request, and must not be shown a spinner
        // (or an offline failure) in place of what the driver had typed.
        if (hydrated) {
            state = LoadState.Ready
            return
        }
        state = LoadState.Loading
        scope.launch {
            try {
                val draft = api.youTubeDraft(clipId)
                if (!hydrated) {
                    title = lastSent?.title ?: draft.title
                    description = lastSent?.description ?: draft.description
                    privacy = (lastSent?.privacy ?: draft.privacy)
                        .takeIf { p -> YouTubeUpload.YOUTUBE_PRIVACY.any { it.value == p } }
                        ?: YouTubeUpload.YOUTUBE_DEFAULT_PRIVACY
                    account = draft.account
                    hydrated = true
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(words(e))
            }
        }
    }

    /** A title past the limit is cut at a code point, never through a surrogate pair. */
    fun setTitleText(text: String) {
        title = if (text.codePointCount(0, text.length) <= TITLE_MAX) {
            text
        } else {
            text.substring(0, text.offsetByCodePoints(0, TITLE_MAX))
        }
    }

    fun upload() {
        if (sending) return
        error = null
        sending = true
        scope.launch {
            try {
                sent = api.startYouTubeUpload(clipId, title, description, privacy)
            } catch (e: ApiException) {
                error = words(e)
            }
            sending = false
        }
    }

    private fun words(e: ApiException): String =
        if (e is ApiException.Transport) YouTubeUpload.YOUTUBE_OFFLINE else YouTubeUpload.youtubeRequestError(e.message)

    companion object {
        /** YouTube's title limit, which `sanitizeVideoMetadata` enforces in code points. */
        const val TITLE_MAX: Int = 100
    }
}
