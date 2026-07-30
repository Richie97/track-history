package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Ported from `test/unit/geo.test.js`, case for case. The `circleTrace` fixture
 * mirrors `circleTrace()` in `test/fixtures/build.mjs` — same radius, speed,
 * sample rate and revolution count — so both suites run on identical geometry.
 */
class GeoTraceTest {

    private companion object {
        const val RADIUS = 300.0
        const val SPEED = 40.0
        const val LAT0 = 36.56
        const val LON0 = -79.2

        /** Seconds per lap for the fixture circle: 2πr/v ≈ 47.12 s. */
        fun lapS(radius: Double = RADIUS, speed: Double = SPEED) = (2 * Math.PI * radius) / speed

        /** 47124 — the same value the JS suite derives. */
        val LAP_MS = JsMath.roundToInt(lapS() * 1000.0)
    }

    private fun <T : Any> present(value: T?, message: String = "expected non-null"): T {
        assertNotNull(value, message)
        return value!!
    }

    /**
     * Counter-clockwise circle. With `revolutions = 3.3` a start/finish line at a
     * quarter turn is crossed 4 times, giving 3 derived laps.
     *
     * Note the JS fixture sets `v` on every point, so the "derives speed from the
     * geometry" case there never actually exercises the fallback. [withSpeed]
     * lets this suite test both paths.
     */
    private fun circleTrace(
        revolutions: Double = 3.3,
        radius: Double = RADIUS,
        speed: Double = SPEED,
        hz: Int = 10,
        withSpeed: Boolean = true,
    ): List<GpsPoint> {
        val totalS = (2 * Math.PI * radius * revolutions) / speed
        val n = Math.floor(totalS * hz).toInt()
        val kx = 111_320.0 * Math.cos(LAT0 * Math.PI / 180.0)
        val ky = 110_540.0
        return (0..n).map { i ->
            val t = i.toDouble() / hz
            val ang = (speed * t) / radius
            GpsPoint(
                t = t,
                lat = LAT0 + (radius * Math.sin(ang)) / ky,
                lon = LON0 + (radius * Math.cos(ang)) / kx,
                v = if (withSpeed) speed else null,
            )
        }
    }

    /** The quarter-turn point at 10 Hz — where the JS suite places the gate. */
    private fun quarterTurnIdx() = JsMath.roundToInt(0.25 * lapS() * 10)

    @Nested
    inner class ProjectTrace {

        @Test
        fun `projects to meters relative to the origin`() {
            val trace = GeoTrace.projectTrace(
                listOf(
                    GpsPoint(0.0, 36.56, -79.2, null),
                    GpsPoint(1.0, 36.561, -79.2, null),
                )
            )
            assertEquals(0.0, trace[0].x)
            assertEquals(0.0, trace[0].y)
            assertEquals(110.54, trace[1].y, 0.05) // 0.001 deg lat ≈ 110.5 m
            assertEquals(0.0, trace[1].x)
        }

        @Test
        fun `uses a shared origin so gates transfer between traces`() {
            // This is what lets one picked line apply to a whole import batch.
            val origin = GpsPoint(0.0, 36.56, -79.2, null)
            val a = GeoTrace.projectTrace(listOf(GpsPoint(0.0, 36.561, -79.2, null)), origin)
            val b = GeoTrace.projectTrace(listOf(GpsPoint(0.0, 36.561, -79.2, null)), origin)
            assertEquals(a[0], b[0])
        }

        @Test
        fun `returns empty for an empty trace instead of throwing`() {
            assertEquals(emptyList<TracePoint>(), GeoTrace.projectTrace(emptyList()))
        }
    }

    @Nested
    inner class LapDerivationOnACircle {

        @Test
        fun `derives one lap per revolution across a picked point`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val gate = present(GeoTrace.buildGate(trace, quarterTurnIdx()))
            val laps = GeoTrace.deriveLaps(trace, gate)
            assertEquals(3, laps.size)
            for (lap in laps) {
                assertTrue(Math.abs(lap.timeMs - LAP_MS) < 200) {
                    "lap ${lap.timeMs}ms differs from expected ${LAP_MS}ms by too much"
                }
                assertTrue(lap.estimated)
            }
        }

        @Test
        fun `derives the same laps from an explicit two-point gate`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val g = present(GeoTrace.buildGate(trace, quarterTurnIdx()))
            val laps = GeoTrace.deriveLaps(
                trace,
                GeoTrace.gateFromSegment(Point(g.x1, g.y1), Point(g.x2, g.y2)),
            )
            assertEquals(3, laps.size)
        }

        @Test
        fun `builds a gate even where the car is turning slowly`() {
            // The widening heading window (3 -> 6 -> 12 -> 24) exists for this:
            // at 1 Hz round a tight radius the immediate neighbours are close
            // enough that the narrow window alone would give no usable heading.
            val trace = GeoTrace.projectTrace(circleTrace(radius = 20.0, speed = 5.0, hz = 1))
            assertNotNull(GeoTrace.buildGate(trace, 5))
        }

        @Test
        fun `returns null for a gate picked where the car never moved`() {
            val still = (0..40).map { TracePoint(it.toDouble(), 0.0, 0.0, 0.0) }
            assertNull(GeoTrace.buildGate(still, 20))
        }

        @Test
        fun `returns null for an out-of-range index`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            assertNull(GeoTrace.buildGate(trace, trace.size))
            assertNull(GeoTrace.buildGate(emptyList(), 0))
        }
    }

    @Nested
    inner class GateCrossingsDirectionFilter {

        /** Straight out-and-back: crosses y=0 northbound at t=10, southbound at t=110. */
        private val outAndBack: List<TracePoint> = buildList {
            for (i in 0..20) add(TracePoint(i.toDouble(), 0.0, (i - 10) * 10.0))
            for (i in 1..20) add(TracePoint(100.0 + i, 0.0, (10 - i) * 10.0))
        }

        @Test
        fun `counts only crossings in the gate's direction of travel`() {
            val gate = present(GeoTrace.buildGate(outAndBack, 10)) // heading north
            assertEquals(listOf(10.0), GeoTrace.gateCrossings(outAndBack, gate))
        }

        @Test
        fun `counts both directions for heading-less gates`() {
            val gate = GeoTrace.gateFromSegment(Point(-20.0, 0.0), Point(20.0, 0.0))
            assertEquals(listOf(10.0, 110.0), GeoTrace.gateCrossings(outAndBack, gate))
        }

        @Test
        fun `treats near-simultaneous crossings as jitter`() {
            val jitter = listOf(
                TracePoint(0.0, 0.0, -5.0),
                TracePoint(1.0, 0.0, 5.0), // crossing ~0.5
                TracePoint(2.0, 0.0, -5.0), // jitter back
                TracePoint(3.0, 0.0, 5.0), // crossing ~2.5, within minGapS
            )
            val gate = GeoTrace.gateFromSegment(Point(-20.0, 0.0), Point(20.0, 0.0))
            assertEquals(1, GeoTrace.gateCrossings(jitter, gate).size)
        }

        @Test
        fun `interpolates the crossing time within the segment`() {
            // The whole point of interpolating: at 1 Hz the crossing is timed to
            // a fraction of a sample, not snapped to one. Here y goes -5 -> 5
            // across one second, so the crossing is at t = 0.5, not 0 or 1.
            val seg = listOf(TracePoint(0.0, 0.0, -5.0), TracePoint(1.0, 0.0, 5.0))
            val gate = GeoTrace.gateFromSegment(Point(-20.0, 0.0), Point(20.0, 0.0))
            assertEquals(0.5, GeoTrace.gateCrossings(seg, gate).single(), 1e-9)
        }
    }

    @Nested
    inner class LapsFromCrossings {

        @Test
        fun `drops deltas that cannot be laps`() {
            // 10s (jitter), 47s (lap), 2h gap (parked), 47s (lap)
            val laps = GeoTrace.lapsFromCrossings(listOf(0.0, 10.0, 57.0, 7257.0, 7304.0))
            assertEquals(listOf(47_000, 47_000), laps.map { it.timeMs })
        }

        @Test
        fun `carries the trace-clock window for per-lap channel cutting`() {
            val laps = GeoTrace.lapsFromCrossings(listOf(10.0, 57.5))
            assertEquals(1, laps.size)
            assertEquals(10.0, laps[0].startT)
            assertEquals(57.5, laps[0].endT)
            assertEquals(47_500, laps[0].timeMs)
        }
    }

    @Nested
    inner class LapTraceExtraction {

        @Test
        fun `slices the window and keeps x y v triples`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val out = present(GeoTrace.lapTrace(trace, 0.0, lapS()))
            assertTrue(out.size > 10)
            assertTrue(out.size <= 301)
            for (p in out) {
                assertTrue(p.x.isFinite() && p.y.isFinite() && p.v.isFinite())
            }
        }

        @Test
        fun `downsamples long windows to roughly the point budget`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val out = present(GeoTrace.lapTrace(trace, 0.0, lapS(), max = 50))
            assertTrue(out.size <= 51) { "size=${out.size}" }
            assertTrue(out.size > 25) { "size=${out.size}" }
        }

        @Test
        fun `uses the source speed when it has one`() {
            val trace = GeoTrace.projectTrace(circleTrace(withSpeed = true))
            val out = present(GeoTrace.lapTrace(trace, 0.0, lapS()))
            assertTrue(out.all { it.v == SPEED }) { "expected the reported constant speed" }
        }

        @Test
        fun `derives speed from the geometry when the source has none`() {
            // The JS suite intends to cover this but its fixture always sets v,
            // so the fallback goes untested there. Driven at constant speed, the
            // derived values should be near-uniform and positive.
            val trace = GeoTrace.projectTrace(circleTrace(withSpeed = false))
            val speeds = present(GeoTrace.lapTrace(trace, 0.0, lapS())).map { it.v }
            assertTrue(speeds.min() > 0.0)
            assertTrue(speeds.max() / speeds.min() < 1.2) {
                "derived speeds too uneven: ${speeds.min()}..${speeds.max()}"
            }
            // Chord-based sampling slightly under-reads a curve, so allow 2%.
            assertTrue(Math.abs(speeds.average() - SPEED) / SPEED < 0.02) {
                "derived mean ${speeds.average()} should be close to $SPEED"
            }
        }

        @Test
        fun `always includes the final point`() {
            // Otherwise the stored polyline stops short of the gate and the
            // rendered racing line has a visible gap at the start/finish.
            val trace = (0..99).map { TracePoint(it.toDouble(), it * 10.0, 0.0, 25.0) }
            val out = present(GeoTrace.lapTrace(trace, 0.0, 99.0, max = 7))
            assertEquals(JsMath.round(trace.last().x, 10.0), out.last().x)
        }

        @Test
        fun `returns null for windows with too few points`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            assertNull(GeoTrace.lapTrace(trace, 0.0, 0.5))
        }
    }

    @Nested
    inner class JsParity {

        /**
         * Exact-value parity against the JavaScript on identical geometry. Every
         * expected number here came from running `public/js/import/geo.js` over
         * `circleTrace()` in Node — not derived by hand.
         *
         * The other cases in this file assert ranges and counts, which would
         * survive a subtly wrong projection or a half-sample timing error. These
         * would not.
         */
        @Test
        fun `matches the JS gate, crossings and lap times exactly`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val g = present(GeoTrace.buildGate(trace, quarterTurnIdx()))

            assertEquals(-300.7611, g.x, 1e-4)
            assertEquals(299.9990, g.y, 1e-4)
            assertEquals(-0.999997, g.hx!!, 1e-6)
            assertEquals(-0.002537, g.hy!!, 1e-6)
            assertEquals(-300.8118, g.x1, 1e-4)
            assertEquals(319.9990, g.y1, 1e-4)

            // Interpolated crossing times, to the microsecond.
            val crossings = GeoTrace.gateCrossings(trace, g)
            val expected = listOf(11.8, 58.923890, 106.047780, 153.171669)
            assertEquals(expected.size, crossings.size)
            expected.forEachIndexed { i, e -> assertEquals(e, crossings[i], 1e-6) }

            // Integer milliseconds, exactly equal — not approximately.
            assertEquals(listOf(47_124, 47_124, 47_124), GeoTrace.deriveLaps(trace, g).map { it.timeMs })
        }

        @Test
        fun `matches the JS lap polyline exactly`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val g = present(GeoTrace.buildGate(trace, quarterTurnIdx()))

            val best = present(GeoTrace.bestLapTrace(trace, g))
            assertEquals(236, best.size)
            assertEquals(TraceSample(-302.8, 300.0, 40.0), best.first())
            assertEquals(TraceSample(-297.9, 300.0, 40.0), best.last())

            // Downsampling stride and rounding both have to agree.
            val lt = present(GeoTrace.lapTrace(trace, 0.0, lapS(), max = 50))
            assertEquals(49, lt.size)
            assertEquals(TraceSample(0.0, 0.0, 40.0), lt.first())
        }
    }

    @Nested
    inner class BestLapTrace {

        @Test
        fun `extracts one lap's worth of points across the gate`() {
            val trace = GeoTrace.projectTrace(circleTrace())
            val gate = present(GeoTrace.buildGate(trace, quarterTurnIdx()))
            val out = present(GeoTrace.bestLapTrace(trace, gate))
            // one lap at 10 Hz ≈ 471 samples, downsampled to ≤ 300
            assertTrue(out.size > 100) { "size=${out.size}" }
            assertTrue(out.size <= 301) { "size=${out.size}" }
            // the lap starts and ends at the gate: closed loop, ends near each other
            val first = out.first()
            val last = out.last()
            assertTrue(Math.hypot(first.x - last.x, first.y - last.y) < 20) {
                "lap polyline does not close at the gate"
            }
        }

        @Test
        fun `returns null when no valid lap crosses the gate`() {
            val straight = (0..100).map { TracePoint(it.toDouble(), it * 10.0, 0.0) }
            val gate = present(GeoTrace.buildGate(straight, 50))
            assertNull(GeoTrace.bestLapTrace(straight, gate))
        }
    }
}
