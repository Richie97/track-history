package app.trackevolution.core.telemetry

import app.trackevolution.core.JsMath
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** `test/unit/pdr-laps.test.js`, ported case for case. */
class PDRLapsTest {

    // Synthetic real-firmware channels: latitude at 2Hz, cumulative odometer at
    // ~7Hz, car lapping the 300m-radius reference circle at 40 m/s.
    private val radius = 300.0
    private val speed = 40.0
    private val lapM = 2 * Math.PI * radius // 1884.96m
    private val lapMs = (lapM / speed) * 1000 // 47124ms

    private fun circleChannels(
        revolutions: Double = 3.3,
        startAngle: Double = 0.0,
        lat0: Double = 36.56,
    ): ParsedTelemetry.RawChannels {
        val totalS = (lapM * revolutions) / speed
        val latPts = ArrayList<ChannelPoint>()
        val odoPts = ArrayList<ChannelPoint>()
        var t = 0.0
        while (t <= totalS) {
            val lat = lat0 + (radius * Math.sin(startAngle + (speed * t) / radius)) / 110540
            latPts.add(ChannelPoint(t = t, v = JsMath.round(lat * 1e7, 1.0)))
            t += 0.5
        }
        t = 0.0
        while (t <= totalS) {
            odoPts.add(ChannelPoint(t = t, v = JsMath.round(speed * t, 1.0)))
            t += 0.15
        }
        return ParsedTelemetry.RawChannels(latPts = latPts, odoPts = odoPts)
    }

    @Test
    fun `recovers the lap length from lat-distance periodicity`() {
        val (latPts, odoPts) = circleChannels()
        val profile = given(PDRLaps.latDistanceProfile(latPts, odoPts))
        val found = given(PDRLaps.findLapLength(profile))
        assertTrue(Math.abs(found.lapM - lapM) < 10)
        assertTrue(found.r > 0.95)
    }

    @Test
    fun `prefers the true lap length over its multiples`() {
        val (latPts, odoPts) = circleChannels(revolutions = 5.0)
        val found = given(PDRLaps.findLapLength(given(PDRLaps.latDistanceProfile(latPts, odoPts))))
        // with 5 laps of data, 2x the lap length correlates just as well —
        // the smallest strong peak must win
        assertTrue(Math.abs(found.lapM - lapM) < 10)
    }

    @Test
    fun `rejects straight-line driving`() {
        val latPts = ArrayList<ChannelPoint>()
        val odoPts = ArrayList<ChannelPoint>()
        var t = 0.0
        while (t <= 200) {
            latPts.add(ChannelPoint(t = t, v = JsMath.round((36.56 + (speed * t) / 110540) * 1e7, 1.0)))
            t += 0.5
        }
        t = 0.0
        while (t <= 200) {
            odoPts.add(ChannelPoint(t = t, v = JsMath.round(speed * t, 1.0)))
            t += 0.15
        }
        val profile = PDRLaps.latDistanceProfile(latPts, odoPts)
        given(profile) // 8km of driving — plenty of distance...
        assertNull(PDRLaps.findLapLength(profile!!)) // ...but no lap periodicity (linear lat correlates at every lag)
    }

    @Test
    fun `refuses paddock footage`() {
        val latPts = ArrayList<ChannelPoint>()
        val odoPts = ArrayList<ChannelPoint>()
        var t = 0.0
        while (t <= 600) {
            latPts.add(ChannelPoint(t = t, v = JsMath.round((36.56 + (8 * Math.sin(t / 45)) / 110540) * 1e7, 1.0)))
            t += 0.5
        }
        t = 0.0
        while (t <= 600) {
            odoPts.add(ChannelPoint(t = t, v = JsMath.round(t * 1.2, 1.0))) // 720m crawled
            t += 0.15
        }
        assertNull(PDRLaps.latDistanceProfile(latPts, odoPts)) // not enough distance for two laps
    }

    @Test
    fun `refuses thin channels`() {
        assertNull(PDRLaps.latDistanceProfile(emptyList(), emptyList()))
        assertNull(PDRLaps.latDistanceProfile(null, null))
    }

    @Test
    fun `locates the template's start-finish in a session that began elsewhere`() {
        // Template: one lap of lat(distance) starting at angle 4.0 rad.
        val theta = 4.0
        val tmpl = ArrayList<Double>()
        var d = 0.0
        while (d < lapM) {
            tmpl.add(36.56 + (radius * Math.sin(theta + d / radius)) / 110540)
            d += 5
        }
        // Session: same circle, pit-out at angle 1.0 rad.
        val (latPts, odoPts) = circleChannels(startAngle = 1.0)
        val profile = given(PDRLaps.latDistanceProfile(latPts, odoPts))
        val phase = given(PDRLaps.matchPhase(profile, tmpl, lapM))
        assertTrue(phase.r > 0.95)
        // start/finish is (4.0 - 1.0) rad ahead of the session start
        assertTrue(Math.abs(phase.offsetM - 3.0 * radius) < 15)

        val laps = PDRLaps.cutLapsAtDistance(odoPts, profile.d0 + phase.offsetM, lapM)
        assertTrue(laps.size >= 2)
        for (lap in laps) {
            assertTrue(lap.estimated)
            assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
        }
        // first boundary lands when the car reaches the start/finish angle
        assertTrue(Math.abs(given(laps[0].startT) - (3.0 * radius) / speed) < 0.5)
    }

    @Test
    fun `cuts rolling laps of the right length without any template`() {
        val rec = given(PDRLaps.recoverPdrLaps(circleChannels()))
        assertFalse(rec.anchored)
        assertEquals(3, rec.laps.size) // 3.3 revolutions
        for (lap in rec.laps) {
            assertTrue(lap.estimated)
            assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
        }
    }

    @Test
    fun `returns null when there is nothing lap-like`() {
        assertNull(PDRLaps.recoverPdrLaps(null))
        assertNull(PDRLaps.recoverPdrLaps(ParsedTelemetry.RawChannels(emptyList(), emptyList())))
    }

    @Test
    fun `a non-positive lap length cuts nothing rather than spinning`() {
        val (_, odoPts) = circleChannels()
        assertTrue(PDRLaps.cutLapsAtDistance(odoPts, 0.0, 0.0).isEmpty())
    }
}
