package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.JsMath
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** `test/unit/channels.test.js`, minus the `.vbo` case — that parser stays web-only. */
class LapChannelsTest {

    // Constant 40 m/s: distance is 40t, one 47.12s lap covers 1884.8m.
    private val dist = List(400) { i -> ChannelPoint(t = i * 0.5, v = i * 20.0) }
    private val speed = List(400) { i -> ChannelPoint(t = i * 0.5, v = 144.0) } // km/h
    private val rpm = List(400) { i -> ChannelPoint(t = i * 0.5, v = 5000.0 + (i % 10)) }

    private val lapS = 2 * Math.PI * 300 / 40

    /** `circleTrace()` in `test/fixtures/build.mjs`: 3.3 revolutions of a 300 m circle at 40 m/s, 10 Hz. */
    private fun circleTrace(lat0: Double = 36.56, lon0: Double = -79.2): List<GpsPoint> {
        val radius = 300.0
        val speedMps = 40.0
        val totalS = (2 * Math.PI * radius * 3.3) / speedMps
        val out = ArrayList<GpsPoint>()
        var t = 0.0
        while (t <= totalS) {
            val theta = (speedMps * t) / radius
            out.add(
                GpsPoint(
                    t = t,
                    lat = lat0 + (radius * Math.sin(theta)) / 110540,
                    lon = lon0 + (radius * Math.cos(theta)) / (111320 * Math.cos(lat0 * Math.PI / 180)),
                    v = speedMps,
                ),
            )
            t = JsMath.round(t + 0.1, 10.0)
        }
        return out
    }

    @Test
    fun `cuts channel arrays on the distance grid for windowed laps`() {
        val laps = listOf(
            ParsedLap(lapNumber = 3, timeMs = 47120, estimated = false, startT = 10.0, endT = 57.12),
            ParsedLap(timeMs = 47120, estimated = false), // no window: skipped
        )
        val out = given(TelemetryChannels.buildLapChannels(laps, dist, ParsedTelemetry.CarChannels(speed = speed, rpm = rpm)))
        assertEquals(20.0, out.dStepM)
        assertEquals(1, out.laps.size)
        val lap = out.laps[0]
        assertEquals(3, lap.n)
        // 47.12s at 40 m/s = 1884.8m -> 95 grid points (0..1880m)
        val s = given(lap.speed)
        val r = given(lap.rpm)
        assertEquals(95, s.size)
        assertEquals(95, r.size)
        assertEquals(144.0, s[0])
        assertTrue(r[50] >= 5000)
    }

    @Test
    fun `synthesizes speed from the distance slope when no speed channel exists`() {
        val laps = listOf(ParsedLap(timeMs = 47120, estimated = false, startT = 10.0, endT = 57.12))
        val out = given(TelemetryChannels.buildLapChannels(laps, dist, ParsedTelemetry.CarChannels()))
        val s = given(out.laps[0].speed)
        assertEquals(95, s.size)
        // 40 m/s = 144 km/h from the odometer slope
        assertEquals(144.0, s[40], 0.5)
        assertNull(out.laps[0].rpm)
    }

    @Test
    fun `returns null when there is nothing to cut`() {
        val chans = ParsedTelemetry.CarChannels(speed = speed)
        assertNull(TelemetryChannels.buildLapChannels(emptyList(), dist, chans))
        assertNull(TelemetryChannels.buildLapChannels(listOf(ParsedLap(timeMs = 1000, estimated = false)), dist, chans))
        assertNull(
            TelemetryChannels.buildLapChannels(
                listOf(ParsedLap(timeMs = 47120, estimated = false, startT = 10.0, endT = 57.12)),
                dist.take(5),
                chans,
            ),
        )
        // degenerate lap: shorter than 10 grid points
        assertNull(
            TelemetryChannels.buildLapChannels(
                listOf(ParsedLap(timeMs = 4000, estimated = false, startT = 10.0, endT = 14.0)),
                dist,
                chans,
            ),
        )
    }

    @Test
    fun `integrates distance from a projected trace`() {
        val trace = circleTrace()
        val d = TelemetryChannels.distFromTrace(GeoTrace.projectTrace(trace))
        // 3.3 revolutions of a 300m-radius circle ≈ 6220m
        assertTrue(d.last().v > 6100)
        assertTrue(d.last().v < 6350)
    }

    @Test
    fun `uses the source's own speed when present`() {
        val trace = circleTrace() // v = 40 m/s on every point
        val s = given(TelemetryChannels.traceChannelData(trace, GeoTrace.projectTrace(trace)).series.speed)
        assertEquals(144.0, s[10].v, 1e-5) // km/h
    }

    @Test
    fun `attaches full car channels to a beacon-timed delta PDR file`() {
        val out = VideoFixtures.parse("pdr-delta.mp4")
        val channels = given(out.lapChannels)
        assertEquals(2, channels.laps.size)
        val lap = channels.laps[0]
        val speedArr = given(lap.speed)
        assertTrue(speedArr.size > 80)
        assertEquals(speedArr.size, given(lap.rpm).size)
        assertEquals(speedArr.size, given(lap.latG).size)
        assertEquals(speedArr.size, given(lap.throttle).size)
        assertEquals(speedArr.size, given(lap.brake).size)
        assertEquals(speedArr.size, given(lap.steering).size)
        assertTrue(speedArr.max() < 160) // ~151 km/h peak
        assertTrue(given(lap.rpm).max() <= 6000)
        // pedals within 0-100%, steering signed degrees (±28.6° in the fixture)
        assertTrue(given(lap.throttle).min() >= 0)
        assertTrue(given(lap.throttle).max() <= 100)
        assertTrue(given(lap.brake).max() <= 100)
        assertTrue(given(lap.steering).min() < -20)
        assertTrue(given(lap.steering).max() < 29.2)
    }

    @Test
    fun `channelDataFor picks the odometer for PDR and the trace for GPS sources`() {
        val pdr = VideoFixtures.parse("pdr-delta-nobeacon.mp4")
        assertSame(given(pdr.channels).odoPts, given(TelemetryChannels.channelDataFor(pdr)).dist)
        val gopro = ParsedTelemetry(kind = ParsedTelemetry.Kind.GOPRO, gps = circleTrace())
        val data = given(TelemetryChannels.channelDataFor(gopro))
        assertEquals(given(gopro.gps).size, data.dist.size)
    }

    @Test
    fun `line-picked laps get speed channels via applyGate`() {
        var parsed = VideoFixtures.parse("pdr-nobeacon.mp4")
        assertNull(parsed.lapChannels) // no laps yet
        val gps = given(parsed.gps)
        val origin = gps[0]
        val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, origin), JsMath.roundToInt(0.25 * lapS * 10)))
        parsed = Telemetry.applyGate(parsed, origin, gate)
        assertEquals(3, parsed.laps.size)
        val channels = given(parsed.lapChannels)
        assertEquals(3, channels.laps.size)
        assertTrue(given(channels.laps[0].speed).size > 80)
    }

    @Test
    fun `drops the lowest-priority channels rather than storing nothing`() {
        // 40 laps of a 14km circuit x 12 channels x ~700 points is ~336k
        // values, nearly three times the cap. The video contract fixture is far
        // too small to reach this path, so it is only checked here.
        val longDist = List(2000) { i -> ChannelPoint(t = i * 7.0, v = i * 280.0) }
        val flat = List(2000) { i -> ChannelPoint(t = i * 7.0, v = 1.0) }
        var chans = ParsedTelemetry.CarChannels()
        for ((name, _) in TelemetryChannels.CHANNEL_NAMES) chans = chans.with(name, flat)
        val laps = List(40) { i ->
            ParsedLap(
                lapNumber = i + 1,
                timeMs = 349_000,
                estimated = false,
                startT = i * 349.0,
                endT = (i + 1) * 349.0,
            )
        }
        val out = given(TelemetryChannels.buildLapChannels(laps, longDist, chans))
        val total = out.laps.sumOf { e ->
            TelemetryChannels.CHANNEL_NAMES.sumOf { e.channel(it.first)?.size ?: 0 }
        }
        assertTrue(total <= TelemetryChannels.MAX_TOTAL_VALUES)
        // speed survives; the tail of CHANNEL_NAMES is what went
        assertNotNull(out.laps[0].speed)
        assertNull(out.laps[0].flags)
    }
}
