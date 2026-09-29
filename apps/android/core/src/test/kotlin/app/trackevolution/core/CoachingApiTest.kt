package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.DriverProfile
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.SessionDraft
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
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * Share with a coach (NS-38) at the API client: the coach mount's prefix, the
 * write refusal, the offline purge, and the tier the channel gates read.
 */
class CoachingApiTest {

    private val store = OfflineStore(InMemoryOfflinePersistence())
    private val requests = mutableListOf<String>()
    private val bodies = mutableListOf<String>()
    private var online = true
    private var profileStatus = HttpStatusCode.OK

    private val root: ApiClient = ApiClient(
        MockEngine { request ->
            requests += "${request.method.value} ${request.url.encodedPath}"
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            val path = request.url.encodedPath.takeIf { request.method.value == "GET" } ?: "write"
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when {
                path.endsWith("/me/profile") && profileStatus != HttpStatusCode.OK ->
                    respond("""{"error":"not found"}""", profileStatus, json)
                path.endsWith("/me/profile") -> respond(Goldens.bodyText("student-profile"), HttpStatusCode.OK, json)
                path.endsWith("/events") -> respond(Goldens.bodyText("student-events"), HttpStatusCode.OK, json)
                path.contains("/coaching/invites/") -> respond(Goldens.bodyText("coaching-invite-preview"), HttpStatusCode.OK, json)
                else -> respond("""{"ok":true,"id":1}""", HttpStatusCode.OK, json)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
        offline = store,
    )

    private val student = root.forOwner(LogbookOwner.Student(id = 7, name = "Alex", pro = true))

    @Test
    fun `a student's reads go through the coach mount and are cached under its prefix`() = runTest {
        student.events()
        assertEquals(listOf("GET /api/students/7/events"), requests)
        assertEquals(Goldens.bodyText("student-events"), store.cachedGet("/students/7/events"))
        // The coach's own logbook is a different key, and untouched.
        assertNull(store.cachedGet("/events"))
    }

    @Test
    fun `the account's own client is unchanged, and asking for Me hands it back`() = runTest {
        assertTrue(root.forOwner(LogbookOwner.Me) === root)
        root.events()
        assertEquals(listOf("GET /api/events"), requests)
    }

    @Test
    fun `every write under the prefix is refused before it is sent — online or not, queue or no queue`() = runTest {
        assertThrows<ApiException.ReadOnly> { student.updateEvent(1, EventPatch()) }
        assertThrows<ApiException.ReadOnly> { student.createSession(1, SessionDraft(laps = listOf(90_000))) }
        assertThrows<ApiException.ReadOnly> { student.deleteLap(3) }
        assertThrows<ApiException.ReadOnly> { student.updateProfile(null) }

        // Offline, and with the coach's own writes already queued — the two
        // conditions under which an owner's write would be queued.
        online = false
        root.deleteLap(99)
        assertEquals(1, store.pendingCount())
        assertThrows<ApiException.ReadOnly> { student.deleteLap(3) }
        assertThrows<ApiException.ReadOnly> { student.appendLaps(4, listOf(90_000)) }

        assertTrue(requests.none { it.contains("/students/") && !it.startsWith("GET") }, requests.toString())
        assertEquals(1, store.pendingCount())
        assertTrue(store.queuedWrites().none { it.path.contains("students") })
    }

    @Test
    fun `offline, a student's read falls back to their own cached copy`() = runTest {
        val live = student.events()
        online = false
        assertEquals(live, student.events())
    }

    @Test
    fun `a 404 from the student's profile is a status, and forgetting them purges the prefix`() = runTest {
        student.events()
        root.events()
        profileStatus = HttpStatusCode.NotFound
        val error = assertThrows<ApiException> { student.profile() }
        assertTrue(error.isNotFound)
        root.forgetStudent(7)
        assertNull(store.cachedGet("/students/7/events"))
        assertEquals(Goldens.bodyText("student-events"), store.cachedGet("/events"))
    }

    @Test
    fun `the invite preview reads past the cache, and a profile clear sends an explicit null`() = runTest {
        root.coachInvite("abc")
        assertFalse(store.cachedKeys().any { it.contains("invites") })
        root.updateProfile(null)
        assertEquals("""{"profile":null}""", bodies.last())
        root.updateProfile(DriverProfile(occupation = "Pilot"))
        assertEquals("""{"profile":{"occupation":"Pilot"}}""", bodies.last())
        assertTrue(requests.contains("PUT /api/me/profile"))
    }

    @Test
    fun `the channel gates read the student's tier, never the viewer's`() {
        val free = Entitlement.FREE
        val pro = Entitlement(tier = Entitlement.Tier.PRO)
        // A free coach of a Pro student sees the full panel…
        assertTrue(Entitlement.canViewChannels(LogbookOwner.Student(1, "A", pro = true).entitlement(free)))
        assertTrue(Entitlement.canViewChannel(LogbookOwner.Student(1, "A", pro = true).entitlement(free), "latG"))
        // …and a Pro coach of a free student sees the free half, as the student does.
        assertFalse(Entitlement.canViewChannels(LogbookOwner.Student(1, "A", pro = false).entitlement(pro)))
        // Their own logbook is their own tier.
        assertFalse(Entitlement.canViewChannels(LogbookOwner.Me.entitlement(free)))
        assertTrue(Entitlement.canViewChannels(LogbookOwner.Me.entitlement(pro)))
        assertTrue(LogbookOwner.Student(1, null, false).readOnly)
        assertFalse(LogbookOwner.Me.readOnly)
    }
}
