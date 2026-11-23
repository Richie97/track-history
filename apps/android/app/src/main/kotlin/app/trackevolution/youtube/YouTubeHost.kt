package app.trackevolution.youtube

import androidx.compose.runtime.staticCompositionLocalOf
import app.trackevolution.core.YouTubeUpload
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.YouTubeAccount
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import app.trackevolution.core.model.YouTubeUpload as Upload

/** What a driver last put in the upload form for a clip, for *Try again*. */
data class YouTubeFormValues(val title: String, val description: String, val privacy: String)

/**
 * Publishing to YouTube as the screens see it (NS-46): the account's
 * connection, the way to connect and disconnect, a connect's outcome, and what
 * is known about each clip's upload since the page was read.
 *
 * One seam, read through [LocalYouTube], because three places need the same
 * answers — the lap page, the upload form and Settings — and the connect step
 * has to be launched from the Activity (a Chrome Custom Tab opened from the
 * application context lands in the wrong task). Inert by default
 * ([NONE]: the feature reads as unavailable), so a screen under Robolectric
 * draws nothing about YouTube unless its test says otherwise — the
 * `LocalClipStatus` arrangement.
 */
interface YouTubeHost {
    /** `user.youtube` on `GET /api/me`; null signed out, or on a `/me` cached before the field. */
    val account: StateFlow<YouTubeAccount?>

    /**
     * The newest upload row this session has seen for each clip id — the 202
     * that started one, or a poll. The event detail the lap page drew from is
     * older than these, so a row here wins over its `clip.youtube`.
     */
    val uploads: StateFlow<Map<Int, Upload>>

    /** A connect's outcome sentence, waiting for Settings to say it once. */
    val result: StateFlow<String?>

    /** Takes [result], so it is said once. */
    fun takeResult(): String?

    /**
     * Opens Google's consent in the system browser. Answers what to say when
     * it couldn't — offline, or the server refused — and null once the browser
     * is open; the outcome arrives later as `trackevolution://youtube?result=…`.
     */
    suspend fun connect(): String?

    /** Disconnects, then re-reads `/me`. Answers what to say on failure, else null. */
    suspend fun disconnect(): String?

    /** Re-reads `/me`: a failed upload may have been the grant going at Google's end. */
    suspend fun refresh()

    fun note(clipId: Int, upload: Upload)

    /** The clip's upload is gone (the status route's 404): its row here goes too. */
    fun forget(clipId: Int)

    fun lastSent(clipId: Int): YouTubeFormValues?

    fun remember(clipId: Int, values: YouTubeFormValues)

    companion object {
        const val DISCONNECT_OFFLINE: String = "Disconnecting YouTube needs a connection."
        const val NO_BROWSER: String = "Couldn't open a browser to connect YouTube."

        val NONE: YouTubeHost = object : YouTubeHost {
            override val account: StateFlow<YouTubeAccount?> = MutableStateFlow(null)
            override val uploads: StateFlow<Map<Int, Upload>> = MutableStateFlow(emptyMap())
            override val result: StateFlow<String?> = MutableStateFlow(null)
            override fun takeResult(): String? = null
            override suspend fun connect(): String? = null
            override suspend fun disconnect(): String? = null
            override suspend fun refresh() = Unit
            override fun note(clipId: Int, upload: Upload) = Unit
            override fun forget(clipId: Int) = Unit
            override fun lastSent(clipId: Int): YouTubeFormValues? = null
            override fun remember(clipId: Int, values: YouTubeFormValues) = Unit
        }
    }
}

/** Published once by `MainActivity`. */
val LocalYouTube = staticCompositionLocalOf { YouTubeHost.NONE }

/**
 * The app's [YouTubeHost]. Everything Android is handed in — [account] off the
 * auth state, [refreshMe] the auth controller's re-read, [openBrowser] a Custom
 * Tab launched from the Activity — so the decisions are tested on the JVM
 * (`YouTubeControllerTest`).
 */
class YouTubeController(
    private val api: ApiClient,
    override val account: StateFlow<YouTubeAccount?>,
    private val refreshMe: suspend () -> Unit,
    private val openBrowser: (url: String) -> Boolean,
) : YouTubeHost {

    private val _uploads = MutableStateFlow<Map<Int, Upload>>(emptyMap())
    override val uploads: StateFlow<Map<Int, Upload>> = _uploads.asStateFlow()

    private val _result = MutableStateFlow<String?>(null)
    override val result: StateFlow<String?> = _result.asStateFlow()

    private val sent = HashMap<Int, YouTubeFormValues>()

    /**
     * The redirect back from a connect (`DeepLink.YouTubeConnect`): hold its
     * sentence for Settings and re-read `/me`, which is what says *connected*.
     */
    suspend fun onConnectResult(result: String) {
        _result.value = YouTubeUpload.YOUTUBE_RESULT_TEXT[result] ?: YouTubeUpload.YOUTUBE_RESULT_TEXT.getValue("error")
        refreshMe()
    }

    override fun takeResult(): String? = _result.value.also { _result.value = null }

    override suspend fun connect(): String? = try {
        if (openBrowser(api.youTubeConnectUrl())) null else YouTubeHost.NO_BROWSER
    } catch (e: ApiException) {
        if (e is ApiException.Transport) YouTubeUpload.YOUTUBE_OFFLINE else YouTubeUpload.youtubeRequestError(e.message)
    }

    override suspend fun disconnect(): String? = try {
        api.disconnectYouTube()
        refreshMe()
        null
    } catch (e: ApiException) {
        if (e is ApiException.Transport) YouTubeHost.DISCONNECT_OFFLINE else e.message
    }

    override suspend fun refresh() = refreshMe()

    override fun note(clipId: Int, upload: Upload) = _uploads.update { it + (clipId to upload) }

    override fun forget(clipId: Int) = _uploads.update { it - clipId }

    override fun lastSent(clipId: Int): YouTubeFormValues? = synchronized(sent) { sent[clipId] }

    override fun remember(clipId: Int, values: YouTubeFormValues) {
        synchronized(sent) { sent[clipId] = values }
    }

    /** Sign-out: nothing about one account's uploads may show under the next. */
    fun clear() {
        _uploads.value = emptyMap()
        _result.value = null
        synchronized(sent) { sent.clear() }
    }
}
