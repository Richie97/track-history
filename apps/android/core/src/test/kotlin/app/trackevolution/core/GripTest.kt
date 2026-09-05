package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The port of `test/unit/grip.test.js`, case for case, plus the cross-language
 * pin against `contracts/logic/grip.json`.
 */
class GripTest {

    /**
     * Eight grid points each. The "cross" lap brakes in a straight line, turns,
     * then accelerates — the two axes are never used together. The "circle" lap
     * trails the brake in (k1, k2) and feeds the power out (k4–k6), all while
     * cornering, and steers left throughout so its samples mirror to −x.
     */
    private val cross = LapChannels(
        n = 1,
        timeMs = 90_000,
        speed = List(8) { 120.0 },
        latG = listOf(0.0, 0.0, 0.0, 1.2, 1.2, 0.0, 0.0, 0.0),
        longG = listOf(0.0, -1.0, -1.0, 0.0, 0.0, 0.5, 0.5, 0.0),
    )
    private val circle = LapChannels(
        n = 2,
        timeMs = 88_000,
        speed = List(8) { 120.0 },
        latG = listOf(0.0, 0.6, 0.9, 1.1, 1.0, 0.8, 0.4, 0.0),
        steering = listOf(0.0, -10.0, -12.0, -14.0, -12.0, -8.0, -3.0, 0.0),
        longG = listOf(0.0, -0.9, -0.6, 0.0, 0.3, 0.5, 0.6, 0.0),
    )
    private val channels = SessionChannels(v = 1, dStepM = 20.0, laps = listOf(cross, circle))

    // ---- hasGripData / gripLaps -------------------------------------------

    @Test
    fun `needs both channels`() {
        assertTrue(Grip.hasGripData(cross))
        assertFalse(Grip.hasGripData(LapChannels(n = 1, timeMs = 0, latG = listOf(1.0, 2.0))))
        assertFalse(Grip.hasGripData(LapChannels(n = 1, timeMs = 0, longG = listOf(1.0, 2.0))))
        assertFalse(Grip.hasGripData(null))
        assertEquals(listOf(0, 1), Grip.gripLaps(channels).map { it.chIdx })
        // a lap without both is left out, and the indexes stay channel indexes
        val mixed = SessionChannels(
            v = 1,
            dStepM = 20.0,
            laps = listOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)), circle),
        )
        assertEquals(listOf(1), Grip.gripLaps(mixed).map { it.chIdx })
        assertEquals(emptyList<Grip.GripLap>(), Grip.gripLaps(null))
    }

    // ---- latSign -----------------------------------------------------------

    @Test
    fun `takes the side from the steering trace, plus one without one`() {
        assertEquals(-1.0, Grip.latSign(circle, 1))
        assertEquals(1.0, Grip.latSign(circle, 0)) // straight: sign doesn't matter, latG ~ 0
        assertEquals(1.0, Grip.latSign(cross, 3)) // no steering stored
        assertEquals(1.0, Grip.latSign(circle, 99)) // past the end of the trace
    }

    // ---- gripPoints --------------------------------------------------------

    @Test
    fun `signs lateral by steering and keeps longitudinal as stored`() {
        val pts = Grip.gripPoints(circle)
        assertEquals(8, pts.size)
        assertEquals(-0.6, pts[1].lat, 1e-12) // steering negative -> left
        assertEquals(-0.9, pts[1].long, 1e-12) // braking stays negative
        assertEquals(hypot(0.6, 0.9), pts[1].g, 1e-12)
        assertEquals(1, pts[1].k)
        assertEquals(1.2, Grip.gripPoints(cross)[3].lat, 1e-12) // no steering: right side
    }

    @Test
    fun `plots the samples both channels cover, and nothing without them`() {
        val ragged = LapChannels(n = 1, timeMs = 0, latG = listOf(1.0, 1.0, 1.0), longG = listOf(0.0, 0.0))
        assertEquals(2, Grip.gripPoints(ragged).size)
        assertTrue(Grip.gripPoints(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0, 2.0))).isEmpty())
    }

    @Test
    fun `a magnitude stored with a sign is still a magnitude`() {
        // pdr.js stores abs(lateral acceleration); a negative would be a bug in a
        // source, and it must not flip a sample to the other side of the plot.
        val odd = LapChannels(n = 1, timeMs = 0, latG = listOf(-1.1), longG = listOf(0.0))
        assertEquals(1.1, Grip.gripPoints(odd)[0].lat, 1e-12)
    }

    // ---- gripShares --------------------------------------------------------

    @Test
    fun `scores the cross at zero on both quadrants`() {
        val sh = requireNotNull(Grip.gripShares(cross))
        assertEquals(6, sh.loaded) // the two zero samples are the tyre doing nothing
        assertEquals(0, sh.trailBrake)
        assertEquals(0, sh.powerDown)
        assertEquals(0.0, sh.trailPct, 1e-12)
        assertEquals(0.0, sh.powerPct, 1e-12)
    }

    @Test
    fun `scores the filled circle on both`() {
        val sh = requireNotNull(Grip.gripShares(circle))
        assertEquals(8, sh.samples)
        assertEquals(6, sh.loaded)
        assertEquals(2, sh.trailBrake)
        assertEquals(3, sh.powerDown)
        assertEquals(2.0 / 6 * 100, sh.trailPct, 1e-9)
        assertEquals(3.0 / 6 * 100, sh.powerPct, 1e-9)
    }

    @Test
    fun `needs both axes past the threshold to count as combined`() {
        val under = LapChannels(
            n = 1,
            timeMs = 0,
            latG = listOf(1.0, Grip.COMBINED_MIN_G - 0.01, 1.0),
            longG = listOf(-(Grip.COMBINED_MIN_G - 0.01), -1.0, -Grip.COMBINED_MIN_G),
        )
        assertEquals(1, requireNotNull(Grip.gripShares(under)).trailBrake) // only the third sample
    }

    @Test
    fun `is null for a lap that never loads the tyre`() {
        assertNull(Grip.gripShares(LapChannels(n = 1, timeMs = 0, latG = listOf(0.0, 0.1), longG = listOf(0.0, -0.1))))
        assertNull(Grip.gripShares(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0))))
        // exactly at the threshold counts as loaded
        val atThreshold = LapChannels(n = 1, timeMs = 0, latG = listOf(Grip.MIN_LOAD_G), longG = listOf(0.0))
        assertEquals(1, requireNotNull(Grip.gripShares(atThreshold)).loaded)
    }

    // ---- peakCombinedG -----------------------------------------------------

    @Test
    fun `is a percentile, so one kerb strike does not set the envelope`() {
        val latG = MutableList(100) { 1.0 }
        latG[42] = 3.0 // the strike
        val spike = SessionChannels(
            v = 1,
            dStepM = 20.0,
            laps = listOf(LapChannels(n = 1, timeMs = 0, latG = latG, longG = List(100) { 0.0 })),
        )
        assertEquals(1.0, requireNotNull(Grip.peakCombinedG(spike)), 1e-12)
        assertEquals(0.99, Grip.PEAK_PERCENTILE)
        // and the max is still reachable when asked for
        assertEquals(3.0, requireNotNull(Grip.peakCombinedG(spike, 1.0)), 1e-12)
    }

    @Test
    fun `pools every plottable lap, and is null without one`() {
        assertTrue(requireNotNull(Grip.peakCombinedG(channels)) > 1.0)
        val none = SessionChannels(
            v = 1,
            dStepM = 20.0,
            laps = listOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0, 2.0))),
        )
        assertNull(Grip.peakCombinedG(none))
        assertNull(Grip.peakCombinedG(null))
    }

    // ---- sessionGrip -------------------------------------------------------

    @Test
    fun `keeps a row per lap and pools the session`() {
        val sg = requireNotNull(Grip.sessionGrip(channels))
        assertEquals(listOf(0, 1), sg.laps.map { it.chIdx })
        assertEquals(1.2, sg.maxG, 1e-12) // the max, unlike the arc
        assertEquals(12, sg.all.loaded)
        assertEquals(2, sg.all.trailBrake)
        assertEquals(3, sg.all.powerDown)
        assertEquals(2.0 / 12 * 100, sg.all.trailPct, 1e-9)
    }

    @Test
    fun `is null when no lap stored both channels`() {
        val none = SessionChannels(
            v = 1,
            dStepM = 20.0,
            laps = listOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0, 2.0))),
        )
        assertNull(Grip.sessionGrip(none))
        assertNull(Grip.sessionGrip(null))
    }

    // ---- cross-language pin ------------------------------------------------

    /**
     * The JS implementation's own output for a shared input has to come back out
     * of this port: counts exactly, and the doubles `hypot` produced to 1e-9,
     * since the last ulp there is a platform's libm rather than this logic.
     */
    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/grip.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val fixtureChannels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)
        val edgeLap = json.decodeFromJsonElement<LapChannels>(input["edgeLap"]!!)
        val spikeChannels = json.decodeFromJsonElement<SessionChannels>(input["spikeChannels"]!!)
        val lapA = fixtureChannels.laps[0]
        val lapB = fixtureChannels.laps[1]

        assertEquals(
            json.decodeFromJsonElement<List<Double>>(expected["latSignA"]!!),
            listOf(0, 3, 13, 99).map { Grip.latSign(lapA, it) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<Double>>(expected["latSignB"]!!),
            listOf(0, 4, 13).map { Grip.latSign(lapB, it) },
        )

        val wantPoints = json.decodeFromJsonElement<List<List<Grip.Point>>>(expected["points"]!!)
        wantPoints.forEachIndexed { lapIdx, want ->
            val got = Grip.gripPoints(fixtureChannels.laps[lapIdx])
            assertEquals(want.size, got.size, "lap $lapIdx point count")
            want.forEachIndexed { i, w ->
                assertEquals(w.k, got[i].k, "lap $lapIdx point $i k")
                assertEquals(w.lat, got[i].lat, 1e-9, "lap $lapIdx point $i lat")
                assertEquals(w.long, got[i].long, 1e-9, "lap $lapIdx point $i long")
                assertEquals(w.g, got[i].g, 1e-9, "lap $lapIdx point $i g")
            }
        }

        val wantShares = json.decodeFromJsonElement<List<Grip.Shares?>>(expected["shares"]!!)
        wantShares.forEachIndexed { lapIdx, want ->
            assertSameShares(want, Grip.gripShares(fixtureChannels.laps[lapIdx]), "lap $lapIdx shares")
        }
        assertSameShares(
            json.decodeFromJsonElement<Grip.Shares>(expected["edgeShares"]!!),
            Grip.gripShares(edgeLap),
            "edge lap",
        )

        val wantSession = json.decodeFromJsonElement<Grip.SessionGrip>(expected["session"]!!)
        val session = requireNotNull(Grip.sessionGrip(fixtureChannels))
        assertEquals(wantSession.laps.map { it.chIdx }, session.laps.map { it.chIdx })
        wantSession.laps.forEachIndexed { i, want ->
            assertEquals(want.trailBrake, session.laps[i].trailBrake, "session lap $i trailBrake")
            assertEquals(want.powerDown, session.laps[i].powerDown, "session lap $i powerDown")
            assertEquals(want.trailPct, session.laps[i].trailPct, 1e-9, "session lap $i trailPct")
        }
        assertSameShares(wantSession.all, session.all, "session pooled")
        assertEquals(wantSession.maxG, session.maxG, 1e-9)
        assertEquals(
            expected["peak"]!!.jsonPrimitive.content.toDouble(),
            requireNotNull(session.peakG),
            1e-9,
        )

        // The percentile is the point: at 0.99 the kerb strike is outside the
        // envelope, at 1 it sets it.
        assertEquals(
            expected["spikePeak"]!!.jsonPrimitive.content.toDouble(),
            requireNotNull(Grip.peakCombinedG(spikeChannels)),
            1e-9,
        )
        assertEquals(
            expected["spikeMax"]!!.jsonPrimitive.content.toDouble(),
            requireNotNull(Grip.peakCombinedG(spikeChannels, 1.0)),
            1e-9,
        )

        assertNull(Grip.sessionGrip(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(fixtureChannels.laps[2]))))
    }

    private fun assertSameShares(want: Grip.Shares?, got: Grip.Shares?, label: String) {
        if (want == null || got == null) {
            assertTrue(want == null && got == null, "$label: one side is null")
            return
        }
        assertEquals(want.samples, got.samples, "$label samples")
        assertEquals(want.loaded, got.loaded, "$label loaded")
        assertEquals(want.trailBrake, got.trailBrake, "$label trailBrake")
        assertEquals(want.powerDown, got.powerDown, "$label powerDown")
        assertTrue(abs(want.trailPct - got.trailPct) < 1e-9, "$label trailPct")
        assertTrue(abs(want.powerPct - got.powerPct) < 1e-9, "$label powerPct")
    }
}
