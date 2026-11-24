package app.trackevolution.core

import app.trackevolution.core.TrackLocate.Candidate
import app.trackevolution.core.TrackLocate.Confidence
import app.trackevolution.core.TrackLocate.Located
import app.trackevolution.core.TrackLocate.Place
import app.trackevolution.core.TrackLocate.Source
import app.trackevolution.core.model.StartFinish
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TrackPlace
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * NS-57: [TrackLocate], pinned against the web implementation
 * (`contracts/logic/track-locate.json`, generated from
 * `public/js/import/locate.js`) — distances and length ratios to 1e-6 — plus
 * the JS unit cases from `test/unit/locate.test.js` that the fixture's rows do
 * not already cover.
 */
class TrackLocateTest {

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/track-locate.json").readText(),
    ).jsonObject

    private data class Own(
        override val id: Int,
        override val name: String,
        override val catalogId: Int?,
        override val geo: TrackPlace?,
    ) : TrackLocate.OwnTrack

    private data class Cat(
        override val id: Int,
        override val name: String,
        override val lat: Double?,
        override val lon: Double?,
        override val lengthM: Int?,
    ) : TrackLocate.CatalogRow

    private data class Ev(
        override val id: Int,
        override val trackId: Int,
        override val startDate: String,
        override val days: Double,
    ) : TrackLocate.EventRow

    private fun JsonElement?.orNull(): JsonElement? = if (this == null || this is JsonNull) null else this
    private fun JsonObject.obj(key: String): JsonObject? = this[key].orNull()?.jsonObject
    private fun JsonObject.arr(key: String): JsonArray = this[key]!!.jsonArray
    private fun JsonObject.d(key: String): Double = this[key]!!.jsonPrimitive.double
    private fun JsonObject.dn(key: String): Double? = this[key].orNull()?.jsonPrimitive?.double
    private fun JsonObject.i(key: String): Int = this[key]!!.jsonPrimitive.int
    private fun JsonObject.inn(key: String): Int? = this[key].orNull()?.jsonPrimitive?.int
    private fun JsonObject.s(key: String): String = this[key]!!.jsonPrimitive.content
    private fun JsonObject.sn(key: String): String? = this[key].orNull()?.jsonPrimitive?.content

    private fun sfOf(o: JsonObject?): StartFinish? = o?.let { StartFinish(it.d("lat"), it.d("lon"), it.d("heading")) }
    private fun geoOf(o: JsonObject?): TrackPlace? =
        o?.let { TrackPlace(it.d("lat"), it.d("lon"), it.i("length_m"), sfOf(it.obj("sf"))) }
    private fun ownOf(a: JsonArray): List<Own> =
        a.map { it.jsonObject }.map { Own(it.i("id"), it.s("name"), it.inn("catalog_id"), geoOf(it.obj("geo"))) }
    private fun placeOf(o: JsonObject?): Place? = o?.let { Place(it.d("lat"), it.d("lon"), it.dn("lengthM")) }
    private fun sourceOf(s: String) = Source.entries.first { it.value == s }
    private fun confidenceOf(s: String) = Confidence.entries.first { it.value == s }
    private fun candidatesOf(a: JsonArray): List<Candidate> = a.map { it.jsonObject }.map {
        Candidate(sourceOf(it.s("source")), it.i("id"), it.s("name"), it.d("distM"), it.dn("lengthOff"))
    }
    private fun locatedOf(o: JsonObject): Located =
        Located(confidenceOf(o.s("confidence")), candidatesOf(o.arr("candidates")), o["venueOnly"]!!.jsonPrimitive.boolean)

    private val catalog: List<Cat> = fixture.arr("catalog").map { it.jsonObject }.map {
        Cat(it.i("id"), it.s("name"), it.dn("lat"), it.dn("lon"), it.inn("length_m"))
    }
    private val events: List<Ev> = fixture.arr("events").map { it.jsonObject }.map {
        Ev(it.i("id"), it.i("track_id"), it.s("start_date"), it.d("days"))
    }
    private val sfOwn = ownOf(fixture.arr("sfOwnTracks"))

    private fun assertCandidates(expected: List<Candidate>, actual: List<Candidate>, what: String) {
        assertEquals(expected.size, actual.size, "$what: candidate count")
        expected.zip(actual).forEachIndexed { n, (e, a) ->
            assertEquals(e.source, a.source, "$what[$n].source")
            assertEquals(e.id, a.id, "$what[$n].id")
            assertEquals(e.name, a.name, "$what[$n].name")
            assertEquals(e.distM, a.distM, 1e-6, "$what[$n].distM")
            if (e.lengthOff == null) assertNull(a.lengthOff, "$what[$n].lengthOff")
            else assertEquals(e.lengthOff, a.lengthOff!!, 1e-9, "$what[$n].lengthOff")
        }
    }

    private fun assertLocated(expected: Located, actual: Located, what: String) {
        assertEquals(expected.confidence, actual.confidence, "$what: confidence")
        assertEquals(expected.venueOnly, actual.venueOnly, "$what: venueOnly")
        assertCandidates(expected.candidates, actual.candidates, what)
    }

    @Test
    fun `the constants match the web`() {
        val c = fixture["constants"]!!.jsonObject
        assertEquals(c.d("OWN_RADIUS_M"), TrackLocate.OWN_RADIUS_M)
        assertEquals(c.d("VENUE_RADIUS_M"), TrackLocate.VENUE_RADIUS_M)
        assertEquals(c.d("LENGTH_TOLERANCE"), TrackLocate.LENGTH_TOLERANCE)
        assertEquals(c.d("CATALOG_SHORT_TOLERANCE"), TrackLocate.CATALOG_SHORT_TOLERANCE)
        assertEquals(c.d("CATALOG_LONG_TOLERANCE"), TrackLocate.CATALOG_LONG_TOLERANCE)
        assertEquals(c.i("DATE_SLACK_DAYS"), TrackLocate.DATE_SLACK_DAYS)
        assertEquals(c.d("GATE_HALF_WIDTH_M"), TrackLocate.GATE_HALF_WIDTH_M)
        assertEquals(GeoTrace.GATE_HALF_WIDTH_M, TrackLocate.GATE_HALF_WIDTH_M)
    }

    @Test
    fun `distanceM matches the web`() {
        for (row in fixture.arr("distanceM")) {
            val o = row.jsonObject
            val a = o.obj("a")!!
            val b = o.obj("b")!!
            assertEquals(o.d("expected"), TrackLocate.distanceM(a.d("lat"), a.d("lon"), b.d("lat"), b.d("lon")), 1e-6)
        }
    }

    private fun traceOf(e: JsonElement?): List<TraceSample>? = e.orNull()?.jsonArray?.map { p ->
        val a = p.jsonArray.map { it.jsonPrimitive.double }
        TraceSample(a[0], a[1], a.getOrElse(2) { 0.0 })
    }

    @Test
    fun `traceLengthM matches the web`() {
        for (row in fixture.arr("traceLengthM")) {
            val o = row.jsonObject
            val expected = o.dn("expected")
            val actual = TrackLocate.traceLengthM(traceOf(o["trace"]))
            if (expected == null) assertNull(actual) else assertEquals(expected, actual!!, 1e-6)
        }
    }

    @Test
    fun `recordingPlace matches the web`() {
        for (row in fixture.arr("recordingPlace")) {
            val o = row.jsonObject
            val parsed = o.obj("parsed")!!
            val geo = parsed.obj("traceGeo")?.let { TraceGeo(it.d("lat"), it.d("lon")) }
            val gps = parsed["gps"].orNull()?.jsonArray?.map { it.jsonObject }?.map { GpsPoint(0.0, it.d("lat"), it.d("lon"), null) }
            val expected = placeOf(o.obj("expected"))
            val actual = TrackLocate.recordingPlace(traceOf(parsed["bestLapTrace"]), geo, gps)
            val name = o.s("name")
            if (expected == null) {
                assertNull(actual, name)
                continue
            }
            assertNotNull(actual, name)
            assertEquals(expected.lat, actual!!.lat, 1e-9, name)
            assertEquals(expected.lon, actual.lon, 1e-9, name)
            if (expected.lengthM == null) assertNull(actual.lengthM, name) else assertEquals(expected.lengthM, actual.lengthM!!, 1e-6, name)
        }
    }

    @Test
    fun `locateTrack matches the web`() {
        val rows = fixture.arr("locateTrack")
        assertTrue(rows.size >= 10)
        for (row in rows) {
            val o = row.jsonObject
            val actual = TrackLocate.locateTrack(placeOf(o.obj("place")), ownOf(o.arr("own")), catalog)
            assertLocated(locatedOf(o.obj("expected")!!), actual, o.s("name"))
        }
    }

    @Test
    fun `eventForDate matches the web`() {
        for (row in fixture.arr("eventForDate")) {
            val o = row.jsonObject
            assertEquals(o.inn("expected"), TrackLocate.eventForDate(events, o.i("trackId"), o.s("date"))?.id, row.toString())
        }
    }

    @Test
    fun `groupImports and eventBodyFor match the web`() {
        for (row in fixture.arr("groupImports")) {
            val o = row.jsonObject
            val name = o.s("name")
            val items = o.arr("items").map { it.jsonObject }.map {
                TrackLocate.Item(it.i("id"), it.sn("date"), it.sn("time"), placeOf(it.obj("place")), it.obj("located")?.let(::locatedOf))
            }
            val evs = o.arr("events").map { it.jsonObject }.map { Ev(it.i("id"), it.i("track_id"), it.s("start_date"), it.d("days")) }
            val choices = o["choices"]!!.jsonObject.entries.associate { (k, v) -> k.toInt() to v.jsonObject.s("name") }
            val groups = TrackLocate.groupImports(items, evs, choices, ownOf(o.arr("own")), o.s("today"))
            val expected = o.arr("expected").map { it.jsonObject }
            assertEquals(expected.size, groups.size, "$name: group count")
            expected.zip(groups).forEachIndexed { n, (e, g) ->
                val what = "$name[$n]"
                assertEquals(e.s("key"), g.key, what)
                assertEquals(e.inn("eventId"), g.eventId, what)
                val t = e.obj("track")
                if (t == null) assertNull(g.track, what)
                else assertEquals(TrackLocate.GroupTrack(sourceOf(t.s("source")), t.inn("id"), t.s("name")), g.track, what)
                assertEquals(confidenceOf(e.s("confidence")), g.confidence, what)
                assertCandidates(candidatesOf(e.arr("candidates")), g.candidates, what)
                assertEquals(e["venueOnly"]!!.jsonPrimitive.boolean, g.venueOnly, what)
                assertEquals(e.s("start"), g.start, what)
                assertEquals(e.i("days"), g.days, what)
                assertEquals(e.arr("itemIds").map { it.jsonPrimitive.int }, g.itemIds, what)
            }
            o.arr("eventBodies").forEachIndexed { n, b ->
                val body = b.orNull()?.jsonObject
                val g = groups[n]
                assertEquals(body != null, g.track != null && g.eventId == null, "$name[$n]: has a body")
                if (body == null) return@forEachIndexed
                val draft = TrackLocate.eventBodyFor(g, "Corvette")
                assertEquals(body.s("track_name"), draft.trackName)
                assertEquals(body.s("start_date"), draft.startDate)
                assertEquals(body.d("days"), draft.days)
                assertEquals(body.sn("car"), draft.car)
            }
        }
    }

    @Test
    fun `otherTrackHere matches the web`() {
        for (row in fixture.arr("otherTrackHere")) {
            val o = row.jsonObject
            val track = o.obj("track")!!
            val located = TrackLocate.locateTrack(placeOf(o.obj("place")), ownOf(o.arr("own")), catalog)
            assertEquals(o.sn("expected"), TrackLocate.otherTrackHere(located, track.i("id"), track.inn("catalog_id")), row.toString())
        }
    }

    @Test
    fun `gateFromSf matches the web`() {
        for (row in fixture.arr("gateFromSf")) {
            val o = row.jsonObject
            val sfRaw = o.obj("sf")
            // A null heading is a line that isn't there; the model can't hold one.
            val sf = if (sfRaw != null && sfRaw["heading"].orNull() != null) sfOf(sfRaw) else null
            val origin = o.obj("origin")?.let { TraceGeo(it.d("lat"), it.d("lon")) }
            val expected = o.obj("expected")
            val actual = TrackLocate.gateFromSf(sf, origin)
            if (expected == null) {
                assertNull(actual, row.toString())
                continue
            }
            assertNotNull(actual, row.toString())
            for (k in listOf("x", "y", "x1", "y1", "x2", "y2")) {
                val got = when (k) { "x" -> actual!!.x; "y" -> actual!!.y; "x1" -> actual!!.x1; "y1" -> actual!!.y1; "x2" -> actual!!.x2; else -> actual!!.y2 }
                assertEquals(expected.d(k), got, 1e-6, "$k of $row")
            }
            assertEquals(expected.d("hx"), actual!!.hx!!, 1e-12)
            assertEquals(expected.d("hy"), actual.hy!!, 1e-12)
        }
    }

    @Test
    fun `knownLines matches the web`() {
        for (row in fixture.arr("knownLines")) {
            val o = row.jsonObject
            val expected = o.arr("expected").map { it.jsonObject }
            val actual = TrackLocate.knownLines(placeOf(o.obj("place")), sfOwn)
            assertEquals(expected.map { it.i("id") }, actual.map { it.id }, row.toString())
            expected.zip(actual).forEach { (e, a) ->
                assertEquals(e.s("name"), a.name)
                assertEquals(sfOf(e.obj("sf")), a.sf)
                assertEquals(e.d("distM"), a.distM, 1e-6)
            }
        }
    }

    @Test
    fun `lineFits matches the web`() {
        for (row in fixture.arr("lineFits")) {
            val o = row.jsonObject
            val places = o.arr("places").map { placeOf(it.orNull()?.jsonObject) }
            assertEquals(o["expected"]!!.jsonPrimitive.boolean, TrackLocate.lineFits(o.i("trackId"), places, sfOwn, catalog), row.toString())
        }
    }

    // ---- the JS unit cases the fixture's rows do not carry -----------------------

    @Test
    fun `a known line times a second day the way the first day's picked line did`() {
        val vir = TraceGeo(36.5617, -79.2047)
        fun drive(laps: Int, leadM: Double, t0: Double = 0.0): List<GpsPoint> {
            val length = 3000.0
            val r = length / (2 * Math.PI)
            val v = 40.0
            val out = mutableListOf<GpsPoint>()
            var i = 0
            while (i * v * 0.1 <= laps * length + 400) {
                val a = (i * v * 0.1 - leadM) / length * 2 * Math.PI
                out.add(GpsPoint(t0 + i * 0.1, vir.lat + 0.6 * r * Math.cos(a) / GeoTrace.KY, vir.lon + r * Math.sin(a) / GeoTrace.KX(vir.lat), v))
                i++
            }
            return out
        }
        val day1 = drive(4, 700.0)
        val trace1 = GeoTrace.projectTrace(day1)
        val gate1 = GeoTrace.buildGate(trace1, 200)!!
        val laps1 = GeoTrace.deriveLaps(trace1, gate1)
        assertEquals(3, laps1.size)
        val stored = GeoTrace.bestLapTrace(trace1, gate1)!!
        // What the server's `startFinish` reads off the stored trace.
        val p0 = stored[0]
        val next = stored.first { Math.hypot(it.x - p0.x, it.y - p0.y) >= 15 }
        val heading = (Math.atan2(next.x - p0.x, next.y - p0.y) * 180 / Math.PI + 360) % 360
        val o1 = GeoTrace.traceOrigin(day1)!!
        val sf = StartFinish(o1.lat + p0.y / GeoTrace.KY, o1.lon + p0.x / GeoTrace.KX(o1.lat), heading)

        val day2 = drive(5, 1900.0, 1000.0)
        val trace2 = GeoTrace.projectTrace(day2)
        val gate2 = TrackLocate.gateFromSf(sf, TraceGeo(day2[0].lat, day2[0].lon))!!
        val laps2 = GeoTrace.deriveLaps(trace2, gate2)
        assertEquals(4, laps2.size)
        for (l in laps2) assertTrue(Math.abs(l.timeMs - laps1[0].timeMs) < 150)

        val reversed = day1.indices.map { n -> day1[day1.size - 1 - n].copy(t = day1[n].t) }
        val gateR = TrackLocate.gateFromSf(sf, TraceGeo(reversed[0].lat, reversed[0].lon))!!
        assertTrue(GeoTrace.deriveLaps(GeoTrace.projectTrace(reversed), gateR).isEmpty())
    }

    @Test
    fun `an unanswered group has no track until the driver names it`() {
        val unknown = Place(10.0, 10.0, 2500.0)
        val items = listOf(
            TrackLocate.Item(0, "2026-06-20", null, unknown, null),
            TrackLocate.Item(1, "2026-06-20", null, unknown, null),
        )
        val groups = TrackLocate.groupImports(items, emptyList(), today = "2026-08-09")
        assertEquals(1, groups.size)
        assertNull(groups[0].track)
        assertEquals(Confidence.NONE, groups[0].confidence)
        assertEquals(listOf(0, 1), groups[0].itemIds)
        val named = TrackLocate.groupImports(items, emptyList(), mapOf(0 to "Paddock Loop", 1 to "Paddock Loop"), today = "2026-08-09")
        assertEquals(TrackLocate.GroupTrack(Source.NEW, null, "Paddock Loop"), named.single().track)
        assertEquals(Confidence.CHOSEN, named.single().confidence)
        assertFalse(named.single().venueOnly)
    }

    @Test
    fun `groupDatesText spans a group's days`() {
        val g = TrackLocate.Group("k", null, null, Confidence.NONE, emptyList(), false, "2026-03-31", 2, listOf(0))
        assertEquals("<2026-03-31> – <2026-04-01>", TrackLocate.groupDatesText(g) { "<$it>" })
        assertEquals("<2026-03-31>", TrackLocate.groupDatesText(g.copy(days = 1)) { "<$it>" })
    }
}
