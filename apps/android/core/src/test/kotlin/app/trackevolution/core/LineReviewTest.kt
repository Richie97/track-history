package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The two ways a pick legitimately produces nothing, and the one way it works.
 *
 * These matter because each needs something specific said to the driver. A pick
 * that silently yields an empty lap list is the dead end NS-17's wording
 * requirement exists to prevent.
 */
class LineReviewTest {

    /** Three laps of a 200 m-radius circle (1257 m round) at 25 m/s, sampled at 5 Hz. */
    private fun circleTrace(laps: Int = 3): List<TracePoint> {
        val radius = 200.0
        val speed = 25.0
        val circumference = 2 * Math.PI * radius
        val lapS = circumference / speed
        val dt = 0.2
        val out = ArrayList<TracePoint>()
        var t = 0.0
        while (t <= lapS * laps) {
            val theta = 2 * Math.PI * (t / lapS)
            out.add(TracePoint(t, radius * Math.cos(theta), radius * Math.sin(theta), speed))
            t += dt
        }
        return out
    }

    /** A car parked in the paddock: hundreds of samples, all in the same spot. */
    private fun stationaryTrace(): List<TracePoint> =
        (0 until 200).map { TracePoint(it * 0.2, 10.0, 20.0, 0.0) }

    @Test
    fun `a pick on a circuit gives laps`() {
        val trace = circleTrace(laps = 3)
        val result = LineReview.pick(trace, trace.size / 2)
        assertNotNull(result.gate)
        assertNull(result.problem)
        assertTrue(result.hasLaps)
        // Three passes past the start point yield two complete laps between them.
        assertEquals(2, result.laps.size, "laps were ${result.laps.map { it.timeMs }}")
        result.laps.forEach {
            // 1257 m at 25 m/s is ~50.3 s; the tolerance is the 5 Hz sampling,
            // not slack.
            assertTrue(
                it.timeMs in 48_700..51_800,
                "expected ~50.3 s, got ${it.timeMs} ms",
            )
        }
    }

    /**
     * `buildGate` needs a direction of travel; a parked car has none, however
     * wide the window it looks at.
     */
    @Test
    fun `a stationary pick is named, not silently empty`() {
        val result = LineReview.pick(stationaryTrace(), 100)
        assertNull(result.gate)
        assertEquals(LineReview.Problem.STATIONARY_PICK, result.problem)
        assertTrue(result.laps.isEmpty())
    }

    /**
     * A gate on a piece of road driven once — an out-lap that never came back —
     * is a different problem from a stationary pick and needs different advice.
     */
    @Test
    fun `a line nothing crosses twice is named`() {
        // Half a lap: the trace passes any given point exactly once.
        val trace = circleTrace(laps = 3).take(circleTrace(laps = 3).size / 6)
        val result = LineReview.pick(trace, trace.size / 2)
        assertNotNull(result.gate, "a gate can still be built — the car was moving")
        assertEquals(LineReview.Problem.NO_CROSSINGS, result.problem)
        assertTrue(result.laps.isEmpty())
    }

    @Test
    fun `an out-of-range pick is refused rather than crashing`() {
        val trace = circleTrace()
        assertEquals(LineReview.Problem.STATIONARY_PICK, LineReview.pick(trace, -1).problem)
        assertEquals(LineReview.Problem.STATIONARY_PICK, LineReview.pick(trace, trace.size).problem)
        assertEquals(LineReview.Problem.STATIONARY_PICK, LineReview.pick(emptyList(), 0).problem)
    }

    @Test
    fun `the best lap is the quickest one`() {
        val laps = listOf(
            Lap(timeMs = 121_000, estimated = false, startT = 0.0, endT = 121.0),
            Lap(timeMs = 118_500, estimated = false, startT = 121.0, endT = 239.5),
            Lap(timeMs = 119_900, estimated = true, startT = 239.5, endT = 359.4),
        )
        assertEquals(1, LineReview.bestLapIndex(laps))
        assertNull(LineReview.bestLapIndex(emptyList()))
    }

    @Test
    fun `nothing picked is not a problem`() {
        assertNull(LineReview.EMPTY.problem)
        assertNull(LineReview.EMPTY.gate)
        assertTrue(!LineReview.EMPTY.hasLaps)
    }
}
