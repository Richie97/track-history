package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/gears.test.js`, case for case, plus the cross-language
 * pin against `contracts/logic/gears.json`.
 */
class GearsTest {

    /** A lap in 2nd, up to 3rd, a clutch-in blip, 4th, then back down to 3rd. */
    private val gearA = listOf(2.0, 2.0, 2.0, 3.0, 3.0, 3.0, 3.0, 0.0, 4.0, 4.0, 4.0, 4.0, 3.0, 3.0)

    /** rpm climbs before each upshift and drops after it. */
    private val rpmA = listOf(
        5000.0, 6000.0, 7000.0, 4500.0, 5500.0, 6500.0, 7100.0,
        7100.0, 4800.0, 5200.0, 5600.0, 6000.0, 6900.0, 5000.0,
    )

    private fun lap(
        n: Int,
        timeMs: Int = 90_000,
        gear: List<Double>? = null,
        rpm: List<Double>? = null,
        speed: List<Double>? = null,
    ) = LapChannels(n = n, timeMs = timeMs, speed = speed, rpm = rpm, gear = gear)

    // ---- ordinal / fmtRpm --------------------------------------------------

    @Test
    fun `spells gears as ordinals and 0 as no gear`() {
        assertEquals(
            listOf("no gear", "1st", "2nd", "3rd", "4th", "8th"),
            listOf(0, 1, 2, 3, 4, 8).map { Gears.ordinal(it.toDouble()) },
        )
    }

    @Test
    fun `groups thousands without touching the locale`() {
        assertEquals("6,400", Gears.fmtRpm(6400.0))
        assertEquals("1,000", Gears.fmtRpm(999.6))
        assertEquals("12", Gears.fmtRpm(12.0))
    }

    // ---- gearSegments ------------------------------------------------------

    @Test
    fun `cuts a lap into runs of one gear, keeping gear-0 runs`() {
        assertEquals(
            listOf(
                Gears.GearRun(2.0, 0, 2),
                Gears.GearRun(3.0, 3, 6),
                Gears.GearRun(0.0, 7, 7),
                Gears.GearRun(4.0, 8, 11),
                Gears.GearRun(3.0, 12, 13),
            ),
            Gears.gearSegments(gearA),
        )
    }

    @Test
    fun `segments are empty for a missing or empty series`() {
        assertEquals(emptyList<Gears.GearRun>(), Gears.gearSegments(null))
        assertEquals(emptyList<Gears.GearRun>(), Gears.gearSegments(emptyList()))
    }

    // ---- lapShifts ---------------------------------------------------------

    @Test
    fun `reports each step with the rpm at the last sample in the old gear`() {
        assertEquals(
            listOf(
                Gears.Shift(k = 3, from = 2.0, to = 3.0, up = true, rpm = 7000.0),
                // Read at k=6, the last sample in 3rd, not the clutch-in blip.
                Gears.Shift(k = 8, from = 3.0, to = 4.0, up = true, rpm = 7100.0),
                Gears.Shift(k = 12, from = 4.0, to = 3.0, up = false, rpm = 6000.0),
            ),
            Gears.lapShifts(lap(1, gear = gearA, rpm = rpmA)),
        )
    }

    @Test
    fun `skips a clutch-in stretch rather than counting it as a gear`() {
        assertEquals(emptyList<Gears.Shift>(), Gears.lapShifts(lap(1, gear = listOf(3.0, 0.0, 0.0, 3.0))))
    }

    @Test
    fun `gives null rpm without an rpm series and nothing without a gear series`() {
        assertEquals(
            listOf(Gears.Shift(k = 1, from = 2.0, to = 3.0, up = true, rpm = null)),
            Gears.lapShifts(lap(1, gear = listOf(2.0, 3.0))),
        )
        assertEquals(emptyList<Gears.Shift>(), Gears.lapShifts(lap(1, rpm = rpmA)))
    }

    // ---- shiftPoints -------------------------------------------------------

    private val channels = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = listOf(
            lap(1, 90_000, gear = gearA, rpm = rpmA),
            lap(2, 89_000, gear = gearA, rpm = rpmA.mapIndexed { k, v -> if (k == 2) 6400.0 else if (k == 6) 7300.0 else v }),
            lap(3, 91_000, gear = gearA), // no rpm: not counted
            lap(4, 92_000, speed = listOf(100.0, 100.0)), // no gear: not counted
        ),
    )

    @Test
    fun `reduces upshifts to min - median - max rpm per gear, downshifts excluded`() {
        val sp = Gears.shiftPoints(channels)!!
        assertEquals(
            listOf(
                Gears.GearShifts(gear = 2.0, count = 2, minRpm = 6400.0, medianRpm = 6700, maxRpm = 7000.0),
                Gears.GearShifts(gear = 3.0, count = 2, minRpm = 7100.0, medianRpm = 7200, maxRpm = 7300.0),
            ),
            sp.gears,
        )
        assertEquals(7050, sp.medianRpm)
        assertEquals(7300.0, sp.maxRpm)
    }

    @Test
    fun `shift points are null when no lap carries gear and rpm, or nothing upshifts`() {
        assertNull(
            Gears.shiftPoints(
                SessionChannels(v = 1, dStepM = 20.0, laps = listOf(channels.laps[2], channels.laps[3])),
            ),
        )
        assertNull(
            Gears.shiftPoints(
                SessionChannels(
                    v = 1,
                    dStepM = 20.0,
                    laps = listOf(lap(1, gear = listOf(3.0, 3.0, 3.0), rpm = listOf(5000.0, 5000.0, 5000.0))),
                ),
            ),
        )
        assertNull(Gears.shiftPoints(SessionChannels(v = 1, dStepM = 20.0, laps = emptyList())))
    }

    // ---- shiftNotes --------------------------------------------------------

    @Test
    fun `names the gears taken to the top of the rev range and the ones shifted early`() {
        val notes = Gears.shiftNotes(
            Gears.SessionShifts(
                gears = listOf(
                    Gears.GearShifts(2.0, 3, 6900.0, 7000, 7150.0),
                    Gears.GearShifts(3.0, 3, 6800.0, 6950, 7100.0),
                    Gears.GearShifts(4.0, 2, 6000.0, 6200, 6400.0),
                    // One shift: not a pattern.
                    Gears.GearShifts(5.0, 1, 5000.0, 5000, 5000.0),
                ),
                medianRpm = 6900,
                maxRpm = 7200.0,
            ),
        )
        assertEquals(
            listOf(
                "Upshifts from 2nd and 3rd run to the top of the rev range seen today (≈7,200 rpm).",
                "Upshifts from 4th come ≈800 rpm earlier than from 2nd.",
            ),
            notes,
        )
    }

    @Test
    fun `says nothing when the gears agree and none reaches the limit`() {
        assertEquals(
            emptyList<String>(),
            Gears.shiftNotes(
                Gears.SessionShifts(
                    gears = listOf(
                        Gears.GearShifts(2.0, 3, 6400.0, 6500, 6600.0),
                        Gears.GearShifts(3.0, 3, 6300.0, 6400, 6500.0),
                    ),
                    medianRpm = 6450,
                    maxRpm = 7200.0,
                ),
            ),
        )
        assertEquals(emptyList<String>(), Gears.shiftNotes(null))
    }

    // ---- gearDisagreements -------------------------------------------------

    @Test
    fun `outlines runs where highlighted laps sit in different gears`() {
        val a = listOf(2.0, 2.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 4.0, 4.0)
        // 4th where a is in 3rd for four points.
        val b = listOf(2.0, 2.0, 4.0, 4.0, 4.0, 4.0, 3.0, 3.0, 4.0, 4.0)
        assertEquals(listOf(Gears.Disagreement(2, 5)), Gears.gearDisagreements(listOf(a, b)))
    }

    @Test
    fun `ignores a shift that merely lands a sample later, and gear 0 on either lap`() {
        val a = listOf(2.0, 2.0, 3.0, 3.0, 3.0, 3.0, 3.0)
        // One-point offset: a shift, not a choice.
        val b = listOf(2.0, 2.0, 2.0, 3.0, 3.0, 3.0, 3.0)
        assertEquals(emptyList<Gears.Disagreement>(), Gears.gearDisagreements(listOf(a, b)))
        // Clutch in where a is in 3rd: no disagreement.
        val c = listOf(2.0, 2.0, 0.0, 0.0, 0.0, 0.0, 3.0)
        assertEquals(emptyList<Gears.Disagreement>(), Gears.gearDisagreements(listOf(a, c)))
        assertEquals(3, Gears.MIN_DISAGREE_POINTS)
    }

    @Test
    fun `needs two series and honours the run threshold`() {
        assertEquals(
            emptyList<Gears.Disagreement>(),
            Gears.gearDisagreements(listOf(listOf(2.0, 3.0))),
        )
        assertEquals(
            listOf(Gears.Disagreement(1, 2)),
            Gears.gearDisagreements(listOf(listOf(2.0, 3.0, 3.0), listOf(2.0, 4.0, 4.0)), minRun = 1),
        )
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
            RepoRoot.path("contracts/logic/gears.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val channels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)

        assertEquals(
            json.decodeFromJsonElement<List<List<Gears.GearRun>>>(expected["segments"]!!),
            channels.laps.map { Gears.gearSegments(it.gear) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<List<Gears.Shift>>>(expected["shifts"]!!),
            channels.laps.map { Gears.lapShifts(it) },
        )

        val sp = Gears.shiftPoints(channels)
        assertNotNull(sp)
        assertEquals(json.decodeFromJsonElement<Gears.SessionShifts>(expected["shiftPoints"]!!), sp)
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["notes"]!!),
            Gears.shiftNotes(sp),
        )
        assertEquals(JsonNull, expected["noRpm"])
        assertNull(
            Gears.shiftPoints(
                SessionChannels(v = 1, dStepM = 20.0, laps = listOf(channels.laps[2], channels.laps[3])),
            ),
        )

        val a = channels.laps[0].gear
        val b = channels.laps[1].gear
        val c = channels.laps[2].gear
        assertEquals(
            json.decodeFromJsonElement<List<Gears.Disagreement>>(expected["disagreementsAB"]!!),
            Gears.gearDisagreements(listOf(a, b)),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Gears.Disagreement>>(expected["disagreementsABC"]!!),
            Gears.gearDisagreements(listOf(a, b, c)),
        )
        val offsetA = listOf(2.0, 2.0, 3.0, 3.0, 3.0)
        val offsetB = listOf(2.0, 2.0, 2.0, 3.0, 3.0)
        assertEquals(
            json.decodeFromJsonElement<List<Gears.Disagreement>>(expected["offsetDefault"]!!),
            Gears.gearDisagreements(listOf(offsetA, offsetB)),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Gears.Disagreement>>(expected["offsetMinRun1"]!!),
            Gears.gearDisagreements(listOf(offsetA, offsetB), minRun = 1),
        )
    }
}
