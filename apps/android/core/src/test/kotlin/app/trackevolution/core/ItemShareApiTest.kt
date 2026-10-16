package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.ItemShareKind
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * Share one event or session (NS-48) at the API client: the owner's routes are
 * live — never queued, never cached — and the public reads send no token.
 */
class ItemShareApiTest {

    private val store = OfflineStore(InMemoryOfflinePersistence())
    private val requests = mutableListOf<String>()
    private var online = true
    private var status = HttpStatusCode.OK

    private val api = ApiClient(
        MockEngine { request ->
            val auth = if (request.headers[HttpHeaders.Authorization] != null) " +auth" else ""
            requests += "${request.method.value} ${request.url.encodedPath}$auth"
            if (!online) throw IOException("Unable to resolve host")
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            val path = request.url.encodedPath
            when {
                status != HttpStatusCode.OK -> respond("""{"error":"not found"}""", status, json)
                request.method.value == "DELETE" -> respond("""{"ok":true}""", HttpStatusCode.OK, json)
                path.endsWith("/url") -> respond("""{"url":"https://x.test/clips/1.mp4","expires_at":1}""", HttpStatusCode.OK, json)
                path.startsWith("/api/share/s/") -> respond(Goldens.bodyText("shared-session"), HttpStatusCode.OK, json)
                path.startsWith("/api/share/e/") -> respond(Goldens.bodyText("shared-event"), HttpStatusCode.OK, json)
                path.startsWith("/api/sessions/") -> respond(Goldens.bodyText("item-share-session-create"), HttpStatusCode.Created, json)
                else -> respond(Goldens.bodyText("item-share-event-create"), HttpStatusCode.Created, json)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
        offline = store,
    )

    @Test
    fun `the owner's routes hit the item's own path and are cached nowhere`() = runTest {
        val event = api.shareItem(ItemShareKind.EVENT, 12)
        assertEquals(ItemShareKind.EVENT, event.kind)
        assertTrue(event.url.endsWith("/share/e/${event.token}"))
        assertEquals(ItemShareKind.SESSION, api.shareItem(ItemShareKind.SESSION, 4).kind)
        api.itemShare(ItemShareKind.EVENT, 12)
        api.stopSharingItem(ItemShareKind.SESSION, 4)
        assertEquals(
            listOf(
                "POST /api/events/12/share +auth",
                "POST /api/sessions/4/share +auth",
                "GET /api/events/12/share +auth",
                "DELETE /api/sessions/4/share +auth",
            ),
            requests,
        )
        assertNull(store.cachedGet("/events/12/share"))
    }

    @Test
    fun `offline, sharing fails rather than queueing`() = runTest {
        online = false
        assertThrows<ApiException.Transport> { api.shareItem(ItemShareKind.EVENT, 12) }
        assertThrows<ApiException.Transport> { api.stopSharingItem(ItemShareKind.EVENT, 12) }
        assertEquals(0, store.pendingCount())
    }

    @Test
    fun `a shared item is read without a token, past the cache`() = runTest {
        val token = "AAAAAAAAAAAAAAAAAAAAAA"
        val item = api.sharedItem(ItemShareKind.SESSION, token)
        assertEquals(ItemShareKind.SESSION, item.kind)
        assertEquals(1, item.event.sessions.size)
        api.sharedClipUrl(ItemShareKind.EVENT, token, 3)
        assertEquals(
            listOf("GET /api/share/s/$token", "GET /api/share/e/$token/clips/3/url"),
            requests,
        )
        assertNull(store.cachedGet("/share/s/$token"))
        // Offline there is no stale copy to fall back to.
        online = false
        assertThrows<ApiException.Transport> { api.sharedItem(ItemShareKind.SESSION, token) }
    }

    @Test
    fun `a revoked link is a 404`() = runTest {
        status = HttpStatusCode.NotFound
        val error = assertThrows<ApiException> { api.sharedItem(ItemShareKind.EVENT, "AAAAAAAAAAAAAAAAAAAAAA") }
        assertTrue(error.isNotFound)
    }
}
