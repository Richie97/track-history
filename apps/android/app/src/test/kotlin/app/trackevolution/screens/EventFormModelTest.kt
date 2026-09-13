package app.trackevolution.screens

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.SessionDraft
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The event form's one irreversible rule.
 *
 * A track name **carries the layout** — "Virginia International Raceway (Full)"
 * against "(Patriot)" — and the server finds-or-creates by name with `COLLATE
 * NOCASE`. Normalising case or punctuation on the client would merge two
 * layouts' personal bests into one, silently, with no undo.
 *
 * So this asserts the name reaching the wire is byte-identical to what was
 * typed, outer whitespace aside. It drives the real `ApiClient` through
 * `MockEngine` rather than testing a helper, because the claim is about the
 * bytes that would actually be sent.
 */
class EventFormModelTest {

    // Ktor's client runs on its own dispatcher, so requests land from another
    // thread — a plain ArrayList would be a data race rather than a test.
    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    /** Paths whose POST should fail with the given status, consumed on first use. */
    private val failNext = java.util.concurrent.ConcurrentHashMap<String, Int>()

    private fun api(): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            failNext.remove(path)?.let { status ->
                return@MockEngine respond(
                    """{"error":"nope"}""",
                    HttpStatusCode.fromValue(status),
                    headersOf(HttpHeaders.ContentType, "application/json"),
                )
            }
            val body = when {
                path.endsWith("/tracks") -> "[]"
                path.endsWith("/catalog") -> "[]"
                path.endsWith("/vehicles") -> "[]"
                path.endsWith("/sessions") -> """{"id":501}"""
                else -> """{"id":42}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    /** Every POST so far, in order, once [count] have arrived (or the model has settled on an error). */
    private fun awaitPosts(model: EventFormModel, count: Int): List<HttpRequestData> = runBlocking {
        withTimeout(5_000) {
            while (sent.count { it.method.value == "POST" } < count && (model.saving || model.error == null)) delay(5)
            while (model.saving) delay(5)
        }
        sent.filter { it.method.value == "POST" }
    }

    private fun bodyOf(request: HttpRequestData) =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    /**
     * Real dispatchers rather than virtual time: the HTTP call runs on the
     * client's own dispatcher, which a `TestScope` scheduler does not drive, so
     * `advanceUntilIdle` would return before anything had been sent.
     */
    private fun trackNameSentFor(typed: String): String = runBlocking {
        val model = EventFormModel(CoroutineScope(Dispatchers.Default), api())
        model.trackName = typed
        model.save()
        val post = withTimeout(5_000) {
            var found = sent.firstOrNull { it.method.value == "POST" }
            while (found == null) {
                delay(5)
                found = sent.firstOrNull { it.method.value == "POST" }
            }
            found
        }
        bodyOf(post)["track_name"]!!.jsonPrimitive.content
    }

    @Test
    fun `sends a layout-qualified name exactly as typed`() {
        assertEquals(
            "Virginia International Raceway (Full)",
            trackNameSentFor("Virginia International Raceway (Full)"),
        )
    }

    @Test
    fun `never normalises case`() {
        // The server matches NOCASE, so this still finds the same track — but
        // rewriting what the user typed is not the client's call.
        assertEquals("vir (patriot)", trackNameSentFor("vir (patriot)"))
    }

    @Test
    fun `trims only the outer whitespace, and nothing inside`() {
        assertEquals("Road  Atlanta", trackNameSentFor("  Road  Atlanta  "))
    }

    @Test
    fun `keeps punctuation that distinguishes layouts`() {
        assertEquals("Watkins Glen — The Boot", trackNameSentFor("Watkins Glen — The Boot"))
    }

    // ---- validation --------------------------------------------------------

    @Test
    fun `refuses an unparseable best time before sending anything`() {
        // Validation is synchronous, so nothing needs awaiting: the point is
        // that save() returns having sent no request at all.
        val model = EventFormModel(CoroutineScope(Dispatchers.Default), api())
        model.trackName = "VIR"
        model.bestTime = "nonsense"
        model.save()

        assertNotNull(model.error)
        assertEquals(
            "Couldn't parse best time \"nonsense\" — use 2:01.24 format.",
            model.error,
        )
        assertNull(sent.firstOrNull { it.method.value == "POST" })
    }

    @Test
    fun `refuses a blank track name`() {
        val model = EventFormModel(CoroutineScope(Dispatchers.Default), api())
        model.trackName = "   "
        model.save()

        assertEquals("A track name is required.", model.error)
        assertNull(sent.firstOrNull { it.method.value == "POST" })
    }

    // ---- the "Add laps" section --------------------------------------------

    /**
     * The event first, then its sessions — staged imports in the order they
     * were staged, then the hand-typed one — every one of them onto the id
     * `POST /events` answered with.
     */
    @Test
    fun `creates the event and then posts the staged and typed sessions onto it, in order`() {
        val model = EventFormModel(CoroutineScope(Dispatchers.Default), api())
        model.trackName = "VIR (Full)"
        model.stage(listOf(SessionDraft(label = "PDR 09:15:00", laps = listOf(121240, 120100))))
        model.stage(listOf(SessionDraft(label = "GoPro 10:30:00", laps = listOf(119900))))
        model.sessionLabel = " Day 1 — Session 3 "
        model.sessionLaps = "2:03.55\n2:01.24"
        model.sessionNotes = "traffic"
        model.save()

        val posts = awaitPosts(model, 4)
        assertEquals(listOf("/api/events", "/api/events/42/sessions", "/api/events/42/sessions", "/api/events/42/sessions"), posts.map { it.url.encodedPath })
        assertEquals("PDR 09:15:00", bodyOf(posts[1])["label"]!!.jsonPrimitive.content)
        assertEquals("GoPro 10:30:00", bodyOf(posts[2])["label"]!!.jsonPrimitive.content)
        val typed = bodyOf(posts[3])
        assertEquals("Day 1 — Session 3", typed["label"]!!.jsonPrimitive.content)
        assertEquals("traffic", typed["notes"]!!.jsonPrimitive.content)
        assertEquals(listOf(123550, 121240), typed["laps"]!!.jsonArray.map { it.jsonPrimitive.content.toInt() })
        assertEquals(42, model.savedId)
        assertNull(model.error)
        assertEquals(emptyList<SessionDraft>(), model.stagedSessions)
    }

    /** No laps typed and nothing staged: exactly the request the form has always sent. */
    @Test
    fun `posts no session when the laps section is empty`() {
        val model = EventFormModel(CoroutineScope(Dispatchers.Default), api())
        model.trackName = "VIR"
        model.sessionLabel = "Only a label"
        model.sessionLaps = "not a lap time"
        model.save()

        val posts = awaitPosts(model, 1)
        assertEquals(listOf("/api/events"), posts.map { it.url.encodedPath })
        assertEquals(42, model.savedId)
    }

    /**
     * A session the server refuses leaves the form up — with the event already
     * created, remembered, and *not* created again on the retry. The two
     * sessions that got through are not posted twice either.
     */
    @Test
    fun `a rejected session keeps the created event id and the next save retries only the sessions`() {
        val model = EventFormModel(CoroutineScope(Dispatchers.Default), api())
        model.trackName = "VIR"
        model.stage(listOf(SessionDraft(label = "first", laps = listOf(100000))))
        model.stage(listOf(SessionDraft(label = "second", laps = listOf(100001))))
        failNext["/api/events/42/sessions"] = 400
        model.save()

        var posts = awaitPosts(model, 2)
        assertEquals(listOf("/api/events", "/api/events/42/sessions"), posts.map { it.url.encodedPath })
        assertNotNull(model.error)
        assertTrue(model.error!!.startsWith("The event was created, but a session couldn't be added"))
        assertNull("the form stays up", model.savedId)
        assertEquals(42, model.createdId)
        assertEquals(listOf("first", "second"), model.stagedSessions.map { it.label })

        model.save()
        posts = awaitPosts(model, 4)
        assertEquals(
            listOf("/api/events", "/api/events/42/sessions", "/api/events/42/sessions", "/api/events/42/sessions"),
            posts.map { it.url.encodedPath },
        )
        assertEquals("first", bodyOf(posts[2])["label"]!!.jsonPrimitive.content)
        assertEquals("second", bodyOf(posts[3])["label"]!!.jsonPrimitive.content)
        assertEquals(42, model.savedId)
        assertNull(model.error)
    }
}
