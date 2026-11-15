package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * Push notifications for coach comments (NS-54) in `:core`: where a tapped
 * notification goes — the same table as iOS's `DeepLink.commentPush` — and
 * the two registration calls, which are live and never queued.
 */
class CommentPushTest {

    private fun data(vararg pairs: Pair<String, String>) = mapOf("kind" to "comment", *pairs)

    @Test
    fun `a lap comment opens the lap, in the owner's logbook`() {
        assertEquals(
            DeepLink.CommentPush(eventId = 30, sessionId = 40, lapId = 50, studentId = null),
            DeepLink.commentPush(data("comment_id" to "7", "event_id" to "30", "session_id" to "40", "lap_id" to "50")),
        )
    }

    @Test
    fun `a session comment opens the event`() {
        assertEquals(
            DeepLink.CommentPush(30, 40, null, null),
            DeepLink.commentPush(data("event_id" to "30", "session_id" to "40")),
        )
    }

    @Test
    fun `a reply to a coach opens it in the student's logbook`() {
        assertEquals(
            DeepLink.CommentPush(30, 40, 50, 9),
            DeepLink.commentPush(data("event_id" to "30", "session_id" to "40", "lap_id" to "50", "student_id" to "9")),
        )
        assertEquals(
            DeepLink.CommentPush(30, 40, null, 9),
            DeepLink.commentPush(data("event_id" to "30", "session_id" to "40", "student_id" to "9")),
        )
    }

    @Test
    fun `a junk lap or student falls back rather than failing`() {
        for (junk in listOf("", "0", "-3", "abc", "1.5", " 5", "99999999999")) {
            assertEquals(
                DeepLink.CommentPush(30, 40, null, null),
                DeepLink.commentPush(data("event_id" to "30", "session_id" to "40", "lap_id" to junk, "student_id" to junk)),
                "junk: '$junk'",
            )
        }
    }

    @Test
    fun `no kind, another kind, or a bad event or session opens nothing`() {
        assertNull(DeepLink.commentPush(mapOf("event_id" to "30", "session_id" to "40")))
        assertNull(DeepLink.commentPush(mapOf("kind" to "invite", "event_id" to "30", "session_id" to "40")))
        assertNull(DeepLink.commentPush(data("session_id" to "40")))
        assertNull(DeepLink.commentPush(data("event_id" to "30")))
        for (junk in listOf("", "0", "-1", "x", "3e2")) {
            assertNull(DeepLink.commentPush(data("event_id" to junk, "session_id" to "40")), "event '$junk'")
            assertNull(DeepLink.commentPush(data("event_id" to "30", "session_id" to junk)), "session '$junk'")
        }
        assertNull(DeepLink.commentPush(emptyMap()))
    }

    // ---- the API -------------------------------------------------------------

    private val requests = mutableListOf<String>()
    private val bodies = mutableListOf<String>()
    private var online = true

    private val api = ApiClient(
        MockEngine { request ->
            requests += "${request.method.value} ${request.url.encodedPath}"
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            respond("""{"ok":true}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
        offline = OfflineStore(InMemoryOfflinePersistence()),
    )

    @Test
    fun `registers and unregisters this phone`() = runTest {
        api.registerPushDevice("fcm-token-1")
        api.unregisterPushDevice()
        assertEquals(listOf("PUT /api/push/device", "DELETE /api/push/device"), requests)
        assertEquals(listOf("""{"platform":"android","token":"fcm-token-1"}"""), bodies)
    }

    @Test
    fun `offline, registration fails rather than queueing`() = runTest {
        online = false
        assertThrows<ApiException> { api.registerPushDevice("fcm-token-1") }
        assertThrows<ApiException> { api.unregisterPushDevice() }
    }
}
