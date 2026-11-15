package app.trackevolution.core

import app.trackevolution.core.MapViewer.MapType
import app.trackevolution.core.MapViewer.Plan
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TracePoint
import app.trackevolution.core.model.UnitSystem
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** [MapViewer], with the cases of `test/unit/map-viewer.test.js` ported one for one. */
class MapViewerTest {

    private val geo = TraceGeo(36.5607, -79.2064)

    @Test
    fun `viewerPlan offers every type over an anchored trace, with nothing to explain`() {
        assertEquals(Plan(MapViewer.MAP_TYPES, null), MapViewer.viewerPlan(geo, mapsOn = true))
    }

    @Test
    fun `viewerPlan says a borrowed anchor is an estimate`() {
        assertEquals(
            Plan(MapViewer.MAP_TYPES, MapViewer.NOTE_APPROX),
            MapViewer.viewerPlan(geo.copy(approx = true), mapsOn = true),
        )
    }

    @Test
    fun `viewerPlan keeps to the line, and says why, in each case that has no map`() {
        val line = listOf(MapType.LINE)
        assertEquals(Plan(line, MapViewer.NOTE_NO_ANCHOR), MapViewer.viewerPlan(null, mapsOn = true))
        assertEquals(Plan(line, MapViewer.NOTE_NOT_SET_UP), MapViewer.viewerPlan(geo, mapsOn = false))
        assertEquals(Plan(line, MapViewer.NOTE_OFFLINE), MapViewer.viewerPlan(geo, mapsOn = true, loadFailed = true))
        assertEquals(MapViewer.NOTE_NO_ANCHOR, MapViewer.viewerPlan(null, mapsOn = false, loadFailed = true).note)
    }

    @Test
    fun `opens on the remembered type only when the plan still offers it`() {
        assertEquals(MapType.STANDARD, MapViewer.startType(Plan(MapViewer.MAP_TYPES, null), MapType.STANDARD))
        assertEquals(MapType.LINE, MapViewer.startType(Plan(listOf(MapType.LINE), null), MapType.SATELLITE))
        assertEquals(MapType.SATELLITE, MapViewer.startType(Plan(MapViewer.MAP_TYPES, null), null))
        assertEquals(MapType.SATELLITE, MapViewer.DEFAULT_MAP_TYPE)
        assertEquals(MapType.STANDARD, MapType.of("standard"))
        assertNull(MapType.of("globe"))
        assertEquals(listOf("Satellite", "Map", "Line"), MapViewer.MAP_TYPES.map { it.label })
    }

    @Test
    fun `rampColor runs from the slow colour to the fast one at bucket midpoints`() {
        assertEquals(0xFF404040.toInt(), MapViewer.rampColor(0, 2, 0x000000, 0xFFFFFF))
        assertEquals(0xFFBFBFBF.toInt(), MapViewer.rampColor(1, 2, 0x000000, 0xFFFFFF))
        assertEquals(0xFF102030.toInt(), MapViewer.rampColor(7, 16, 0x102030, 0x102030))
    }

    // A 400 m straight heading east from the anchor, then north.
    private val trace = listOf(
        TracePoint(0.0, 0.0, 0.0), TracePoint(100.0, 0.0, 0.0), TracePoint(200.0, 0.0, 0.0),
        TracePoint(400.0, 0.0, 0.0), TracePoint(400.0, 300.0, 0.0),
    )

    private fun at(x: Double, y: Double) =
        Pair(geo.lat + y / 110540, geo.lon + x / (111320 * Math.cos(geo.lat * Math.PI / 180)))

    @Test
    fun `traceMetres inverts the projection`() {
        val p = GeoTrace.projectTrace(
            listOf(GpsPoint(0.0, 36.5631, -79.2019, null)),
            GpsPoint(0.0, geo.lat, geo.lon, null),
        )[0]
        val m = MapViewer.traceMetres(36.5631, -79.2019, geo)
        assertEquals(p.x, m.x, 1e-9)
        assertEquals(p.y, m.y, 1e-9)
    }

    @Test
    fun `reads the line within the tap radius and nothing beyond it`() {
        val (lat, lon) = at(250.0, 20.0)
        val hit = MapViewer.tapHit(trace, geo, lat, lon, 1.0)!!
        assertEquals(250.0, hit.alongM, 1e-6)
        assertEquals(20.0, hit.offM, 1e-6)
        val (lat2, lon2) = at(250.0, 30.0)
        assertNull(MapViewer.tapHit(trace, geo, lat2, lon2, 1.0))
        assertNotNull(MapViewer.tapHit(trace, geo, lat2, lon2, 2.0))
        assertEquals(24, MapViewer.TAP_RADIUS_PX)
    }

    @Test
    fun `pointAlong is the point on the line, not the nearer fix`() {
        assertEquals(Point(250.0, 0.0), MapViewer.pointAlong(trace, 250.0))
        assertEquals(Point(400.0, 100.0), MapViewer.pointAlong(trace, 500.0))
        assertEquals(Point(400.0, 300.0), MapViewer.pointAlong(trace, 9999.0))
    }

    @Test
    fun `headingDeg is the way round, clockwise from north`() {
        assertEquals(90.0, MapViewer.headingDeg(trace, 1), 1e-9)
        assertEquals(0.0, MapViewer.headingDeg(trace, 4), 1e-9)
        assertEquals(
            270.0,
            MapViewer.headingDeg(listOf(TracePoint(0.0, 0.0, 0.0), TracePoint(-10.0, 0.0, 0.0)), 0),
            1e-9,
        )
    }

    private val entry = LapChannels(n = 1, timeMs = 60_000, speed = listOf(100.0, 120.0, 140.0, 160.0, 180.0))

    @Test
    fun `reads speed and distance off the lap's own channel entry`() {
        val place = MapViewer.placeAt(TraceHit(0, 0.625, 999.0, 0.0), entry, 20.0)
        assertEquals(150.0, place.kph!!, 1e-9)
        assertEquals(50.0, place.distM, 1e-9)
        assertEquals("150 km/h · 50 m", MapViewer.readoutText(place, UnitSystem.METRIC))
        assertEquals("93 mph · 164 ft", MapViewer.readoutText(place, UnitSystem.IMPERIAL))
    }

    @Test
    fun `holds at the lap's last sample`() {
        assertEquals(MapViewer.Place(180.0, 80.0), MapViewer.placeAt(TraceHit(0, 1.0, 0.0, 0.0), entry, 20.0))
    }

    @Test
    fun `is the distance along the drawn line alone without a channel entry`() {
        val place = MapViewer.placeAt(TraceHit(0, 0.5, 1240.4, 0.0), null, null)
        assertEquals(MapViewer.Place(null, 1240.4), place)
        assertEquals("1.2 km", MapViewer.readoutText(place, UnitSystem.METRIC))
        val short = LapChannels(n = 1, timeMs = 1, speed = listOf(1.0))
        assertNull(MapViewer.placeAt(TraceHit(0, 0.5, 7.0, 0.0), short, 20.0).kph)
    }

    @Test
    fun `steps the read-out 5 percent of the lap at a time, clamped at the ends`() {
        val first = MapViewer.stepHit(trace, null, 1)!!
        assertEquals(0.05, first.frac, 1e-12)
        assertEquals(35.0, first.alongM, 1e-9)
        assertEquals(0.0, MapViewer.stepHit(trace, first, -3)!!.frac)
        assertEquals(1.0, MapViewer.stepHit(trace, first, 40)!!.frac)
    }
}
