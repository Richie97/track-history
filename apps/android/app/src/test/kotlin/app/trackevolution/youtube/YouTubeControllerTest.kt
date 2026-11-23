package app.trackevolution.youtube

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.YouTubeAccount
import app.trackevolution.core.model.YouTubeUpload
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

/**
 * The app's YouTube seam (NS-46) over the real `ApiClient` and `MockEngine`:
 * connecting opens the server's ticket URL in the browser, the redirect's
 * result becomes a sentence said once and a re-read of `/me`, and every
 * failure is in words.
 */
class YouTubeControllerTest {

    private val requests = mutableListOf<String>()
    private var online = true
    private var status = HttpStatusCode.OK
    private val opened = mutableListOf<String>()
    private var browser = true
    private var refreshes = 0

    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val api = ApiClient(
        MockEngine { request ->
            requests += "${request.method.value} ${request.url.encodedPath}"
            if (!online) throw IOException("Unable to resolve host")
            when {
                status != HttpStatusCode.OK -> respond("""{"error":"not found"}""", status, json)
                request.url.encodedPath.endsWith("/youtube/connect") ->
                    respond("""{"url":"https://example.test/youtube/connect?ticket=t1"}""", HttpStatusCode.OK, json)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, json)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
    )

    private val controller = YouTubeController(
        api = api,
        account = MutableStateFlow(YouTubeAccount(available = true, connected = false)),
        refreshMe = { refreshes++ },
        openBrowser = { url -> opened += url; browser },
    )

    @Test
    fun `connecting opens the server's ticket URL in the browser`() = runBlocking {
        assertNull(controller.connect())
        assertEquals(listOf("POST /api/youtube/connect"), requests)
        assertEquals(listOf("https://example.test/youtube/connect?ticket=t1"), opened)
    }

    @Test
    fun `connecting offline, with no browser, or refused says so and opens nothing more`() = runBlocking {
        online = false
        assertEquals("Uploading to YouTube needs a connection.", controller.connect())
        assertEquals(emptyList<String>(), opened)

        online = true
        browser = false
        assertEquals(YouTubeHost.NO_BROWSER, controller.connect())

        // The feature switched off for this account between `/me` and the tap.
        status = HttpStatusCode.NotFound
        assertEquals("not found", controller.connect())
    }

    @Test
    fun `the redirect's result is a sentence said once, after re-reading me`() = runBlocking {
        controller.onConnectResult("connected")
        assertEquals(1, refreshes)
        assertEquals("YouTube is connected.", controller.result.value)
        assertEquals("YouTube is connected.", controller.takeResult())
        assertNull(controller.takeResult())

        controller.onConnectResult("denied")
        assertEquals("YouTube wasn't connected — Google's permission was declined.", controller.takeResult())
        // Whatever else it said, YouTube was not connected.
        controller.onConnectResult("granted")
        assertEquals("Couldn't connect YouTube. Try again.", controller.takeResult())
    }

    @Test
    fun `disconnecting re-reads me, and offline says it needs a connection`() = runBlocking {
        assertNull(controller.disconnect())
        assertEquals(listOf("DELETE /api/youtube"), requests)
        assertEquals(1, refreshes)

        online = false
        assertEquals(YouTubeHost.DISCONNECT_OFFLINE, controller.disconnect())
        assertEquals("a failed disconnect changes nothing to re-read", 1, refreshes)
    }

    @Test
    fun `keeps the newest upload row and the last form per clip, and forgets them on sign-out`() {
        val queued = YouTubeUpload(status = "queued", progress = 0.0, privacy = "public")
        controller.note(7, queued)
        controller.note(7, queued.copy(status = "uploading", progress = 0.4))
        assertEquals("uploading", controller.uploads.value[7]?.status)
        controller.remember(7, YouTubeFormValues("T", "D", "public"))
        assertEquals("public", controller.lastSent(7)?.privacy)
        assertNull(controller.lastSent(8))

        controller.forget(7)
        assertNull(controller.uploads.value[7])

        controller.note(9, queued)
        controller.clear()
        assertEquals(emptyMap<Int, YouTubeUpload>(), controller.uploads.value)
        assertNull(controller.lastSent(7))
    }
}
