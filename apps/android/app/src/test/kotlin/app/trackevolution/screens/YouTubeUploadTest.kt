package app.trackevolution.screens

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.LapClipYouTube
import app.trackevolution.core.model.YouTubeAccount
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.theme.TrackTheme
import app.trackevolution.youtube.LocalYouTube
import app.trackevolution.youtube.YouTubeController
import app.trackevolution.youtube.YouTubeFormValues
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Publishing a best-lap video to YouTube (NS-46) on the phone, over the real
 * `ApiClient` and `MockEngine`: the form (pre-filled from the server's draft,
 * the visibility the driver's choice, refusals in the web's words, the draft
 * kept across a restore), the lap page's panel by `youtubeOffer` with its
 * polled status line, and Settings' section.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class YouTubeUploadTest {

    @get:Rule
    val compose = createComposeRule()

    private val requests = CopyOnWriteArrayList<String>()
    private val bodies = CopyOnWriteArrayList<String>()
    @Volatile private var online = true
    @Volatile private var refusal: Pair<HttpStatusCode, String>? = null

    /** What the status route answers, in order; the last one repeats. */
    private val statuses = CopyOnWriteArrayList<String>()

    private val api = ApiClient(
        MockEngine { request ->
            val path = request.url.encodedPath
            val method = request.method.value
            requests += "$method $path"
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            refusal?.let { (status, error) -> return@MockEngine respond("""{"error":"$error"}""", status, JSON) }
            when {
                path.endsWith("/youtube/draft") -> respond(DRAFT, HttpStatusCode.OK, JSON)
                path.endsWith("/youtube/connect") ->
                    respond("""{"url":"https://example.test/youtube/connect?ticket=t1"}""", HttpStatusCode.OK, JSON)
                path.endsWith("/clips/7/youtube") && method == "POST" -> respond(
                    upload("queued", privacy = Json.parseToJsonElement(bodies.last()).jsonObject["privacy"]!!.jsonPrimitive.content),
                    HttpStatusCode.Accepted, JSON,
                )
                path.endsWith("/clips/7/youtube") ->
                    respond(if (statuses.size > 1) statuses.removeAt(0) else statuses.first(), HttpStatusCode.OK, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
    )

    private val account = MutableStateFlow<YouTubeAccount?>(
        YouTubeAccount(available = true, connected = true, account = "driver@channel.example"),
    )
    private val opened = CopyOnWriteArrayList<String>()
    @Volatile private var refreshes = 0
    private val host = YouTubeController(
        api = api,
        account = account,
        refreshMe = { refreshes++ },
        openBrowser = { url -> opened += url; true },
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val pro = Entitlement(tier = Entitlement.Tier.PRO)

    /** See `CoachingScreensTest.eventually`: sleep and idle between checks. */
    private fun eventually(condition: () -> Boolean) {
        repeat(400) {
            if (condition()) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        assertTrue("condition never held", condition())
    }

    private fun has(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun hasText(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    private fun selected(tag: String) =
        compose.onNodeWithTag(tag).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Selected) == true

    // ---- The form ------------------------------------------------------------

    private var done = 0

    private fun form(
        saved: SavedStateHandle = SavedStateHandle(),
        lastSent: YouTubeFormValues? = null,
    ): YouTubeUploadModel {
        val model = YouTubeUploadModel(scope, api, clipId = 7, lastSent = lastSent, saved = saved)
        compose.setContent {
            CompositionLocalProvider(LocalYouTube provides host) {
                TrackTheme { YouTubeUploadScreen(model = model, onDone = { done++ }) }
            }
        }
        eventually { model.state != LoadState.Loading }
        return model
    }

    @Test
    fun `the form opens on the server's draft, Unlisted, naming the account`() {
        form()
        compose.onNodeWithTag("youtubeTitle").assertTextContains("VIR (Full) · 2:01.500 · Corvette C7")
        compose.onNodeWithTag("youtubeDescription").assertTextContains("Best lap of Session 2.", substring = true)
        compose.onNodeWithText("35 / 100").assertIsDisplayed()
        assertTrue(selected("youtubePrivacy:unlisted"))
        assertTrue(!selected("youtubePrivacy:public") && !selected("youtubePrivacy:private"))
        compose.onNodeWithText("Uploading to driver@channel.example · Not made for kids").assertIsDisplayed()
    }

    @Test
    fun `choosing Public sends public, tells the lap page and leaves`() {
        val model = form()
        compose.onNodeWithTag("youtubePrivacy:public").performClick()
        compose.waitForIdle()
        assertTrue(selected("youtubePrivacy:public"))
        assertTrue(!selected("youtubePrivacy:unlisted"))
        compose.onNodeWithTag("youtubeTitle").performTextReplacement("My lap")
        compose.onNodeWithTag("youtubeSend").performScrollTo().performClick()
        eventually { done == 1 }

        val body = Json.parseToJsonElement(bodies.last()).jsonObject
        assertEquals(setOf("title", "description", "privacy"), body.keys)
        assertEquals("public", body["privacy"]!!.jsonPrimitive.content)
        assertEquals("My lap", body["title"]!!.jsonPrimitive.content)
        assertEquals("Best lap of Session 2.\nLap starts at 0:03.", body["description"]!!.jsonPrimitive.content)
        // The lap page's panel reads this rather than its older event detail.
        assertEquals("queued", host.uploads.value[7]?.status)
        assertEquals("public", host.uploads.value[7]?.privacy)
        assertEquals(YouTubeFormValues("My lap", model.description, "public"), host.lastSent(7))
    }

    @Test
    fun `Private and Unlisted are sent as chosen too`() {
        val model = form()
        for (value in listOf("private", "unlisted")) {
            compose.onNodeWithTag("youtubePrivacy:$value").performClick()
            compose.waitForIdle()
            assertEquals(value, model.privacy)
            val before = bodies.size
            compose.onNodeWithTag("youtubeSend").performScrollTo().performClick()
            eventually { bodies.size > before }
            assertEquals(value, Json.parseToJsonElement(bodies.last()).jsonObject["privacy"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun `a refusal is said in the web's words and the form stays, fields intact`() {
        val model = form()
        compose.onNodeWithTag("youtubePrivacy:public").performClick()
        refusal = HttpStatusCode.TooManyRequests to "youtube upload limit"
        compose.onNodeWithTag("youtubeSend").performScrollTo().performClick()
        eventually { hasText("You can upload 10 videos to YouTube a day.") }
        assertEquals(0, done)
        assertNull(host.uploads.value[7])
        assertEquals("public", model.privacy)

        // A 400's named rule is shown as the server worded it.
        refusal = HttpStatusCode.BadRequest to "title must be at most 100 characters"
        compose.onNodeWithTag("youtubeSend").performScrollTo().performClick()
        eventually { hasText("title must be at most 100 characters") }

        online = false
        compose.onNodeWithTag("youtubeSend").performScrollTo().performClick()
        eventually { hasText("Uploading to YouTube needs a connection.") }
        assertEquals(0, done)
    }

    @Test
    fun `offline, the form says uploading needs a connection instead of loading`() {
        online = false
        val model = form()
        assertEquals(LoadState.Failed("Uploading to YouTube needs a connection."), model.state)
        compose.onNodeWithText("Uploading to YouTube needs a connection.").assertIsDisplayed()
    }

    @Test
    fun `a restored draft is kept, not overwritten by the server's and not re-fetched`() {
        val saved = SavedStateHandle()
        val first = YouTubeUploadModel(scope, api, clipId = 7, saved = saved)
        first.load()
        eventually { first.state == LoadState.Ready }
        first.setTitleText("Half-typed")
        first.privacy = "private"
        val drafts = requests.count { it.endsWith("/youtube/draft") }

        // The process was killed and the destination restored from its handle.
        form(saved = saved)
        compose.onNodeWithTag("youtubeTitle").assertTextContains("Half-typed")
        assertTrue(selected("youtubePrivacy:private"))
        compose.onNodeWithText("Uploading to driver@channel.example · Not made for kids").assertIsDisplayed()
        assertEquals(drafts, requests.count { it.endsWith("/youtube/draft") })
    }

    @Test
    fun `Try again reopens the form with what was last sent`() {
        form(lastSent = YouTubeFormValues("Second go", "Mine", "public"))
        compose.onNodeWithTag("youtubeTitle").assertTextContains("Second go")
        assertTrue(selected("youtubePrivacy:public"))
    }

    @Test
    fun `the title is counted and cut in code points, and an empty one can't be sent`() {
        val model = form()
        // 99 letters and two flags' worth of surrogate pairs: 101 code points.
        model.setTitleText("a".repeat(99) + "😀😀")
        assertEquals(100, model.titleCount)
        assertTrue(model.title.endsWith("😀"))
        compose.onNodeWithTag("youtubeTitle").performTextReplacement("")
        compose.onNodeWithTag("youtubeSend").performScrollTo().assertIsNotEnabled()
    }

    // ---- The lap page's panel -------------------------------------------------

    private var formsOpened = CopyOnWriteArrayList<Int>()
    @Volatile private var changed = 0

    private fun clip(status: String?, url: String? = null, privacy: String = "unlisted") = LapClip(
        id = 7, durationMs = 108_000, lapOffsetMs = 3_317,
        youtube = status?.let { LapClipYouTube(status = it, url = url, privacy = privacy) },
    )

    private fun panel(clip: LapClip, viewer: Entitlement = pro, readOnly: Boolean = false) {
        compose.setContent {
            CompositionLocalProvider(LocalYouTube provides host) {
                TrackTheme {
                    YouTubeLapPanel(
                        api = api,
                        clip = clip,
                        viewer = viewer,
                        readOnly = readOnly,
                        onUpload = { formsOpened += it },
                        onChanged = { changed++ },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `a connected Pro driver is offered the upload, which opens the form`() {
        panel(clip(null))
        compose.onNodeWithText("Upload to YouTube…").performClick()
        assertEquals(listOf(7), formsOpened.toList())
        assertTrue("an idle clip reads nothing from the status route", requests.isEmpty())
    }

    @Test
    fun `with no grant, the consent text and its links come before Connect, which opens the browser`() {
        account.value = YouTubeAccount(available = true, connected = false)
        panel(clip(null))
        compose.onNodeWithText(app.trackevolution.core.YouTubeUpload.YOUTUBE_CONNECT_TEXT).assertIsDisplayed()
        compose.onNodeWithText("YouTube Terms of Service ↗").assertIsDisplayed()
        compose.onNodeWithText("Google Privacy Policy ↗").assertIsDisplayed()
        compose.onNodeWithTag("youtubeConnect").performClick()
        eventually { opened.isNotEmpty() }
        assertEquals(listOf("https://example.test/youtube/connect?ticket=t1"), opened.toList())
    }

    @Test
    fun `an upload on its way polls every five seconds until YouTube has it`() {
        statuses += upload("uploading", progress = 0.4)
        statuses += upload("uploading", progress = 0.996)
        statuses += upload("done", progress = 1.0, url = "https://youtu.be/abc")
        panel(clip("queued"))
        // The event detail carries no progress; the first read is at once.
        eventually { hasText("Uploading to YouTube · 40%") }
        assertEquals(1, requests.count { it == "GET /api/clips/7/youtube" })

        compose.mainClock.advanceTimeBy(YouTubeText.POLL_MS)
        eventually { hasText("Uploading to YouTube · 99%") }
        assertEquals(0, changed)

        compose.mainClock.advanceTimeBy(YouTubeText.POLL_MS)
        eventually { hasText("On YouTube · Unlisted") }
        compose.onNodeWithTag("youtubeOpen").assertIsDisplayed()
        assertEquals("the page re-reads its event once the upload lands", 1, changed)

        // Done: nothing more is asked.
        val polls = requests.count { it == "GET /api/clips/7/youtube" }
        compose.mainClock.advanceTimeBy(YouTubeText.POLL_MS * 3)
        compose.waitForIdle()
        assertEquals(polls, requests.count { it == "GET /api/clips/7/youtube" })
        assertEquals(3, polls)
    }

    @Test
    fun `offline, a pending upload says so and keeps trying`() {
        statuses += upload("uploading", progress = 0.5)
        online = false
        panel(clip("uploading"))
        eventually { hasText("Uploading to YouTube needs a connection.") }
        online = true
        compose.mainClock.advanceTimeBy(YouTubeText.POLL_MS)
        eventually { hasText("Uploading to YouTube · 50%") }
    }

    @Test
    fun `a failed upload reads its reason, re-reads me and offers Try again`() {
        statuses += upload("failed", error = "YouTube was disconnected.")
        panel(clip("failed"))
        eventually { hasText("YouTube was disconnected.") }
        eventually { refreshes == 1 }
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf(7), formsOpened.toList())
    }

    @Test
    fun `a video on YouTube says its visibility and opens, even for a lapsed owner`() {
        panel(clip("done", url = "https://youtu.be/abc", privacy = "public"), viewer = Entitlement.FREE)
        compose.onNodeWithText("On YouTube · Public").assertIsDisplayed()
        compose.onNodeWithTag("youtubeOpen").assertIsDisplayed()
        assertTrue(requests.isEmpty())
    }

    @Test
    fun `nothing is drawn for a free account, a coach, or while the feature is off`() {
        panel(clip(null), viewer = Entitlement.FREE)
        assertTrue(!has("youtubePanel"))
    }

    @Test
    fun `a coach sees nothing whatever the upload's state`() {
        panel(clip("done", url = "https://youtu.be/abc"), readOnly = true)
        assertTrue(!has("youtubePanel"))
    }

    @Test
    fun `the feature switched off draws nothing`() {
        account.value = YouTubeAccount(available = false, connected = true)
        panel(clip("done", url = "https://youtu.be/abc"))
        assertTrue(!has("youtubePanel"))
    }

    @Test
    fun `the lap video card carries the panel for its owner and not for a coach`() {
        val lap = Lap(id = 41, sessionId = 501, lapNum = 6, timeMs = 122_110, clip = clip(null))
        fun card(owner: LogbookOwner) = compose.setContent {
            CompositionLocalProvider(LocalYouTube provides host) {
                TrackTheme {
                    LapVideoCard(
                        api = api, owner = owner, viewer = pro, sessionId = 501, lap = lap,
                        sessionLaps = listOf(lap), onSubscribe = {}, onDeleted = {},
                        onYouTubeUpload = { formsOpened += it },
                    )
                }
            }
        }
        card(LogbookOwner.Me)
        compose.onNodeWithTag("youtubeUpload").performClick()
        assertEquals(listOf(7), formsOpened.toList())
    }

    @Test
    fun `a coach's lap video card has no YouTube panel`() {
        val lap = Lap(id = 41, sessionId = 501, lapNum = 6, timeMs = 122_110, clip = clip("done", url = "https://youtu.be/abc"))
        compose.setContent {
            CompositionLocalProvider(LocalYouTube provides host) {
                TrackTheme {
                    LapVideoCard(
                        api = api, owner = LogbookOwner.Student(3, "Alex", pro = true), viewer = pro,
                        sessionId = 501, lap = lap, sessionLaps = listOf(lap), onSubscribe = {}, onDeleted = {},
                    )
                }
            }
        }
        compose.onNodeWithTag("lapVideo").assertIsDisplayed()
        assertTrue(!has("youtubePanel"))
    }

    @Test
    fun `deleting a video that is on YouTube says the copy there stays`() {
        assertEquals(
            "Delete this lap video? The lap and its telemetry stay. The copy on YouTube stays. Delete it in YouTube Studio.",
            LapVideoText.confirmDelete(onYouTube = true),
        )
        assertEquals(LapVideoText.CONFIRM_DELETE, LapVideoText.confirmDelete(onYouTube = false))

        val lap = Lap(id = 41, sessionId = 501, lapNum = 6, timeMs = 122_110, clip = clip("done", url = "https://youtu.be/abc"))
        compose.setContent {
            CompositionLocalProvider(LocalYouTube provides host) {
                TrackTheme {
                    LapVideoCard(
                        api = api, owner = LogbookOwner.Me, viewer = pro, sessionId = 501, lap = lap,
                        sessionLaps = listOf(lap), onSubscribe = {}, onDeleted = {},
                    )
                }
            }
        }
        compose.onNodeWithTag("lapVideoMenu").performClick()
        compose.onNodeWithText("Delete video").performClick()
        compose.onNodeWithText(LapVideoText.confirmDelete(onYouTube = true)).assertIsDisplayed()
    }

    // ---- Settings -------------------------------------------------------------

    private val links = CopyOnWriteArrayList<String>()

    private fun settings() {
        compose.setContent {
            CompositionLocalProvider(LocalYouTube provides host) {
                TrackTheme { YouTubeSettingsCard(onOpenLink = { links += it }) }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `Settings says which account is connected, links Google's permissions and disconnects on confirm`() {
        account.value = YouTubeAccount(true, true, "driver@channel.example", "Fast Laps")
        settings()
        compose.onNodeWithText("Connected as driver@channel.example · Fast Laps").assertIsDisplayed()
        compose.onNodeWithTag("youtubePermissions").performClick()
        assertEquals(listOf("https://myaccount.google.com/permissions"), links.toList())

        compose.onNodeWithTag("youtubeDisconnect").performClick()
        compose.onNodeWithText("Disconnect YouTube? Videos you've uploaded stay on YouTube.").assertIsDisplayed()
        assertTrue("nothing is sent before the confirm", requests.isEmpty())
        compose.onNodeWithText("Disconnect").performClick()
        eventually { refreshes == 1 }
        assertEquals(listOf("DELETE /api/youtube"), requests.toList())
    }

    @Test
    fun `Settings offers Connect with the consent text, or Reconnect after a revoked grant`() {
        account.value = YouTubeAccount(available = true, connected = false)
        settings()
        compose.onNodeWithText("Not connected.").assertIsDisplayed()
        compose.onNodeWithText(app.trackevolution.core.YouTubeUpload.YOUTUBE_CONNECT_TEXT).assertIsDisplayed()
        compose.onNodeWithText("Connect YouTube…").performClick()
        eventually { opened.isNotEmpty() }

        account.value = YouTubeAccount(available = true, connected = false, account = "driver@channel.example")
        compose.waitForIdle()
        compose.onNodeWithText("YouTube access for driver@channel.example was removed. Reconnect to upload again.")
            .assertIsDisplayed()
        compose.onNodeWithText("Reconnect YouTube…").assertIsDisplayed()
    }

    @Test
    fun `a connect's outcome is said in Settings once`() {
        kotlinx.coroutines.runBlocking { host.onConnectResult("denied") }
        settings()
        compose.onNodeWithText("YouTube wasn't connected — Google's permission was declined.").assertIsDisplayed()
        assertNull("taken, so the next visit is quiet", host.result.value)
    }

    @Test
    fun `Settings draws nothing while the feature is off`() {
        account.value = YouTubeAccount(available = false, connected = false)
        settings()
        assertTrue(!has("youtubeSettings"))
        account.value = null
        compose.waitForIdle()
        assertTrue(!has("youtubeSettings"))
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        const val DRAFT = """{"title":"VIR (Full) · 2:01.500 · Corvette C7","description":"Best lap of Session 2.\nLap starts at 0:03.","privacy":"unlisted","account":"driver@channel.example"}"""

        fun upload(
            status: String,
            progress: Double = 0.0,
            privacy: String = "unlisted",
            url: String? = null,
            error: String? = null,
        ): String {
            fun q(s: String?) = if (s == null) "null" else "\"$s\""
            return """{"status":"$status","progress":$progress,"privacy":"$privacy","url":${q(url)},"error":${q(error)}}"""
        }
    }
}
