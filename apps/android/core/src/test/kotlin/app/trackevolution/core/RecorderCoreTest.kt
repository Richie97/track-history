package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.time.ZoneId

/**
 * The Kotlin half of `test/unit/record.test.js` (NS-12). Every case there has an
 * equivalent here with the same inputs and expectations — if one suite is
 * changed, the other must change with it, or the web and Android recorders have
 * silently diverged.
 *
 * The one deliberate gap: the JS `toParsed` case continues into
 * `projectTrace`/`buildGate`/`deriveLaps` from js/import/geo.js to prove the
 * derived lap times. That is the lap-geometry port (NS-14); the shared-fixture
 * lap-time comparison lands with it.
 */
class RecorderCoreTest {

    // Mirrors the `syntheticRecording` helper in the JS suite: a synthetic track
    // day at 1 Hz — idle in the paddock, then `laps` laps of a 200 m-radius
    // circle at 25 m/s (~50.3 s/lap), then idle again.
    private class Synthetic(val rec: RecordingBuilder, val lapS: Double, val driveS: Int)

    private fun syntheticRecording(
        idleBeforeS: Int = 120,
        laps: Int = 5,
        idleAfterS: Int = 120,
        speed: Double = 25.0,
        startedAtMs: Double = 1_750_000_000_000.0,
    ): Synthetic {
        val rec = createRecording(1L, startedAtMs)
        val r = 200.0
        val lapS = 2 * Math.PI * r / speed
        val driveS = Math.round(laps * lapS).toInt()
        var t = 0
        fun push(lat: Double, lon: Double, v: Double) {
            rec.addFix(GpsFix(startedAtMs + t++ * 1000.0, lat, lon, v, 5.0))
        }
        repeat(idleBeforeS) { push(LAT0, LON0 - 500 / KX, 0.0) }
        for (i in 0..driveS) {
            val a = i * speed / r
            push(LAT0 + r * Math.sin(a) / KY, LON0 + r * Math.cos(a) / KX, speed)
        }
        repeat(idleAfterS) { push(LAT0, LON0 - 500 / KX, 0.0) }
        return Synthetic(rec, lapS, driveS)
    }

    @Nested
    inner class AddFix {

        @Test
        fun `keeps plausible fixes and rejects garbage`() {
            val rec = createRecording(1L, 1000.0)
            assertTrue(rec.addFix(GpsFix(2000.0, 36.5, -79.2, speed = 3.0, accuracy = 8.0)))
            assertFalse(rec.addFix(GpsFix(3000.0, Double.NaN, -79.2)))
            assertFalse(rec.addFix(GpsFix(4000.0, 95.0, -79.2)))
            assertFalse(rec.addFix(GpsFix(5000.0, 36.5, -79.2, accuracy = 500.0))) // hopeless accuracy
            assertFalse(rec.addFix(GpsFix(500.0, 36.5, -79.2))) // before start
            assertFalse(rec.addFix(GpsFix(2000.0, 36.5, -79.2))) // not after the last fix
            assertEquals(1, rec.fixes.size)
            assertEquals(Fix(1.0, 36.5, -79.2, 3.0, 8.0), rec.fixes[0])
        }

        @Test
        fun `stores null for missing speed or accuracy`() {
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(1000.0, 1.0, 2.0))
            assertEquals(Fix(1.0, 1.0, 2.0, null, null), rec.fixes[0])
        }

        @Test
        fun `rejects out-of-range longitude and non-finite time`() {
            val rec = createRecording(null, 0.0)
            assertFalse(rec.addFix(GpsFix(1000.0, 36.5, 181.0)))
            assertFalse(rec.addFix(GpsFix(Double.NaN, 36.5, -79.2)))
            assertFalse(rec.addFix(GpsFix(1000.0, 36.5, Double.POSITIVE_INFINITY)))
            assertTrue(rec.fixes.isEmpty())
        }

        @Test
        fun `keeps a fix whose accuracy is reported as non-finite`() {
            // JS: `Number.isFinite(accuracy)` is false, so the fix is neither
            // rejected by the MAX_ACC_M test nor stored with an accuracy.
            val rec = createRecording(null, 0.0)
            assertTrue(rec.addFix(GpsFix(1000.0, 36.5, -79.2, accuracy = Double.NaN)))
            assertNull(rec.fixes[0].accuracy)
        }

        @Test
        fun `drops a negative reported speed rather than storing it`() {
            // Android's Location.getSpeed() is 0 when unknown, but a replayed or
            // synthetic source can hand back a sentinel.
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(1000.0, 36.5, -79.2, speed = -1.0))
            assertNull(rec.fixes[0].speed)
        }

        @Test
        fun `rounds to the checkpoint's precision, including negative values`() {
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(1234.0, -36.5654321, -79.2123456, speed = 1.005, accuracy = 4.44))
            // t 2dp, lat/lon 6dp, speed 2dp, accuracy 1dp — and 1.005 rounds to
            // 1.0, not 1.01, because 1.005 * 100 is 100.49999999999999.
            assertEquals(Fix(1.23, -36.565432, -79.212346, 1.0, 4.4), rec.fixes[0])
        }

        @Test
        fun `stops accepting fixes at the MAX_FIXES cap`() {
            val rec = createRecording(null, 0.0)
            for (i in 1..MAX_FIXES) assertTrue(rec.addFix(GpsFix(i * 100.0, 36.5, -79.2)))
            assertEquals(MAX_FIXES, rec.fixes.size)
            assertFalse(rec.addFix(GpsFix((MAX_FIXES + 1) * 100.0, 36.5, -79.2)))
            assertEquals(MAX_FIXES, rec.fixes.size)
        }
    }

    @Nested
    inner class FixSpeeds {

        @Test
        fun `prefers reported speed and falls back to displacement rate`() {
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(1000.0, LAT0, LON0))
            rec.addFix(GpsFix(2000.0, LAT0 + 20 / KY, LON0)) // 20 m north in 1 s
            rec.addFix(GpsFix(3000.0, LAT0 + 40 / KY, LON0, speed = 7.0))
            val speeds = fixSpeeds(rec.fixes)
            assertEquals(20.0, speeds[1], 0.5) // 40 m over a 2 s window
            assertEquals(7.0, speeds[2])
        }

        @Test
        fun `clamps the neighbour window at both ends`() {
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(1000.0, LAT0, LON0))
            rec.addFix(GpsFix(2000.0, LAT0 + 20 / KY, LON0))
            val speeds = fixSpeeds(rec.fixes)
            // Both fixes measure over the same one-sided window rather than
            // dropping out of the series.
            assertEquals(20.0, speeds[0], 0.5)
            assertEquals(20.0, speeds[1], 0.5)
        }

        @Test
        fun `is empty for no fixes`() {
            assertEquals(0, fixSpeeds(emptyList()).size)
        }
    }

    @Nested
    inner class ShouldAutoStop {

        @Test
        fun `stops after long-stationary once the car has been driven at pace`() {
            val s = syntheticRecording(idleAfterS = 0)
            val endMs = s.rec.startedAtMs + (120 + s.driveS) * 1000.0
            assertFalse(shouldAutoStop(s.rec, endMs + 5 * 60 * 1000))
            assertTrue(shouldAutoStop(s.rec, endMs + 16 * 60 * 1000))
        }

        @Test
        fun `never stops during a slow-speed wait before the first lap`() {
            // The grid-wait case: a paddock crawl at 3 m/s then a 20-minute
            // wait. Nothing has exceeded DRIVEN_MPS, so auto-stop is unarmed —
            // this is what stops the recorder dying before the session starts.
            val rec = createRecording(null, 0.0)
            for (t in 0 until 60) {
                rec.addFix(GpsFix(t * 1000.0, LAT0 + 3 * t / KY, LON0, speed = 3.0))
            }
            assertFalse(shouldAutoStop(rec, 60 * 1000.0 + 20 * 60 * 1000))
        }

        @Test
        fun `stays unarmed through a two-hour grid wait`() {
            val rec = createRecording(null, 0.0)
            for (t in 0 until 60) {
                rec.addFix(GpsFix(t * 1000.0, LAT0 + 3 * t / KY, LON0, speed = 3.0))
            }
            assertFalse(shouldAutoStop(rec, 2 * 3600 * 1000.0))
        }

        @Test
        fun `always stops at the hard duration cap`() {
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(1000.0, LAT0, LON0, speed = 0.0))
            assertTrue(shouldAutoStop(rec, 5 * 3600 * 1000.0))
        }

        @Test
        fun `honours overridden thresholds`() {
            val s = syntheticRecording(idleAfterS = 0)
            val endMs = s.rec.startedAtMs + (120 + s.driveS) * 1000.0
            assertTrue(shouldAutoStop(s.rec, endMs + 60 * 1000, idleS = 30.0))
            assertFalse(shouldAutoStop(s.rec, endMs + 60 * 1000, drivenMps = 100.0))
        }
    }

    @Nested
    inner class TrimIdle {

        @Test
        fun `cuts stationary tails but keeps a margin around the driving`() {
            val s = syntheticRecording()
            val trimmed = trimIdle(s.rec.fixes)
            assertTrue(trimmed.isNotEmpty())
            val t0 = trimmed.first().t
            val t1 = trimmed.last().t
            assertTrue(t0 >= 120 - 31) { "expected the leading margin to be kept, got $t0" }
            assertTrue(t0 < 120) { "expected some pre-driving context, got $t0" }
            assertTrue(t1 > 120 + s.driveS) { "expected the trailing margin to be kept, got $t1" }
            assertTrue(t1 <= 120 + s.driveS + 31) { "expected the idle tail to be cut, got $t1" }
        }

        @Test
        fun `returns nothing for a recording that never moved`() {
            val rec = createRecording(null, 0.0)
            for (t in 0 until 100) rec.addFix(GpsFix(t * 1000.0, LAT0, LON0, speed = 0.0))
            assertEquals(emptyList<Fix>(), trimIdle(rec.fixes))
        }

        @Test
        fun `passes through a list too short to trim`() {
            val rec = createRecording(null, 0.0)
            rec.addFix(GpsFix(0.0, LAT0, LON0, speed = 0.0))
            assertEquals(rec.fixes, trimIdle(rec.fixes))
        }
    }

    @Nested
    inner class ToParsed {

        @Test
        fun `produces a parser-contract object`() {
            val s = syntheticRecording()
            val parsed = requireNotNull(toParsed(s.rec))
            assertEquals("live", parsed.kind)
            assertTrue(parsed.needsLine)
            assertTrue(Regex("""^\d{4}-\d{2}-\d{2}$""").matches(parsed.date)) { parsed.date }
            assertTrue(Regex("""^\d{2}:\d{2}$""").matches(parsed.time)) { parsed.time }
            assertTrue(parsed.gps.size > 200) { "got ${parsed.gps.size} points" }
            assertEquals(parsed.gps.last().t - parsed.gps.first().t, parsed.durationS)
            // The trace carries the reported speed through for the review charts.
            assertEquals(25.0, parsed.gps[parsed.gps.size / 2].v)
        }

        @Test
        fun `dates the recording in local time, not UTC`() {
            // 1750000000000 is 2025-06-15T15:06:40Z. A recorder in Los Angeles
            // must file that under the day and time the driver saw at the track.
            val s = syntheticRecording()
            assertEquals("2025-06-15", toParsed(s.rec, ZoneId.of("UTC"))!!.date)
            assertEquals("15:06", toParsed(s.rec, ZoneId.of("UTC"))!!.time)
            assertEquals("2025-06-15", toParsed(s.rec, ZoneId.of("America/Los_Angeles"))!!.date)
            assertEquals("08:06", toParsed(s.rec, ZoneId.of("America/Los_Angeles"))!!.time)
        }

        @Test
        fun `returns null for recordings too short to time`() {
            val rec = createRecording(null, 0.0)
            for (t in 0 until 20) {
                rec.addFix(GpsFix(t * 1000.0, LAT0 + 25 * t / KY, LON0, speed = 25.0))
            }
            assertNull(toParsed(rec))
        }

        @Test
        fun `returns null for enough fixes but under a minute of driving`() {
            // 40 fixes at 4 Hz is only 10 s — past the fix count, short on time.
            val rec = createRecording(null, 0.0)
            for (i in 0 until 40) {
                rec.addFix(GpsFix(i * 250.0, LAT0 + 25 * (i / 4.0) / KY, LON0, speed = 25.0))
            }
            assertNull(toParsed(rec))
        }
    }

    private companion object {
        const val LAT0 = 36.56
        const val LON0 = -79.2
        val KX = 111320 * Math.cos(LAT0 * Math.PI / 180)
        const val KY = 110540.0
    }
}
