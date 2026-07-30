package app.trackevolution.core

import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Ported from `test/unit/record.test.js`, case for case, with the same inputs and
 * the same expectations. If one of these fails, the Kotlin recorder has diverged
 * from the web and iOS implementations.
 *
 * The `describe` blocks of the original map to [Nested] classes here so the two
 * files stay readable side by side.
 */
class RecorderCoreTest {

    private companion object {
        const val LAT0 = 36.56
        const val LON0 = -79.2
        val KX = 111_320.0 * Math.cos(LAT0 * Math.PI / 180.0)
        const val KY = 110_540.0
        const val STARTED_AT = 1_750_000_000_000.0
    }

    /**
     * JUnit 5's [assertNotNull] returns Unit, so it cannot narrow the type the
     * way `kotlin.test.assertNotNull` does. This asserts and hands the value
     * back, keeping the test bodies readable.
     */
    private fun <T : Any> present(value: T?, message: String = "expected non-null"): T {
        assertNotNull(value, message)
        return value!!
    }

    /**
     * A synthetic track day at 1Hz: idle in the paddock, then [laps] laps of a
     * 200 m-radius circle at [speed] m/s (~50.3 s/lap), then idle again.
     * Mirrors `syntheticRecording` in the JS suite exactly.
     */
    private class Synthetic(val rec: Recording, val lapS: Double, val driveS: Int)

    private fun syntheticRecording(
        idleBeforeS: Int = 120,
        laps: Int = 5,
        idleAfterS: Int = 120,
        speed: Double = 25.0,
        startedAtMs: Double = STARTED_AT,
    ): Synthetic {
        val rec = RecorderCore.createRecording("ev1", startedAtMs)
        val r = 200.0
        val lapS = (2 * Math.PI * r) / speed
        val driveS = JsMath.roundToInt(laps * lapS)
        var t = 0
        fun push(lat: Double, lon: Double, v: Double) {
            rec.addFix(LocationFix(startedAtMs + t++ * 1000.0, lat, lon, v, 5.0))
        }
        repeat(idleBeforeS) { push(LAT0, LON0 - 500 / KX, 0.0) }
        for (i in 0..driveS) {
            val a = (i * speed) / r
            push(LAT0 + (r * Math.sin(a)) / KY, LON0 + (r * Math.cos(a)) / KX, speed)
        }
        repeat(idleAfterS) { push(LAT0, LON0 - 500 / KX, 0.0) }
        return Synthetic(rec, lapS, driveS)
    }

    @Nested
    inner class AddFix {

        @Test
        fun `keeps plausible fixes and rejects garbage`() {
            val rec = RecorderCore.createRecording("e", 1000.0)
            assertTrue(rec.addFix(LocationFix(2000.0, 36.5, -79.2, 3.0, 8.0)))
            assertFalse(rec.addFix(LocationFix(3000.0, Double.NaN, -79.2)))
            assertFalse(rec.addFix(LocationFix(4000.0, 95.0, -79.2)))
            // hopeless accuracy
            assertFalse(rec.addFix(LocationFix(5000.0, 36.5, -79.2, accuracy = 500.0)))
            // before start
            assertFalse(rec.addFix(LocationFix(500.0, 36.5, -79.2)))
            // not after the last fix
            assertFalse(rec.addFix(LocationFix(2000.0, 36.5, -79.2)))
            assertEquals(1, rec.fixes.size)
            assertEquals(Fix(1.0, 36.5, -79.2, 3.0, 8.0), rec.fixes[0])
        }

        @Test
        fun `stores null for missing speed and accuracy`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            rec.addFix(LocationFix(1000.0, 1.0, 2.0))
            assertEquals(Fix(1.0, 1.0, 2.0, null, null), rec.fixes[0])
        }

        @Test
        fun `rejects a negative reported speed rather than storing it`() {
            // Platforms signal "no speed" with a negative sentinel (CoreLocation
            // uses -1). It must become null, never a bogus zero or a negative.
            val rec = RecorderCore.createRecording("e", 0.0)
            rec.addFix(LocationFix(1000.0, 1.0, 2.0, speed = -1.0))
            assertNull(rec.fixes[0].speed)
        }

        @Test
        fun `stops accepting fixes at MAX_FIXES`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            repeat(RecorderCore.MAX_FIXES) { i ->
                rec.addFix(LocationFix((i + 1) * 100.0, LAT0, LON0, 25.0, 5.0))
            }
            assertEquals(RecorderCore.MAX_FIXES, rec.fixes.size)
            assertFalse(rec.addFix(LocationFix(1e9, LAT0, LON0, 25.0, 5.0)))
            assertEquals(RecorderCore.MAX_FIXES, rec.fixes.size)
        }
    }

    @Nested
    inner class FixSpeeds {

        @Test
        fun `prefers reported speed and falls back to displacement rate`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            rec.addFix(LocationFix(1000.0, LAT0, LON0))
            rec.addFix(LocationFix(2000.0, LAT0 + 20 / KY, LON0)) // 20 m north in 1 s
            rec.addFix(LocationFix(3000.0, LAT0 + 40 / KY, LON0, speed = 7.0))
            val speeds = RecorderCore.fixSpeeds(rec.fixes)
            assertEquals(20.0, speeds[1], 0.5) // 40 m over a 2 s window
            assertEquals(7.0, speeds[2])
        }

        @Test
        fun `is empty for no fixes`() {
            assertEquals(emptyList<Double>(), RecorderCore.fixSpeeds(emptyList()))
        }
    }

    @Nested
    inner class ShouldAutoStop {

        @Test
        fun `stops after long-stationary once the car has been driven at pace`() {
            val s = syntheticRecording(idleAfterS = 0)
            val endMs = s.rec.startedAtMs + (120 + s.driveS) * 1000.0
            assertFalse(RecorderCore.shouldAutoStop(s.rec, endMs + 5 * 60 * 1000.0))
            assertTrue(RecorderCore.shouldAutoStop(s.rec, endMs + 16 * 60 * 1000.0))
        }

        @Test
        fun `never stops during a slow-speed wait before the first lap`() {
            // This is the grid-wait exemption, and it is the reason the "driven
            // first" condition exists. A paddock crawl at 3 m/s is above IDLE_MPS
            // but never reaches DRIVEN_MPS, so auto-stop stays disarmed.
            val rec = RecorderCore.createRecording("e", 0.0)
            for (t in 0 until 60) {
                rec.addFix(LocationFix(t * 1000.0, LAT0 + (3.0 * t) / KY, LON0, speed = 3.0))
            }
            assertFalse(RecorderCore.shouldAutoStop(rec, 60 * 1000.0 + 20 * 60 * 1000.0))
        }

        @Test
        fun `always stops at the hard duration cap`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            rec.addFix(LocationFix(1000.0, LAT0, LON0, speed = 0.0))
            assertTrue(RecorderCore.shouldAutoStop(rec, 5 * 3600 * 1000.0))
        }
    }

    @Nested
    inner class TrimIdle {

        @Test
        fun `cuts stationary tails but keeps a margin around the driving`() {
            val s = syntheticRecording()
            val trimmed = RecorderCore.trimIdle(s.rec.fixes)
            assertTrue(trimmed.isNotEmpty())
            val t0 = trimmed.first().t
            val t1 = trimmed.last().t
            assertTrue(t0 >= 120 - 31) { "t0=$t0 trimmed too much before the driving" }
            assertTrue(t0 < 120) { "t0=$t0 should keep some pre-driving margin" }
            assertTrue(t1 > 120 + s.driveS) { "t1=$t1 trimmed into the driving" }
            assertTrue(t1 <= 120 + s.driveS + 31) { "t1=$t1 kept too much cool-down" }
        }

        @Test
        fun `returns nothing for a recording that never moved`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            for (t in 0 until 100) rec.addFix(LocationFix(t * 1000.0, LAT0, LON0, speed = 0.0))
            assertEquals(emptyList<Fix>(), RecorderCore.trimIdle(rec.fixes))
        }
    }

    @Nested
    inner class ToParsed {

        @Test
        fun `produces the parser-contract object a file import also produces`() {
            val s = syntheticRecording()
            val parsed = present(RecorderCore.toParsed(s.rec, ZoneId.of("America/New_York")))
            assertEquals("live", parsed.kind)
            assertTrue(parsed.needsLine)
            assertEquals(emptyList<Nothing>(), parsed.laps)
            assertTrue(parsed.gps.size > 200) { "gps=${parsed.gps.size}" }
            assertTrue(Regex("""^\d{4}-\d{2}-\d{2}$""").matches(parsed.date)) { parsed.date }
            assertTrue(Regex("""^\d{2}:\d{2}$""").matches(parsed.time)) { parsed.time }
        }

        @Test
        fun `renders date and time in local time, not UTC`() {
            // STARTED_AT is 2025-06-15T15:06:40Z. Track time is phone time, so a
            // recording made in the eastern US must be stamped 11:06, not the UTC
            // hour. These values were produced by running the real JS toParsed
            // under TZ=America/New_York, not derived by hand.
            val s = syntheticRecording()
            val ny = present(RecorderCore.toParsed(s.rec, ZoneId.of("America/New_York")))
            val utc = present(RecorderCore.toParsed(s.rec, ZoneId.of("UTC")))
            assertEquals("2025-06-15", ny.date)
            assertEquals("11:06", ny.time)
            assertEquals("15:06", utc.time)
        }

        @Test
        fun `matches the JS reference output for the synthetic track day`() {
            // Same fixture, same numbers as the JS module produces:
            //   date=2025-06-15 time=11:06 gps=312 durationS=311
            val s = syntheticRecording()
            val parsed = present(RecorderCore.toParsed(s.rec, ZoneId.of("America/New_York")))
            assertEquals(312, parsed.gps.size)
            assertEquals(311.0, parsed.durationS)
        }

        @Test
        fun `laps derive from the parsed output via the line-picker path`() {
            // The end-to-end case from test/unit/record.test.js: exactly the flow
            // js/import/ui.js runs after the user picks a start/finish line on a
            // live recording. This is what makes a native recording become laps,
            // and it could not be ported until GeoTrace landed (NS-14).
            val s = syntheticRecording()
            val parsed = present(RecorderCore.toParsed(s.rec))
            val trace = GeoTrace.projectTrace(parsed.gps)
            // pick a point mid-drive, away from the trim margins
            val gate = present(GeoTrace.buildGate(trace, trace.size / 2))
            val laps = GeoTrace.deriveLaps(trace, gate)

            assertTrue(laps.size >= 3) { "expected at least 3 laps, got ${laps.size}" }
            for (lap in laps) {
                val seconds = lap.timeMs / 1000.0
                assertTrue(seconds > s.lapS - 2) { "lap ${seconds}s too short vs ${s.lapS}s" }
                assertTrue(seconds < s.lapS + 2) { "lap ${seconds}s too long vs ${s.lapS}s" }
                assertTrue(lap.estimated) { "GPS-derived laps must stay flagged estimated" }
            }
        }

        @Test
        fun `returns null for recordings too short to time`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            for (t in 0 until 20) {
                rec.addFix(LocationFix(t * 1000.0, LAT0 + (25.0 * t) / KY, LON0, speed = 25.0))
            }
            assertNull(RecorderCore.toParsed(rec))
        }

        @Test
        fun `returns null when the duration is under a minute`() {
            // 40 fixes clears the 30-fix floor but spans only 39 s.
            val rec = RecorderCore.createRecording("e", 0.0)
            for (t in 0 until 40) {
                rec.addFix(LocationFix(t * 1000.0, LAT0 + (25.0 * t) / KY, LON0, speed = 25.0))
            }
            assertNull(RecorderCore.toParsed(rec))
        }
    }

    @Nested
    inner class CheckpointSerialization {

        @Test
        fun `round-trips a recording`() {
            val s = syntheticRecording(idleBeforeS = 5, laps = 1, idleAfterS = 5)
            val back = RecorderCore.deserializeRecording(RecorderCore.serializeRecording(s.rec))
            assertEquals(s.rec, back)
        }

        @Test
        fun `rejects corrupt checkpoints instead of throwing`() {
            assertNull(RecorderCore.deserializeRecording(null))
            assertNull(RecorderCore.deserializeRecording(""))
            assertNull(RecorderCore.deserializeRecording("not json{"))
            assertNull(RecorderCore.deserializeRecording("""{"v":99,"fixes":[]}"""))
            assertNull(
                RecorderCore.deserializeRecording("""{"v":1,"startedAtMs":0,"fixes":[["x"]]}""")
            )
            // Structurally incomplete tuples and non-finite values.
            assertNull(RecorderCore.deserializeRecording("""{"v":1,"startedAtMs":0,"fixes":[[1,2]]}"""))
            assertNull(
                RecorderCore.deserializeRecording("""{"v":1,"startedAtMs":0,"fixes":[[null,2,3]]}""")
            )
            assertNull(RecorderCore.deserializeRecording("""{"v":1,"fixes":[]}"""))
            assertNull(RecorderCore.deserializeRecording("""{"v":1,"startedAtMs":0}"""))
            assertNull(RecorderCore.deserializeRecording("[]"))
        }

        @Test
        fun `accepts a three-element tuple as having no speed or accuracy`() {
            // JS validates length >= 3, so a hand-trimmed checkpoint is legal and
            // reads as "no speed, no accuracy" rather than being rejected.
            val rec = present(
                RecorderCore.deserializeRecording("""{"v":1,"startedAtMs":0,"fixes":[[1,36.5,-79.2]]}""")
            )
            assertEquals(Fix(1.0, 36.5, -79.2, null, null), rec.fixes[0])
        }
    }

    @Nested
    inner class CrossClientWireFormat {

        /**
         * The strongest parity test available without a device: a checkpoint
         * produced by the real `public/js/record/core.js` (see
         * `src/test/resources/web-checkpoint.json`, generated by running the
         * module in Node) must both deserialize here and re-serialize
         * byte-identically.
         *
         * It pins three things a naive port gets wrong: `eventId` is a JSON
         * *number*, integer-valued doubles carry no `.0`, and accuracy `4.25`
         * rounds to `4.3` (half-up) rather than `4.2` (half-to-even).
         */
        private fun webCheckpoint(): String =
            checkNotNull(javaClass.getResourceAsStream("/web-checkpoint.json")) {
                "web-checkpoint.json fixture missing"
            }.use { it.readBytes().toString(Charsets.UTF_8) }

        @Test
        fun `deserializes a checkpoint written by the web app`() {
            val rec = present(RecorderCore.deserializeRecording(webCheckpoint()))
            assertEquals("7", rec.eventId)
            assertEquals(1_750_000_000_000.0, rec.startedAtMs)
            assertEquals(3, rec.fixes.size)
            assertEquals(Fix(0.0, 36.56, -79.2, 0.0, 5.0), rec.fixes[0])
            // 4.25 -> 4.3: half-up. kotlin.math.round would give 4.2 here.
            assertEquals(Fix(1.0, 36.560181, -79.2, 25.5, 4.3), rec.fixes[1])
            assertEquals(Fix(2.0, 36.560362, -79.2, null, null), rec.fixes[2])
        }

        @Test
        fun `re-serializes byte-identically to the web app`() {
            val original = webCheckpoint()
            val rec = present(RecorderCore.deserializeRecording(original))
            assertEquals(original, RecorderCore.serializeRecording(rec))
        }

        @Test
        fun `preserves a tmp- event id as a JSON string`() {
            // An event created offline carries a tmp-N id (public/js/offline.js).
            // Numbers stay bare, strings stay quoted — a round-trip must not
            // rewrite the field's JSON type.
            val json = """{"v":1,"eventId":"tmp-3","startedAtMs":0,"fixes":[[0,1,2,null,null]]}"""
            val rec = present(RecorderCore.deserializeRecording(json))
            assertEquals("tmp-3", rec.eventId)
            assertEquals(json, RecorderCore.serializeRecording(rec))
        }

        @Test
        fun `serializes the whole synthetic track day identically to the web app`() {
            // The broadest parity check available offline. The fixture is the
            // serialized output of the real JS core.js for the *same* synthetic
            // recording this suite builds — 492 fixes of real trig values, each
            // one rounded on ingest. Byte equality here means addFix's rounding
            // agrees with JavaScript across the whole trace, not just on the
            // hand-picked edge cases above.
            //
            // Regenerate with the snippet in NS-12's PR description if the
            // fixture generator or the rounding ever legitimately changes.
            val expected = checkNotNull(
                javaClass.getResourceAsStream("/web-synthetic-checkpoint.json")
            ) { "web-synthetic-checkpoint.json fixture missing" }
                .use { it.readBytes().toString(Charsets.UTF_8) }

            val s = syntheticRecording()
            assertEquals(492, s.rec.fixes.size) { "fixture and test fixture drifted" }
            assertEquals(expected, RecorderCore.serializeRecording(s.rec))
        }

        @Test
        fun `preserves a null event id for an event-less recording`() {
            // CarPlay/Android Auto can start a recording before the event exists.
            val json = """{"v":1,"eventId":null,"startedAtMs":0,"fixes":[[0,1,2,null,null]]}"""
            val rec = present(RecorderCore.deserializeRecording(json))
            assertNull(rec.eventId)
            assertEquals(json, RecorderCore.serializeRecording(rec))
        }
    }

    @Nested
    inner class Snapshots {

        @Test
        fun `snapshot is an immutable copy that later appends do not affect`() {
            val rec = RecorderCore.createRecording("e", 0.0)
            rec.addFix(LocationFix(1000.0, LAT0, LON0, 25.0, 5.0))
            val snap = rec.snapshot()
            rec.addFix(LocationFix(2000.0, LAT0, LON0, 25.0, 5.0))
            assertEquals(1, snap.fixes.size)
            assertEquals(2, rec.fixes.size)
        }
    }
}
