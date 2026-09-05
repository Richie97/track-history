package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/limits.test.js`, case for case, plus the
 * cross-language pin against `contracts/logic/limits.json`.
 */
class LimitsTest {

    private val abs = Limits.FLAG_ABS.toDouble()
    private val tc = Limits.FLAG_TC.toDouble()
    private val vsc = Limits.FLAG_VSC.toDouble()

    /**
     * 20 grid points: ABS pulses across a braking zone (k 2–5, with a one-point
     * gap), TC once on an exit (k 9–10), VSC never; wheelspin on that same exit
     * and a lockup at k 3.
     */
    private val flags = listOf(
        0.0, 0.0, abs, 0.0, abs, abs, 0.0, 0.0, 0.0, tc,
        tc, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    )
    private val slip = listOf(
        0.0, 0.0, 0.0, -3.0, -1.0, 0.0, 0.0, 0.0, 0.5, 3.0,
        4.5, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    )
    private val lap = LapChannels(
        n = 1,
        timeMs = 90_000,
        speed = List(20) { 100.0 },
        wheelSlip = slip,
        flags = flags,
    )

    // ---- limitAt / hasLimitData -------------------------------------------

    @Test
    fun `reads the flag bits and the slip thresholds, null for a channel the lap lacks`() {
        assertEquals(true, Limits.limitAt(lap, "abs", 2))
        assertEquals(false, Limits.limitAt(lap, "abs", 3))
        assertEquals(true, Limits.limitAt(lap, "tc", 9))
        assertEquals(false, Limits.limitAt(lap, "vsc", 9))
        assertEquals(true, Limits.limitAt(lap, "wheelspin", 10))
        assertEquals(false, Limits.limitAt(lap, "wheelspin", 8)) // 0.5 % is noise
        assertEquals(true, Limits.limitAt(lap, "lockup", 3))
        assertNull(Limits.limitAt(LapChannels(n = 1, timeMs = 0, flags = flags), "wheelspin", 3))
        assertNull(Limits.limitAt(LapChannels(n = 1, timeMs = 0, wheelSlip = slip), "abs", 3))
        assertNull(Limits.limitAt(lap, "abs", 99))
        assertTrue(Limits.hasLimitData(lap))
        assertFalse(Limits.hasLimitData(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0, 2.0))))
    }

    @Test
    fun `VSC is bit 2`() {
        val both = LapChannels(n = 1, timeMs = 0, flags = listOf(vsc + abs))
        assertEquals(true, Limits.limitAt(both, "vsc", 0))
        assertEquals(false, Limits.limitAt(both, "tc", 0))
    }

    // ---- booleanRuns -------------------------------------------------------

    @Test
    fun `merges runs across short gaps and keeps longer ones apart`() {
        val s = listOf(false, true, true, false, true, false, false, false, true, true)
        assertEquals(
            listOf(
                Limits.Run(1, 4), // one clear point between: merged
                Limits.Run(8, 9), // three clear points: separate
            ),
            Limits.booleanRuns(s, 2),
        )
        assertEquals(
            listOf(Limits.Run(1, 2), Limits.Run(4, 4), Limits.Run(8, 9)),
            Limits.booleanRuns(s, 0),
        )
        assertEquals(emptyList<Limits.Run>(), Limits.booleanRuns(emptyList(), 2))
        assertEquals(2, Limits.MERGE_GAP_POINTS)
    }

    // ---- limitRuns ---------------------------------------------------------

    @Test
    fun `lists every kind's runs in kind order, the ABS pulse train as one run`() {
        assertEquals(
            listOf(
                Limits.LimitRun("abs", 2, 5),
                Limits.LimitRun("lockup", 3, 3),
                Limits.LimitRun("tc", 9, 10),
                Limits.LimitRun("wheelspin", 9, 10),
            ),
            Limits.limitRuns(lap),
        )
    }

    @Test
    fun `skips the kinds whose channel is missing`() {
        assertEquals(
            listOf("abs", "tc"),
            Limits.limitRuns(LapChannels(n = 1, timeMs = 0, flags = flags)).map { it.kind },
        )
        assertEquals(
            emptyList<Limits.LimitRun>(),
            Limits.limitRuns(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0, 2.0))),
        )
    }

    // ---- activeLimitLabels -------------------------------------------------

    @Test
    fun `names what is active at a grid point`() {
        assertEquals(listOf("Lockup"), Limits.activeLimitLabels(lap, 3))
        assertEquals(listOf("Traction control", "Wheelspin"), Limits.activeLimitLabels(lap, 10))
        assertEquals(emptyList<String>(), Limits.activeLimitLabels(lap, 0))
    }

    // ---- sessionLimits / limitSummary --------------------------------------

    /** ABS in the same zone, plus a second zone at k 15–16; no slip channel. */
    private val lap2 = LapChannels(
        n = 2,
        timeMs = 91_000,
        speed = List(20) { 100.0 },
        flags = flags.mapIndexed { k, f ->
            if (k == 15 || k == 16) abs else (f.toInt() and Limits.FLAG_ABS).toDouble()
        },
    )

    @Test
    fun `counts distinct places across laps and the laps involved`() {
        val sl = Limits.sessionLimits(
            SessionChannels(
                v = 1,
                dStepM = 20.0,
                laps = listOf(lap, lap2, LapChannels(n = 3, timeMs = 0, speed = listOf(1.0, 2.0))),
            ),
        )!!
        assertTrue(sl.hasFlags)
        assertTrue(sl.hasSlip)
        assertEquals(
            listOf(
                Limits.KindTally("abs", 2, 2),
                Limits.KindTally("lockup", 1, 1),
                Limits.KindTally("tc", 1, 1),
                Limits.KindTally("wheelspin", 1, 1),
                Limits.KindTally("vsc", 0, 0),
            ),
            sl.kinds,
        )
        assertEquals(
            "ABS in 2 places, lockup in 1 place, traction control in 1 place, wheelspin in 1 place",
            Limits.limitSummary(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(lap, lap2))),
        )
    }

    @Test
    fun `says no interventions when the systems never fired, and null without the channels`() {
        val quiet = SessionChannels(
            v = 1,
            dStepM = 20.0,
            laps = listOf(LapChannels(n = 1, timeMs = 0, flags = List(20) { 0.0 })),
        )
        assertEquals("no interventions", Limits.limitSummary(quiet))
        // No slip channel: those kinds are absent rather than reported as zero.
        assertEquals(listOf("abs", "tc", "vsc"), Limits.sessionLimits(quiet)!!.kinds.map { it.kind })
        assertNull(
            Limits.limitSummary(
                SessionChannels(
                    v = 1,
                    dStepM = 20.0,
                    laps = listOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0, 2.0))),
                ),
            ),
        )
        assertNull(Limits.limitSummary(SessionChannels(v = 1, dStepM = 20.0, laps = emptyList())))
    }

    // ---- limitMarkers ------------------------------------------------------

    /**
     * A 380 m straight-line trace sampled every 10 m, so distance fractions map
     * to indexes directly.
     */
    private val trace = List(39) { TraceSample(x = it * 10.0, y = 0.0, v = 50.0) }

    @Test
    fun `places each run's mid-point on the trace by driven-distance fraction`() {
        val m = Limits.limitMarkers(lap, 20.0, trace)
        assertEquals(listOf("abs", "lockup", "tc", "wheelspin"), m.map { it.kind })
        // ABS mid-point k=3.5 of 19 → 70 m of 380 → index 7 on the 10 m trace.
        assertEquals(Limits.Marker("abs", 2, 5, 7), m[0])
        assertEquals(19, m[2].idx) // k=9.5 → 190 m
    }

    @Test
    fun `scales to the trace's own length when it differs from the grid length`() {
        val shortTrace = List(20) { TraceSample(x = it * 10.0, y = 0.0, v = 50.0) } // 190 m
        // 70/380 · 190 = 35 m → the first point at or past 35 m.
        assertEquals(4, Limits.limitMarkers(lap, 20.0, shortTrace)[0].idx)
    }

    @Test
    fun `markers are empty without a trace or without runs`() {
        assertEquals(emptyList<Limits.Marker>(), Limits.limitMarkers(lap, 20.0, null))
        assertEquals(
            emptyList<Limits.Marker>(),
            Limits.limitMarkers(
                LapChannels(n = 1, timeMs = 0, speed = List(20) { 100.0 }, flags = List(20) { 0.0 }),
                20.0,
                trace,
            ),
        )
    }

    // ---- LIMIT_KINDS -------------------------------------------------------

    @Test
    fun `colours by side and never leaves two kinds of one side colour-alone`() {
        for (side in listOf(Limits.Side.BRAKE, Limits.Side.POWER)) {
            val kinds = Limits.LIMIT_KINDS.filter { it.side == side }
            assertEquals(2, kinds.size)
            assertNotEquals(kinds[0].filled, kinds[1].filled)
        }
    }

    // ---- cross-language pin ------------------------------------------------

    /**
     * The JS implementation's own output for a shared input has to come back out
     * of this port integer for integer and string for string.
     */
    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/limits.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val channels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)
        // The fixture's trace is the stored [x, y, v] tuple shape.
        val trace = json.decodeFromJsonElement<List<List<Double>>>(input["trace"]!!)
            .map { TraceSample(x = it[0], y = it[1], v = it[2]) }

        assertEquals(
            json.decodeFromJsonElement<List<List<Limits.LimitRun>>>(expected["runs"]!!),
            channels.laps.map { Limits.limitRuns(it) },
        )
        assertEquals(
            json.decodeFromJsonElement<Limits.SessionLimits>(expected["session"]!!),
            Limits.sessionLimits(channels),
        )
        assertEquals(expected["summary"]!!.jsonPrimitive.content, Limits.limitSummary(channels))
        assertEquals(
            expected["quietSummary"]!!.jsonPrimitive.content,
            Limits.limitSummary(
                SessionChannels(
                    v = 1,
                    dStepM = 20.0,
                    laps = listOf(LapChannels(n = 1, timeMs = 0, flags = List(20) { 0.0 })),
                ),
            ),
        )
        assertEquals(JsonNull, expected["noData"])
        assertNull(
            Limits.limitSummary(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(channels.laps[2]))),
        )
        assertEquals(
            json.decodeFromJsonElement<List<List<String>>>(expected["labelsAt"]!!),
            listOf(0, 3, 10).map { Limits.activeLimitLabels(channels.laps[0], it) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<Limits.Marker>>(expected["markers"]!!),
            Limits.limitMarkers(channels.laps[0], channels.dStepM, trace),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Limits.Marker>>(expected["noTrace"]!!),
            Limits.limitMarkers(channels.laps[0], channels.dStepM, null),
        )
    }
}
