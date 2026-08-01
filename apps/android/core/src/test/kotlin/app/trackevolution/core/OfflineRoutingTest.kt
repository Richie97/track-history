package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.model.TrackPatch
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * [ApiClient] with an [OfflineStore] behind it — the seam where "the app works in
 * a paddock" is actually decided.
 *
 * There is deliberately no second path to the server for a screen to take, so
 * these cases are the whole contract: reads are network-first and fall back to
 * the cache only when the *network* failed, and a queueable write with nowhere to
 * go becomes a queue entry plus a synthetic response rather than an error.
 */
class OfflineRoutingTest {

    private val store = OfflineStore(InMemoryOfflinePersistence())
    private val requests = mutableListOf<String>()
    private var online = true

    private fun client(
        handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): ApiClient {
        val engine = MockEngine { request ->
            val query = request.url.encodedQuery
            requests += buildString {
                append(request.method.value)
                append(' ')
                append(request.url.encodedPath)
                if (query.isNotEmpty()) append("?").append(query)
            }
            if (!online) throw IOException("Unable to resolve host")
            handler(request)
        }
        return ApiClient(
            engine,
            baseUrl = "https://example.test",
            tokens = StaticToken("tok"),
            offline = store,
        )
    }

    private fun MockRequestHandleScope.respondJson(
        body: String,
        status: HttpStatusCode = HttpStatusCode.OK,
    ): HttpResponseData = respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    // ---- reads ------------------------------------------------------------

    @Test
    fun `a successful read fills the cache`() = runTest {
        val api = client { respondJson(Goldens.bodyText("events-list")) }
        api.events()
        assertEquals(Goldens.bodyText("events-list"), store.cachedGet("/events"))
    }

    @Test
    fun `a network failure falls back to the cache`() = runTest {
        val api = client { respondJson(Goldens.bodyText("events-list")) }
        val fresh = api.events()

        online = false
        val cached = api.events()

        assertEquals(fresh, cached)
        assertTrue(store.syncStatus.value.offline)
    }

    @Test
    fun `a server error does not fall back to the cache`() = runTest {
        var status = HttpStatusCode.OK
        val api = client { respondJson(if (status == HttpStatusCode.OK) Goldens.bodyText("events-list") else """{"error":"boom"}""", status) }
        api.events()

        // A 500 is an answer, and answering from a stale cache would hide it.
        status = HttpStatusCode.InternalServerError
        val error = assertThrows<ApiException> { api.events() }
        assertEquals(500, error.status)
    }

    @Test
    fun `a read with no cache and no network still fails`() = runTest {
        online = false
        val api = client { respondJson("{}") }
        assertThrows<ApiException.Transport> { api.events() }
    }

    @Test
    fun `a track-filtered list is served from the cached full list when offline`() = runTest {
        val api = client { respondJson(Goldens.bodyText("events-list")) }
        val all = api.events()
        val trackId = all.first().trackId

        online = false
        val filtered = api.events(trackId = trackId)
        assertEquals(all.filter { it.trackId == trackId }, filtered)
        // Never stored under its own key — derived from the full list on read.
        assertTrue("/events?track_id=$trackId" !in store.cachedKeys())
    }

    @Test
    fun `a read of a row created offline is served from the cache without asking the server`() = runTest {
        val api = client { respondJson("""[]""") }
        api.events()

        online = false
        val tempId = api.createEvent(EventDraft(startDate = "2026-05-01", trackName = "New Ring"))
        assertTrue(OfflineStore.isTemp(tempId))

        online = true
        requests.clear()
        val detail = api.event(tempId)
        assertEquals("New Ring", detail.event.trackName)
        // The server would 404 a negative id; it is never asked.
        assertEquals(emptyList<String>(), requests)
    }

    // ---- writes -----------------------------------------------------------

    @Test
    fun `a write with no network queues and reports a synthetic response`() = runTest {
        val api = client { respondJson("""[]""") }
        api.events()

        online = false
        val tempId = api.createEvent(EventDraft(startDate = "2026-05-01", trackName = "New Ring"))

        assertTrue(OfflineStore.isTemp(tempId))
        assertEquals(1, api.syncStatus.value.pending)
        assertTrue(api.syncStatus.value.offline)
    }

    @Test
    fun `a write that is not queueable still fails offline`() = runTest {
        val api = client { respondJson("""{"slug":"x"}""") }
        online = false
        // Share links, vehicles and garage parts need a live server answer, so
        // they fail with their normal error rather than pretending to succeed.
        assertThrows<ApiException.Transport> { api.shareSlug("my-logbook") }
        assertEquals(0, api.syncStatus.value.pending)
    }

    @Test
    fun `a queueable write queues while earlier writes are pending, even with a network`() = runTest {
        val api = client { respondJson("""{"ok":true}""") }
        online = false
        api.updateTrack(3, trackGoalPatch)
        online = true
        requests.clear()

        // Sending this directly would put it ahead of the write already waiting.
        api.updateEvent(10, EventPatch(notes = Patch.Set("wet")))
        assertEquals(emptyList<String>(), requests)
        assertEquals(2, api.syncStatus.value.pending)
    }

    @Test
    fun `a server rejection of a write is not queued`() = runTest {
        val api = client { respondJson("""{"error":"start_date required"}""", HttpStatusCode.BadRequest) }
        val error = assertThrows<ApiException> { api.createEvent(EventDraft(startDate = "")) }
        assertEquals(400, error.status)
        assertEquals(0, api.syncStatus.value.pending)
    }

    // ---- flush ------------------------------------------------------------

    @Test
    fun `flush replays through the client's own transport`() = runTest {
        val api = client { request ->
            when {
                request.method == HttpMethod.Get -> respondJson("""[]""")
                request.url.encodedPath.endsWith("/sessions") ->
                    respondJson("""{"id":43}""", HttpStatusCode.Created)
                else -> respondJson("""{"id":42}""", HttpStatusCode.Created)
            }
        }
        api.events()

        online = false
        val tempId = api.createEvent(EventDraft(startDate = "2026-05-01", trackName = "New Ring"))
        api.createSession(tempId, SessionDraft(label = "S1", laps = listOf(121_000)))
        assertEquals(2, api.syncStatus.value.pending)

        online = true
        requests.clear()
        val status = api.flushQueue()

        assertEquals(
            listOf("POST /api/events", "POST /api/events/42/sessions"),
            requests,
        )
        assertEquals(0, status?.pending)
        assertEquals(0, status?.failed)
        assertEquals(42, api.resolveTempId(tempId))
    }

    @Test
    fun `warming the cache re-fetches only the rows that changed`() = runTest {
        val detail = Goldens.bodyText("event-detail")
        val api = client { request ->
            if (request.url.encodedPath == "/api/events") {
                respondJson(Goldens.bodyText("events-list"))
            } else {
                respondJson(detail)
            }
        }
        val events = api.events()

        requests.clear()
        api.warmCache(events)
        val firstPass = requests.size
        assertTrue(firstPass > 0, "a cold cache has to fetch something")

        requests.clear()
        api.warmCache(events)
        // Every row's cached copy is now at the server's updated_at — nothing to do.
        assertEquals(emptyList<String>(), requests)
    }

    @Test
    fun `signing out leaves nothing behind`() = runTest {
        val api = client { respondJson("""[]""") }
        api.events()
        online = false
        api.createEvent(EventDraft(startDate = "2026-05-01", trackName = "New Ring"))

        api.clearOffline()

        assertEquals(emptyList<String>(), store.cachedKeys())
        assertEquals(0, api.syncStatus.value.pending)
    }

    /** Any queueable write will do here; this is the smallest one. */
    private val trackGoalPatch = TrackPatch(goalMs = Patch.Set(119_500))
}
