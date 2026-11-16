package app.trackevolution.core

import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TracePoint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * NS-53: [GeoTrace]'s map half, pinned against the web implementation
 * (`contracts/logic/geo-anchor.json`, generated from
 * `public/js/import/geo.js`) — coordinates to 1e-9 degrees, metres to 1e-6 —
 * plus the JS unit cases from `test/unit/geo-anchor.test.ts`.
 */
class GeoAnchorTest {

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/geo-anchor.json").readText(),
    ).jsonObject

    private fun JsonObject.d(key: String) = this[key]!!.jsonPrimitive.double

    private fun geoOf(o: JsonObject?): TraceGeo? = o?.let { TraceGeo(it.d("lat"), it.d("lon")) }

    private val geo = geoOf(fixture["geo"]!!.jsonObject)!!
    private val trace: List<TracePoint> = fixture["trace"]!!.jsonArray.map { p ->
        val a = p.jsonArray.map { it.jsonPrimitive.double }
        TracePoint(a[0], a[1], a.getOrElse(2) { 0.0 })
    }

    private fun t(vararg xyv: Double) = TracePoint(xyv[0], xyv[1], xyv[2])

    @Test
    fun `the projection constants match the web`() {
        val c = fixture["constants"]!!.jsonObject
        assertEquals(c.d("KY"), GeoTrace.KY)
        for (row in c["KX_at"]!!.jsonArray) {
            val o = row.jsonObject
            assertEquals(o.d("kx"), GeoTrace.KX(o.d("lat")), 1e-9, "KX(${o.d("lat")})")
        }
    }

    @Test
    fun `traceOrigin matches the web`() {
        for (row in fixture["traceOrigin"]!!.jsonArray) {
            val o = row.jsonObject
            val gps = o["gps"]!!.jsonArray.map {
                val p = it.jsonObject
                GpsPoint(t = 0.0, lat = p.d("lat"), lon = p.d("lon"), v = null)
            }
            val origin = (o["origin"] as? JsonObject)?.let { GpsPoint(0.0, it.d("lat"), it.d("lon"), null) }
            val expected = (o["expected"] as? JsonObject)?.let { geoOf(it) }
            assertEquals(expected, GeoTrace.traceOrigin(gps, origin), "traceOrigin($row)")
        }
    }

    @Test
    fun `unprojectTrace and traceGeoBounds match the web`() {
        val expected = fixture["unprojected"]!!.jsonArray
        val actual = GeoTrace.unprojectTrace(trace, geo)
        assertEquals(expected.size, actual.size)
        for ((a, e) in actual.zip(expected)) {
            val o = e.jsonObject
            assertEquals(o.d("lat"), a.lat, 1e-9)
            assertEquals(o.d("lon"), a.lon, 1e-9)
            assertEquals(o.d("v"), a.v, 1e-9)
        }
        val b = fixture["bounds"]!!.jsonObject
        val bounds = GeoTrace.traceGeoBounds(trace, geo)!!
        assertEquals(b.d("south"), bounds.south, 1e-9)
        assertEquals(b.d("west"), bounds.west, 1e-9)
        assertEquals(b.d("north"), bounds.north, 1e-9)
        assertEquals(b.d("east"), bounds.east, 1e-9)
    }

    @Test
    fun `nearestOnTrace matches the web`() {
        for (row in fixture["nearest"]!!.jsonArray) {
            val o = row.jsonObject
            val maxM = (o["maxM"] as? JsonNull)?.let { Double.POSITIVE_INFINITY } ?: o.d("maxM")
            val hit = GeoTrace.nearestOnTrace(trace, o.d("x"), o.d("y"), maxM)
            val e = o["expected"] as? JsonObject
            if (e == null) {
                assertNull(hit, "nearest($row)")
                continue
            }
            assertNotNull(hit, "nearest($row)")
            assertEquals(e["idx"]!!.jsonPrimitive.int, hit!!.idx)
            assertEquals(e.d("frac"), hit.frac, 1e-9)
            assertEquals(e.d("alongM"), hit.alongM, 1e-6)
            assertEquals(e.d("offM"), hit.offM, 1e-6)
        }
    }

    @Test
    fun `speedRuns matches the web`() {
        for (row in fixture["speedRuns"]!!.jsonArray) {
            val o = row.jsonObject
            val expected = o["expected"]!!.jsonArray.map {
                val r = it.jsonObject
                SpeedRun(r["from"]!!.jsonPrimitive.int, r["to"]!!.jsonPrimitive.int, r["bucket"]!!.jsonPrimitive.int)
            }
            assertEquals(expected, GeoTrace.speedRuns(trace, o["buckets"]!!.jsonPrimitive.int))
        }
        val flat = fixture["flatSpeedRuns"]!!.jsonArray.map {
            val r = it.jsonObject
            SpeedRun(r["from"]!!.jsonPrimitive.int, r["to"]!!.jsonPrimitive.int, r["bucket"]!!.jsonPrimitive.int)
        }
        assertEquals(flat, GeoTrace.speedRuns(trace.map { it.copy(v = 50.0) }))
    }

    // ---- The JS unit cases ------------------------------------------------

    @Test
    fun `traceOrigin is gps 0 unless handed the projection's origin, and null off the map`() {
        val gps = listOf(GpsPoint(0.0, 36.56071234567, -79.2, null), GpsPoint(1.0, 36.57, -79.21, null))
        assertEquals(TraceGeo(36.5607123, -79.2), GeoTrace.traceOrigin(gps))
        assertEquals(TraceGeo(40.0, -75.0), GeoTrace.traceOrigin(gps, GpsPoint(0.0, 40.0, -75.0, null)))
        assertNull(GeoTrace.traceOrigin(listOf(GpsPoint(0.0, 0.0, 0.0, null))))
        assertNull(GeoTrace.traceOrigin(emptyList()))
        assertNull(GeoTrace.traceOrigin(null))
    }

    @Test
    fun `traceGeoBounds boxes the line in degrees`() {
        val g = TraceGeo(36.5, -79.2)
        val b = GeoTrace.traceGeoBounds(listOf(t(-100.0, -50.0, 1.0), t(300.0, 250.0, 2.0), t(0.0, 0.0, 3.0)), g)!!
        assertEquals(36.5 - 50 / GeoTrace.KY, b.south, 1e-12)
        assertEquals(36.5 + 250 / GeoTrace.KY, b.north, 1e-12)
        assertEquals(-79.2 - 100 / GeoTrace.KX(36.5), b.west, 1e-12)
        assertEquals(-79.2 + 300 / GeoTrace.KX(36.5), b.east, 1e-12)
        assertNull(GeoTrace.traceGeoBounds(emptyList(), g))
    }

    @Test
    fun `nearestOnTrace finds the place by distance driven, not by index`() {
        val tr = listOf(t(0.0, 0.0, 5.0), t(1.0, 0.0, 5.0), t(2.0, 0.0, 5.0), t(3.0, 0.0, 5.0), t(103.0, 0.0, 60.0))
        assertEquals(TraceHit(idx = 3, frac = 43.0 / 103, alongM = 43.0, offM = 4.0), GeoTrace.nearestOnTrace(tr, 43.0, 4.0))
        assertEquals(4, GeoTrace.nearestOnTrace(tr, 60.0, 4.0)!!.idx)
        assertNull(GeoTrace.nearestOnTrace(tr, 53.0, 30.0, 24.0))
        val before = GeoTrace.nearestOnTrace(tr, -10.0, 0.0)!!
        assertEquals(0, before.idx)
        assertEquals(0.0, before.frac)
        assertEquals(10.0, before.offM)
        assertNull(GeoTrace.nearestOnTrace(listOf(t(0.0, 0.0, 1.0)), 0.0, 0.0))
        assertNull(GeoTrace.nearestOnTrace(listOf(t(5.0, 5.0, 1.0), t(5.0, 5.0, 1.0)), 5.0, 5.0))
    }

    @Test
    fun `speedRuns cuts the line where its colour changes, covering every segment once`() {
        val tr = listOf(
            t(0.0, 0.0, 10.0), t(1.0, 0.0, 10.0), t(2.0, 0.0, 20.0),
            t(3.0, 0.0, 30.0), t(4.0, 0.0, 30.0), t(5.0, 0.0, 10.0),
        )
        assertEquals(listOf(SpeedRun(0, 2, 0), SpeedRun(2, 3, 2), SpeedRun(3, 5, 3)), GeoTrace.speedRuns(tr, 4))
        assertEquals(
            listOf(SpeedRun(0, 2, 8)),
            GeoTrace.speedRuns(listOf(t(0.0, 0.0, 7.0), t(1.0, 0.0, 7.0), t(2.0, 0.0, 7.0)), 16),
        )
        assertEquals(emptyList<SpeedRun>(), GeoTrace.speedRuns(listOf(t(0.0, 0.0, 7.0))))
    }
}
