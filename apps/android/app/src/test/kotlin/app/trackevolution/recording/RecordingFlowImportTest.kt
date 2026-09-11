package app.trackevolution.recording

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.trackevolution.core.LineReview
import app.trackevolution.core.LocationFix
import app.trackevolution.core.RecorderCore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.telemetry.ByteArraySource
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.videoimport.ImportedClip
import app.trackevolution.videoimport.TelemetryImporter
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The review flow as the importer drives it: several clips, one picked line
 * applied to the ones that need it, and a `POST /events/:id/sessions` per
 * included clip carrying laps, the racing line and the per-lap channels.
 *
 * What is asserted here is the *shape of the request* the phone sends — the
 * parsers' correctness is `VideoContractTest`'s job in `:core`, and the flow's
 * job is to not lose anything between a parsed clip and the wire. The recording
 * case is here too, because generalising the flow gave a recorded session
 * per-lap channels for the first time, and that is worth pinning.
 */
@RunWith(RobolectricTestRunner::class)
class RecordingFlowImportTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val posted = CopyOnWriteArrayList<Pair<String, String>>()

    private fun api(): ApiClient {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                request.method == HttpMethod.Post && path.matches(Regex(".*/events/\\d+/sessions$")) -> {
                    posted.add(path to (request.body as TextContent).text)
                    """{"id":501}"""
                }
                path.endsWith("/events") -> EVENTS
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    private fun fixture(name: String): ByteArray {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, "package.json").isFile) dir = dir.parentFile
        return File(dir ?: error("repository root not found"), "contracts/logic/video/$name").readBytes()
    }

    private fun clip(name: String): ImportedClip =
        TelemetryImporter.parseOne(name) { ByteArraySource(fixture(name)) }

    private fun awaitSaved(flow: RecordingFlow) = runBlocking {
        withTimeout(15_000) { flow.saved.first { it } }
    }

    private fun awaitEvents(flow: RecordingFlow) = runBlocking {
        withTimeout(15_000) { while (flow.state.value.events.isEmpty()) delay(5) }
    }

    private fun body(i: Int) = Json.parseToJsonElement(posted[i].second).jsonObject

    @Test
    fun `imports a batch, applies one line to the clip that needs it, and posts what was included`() {
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        // A GoPro clip (needs a line) and a beacon-timed PDR clip (arrives with laps).
        flow.beginImport(TelemetryImporter.finish(listOf(clip("gopro.mp4"), clip("pdr-delta.mp4"))), preferredEventId = 7)
        awaitEvents(flow)

        var state = flow.state.value
        assertTrue(state.isImport)
        assertEquals(2, state.items.size)
        assertTrue("the GoPro trace goes to the picker", state.needsLinePick)
        val gopro = state.items.indexOfFirst { it.file == "gopro.mp4" }
        val pdr = state.items.indexOfFirst { it.file == "pdr-delta.mp4" }
        assertFalse("no laps yet, so not included yet", state.items[gopro].include)
        assertTrue("beacon laps are included from the start", state.items[pdr].include)
        assertEquals(listOf(47124, 47124), state.items[pdr].laps.map { it.timeMs })
        assertEquals("PDR 09:15:00", state.items[pdr].label)
        assertEquals("GoPro 09:15:00", state.items[gopro].label)
        assertEquals(7, state.selectedEventId)

        // The same pick the contract fixture records: a quarter lap in.
        flow.pick(118)
        state = flow.state.value
        assertNull(state.problem)
        assertEquals(listOf(47124, 47124, 47124), state.items[gopro].laps.map { it.timeMs })
        assertTrue("a pick that produced laps includes the clip", state.items[gopro].include)
        assertEquals(2, state.selectedCount)

        // Leave the PDR clip out; the choice is the driver's and sticks.
        flow.setInclude(pdr, false)
        flow.setLabel(gopro, "Morning session")
        flow.pick(118)
        assertFalse(flow.state.value.items[pdr].include)

        flow.save(context)
        awaitSaved(flow)

        assertEquals(1, posted.size)
        assertEquals("/api/events/7/sessions", posted[0].first)
        val draft = body(0)
        assertEquals("Morning session", draft["label"]!!.jsonPrimitive.content)
        assertEquals(
            "Imported from gopro.mp4 — lap times derived from GPS start/finish crossings (~±0.1–0.3s)",
            draft["notes"]!!.jsonPrimitive.content,
        )
        assertEquals(listOf(47124, 47124, 47124), draft["laps"]!!.jsonArray.map { it.jsonPrimitive.content.toInt() })
        assertTrue("the best lap's racing line", draft["trace"]!!.jsonArray.size > 10)
        val channels = draft["channels"]!!.jsonObject
        assertEquals(3, channels["laps"]!!.jsonArray.size)
        assertEquals(20.0, channels["dStepM"]!!.jsonPrimitive.content.toDouble(), 0.0)
        assertEquals(7, flow.savedEventId)
    }

    @Test
    fun `a PDR clip with beacons needs no line and posts its car channels`() {
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        flow.beginImport(TelemetryImporter.finish(listOf(clip("pdr-delta.mp4"))), preferredEventId = 7)
        awaitEvents(flow)
        assertFalse("beacon-timed laps skip the picker", flow.state.value.needsLinePick)
        assertTrue(flow.state.value.canSave)

        flow.save(context)
        awaitSaved(flow)

        val draft = body(0)
        val lap = draft["channels"]!!.jsonObject["laps"]!!.jsonArray[0].jsonObject
        for (name in listOf("speed", "rpm", "latG", "throttle", "brake", "steering")) {
            assertTrue("$name is carried", lap[name]!!.jsonArray.size > 80)
        }
        assertTrue(draft["notes"]!!.jsonPrimitive.content.startsWith("Imported from pdr-delta.mp4 — top speed "))
    }

    @Test
    fun `a clip that yielded nothing is listed by name and cannot be saved`() {
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        val broken = ImportedClip(file = "dashcam.mp4", parsed = null, error = "No PDR or GoPro telemetry in this video")
        flow.beginImport(TelemetryImporter.finish(listOf(broken)), preferredEventId = 7)
        val state = flow.state.value
        assertEquals("dashcam.mp4", state.items.single().file)
        assertEquals("No PDR or GoPro telemetry in this video", state.items.single().error)
        assertFalse(state.canSave)
        assertFalse(state.needsLinePick)
    }

    @Test
    fun `a stationary pick is named rather than silently yielding nothing`() {
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        val gopro = clip("gopro.mp4")
        // Park the car: every fix at the same spot has no heading to build a gate across.
        val parked = gopro.parsed!!.let { p -> p.copy(gps = p.gps!!.map { it.copy(lat = p.gps!![0].lat, lon = p.gps!![0].lon) }) }
        flow.beginImport(listOf(gopro.copy(parsed = parked)), preferredEventId = 7)
        flow.pick(10)
        assertEquals(LineReview.Problem.STATIONARY_PICK, flow.state.value.problem)
        assertFalse(flow.state.value.canSave)
    }

    /**
     * The side effect of sharing one flow: a *recorded* session now stores
     * per-lap channels — speed on the distance grid from the phone's own fixes —
     * where it used to post `channels: null`.
     */
    @Test
    fun `a recording reviewed through the same flow posts per-lap channels`() {
        val gps = clip("gopro.mp4").parsed!!.gps!!
        val recording = RecorderCore.createRecording(eventId = "7", startedAtMs = 1_700_000_000_000.0)
        for (p in gps) {
            recording.addFix(
                LocationFix(timeMs = 1_700_000_000_000.0 + p.t * 1000, lat = p.lat, lon = p.lon, speed = p.v, accuracy = 4.0),
            )
        }
        val flow = RecordingFlow(CoroutineScope(Dispatchers.Default), api())
        flow.begin(recording)
        awaitEvents(flow)

        var state = flow.state.value
        assertFalse(state.isImport)
        assertEquals(ParsedTelemetry.Kind.LIVE, state.items.single().parsed?.kind)
        assertEquals(7, state.selectedEventId)
        assertTrue(state.needsLinePick)

        flow.pick(118)
        flow.setNotes("Damp at first")
        state = flow.state.value
        assertEquals(3, state.items.single().laps.size)

        flow.save(context)
        awaitSaved(flow)

        val draft = body(0)
        assertEquals("Damp at first", draft["notes"]!!.jsonPrimitive.content)
        assertTrue(draft["label"]!!.jsonPrimitive.content.startsWith("Recorded "))
        val channels = draft["channels"]
        assertNotNull("a recorded session carries channels now", channels)
        assertTrue(channels !is JsonNull)
        val lap = channels!!.jsonObject["laps"]!!.jsonArray[0].jsonObject
        assertTrue(lap["speed"]!!.jsonArray.size > 80)
        assertNull("the phone's GPS has no RPM", lap["rpm"])
    }

    private companion object {
        const val EVENTS = """
            [{"id":7,"track_id":1,"track_name":"Summit Point (Shenandoah)",
              "start_date":"2026-06-20","days":1,"lap_count":0,"session_count":0,
              "hours":2,"updated_at":1}]
        """
    }
}
