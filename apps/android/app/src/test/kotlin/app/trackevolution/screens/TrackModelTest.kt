package app.trackevolution.screens

import app.trackevolution.core.api.ApiClient
import app.trackevolution.ui.LoadState
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The track page's two claims that are easy to get quietly wrong.
 *
 * **"Dry only" hides events known not to be dry, and keeps unlabelled ones.**
 * The other reading — keep only events explicitly marked dry — silently drops
 * every event logged before conditions were recorded, which for a real logbook
 * is most of its history, and the personal best moves with it.
 *
 * **The goal wording is the web app's**, because it has been read at a track for
 * a couple of seasons and "0.8s to goal" is what it says.
 */
class TrackModelTest {

    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    /** One track, four events: dry, wet, unlabelled, and a second dry one. */
    private fun api(): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/tracks") -> TRACKS
                path.endsWith("/events") -> EVENTS
                path.endsWith("/me") -> ME
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    /**
     * Real dispatchers, like `EventFormModelTest`: the HTTP call runs on the
     * client's own dispatcher, which a `TestScope` scheduler never drives.
     */
    private fun loaded(): TrackModel = runBlocking {
        val model = TrackModel(CoroutineScope(Dispatchers.Default), api(), trackId = 1)
        model.load()
        withTimeout(5_000) {
            while (model.state != LoadState.Ready) delay(5)
        }
        model
    }

    @Test
    fun `dry only hides wet events and keeps unlabelled history`() {
        val model = loaded()
        assertEquals(4, model.events.size)
        assertTrue(model.hasWetData)

        model.dryOnly = true
        assertEquals(
            listOf("2026-05-01", "2026-03-01", "2026-01-01"),
            model.events.map { it.startDate },
        )
    }

    @Test
    fun `the personal best follows the filter`() {
        val model = loaded()
        // The outright best was set in the wet. Filtering it out has to move the
        // headline number too, or the page claims a dry PB it doesn't have.
        assertEquals(118_000, model.personalBest)
        model.dryOnly = true
        assertEquals(119_500, model.personalBest)
    }

    @Test
    fun `the dry toggle is only offered when something was logged as not dry`() {
        val model = loaded()
        assertTrue(model.hasWetData)
    }

    @Test
    fun `chart points are chronological and spaced by real time`() {
        val model = loaded()
        val points = model.chartPoints
        // The server returns newest first; a progress chart that plots them in
        // that order reads as a driver getting slower.
        assertEquals(listOf("120.0", "119.5", "118.0", "121.0"), points.map { (it.ms / 1000.0).toString() })
        // Jan 1 → Mar 1 is 59 days; Mar 1 → Apr 1 is 31. Ordinal spacing would
        // make both 1.
        assertEquals(59.0, points[1].x - points[0].x, 0.0)
        assertEquals(31.0, points[2].x - points[1].x, 0.0)
    }

    @Test
    fun `a beaten goal says by how much`() {
        val model = loaded()
        // Goal 1:59.000, best 1:58.000.
        assertEquals("Goal beaten by 1s ✓", model.goalStatus?.text)
        assertTrue(model.goalStatus!!.met)
    }

    @Test
    fun `an unbeaten goal says how far off it is`() {
        val model = loaded()
        model.dryOnly = true
        assertEquals("+0.5s to goal", model.goalStatus?.text)
        assertFalse(model.goalStatus!!.met)
    }

    @Test
    fun `an unparseable goal is refused before anything is sent`() {
        val model = loaded()
        sent.clear()
        model.goalText = "nonsense"
        model.saveGoal()

        assertEquals("Couldn't parse \"nonsense\" — use 1:59.0", model.writeError)
        assertNull(sent.firstOrNull { it.method.value == "PUT" })
    }

    @Test
    fun `notes are only savable once they differ from the server's copy`() {
        val model = loaded()
        assertFalse(model.notesChanged)
        model.notes = "T1: brake at the 300 board"
        assertTrue(model.notesChanged)
    }

    @Test
    fun `there is no share link until a slug exists`() = runBlocking {
        val model = loaded()
        withTimeout(5_000) {
            while (model.shareSlug == null) delay(5)
        }
        assertEquals(
            "https://example.test/share/eric#/track/1",
            model.shareUrl("https://example.test"),
        )
    }

    private companion object {
        const val TRACKS = """
            [{"id":1,"name":"VIR (Full)","goal_ms":119000,"notes":null,"catalog_id":null,
              "updated_at":1,"event_count":4,"track_days":6,"best_ms":118000,
              "last_date":"2026-05-01","series":[]}]
        """

        /** Newest first, the way `listEvents` returns them. */
        const val EVENTS = """
            [{"id":4,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-05-01","days":2,
              "conditions":"dry","best_ms":121000,"lap_count":10,"session_count":2,
              "consistency":0.021,"hours":4,"updated_at":4},
             {"id":3,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-04-01","days":1,
              "conditions":"wet","best_ms":118000,"lap_count":8,"session_count":1,
              "consistency":0.03,"hours":2,"updated_at":3},
             {"id":2,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-03-01","days":2,
              "best_ms":119500,"lap_count":12,"session_count":2,"consistency":0.018,
              "hours":4,"updated_at":2},
             {"id":1,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-01-01","days":1,
              "conditions":"dry","best_ms":120000,"lap_count":6,"session_count":1,
              "consistency":0.025,"hours":2,"updated_at":1}]
        """

        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":4,"track_days":6}}
        """
    }
}
