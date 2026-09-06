package app.trackevolution.core

import app.trackevolution.core.model.TracePoint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import kotlin.math.roundToInt

/**
 * [TrackMap.traceIndexAtFraction], pinned against the web implementation
 * (`contracts/logic/trackmap.json`) — the mapping behind "which corner is this
 * dot" (NS-34 ticket 3).
 *
 * The same fixture the iOS port asserts against, so both are checked against
 * `public/js/trackmap.js` rather than against each other.
 */
class TrackMapTest {

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/trackmap.json").readText(),
    ).jsonObject

    private val trace: List<TracePoint> =
        fixture["input"]!!.jsonObject["trace"]!!.jsonArray.map { point ->
            val xyv = point.jsonArray.map { it.jsonPrimitive.double }
            TracePoint(x = xyv[0], y = xyv[1], v = xyv[2])
        }

    @Test
    fun `matches the JavaScript implementation on the shared fixture`() {
        val expected = fixture["expected"]!!.jsonObject
        for (entry in expected["atFraction"]!!.jsonArray) {
            val o = entry.jsonObject
            val frac = o["frac"]!!.jsonPrimitive.double
            assertEquals(
                o["idx"]!!.jsonPrimitive.int,
                TrackMap.traceIndexAtFraction(trace, frac),
                "fraction $frac",
            )
        }
    }

    /**
     * The claim the fixture exists to make: the walk is along **distance**, not
     * along sample index.
     *
     * The fixture's trace spends five of its ten points crawling through one
     * short straight, so a quarter of the way round by distance is a long way
     * past a quarter of the way through the samples. A port that indexed by count
     * would pass a smoke test and be wrong by a corner on every real lap.
     */
    @Test
    fun `walks by distance rather than by sample count`() {
        assertNotEquals(
            ((trace.size - 1) * 0.25).roundToInt(),
            TrackMap.traceIndexAtFraction(trace, 0.25),
        )
    }

    /**
     * Degenerate traces answer null, never 0: ringing the start line would say
     * the dot belongs there.
     */
    @Test
    fun `degenerate traces have no point to ring`() {
        assertNull(TrackMap.traceIndexAtFraction(emptyList(), 0.5))
        assertNull(TrackMap.traceIndexAtFraction(listOf(TracePoint(0.0, 0.0, 1.0)), 0.5))
        assertNull(TrackMap.traceIndexAtFraction(List(3) { TracePoint(5.0, 5.0, 0.0) }, 0.5))
    }

    /** Out of range is clamped: a fraction is a position, and the ends are positions. */
    @Test
    fun `fractions outside the lap clamp to its ends`() {
        val straight = listOf(
            TracePoint(0.0, 0.0, 10.0),
            TracePoint(10.0, 0.0, 10.0),
            TracePoint(20.0, 0.0, 10.0),
        )
        assertEquals(0, TrackMap.traceIndexAtFraction(straight, -3.0))
        assertEquals(straight.size - 1, TrackMap.traceIndexAtFraction(straight, 4.0))
    }
}
