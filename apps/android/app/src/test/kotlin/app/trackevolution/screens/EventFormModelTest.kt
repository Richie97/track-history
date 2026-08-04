package app.trackevolution.screens

import app.trackevolution.core.api.ApiClient
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    private fun api(): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val body = when {
                request.url.encodedPath.endsWith("/tracks") -> "[]"
                request.url.encodedPath.endsWith("/catalog") -> "[]"
                request.url.encodedPath.endsWith("/vehicles") -> "[]"
                else -> """{"id":42}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
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
}
