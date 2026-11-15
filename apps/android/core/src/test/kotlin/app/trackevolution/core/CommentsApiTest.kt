package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.EventPatch
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
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * Coach comments (NS-52) at the API client: the two roles' paths, the
 * read-only exception (a coach's comment goes out even from the student's
 * scoped view, every other write still refused), that no comment write is
 * ever queued, and that forgetting a student drops their thread's cache.
 */
class CommentsApiTest {

    private val store = OfflineStore(InMemoryOfflinePersistence())
    private val requests = mutableListOf<String>()
    private val bodies = mutableListOf<String>()
    private var online = true

    private val root: ApiClient = ApiClient(
        MockEngine { request ->
            val path = request.url.encodedPath
            requests += "${request.method.value} $path"
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when {
                path.endsWith("/comments/seen") -> respond(Goldens.bodyText("comments-seen"), HttpStatusCode.OK, json)
                path.startsWith("/api/coaching/students/") && request.method.value == "GET" ->
                    respond(Goldens.bodyText("comments-student-event"), HttpStatusCode.OK, json)
                path == "/api/coaching/comments" -> respond(Goldens.bodyText("comments-feed"), HttpStatusCode.OK, json)
                path.endsWith("/comments") && request.method.value == "GET" ->
                    respond(Goldens.bodyText("comments-event"), HttpStatusCode.OK, json)
                path.endsWith("/comments") -> respond(Goldens.bodyText("comment-create"), HttpStatusCode.Created, json)
                path.startsWith("/api/comments/") && request.method.value == "PUT" ->
                    respond(Goldens.bodyText("comment-update"), HttpStatusCode.OK, json)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, json)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
        offline = store,
    )

    private val alex = LogbookOwner.Student(id = 7, name = "Alex", pro = false)
    private val student = root.forOwner(alex)

    @Test
    fun `the owner reads, replies into a coach's thread and marks it read`() = runTest {
        val read = root.eventComments(LogbookOwner.Me, 3)
        assertNotNull(read.coaches)
        root.postComment(LogbookOwner.Me, 4, "Tried it", lapId = 41, distM = 1240, coachId = 2)
        root.markCommentsSeen(LogbookOwner.Me, 3)
        assertEquals(
            listOf("GET /api/events/3/comments", "POST /api/sessions/4/comments", "POST /api/events/3/comments/seen"),
            requests,
        )
        assertEquals("""{"body":"Tried it","lap_id":41,"dist_m":1240,"coach_id":2}""", bodies[0])
    }

    @Test
    fun `a coach comments from the student's scoped view, through the coach's own routes`() = runTest {
        student.eventComments(alex, 3)
        student.postComment(alex, 4, "Brake later", lapId = 41, distM = 1240, coachId = 99)
        student.postComment(alex, 4, "Good session")
        student.markCommentsSeen(alex, 3)
        assertEquals(
            listOf(
                "GET /api/coaching/students/7/events/3/comments",
                "POST /api/coaching/students/7/sessions/4/comments",
                "POST /api/coaching/students/7/sessions/4/comments",
                "POST /api/coaching/students/7/events/3/comments/seen",
            ),
            requests,
        )
        // coach_id is never the coach's to send: the server takes the caller.
        assertEquals("""{"body":"Brake later","lap_id":41,"dist_m":1240}""", bodies[0])
        assertEquals("""{"body":"Good session"}""", bodies[1])
        // …and every other write from that view is still refused unsent.
        assertThrows<ApiException.ReadOnly> { student.updateEvent(3, EventPatch()) }
        assertThrows<ApiException.ReadOnly> { student.deleteLap(41) }
        assertTrue(requests.none { it.contains("/students/7/") && !it.contains("/coaching/") })
    }

    @Test
    fun `a place without a lap is not sent`() = runTest {
        root.postComment(LogbookOwner.Me, 4, "x", lapId = null, distM = 100, coachId = 2)
        assertEquals("""{"body":"x","coach_id":2}""", bodies.single())
    }

    @Test
    fun `edit, delete and the feed`() = runTest {
        root.editComment(5, "Edited")
        student.deleteComment(5)
        val feed = root.commentFeed()
        assertTrue(feed.unread >= 0)
        assertEquals(listOf("PUT /api/comments/5", "DELETE /api/comments/5", "GET /api/coaching/comments"), requests)
        assertEquals("""{"body":"Edited"}""", bodies[0])
    }

    @Test
    fun `no comment write is queued offline — it fails, and the queue stays empty`() = runTest {
        online = false
        assertThrows<ApiException.Transport> { root.postComment(LogbookOwner.Me, 4, "x", coachId = 2) }
        assertThrows<ApiException.Transport> { student.postComment(alex, 4, "x") }
        assertThrows<ApiException.Transport> { root.editComment(5, "x") }
        assertThrows<ApiException.Transport> { root.deleteComment(5) }
        assertThrows<ApiException.Transport> { root.markCommentsSeen(LogbookOwner.Me, 3) }
        assertEquals(0, store.pendingCount())

        // Even behind a queued owner write, which makes a queueable write queue.
        root.deleteLap(99)
        assertEquals(1, store.pendingCount())
        assertThrows<ApiException.Transport> { root.postComment(LogbookOwner.Me, 4, "x", coachId = 2) }
        assertEquals(1, store.pendingCount())
        assertTrue(store.queuedWrites().none { it.path.contains("comments") })
    }

    @Test
    fun `reads are cached, and forgetting a student drops their thread too`() = runTest {
        student.eventComments(alex, 3)
        root.eventComments(LogbookOwner.Me, 3)
        online = false
        assertEquals(student.eventComments(alex, 3), student.eventComments(alex, 3))
        root.forgetStudent(7)
        assertNull(store.cachedGet("/coaching/students/7/events/3/comments"))
        assertFalse(store.cachedGet("/events/3/comments").isNullOrEmpty())
    }
}
