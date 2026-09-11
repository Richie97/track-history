package app.trackevolution.core.telemetry

import app.trackevolution.core.JsMath
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer

/**
 * `test/unit/pdr.test.js`, ported case for case.
 *
 * The JS builds its delta-encoded input with `buildPdrDeltaMp4()`; the same
 * bytes are committed as `contracts/logic/video/pdr-delta.mp4` (with beacons)
 * and `pdr-delta-nobeacon.mp4` (without), so the Kotlin can ask the identical
 * question of the identical file.
 */
class PDRTest {

    // ---- gpsFromChannels ----------------------------------------------------------

    private fun t(i: Int) = i * 0.15
    private fun chan(n: Int, deg: (Int) -> Double) =
        List(n) { i -> ChannelPoint(t = t(i), v = JsMath.round(deg(i) * 1e7, 1.0)) }

    @Test
    fun `decodes deg times 1e7 lat and lon channels into a degrees trace`() {
        val lat = chan(40) { 36.56 + it * 1e-4 }
        val lon = chan(40) { -79.2 + it * 1e-4 }
        val gps = given(PDR.gpsFromChannels(lat, lon))
        assertEquals(40, gps.size)
        assertEquals(36.561, gps[10].lat, 1e-6)
        assertEquals(-79.199, gps[10].lon, 1e-6)
        assertNull(gps[10].v)
    }

    @Test
    fun `takes speed from the odometer series when given`() {
        val lat = chan(40) { 36.56 + it * 1e-4 }
        val lon = chan(40) { -79.2 + it * 1e-4 }
        val odo = series(List(40) { i -> ChannelPoint(t = t(i), v = i * 6.0) }) // 40 m/s
        val gps = given(PDR.gpsFromChannels(lat, lon, odo))
        assertEquals(40.0, given(gps[20].v), 1e-6)
    }

    @Test
    fun `decodes float32-bit lat and lon channels via the fallback interpretation`() {
        fun asBits(deg: Double): Double = java.lang.Float.floatToIntBits(deg.toFloat()).toDouble()
        val lat = List(40) { i -> ChannelPoint(t = t(i), v = asBits(36.56 + i * 1e-4)) }
        val lon = List(40) { i -> ChannelPoint(t = t(i), v = asBits(-79.2 + i * 1e-4)) }
        val gps = given(PDR.gpsFromChannels(lat, lon))
        assertEquals(36.561, gps[10].lat, 1e-4)
        assertEquals(-79.199, gps[10].lon, 1e-4)
    }

    @Test
    fun `returns null rather than a garbage trace`() {
        // parked car: zero extent
        val stuck = List(40) { i -> ChannelPoint(t = t(i), v = 365600000.0) }
        assertNull(PDR.gpsFromChannels(stuck, stuck))
        // values plausible under neither interpretation
        val noise = List(40) { i -> ChannelPoint(t = t(i), v = 2000000000.0 - i * 55555555.0) }
        assertNull(PDR.gpsFromChannels(noise, noise))
        // too few samples
        assertNull(PDR.gpsFromChannels(emptyList(), emptyList()))
    }

    // ---- parsePdrFile with a delta-encoded stream (real firmware shape) ---------

    private val lapS = 2 * Math.PI * 300 / 40 // 47.12s

    @Test
    fun `decodes the delta-encoded GPS channels into a dictionary-scaled trace`() {
        val out = VideoFixtures.parse("pdr-delta-nobeacon.mp4")
        val gps = given(out.gps)
        assertTrue(gps.size > 100)
        // ~2Hz stream around the reference circle at lat0/lon0
        assertTrue(gps.minOf { it.lat } > 36.5545)
        assertTrue(gps.maxOf { it.lat } < 36.5655)
        assertEquals(-79.2, (gps.minOf { it.lon } + gps.maxOf { it.lon }) / 2, 0.005)
        // racing-line speed comes from the Speed channel (m/s), modulated ±5% around 40
        val vs = gps.map { it.v ?: 0.0 }
        assertTrue(vs.max() > 40)
        assertTrue(vs.max() < 42.5)
    }

    @Test
    fun `keeps decoder state across sample boundaries`() {
        // the fixture splits records into 250-record samples; a state reset would
        // orphan every delta at a sample start and thin or corrupt the trace
        val out = VideoFixtures.parse("pdr-delta-nobeacon.mp4")
        val gps = given(out.gps)
        val dt = gps.drop(1).mapIndexed { i, p -> p.t - gps[i].t }
        assertTrue(dt.max() < 1.5) // no holes
        assertTrue(out.durationS > 150)
    }

    @Test
    fun `times laps from delta-stream beacons and reads mrlv date and time`() {
        val out = VideoFixtures.parse("pdr-delta.mp4")
        val ms = JsMath.roundToInt(lapS * 1000) // 47124
        assertEquals(listOf(ms, ms), out.laps.map { it.timeMs })
        assertTrue(out.laps.all { !it.estimated })
        assertEquals("2026-06-20", out.date)
        assertEquals("09:15:00", out.time)
    }

    @Test
    fun `reports top speed, max RPM and max lateral G from the car channels`() {
        val out = VideoFixtures.parse("pdr-delta-nobeacon.mp4")
        val metrics = given(out.metrics)
        // speed peaks at 42 m/s = 151.2 km/h; rpm at 6000; latAcc at v²/r ≈ 0.6 G
        val top = given(metrics.topSpeedKph)
        assertTrue(top > 148 && top < 152)
        val rpm = given(metrics.maxRpm)
        assertTrue(rpm > 5900 && rpm <= 6000)
        val g = given(metrics.maxLatG)
        assertTrue(g > 0.5 && g < 0.65)
    }

    @Test
    fun `decodes throttle, brake and steering car channels`() {
        val out = VideoFixtures.parse("pdr-delta-nobeacon.mp4")
        // pedals are raw 0-255 scaled by the dictionary's "%" units to 0-100,
        // alternating (throttle on the sine's positive half, brake the negative)
        val th = given(out.carChannels.throttle).map { it.v }
        val br = given(out.carChannels.brake).map { it.v }
        assertEquals(0.0, th.min())
        assertTrue(th.max() > 99)
        assertTrue(th.max() <= 100)
        assertTrue(br.max() > 99)
        // steering is stored in radians with an empty units string (the real
        // firmware shape); the parser converts to degrees itself: ±0.5 rad = ±28.6°
        val st = given(out.carChannels.steering).map { it.v }
        assertTrue(st.max() > 28)
        assertTrue(st.max() < 29.2)
        assertTrue(st.min() < -28)
    }

    // ---- boxes -----------------------------------------------------------------------

    /** Two MP4 boxes: "ftyp" (12 bytes) and "free" (8 bytes). */
    private fun buildBoxes(): ByteArray {
        val buf = ByteBuffer.allocate(20)
        fun put(off: Int, size: Int, type: String) {
            buf.putInt(off, size)
            type.forEachIndexed { i, ch -> buf.put(off + 4 + i, ch.code.toByte()) }
        }
        put(0, 12, "ftyp")
        put(12, 8, "free")
        return buf.array()
    }

    @Test
    fun `parses consecutive box headers`() {
        val out = MP4.boxes(ByteView(buildBoxes()), 0, 20)
        assertEquals(
            listOf(
                MP4.Box(type = "ftyp", start = 0, body = 8, size = 12),
                MP4.Box(type = "free", start = 12, body = 20, size = 8),
            ),
            out,
        )
    }

    @Test
    fun `stops at garbage instead of running away`() {
        val bytes = buildBoxes()
        ByteBuffer.wrap(bytes).putInt(12, 3) // invalid size < 8
        assertEquals(1, MP4.boxes(ByteView(bytes), 0, 20).size)
    }
}
