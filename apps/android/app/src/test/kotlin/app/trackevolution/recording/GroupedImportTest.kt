package app.trackevolution.recording

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.TraceSample
import app.trackevolution.core.TrackLocate
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.telemetry.ParsedLap
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.videoimport.ImportedClip
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CopyOnWriteArrayList

/**
 * NS-57: an import with no event picked. The matching itself is
 * `TrackLocateTest`'s job in `:core`; what is asserted here is what the phone
 * *does* with it — which cards it shows, and the requests a save sends, in
 * order: `POST /events` for a new group, then its sessions, never a second
 * event on a retry, and nothing at all for a place nobody has named.
 */
@RunWith(RobolectricTestRunner::class)
class GroupedImportTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val posted = CopyOnWriteArrayList<Pair<String, String>>()

    /** Session posts to fail with a 500, counted down. */
    private var failSessions = 0

    private fun api(tracks: String = "[]", events: String = "[]"): ApiClient {
        var nextEvent = 900
        var nextSession = 500
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val post = request.method == HttpMethod.Post
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            if (post) posted.add(path to (request.body as TextContent).text)
            when {
                post && path.matches(Regex(".*/events/\\d+/sessions$")) -> if (failSessions > 0) {
                    failSessions--
                    respond("""{"error":"Server is down"}""", HttpStatusCode.InternalServerError, json)
                } else {
                    respond("""{"id":${nextSession++}}""", HttpStatusCode.OK, json)
                }
                post && path.endsWith("/events") -> respond("""{"id":${nextEvent++}}""", HttpStatusCode.OK, json)
                path.endsWith("/tracks") -> respond(tracks, HttpStatusCode.OK, json)
                path.endsWith("/catalog") -> respond(CATALOG, HttpStatusCode.OK, json)
                path.endsWith("/events") -> respond(events, HttpStatusCode.OK, json)
                path.endsWith("/vehicles") -> respond(VEHICLES, HttpStatusCode.OK, json)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, json)
            }
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    /** A closed circle of [lengthM], as a stored best-lap trace. */
    private fun circle(lengthM: Double): List<TraceSample> {
        val r = lengthM / (2 * Math.PI)
        return (0 until 120).map { i ->
            val a = 2 * Math.PI * i / 120
            TraceSample(r * Math.sin(a), r * Math.cos(a), 40.0)
        }
    }

    /** A file that arrived with its laps: driven at [at], a lap [lengthM] long. */
    private fun timed(file: String, date: String, time: String, at: TraceGeo, lengthM: Double, lapMs: Int = 120_000) = ImportedClip(
        file = file,
        parsed = ParsedTelemetry(
            kind = ParsedTelemetry.Kind.PDR,
            date = date,
            time = time,
            durationS = 600.0,
            laps = listOf(ParsedLap(timeMs = lapMs, estimated = false), ParsedLap(timeMs = lapMs + 900, estimated = false)),
            bestLapTrace = circle(lengthM),
            traceGeo = at,
        ),
    )

    /** A 3 km oval at [VIR], driven clockwise at 10 Hz from [leadM] before its top. */
    private fun drive(laps: Int, leadM: Double): List<GpsPoint> {
        val length = 3000.0
        val r = length / (2 * Math.PI)
        val out = mutableListOf<GpsPoint>()
        var i = 0
        while (i * 4.0 <= laps * length + 400) {
            val a = (i * 4.0 - leadM) / length * 2 * Math.PI
            out.add(GpsPoint(i * 0.1, VIR.lat + 0.6 * r * Math.cos(a) / GeoTrace.KY, VIR.lon + r * Math.sin(a) / GeoTrace.KX(VIR.lat), 40.0))
            i++
        }
        return out
    }

    private fun await(what: String, until: () -> Boolean) = runBlocking {
        withTimeout(15_000) { while (!until()) delay(5) }
    }

    private fun body(i: Int) = Json.parseToJsonElement(posted[i].second).jsonObject

    @Test
    fun `a weekend at a catalog track becomes one event, and an unknown place waits for a name`() {
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        flow.beginImport(
            listOf(
                timed("sat.mp4", "2026-03-14", "10:00", VIR, 5200.0),
                timed("sun.mp4", "2026-03-15", "09:00", VIR, 5210.0),
                timed("farm.mp4", "2026-06-20", "11:00", TraceGeo(10.0, 10.0), 2500.0),
            ),
            preferredEventId = null,
            auto = true,
        )
        await("the cards") { flow.state.value.placesLoaded && flow.state.value.groups.isNotEmpty() }

        var state = flow.state.value
        assertTrue(state.auto)
        assertFalse("a grouped review never offers the one-event fallback", state.offersNewEvent)
        assertEquals(2, state.groups.size)
        val vir = state.groups[0]
        assertEquals("Virginia International Raceway (Full)", vir.track?.name)
        assertEquals(TrackLocate.Confidence.EXACT, vir.confidence)
        assertEquals("2026-03-14" to 2, vir.start to vir.days)
        assertEquals(listOf(0, 1), vir.itemIds)
        assertNull("nothing known is there, so nothing is guessed", state.groups[1].track)
        assertEquals(1, state.saveableGroups.size)

        flow.save(context)
        await("the first save") { !flow.state.value.saving && flow.state.value.savedGroups.isNotEmpty() }

        // The event first, then its sessions, in date order — and nothing for the place with no name.
        assertEquals(listOf("/api/events", "/api/events/900/sessions", "/api/events/900/sessions"), posted.map { it.first })
        val event = body(0)
        assertEquals("Virginia International Raceway (Full)", event["track_name"]!!.jsonPrimitive.content)
        assertEquals("2026-03-14", event["start_date"]!!.jsonPrimitive.content)
        assertEquals(2.0, event["days"]!!.jsonPrimitive.double, 0.0)
        assertEquals("the default car", "Corvette", event["car"]!!.jsonPrimitive.content)
        assertEquals("PDR 10:00", body(1)["label"]!!.jsonPrimitive.content)

        state = flow.state.value
        assertFalse("one card is still unanswered, so the review stays", flow.saved.value)
        assertEquals(listOf(900, 900, null), state.items.map { it.savedTo })
        assertEquals(1, state.groups.size)
        assertFalse(state.canSave)

        // Named once; saved as a new track's event.
        flow.chooseTrack(state.groups[0].key, " The Farm ")
        state = flow.state.value
        assertEquals(TrackLocate.GroupTrack(TrackLocate.Source.NEW, null, "The Farm"), state.groups[0].track)
        flow.save(context)
        runBlocking { withTimeout(15_000) { flow.saved.first { it } } }
        assertEquals("/api/events", posted[3].first)
        assertEquals("The Farm", body(3)["track_name"]!!.jsonPrimitive.content)
        assertEquals("/api/events/901/sessions", posted[4].first)
        assertNull("several events: the dashboard, not one of them", flow.savedEventId)
    }

    @Test
    fun `a file from a day already logged joins that event`() {
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api(tracks = OWN_TRACKS, events = EVENTS))
        flow.beginImport(listOf(timed("sat.mp4", "2026-03-14", "10:00", VIR, 5235.0)), preferredEventId = null, auto = true)
        await("the cards") { flow.state.value.groups.isNotEmpty() }
        val group = flow.state.value.groups.single()
        assertEquals(7, group.eventId)
        assertEquals(TrackLocate.Source.OWN, group.track?.source)

        flow.save(context)
        runBlocking { withTimeout(15_000) { flow.saved.first { it } } }
        assertEquals("no event is created for one that exists", listOf("/api/events/7/sessions"), posted.map { it.first })
        assertEquals("one event: the review lands on it", 7, flow.savedEventId)
    }

    @Test
    fun `a session that fails is retried onto the event already made, never a second one`() {
        failSessions = 1
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        flow.beginImport(listOf(timed("sat.mp4", "2026-03-14", "10:00", VIR, 5200.0)), preferredEventId = null, auto = true)
        await("the cards") { flow.state.value.groups.isNotEmpty() }
        val key = flow.state.value.groups.single().key

        flow.save(context)
        await("the failure") { flow.state.value.groupErrors.isNotEmpty() && !flow.state.value.saving }
        assertEquals("Server is down", flow.state.value.groupErrors[key])
        assertFalse(flow.saved.value)
        assertEquals("the card is still there to retry", 1, flow.state.value.groups.size)

        flow.save(context)
        runBlocking { withTimeout(15_000) { flow.saved.first { it } } }
        assertEquals(
            listOf("/api/events", "/api/events/900/sessions", "/api/events/900/sessions"),
            posted.map { it.first },
        )
        assertTrue(flow.state.value.groupErrors.isEmpty())
    }

    @Test
    fun `a venue the driver has timed before needs no line picked`() {
        // The first day: a picked line, and what the server reads back off the stored lap.
        val day1 = drive(4, 700.0)
        val trace1 = GeoTrace.projectTrace(day1)
        val gate1 = GeoTrace.buildGate(trace1, 200)!!
        val stored = GeoTrace.bestLapTrace(trace1, gate1)!!
        val p0 = stored[0]
        val next = stored.first { Math.hypot(it.x - p0.x, it.y - p0.y) >= 15 }
        val heading = (Math.atan2(next.x - p0.x, next.y - p0.y) * 180 / Math.PI + 360) % 360
        val origin = GeoTrace.traceOrigin(day1)!!
        val place = TrackLocate.recordingPlace(stored, origin, null)!!
        val tracks = """
            [{"id":3,"name":"The Oval","catalog_id":null,"updated_at":1,"event_count":1,"track_days":1,"series":[],
              "geo":{"lat":${place.lat},"lon":${place.lon},"length_m":${Math.round(place.lengthM!!)},
                     "sf":{"lat":${origin.lat + p0.y / GeoTrace.KY},"lon":${origin.lon + p0.x / GeoTrace.KX(origin.lat)},"heading":$heading}}}]
        """

        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api(tracks = tracks))
        val gopro = ImportedClip(
            file = "day2.mp4",
            parsed = ParsedTelemetry(kind = ParsedTelemetry.Kind.GOPRO, date = "2026-04-11", time = "09:00", durationS = 500.0, gps = drive(5, 1900.0), needsLine = true),
        )
        flow.beginImport(listOf(gopro), preferredEventId = null, auto = true)
        assertEquals("one venue, one picker", 1, flow.state.value.venuePickers.size)
        await("the cards") { flow.state.value.groups.isNotEmpty() }

        val state = flow.state.value
        assertEquals("The Oval", state.venuePickers.single().lineFrom)
        assertNull("nobody tapped the map", state.venuePickers.single().pickedIndex)
        assertEquals(4, state.items.single().laps.size)
        assertTrue(state.items.single().include)
        val group = state.groups.single()
        assertEquals(TrackLocate.GroupTrack(TrackLocate.Source.OWN, 3, "The Oval"), group.track)
        assertEquals(TrackLocate.Confidence.EXACT, group.confidence)

        // The driver's own line replaces it, and says so no longer.
        flow.pickVenue(0, 300)
        assertNull(flow.state.value.venuePickers.single().lineFrom)
        assertEquals(300, flow.state.value.venuePickers.single().pickedIndex)
    }

    private companion object {
        val VIR = TraceGeo(36.5617, -79.2047)

        const val CATALOG = """
            [{"id":1,"name":"Virginia International Raceway (Full)","lat":36.5617,"lon":-79.2047,"length_m":5262},
             {"id":2,"name":"Virginia International Raceway (North)","lat":36.5655,"lon":-79.2055,"length_m":3621}]
        """
        const val VEHICLES = """
            [{"id":1,"name":"Corvette","notes":null,"is_default":1,"updated_at":1}]
        """
        const val OWN_TRACKS = """
            [{"id":13,"name":"VIR full course","catalog_id":null,"updated_at":1,"event_count":1,"track_days":2,"series":[],
              "geo":{"lat":36.5618,"lon":-79.2046,"length_m":5230,"sf":null}}]
        """
        const val EVENTS = """
            [{"id":7,"track_id":13,"track_name":"VIR full course","start_date":"2026-03-14","days":2,
              "lap_count":0,"session_count":0,"hours":2,"updated_at":1}]
        """
    }
}
