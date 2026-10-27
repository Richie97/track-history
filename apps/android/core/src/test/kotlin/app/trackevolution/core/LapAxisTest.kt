package app.trackevolution.core

import app.trackevolution.core.LapAxis.AxisMode
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.UnitSystem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs

/**
 * The port of `test/unit/lap-axis.test.js` (its pure half), case for case, plus
 * the cross-language pin against `contracts/logic/lap-axis.json`. The tab half
 * of the fixture (`constants.tabs` / `tabOf`) is asserted against the panel's
 * enum in `:app`, where the enum lives.
 */
class LapAxisTest {

    // Two laps on a 20 m grid: B is slower through the middle and a grid point
    // shorter, so the two axes put them in different places.
    private val a = LapChannels(
        n = 1,
        timeMs = 10000,
        speed = listOf(100, 120, 140, 140, 120, 100, 110, 130, 150, 160, 160, 150).map { it.toDouble() },
        throttle = listOf(50, 80, 100, 100, 60, 20, 60, 90, 100, 100, 100, 90).map { it.toDouble() },
    )
    private val b = LapChannels(
        n = 2,
        timeMs = 11000,
        speed = listOf(95, 110, 120, 120, 100, 90, 100, 120, 140, 150, 150).map { it.toDouble() },
        throttle = listOf(40, 70, 90, 90, 50, 10, 50, 80, 95, 100, 100).map { it.toDouble() },
    )

    private fun close(want: Double, got: Double?, tol: Double = 1e-9) {
        assertNotNull(got)
        assertTrue(abs(want - got!!) <= tol, "want $want, got $got")
    }

    // ---- lapAxisSeries -----------------------------------------------------

    @Test
    fun `is k times the grid step on distance`() {
        assertEquals((0..11).map { it * 20.0 }, LapAxis.lapAxisSeries(a, 20.0, AxisMode.DISTANCE))
    }

    @Test
    fun `is the lap's own elapsed time on time, ending on the timed lap`() {
        val xs = LapAxis.lapAxisSeries(a, 20.0, AxisMode.TIME)!!
        assertEquals(ChannelGraphs.lapTimeSeries(a.speed!!, 20.0, a.timeMs), xs)
        close(10.0, xs.last())
    }

    @Test
    fun `has nothing for a lap with no speed on time, but a grid on distance`() {
        val noSpeed = LapChannels(n = 3, timeMs = 9000, throttle = listOf(1.0, 2.0, 3.0))
        assertNull(LapAxis.lapAxisSeries(noSpeed, 20.0, AxisMode.TIME))
        assertEquals(listOf(0.0, 20.0, 40.0), LapAxis.lapAxisSeries(noSpeed, 20.0, AxisMode.DISTANCE))
        assertNull(LapAxis.lapAxisSeries(LapChannels(n = 4, timeMs = 1), 20.0, AxisMode.DISTANCE))
    }

    // ---- axisExtent / gridAtAxis / axisAtGrid ------------------------------

    @Test
    fun `is the longest lap on either axis`() {
        assertEquals(220.0, LapAxis.axisExtent(listOf(a, b), 20.0, AxisMode.DISTANCE))
        close(11.0, LapAxis.axisExtent(listOf(a, b), 20.0, AxisMode.TIME))
        assertEquals(0.0, LapAxis.axisExtent(emptyList(), 20.0, AxisMode.TIME))
    }

    @Test
    fun `finds a fractional grid index, and nothing off the lap`() {
        val xs = LapAxis.lapAxisSeries(a, 20.0, AxisMode.DISTANCE)
        close(2.5, LapAxis.gridAtAxis(xs, 50.0))
        assertEquals(0.0, LapAxis.gridAtAxis(xs, 0.0))
        assertEquals(11.0, LapAxis.gridAtAxis(xs, 220.0))
        assertNull(LapAxis.gridAtAxis(xs, 221.0))
        assertNull(LapAxis.gridAtAxis(xs, -1.0))
        assertNull(LapAxis.gridAtAxis(null, 5.0))
    }

    @Test
    fun `round-trips`() {
        val xs = LapAxis.lapAxisSeries(a, 20.0, AxisMode.TIME)
        close(4.2, LapAxis.axisAtGrid(xs, LapAxis.gridAtAxis(xs, 4.2)))
        assertEquals(0.0, LapAxis.axisAtGrid(xs, -3.0))
        assertEquals(xs!!.last(), LapAxis.axisAtGrid(xs, 99.0))
    }

    // ---- axisPlaces --------------------------------------------------------

    @Test
    fun `puts both laps at the same index on distance`() {
        val p = LapAxis.axisPlaces(listOf(a, b), 20.0, AxisMode.DISTANCE, 100.0, listOf(0, 1))
        assertEquals(listOf(0, 1), p.map { it.chIdx })
        close(5.0, p[0].k)
        close(5.0, p[1].k)
        close(5.0 / 11, p[0].frac)
        close(5.0 / 10, p[1].frac)
    }

    @Test
    fun `leaves the slower lap behind on time`() {
        val (pa, pb) = LapAxis.axisPlaces(listOf(a, b), 20.0, AxisMode.TIME, 5.0, listOf(0, 1))
        assertTrue(pb.k < pa.k)
    }

    @Test
    fun `drops a lap the value is past, in the caller's order`() {
        val p = LapAxis.axisPlaces(listOf(a, b), 20.0, AxisMode.DISTANCE, 210.0, listOf(1, 0))
        assertEquals(listOf(0), p.map { it.chIdx })
    }

    // ---- time ticks and words ----------------------------------------------

    @Test
    fun `steps so a lap gets at most six ticks`() {
        assertEquals(listOf(0.0, 2.0, 4.0, 6.0, 8.0, 10.0), LapAxis.timeAxisTicks(10.0).map { it.s })
        assertEquals(listOf("0:00", "0:30", "1:00", "1:30", "2:00"), LapAxis.timeAxisTicks(125.0).map { it.label })
        assertEquals(emptyList<LapAxis.TimeTick>(), LapAxis.timeAxisTicks(0.0))
    }

    @Test
    fun `says minutes and seconds`() {
        assertEquals("1:05", LapAxis.fmtAxisSeconds(65.0))
        assertEquals("1:23.5", LapAxis.fmtAxisValue(83.46, AxisMode.TIME, UnitSystem.IMPERIAL))
        assertEquals("1:00.0", LapAxis.fmtAxisValue(59.96, AxisMode.TIME, UnitSystem.IMPERIAL))
        assertEquals("1.2 km", LapAxis.fmtAxisValue(1234.4, AxisMode.DISTANCE, UnitSystem.METRIC))
        assertEquals("—", LapAxis.fmtAxisValue(null, AxisMode.TIME, UnitSystem.METRIC))
    }

    @Test
    fun `defaults to distance`() {
        assertEquals(listOf("distance", "time"), LapAxis.AXIS_MODES.map { it.key })
        assertEquals(AxisMode.DISTANCE, LapAxis.DEFAULT_AXIS)
    }

    // ---- cross-language pin ------------------------------------------------

    private val fixture by lazy {
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/lap-axis.json").readText()).jsonObject
    }

    private fun mode(e: JsonElement): AxisMode = AxisMode.of(e.jsonPrimitive.content)!!
    private fun num(e: JsonElement?): Double? = if (e == null || e is JsonNull) null else e.jsonPrimitive.double
    private fun nums(e: JsonElement?): List<Double>? =
        if (e == null || e is JsonNull) null else e.jsonArray.map { it.jsonPrimitive.double }
    private fun units(e: JsonElement): UnitSystem =
        if (e.jsonPrimitive.content == "metric") UnitSystem.METRIC else UnitSystem.IMPERIAL

    private fun closeList(want: List<Double>?, got: List<Double>?, what: String) {
        if (want == null) {
            assertNull(got, what)
            return
        }
        assertNotNull(got, what)
        assertEquals(want.size, got!!.size, what)
        want.indices.forEach { assertTrue(abs(want[it] - got[it]) <= 1e-9, "$what[$it]: ${want[it]} vs ${got[it]}") }
    }

    @Test
    fun `matches the fixture's constants`() {
        val c = fixture["constants"]!!.jsonObject
        assertEquals(c["axisModes"]!!.jsonArray.map { it.jsonPrimitive.content }, LapAxis.AXIS_MODES.map { it.key })
        assertEquals(c["defaultAxis"]!!.jsonPrimitive.content, LapAxis.DEFAULT_AXIS.key)
        assertEquals(c["timeTickSteps"]!!.jsonArray.map { it.jsonPrimitive.int }, LapAxis.TIME_TICK_STEPS)
        assertEquals(c["timeTickTarget"]!!.jsonPrimitive.int, LapAxis.TIME_TICK_TARGET)
    }

    @Test
    fun `matches the web implementation's reference output`() {
        val json = Json { ignoreUnknownKeys = false }
        val input = fixture["input"]!!.jsonObject
        val dStepM = input["dStepM"]!!.jsonPrimitive.double
        val laps = json.decodeFromJsonElement<List<LapChannels>>(input["laps"]!!)
        val expected = fixture["expected"]!!.jsonObject

        for (row in expected["lapAxisSeries"]!!.jsonArray.map { it.jsonObject }) {
            val lap = row["lap"]!!.jsonPrimitive.int
            val m = mode(row["mode"]!!)
            closeList(nums(row["xs"]), LapAxis.lapAxisSeries(laps[lap], dStepM, m), "lapAxisSeries $lap $m")
        }
        for (row in expected["axisExtent"]!!.jsonArray.map { it.jsonObject }) {
            close(num(row["x1"])!!, LapAxis.axisExtent(laps, dStepM, mode(row["mode"]!!)))
        }
        for (row in expected["gridAtAxis"]!!.jsonArray.map { it.jsonObject }) {
            val xs = LapAxis.lapAxisSeries(laps[row["lap"]!!.jsonPrimitive.int], dStepM, mode(row["mode"]!!))
            val want = num(row["k"])
            val got = LapAxis.gridAtAxis(xs, num(row["x"]))
            if (want == null) assertNull(got, "gridAtAxis $row") else close(want, got)
        }
        for (row in expected["axisAtGrid"]!!.jsonArray.map { it.jsonObject }) {
            val xs = LapAxis.lapAxisSeries(laps[row["lap"]!!.jsonPrimitive.int], dStepM, mode(row["mode"]!!))
            val want = num(row["x"])
            val got = LapAxis.axisAtGrid(xs, num(row["k"]))
            if (want == null) assertNull(got, "axisAtGrid $row") else close(want, got)
        }
        for (row in expected["axisPlaces"]!!.jsonArray.map { it.jsonObject }) {
            val lit = row["lit"]!!.jsonArray.map { it.jsonPrimitive.int }
            val got = LapAxis.axisPlaces(laps, dStepM, mode(row["mode"]!!), num(row["x"]), lit)
            val want = (row["places"] as JsonArray).map { it.jsonObject }
            assertEquals(want.map { it["chIdx"]!!.jsonPrimitive.int }, got.map { it.chIdx }, "axisPlaces $row")
            want.forEachIndexed { i, p ->
                close(num(p["k"])!!, got[i].k)
                close(num(p["frac"])!!, got[i].frac)
            }
        }
        for (row in expected["timeAxisTicks"]!!.jsonArray.map { it.jsonObject }) {
            val want = row["ticks"]!!.jsonArray.map { it.jsonObject }
            val got = LapAxis.timeAxisTicks(num(row["x1"])!!)
            assertEquals(want.map { it["label"]!!.jsonPrimitive.content }, got.map { it.label }, "ticks $row")
            closeList(want.map { num(it["s"])!! }, got.map { it.s }, "ticks $row")
        }
        for (row in expected["fmtAxisSeconds"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(row["text"]!!.jsonPrimitive.content, LapAxis.fmtAxisSeconds(num(row["s"])!!), "$row")
        }
        for (row in expected["fmtAxisValue"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(
                row["text"]!!.jsonPrimitive.content,
                LapAxis.fmtAxisValue(num(row["x"]), mode(row["mode"]!!), units(row["units"]!!)),
                "$row",
            )
        }
    }
}
