package app.trackevolution.core.telemetry

import app.trackevolution.core.RepoRoot
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * `test/unit/smartycam.test.js`, ported case for case. Where the JS builds a
 * file with `buildSmartyCamMov`, these read the committed one built from the
 * same options: `smartycam-laps.mov` is `buildSmartyCamMov()` and
 * `smartycam-midsession.mov` is `buildSmartyCamMov({ startCount: 3, resetAtS:
 * 80, badGear: true, dropped: [], meta: null })`. [SmartyCamContractTest] pins
 * the whole output to the JS; these say what each part of it means.
 *
 * One JS assertion has no counterpart here: `sanitizeChannels(body.channels)`,
 * the server's own validator, which `:core` doesn't carry.
 */
class SmartyCamTest {

    /** `Math.round(LAP_S() * 100) * 10` — the logger reports to 10 ms. */
    private val lapMs = 47120
    private val fps = 30.0 // SMARTYCAM_FPS

    private fun bytes(file: String): ByteArray = RepoRoot.path("contracts/logic/smartycam/$file").readBytes()

    private fun mov(file: String = "smartycam-laps.mov") = ByteArraySource(bytes(file))

    // ---- ecefToGeodetic --------------------------------------------------------

    @Test
    fun `lands on the equator, the pole and a known point`() {
        assertEquals(SmartyCam.Geodetic(lat = 0.0, lon = 0.0), SmartyCam.ecefToGeodetic(6378137.0, 0.0, 0.0))
        assertEquals(90.0, SmartyCam.ecefToGeodetic(0.0, 0.0, 6356752.314245).lat, 5e-10)
        // VIR's start/finish, from a real record: X 960562.82 m, Y -5037961.28 m, Z 3779118.22 m
        val p = SmartyCam.ecefToGeodetic(960562.82, -5037961.28, 3779118.22)
        assertEquals(36.5688, p.lat, 5e-4)
        assertEquals(-79.2051, p.lon, 5e-4)
    }

    // ---- readRecord ------------------------------------------------------------

    private fun record(fill: (ByteBuffer) -> Unit): SmartyCam.Record {
        val buf = ByteBuffer.allocate(SmartyCam.RECORD_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        fill(buf)
        return SmartyCam.readRecord(ByteView(buf.array()))
    }

    private fun withFix(dv: ByteBuffer) {
        dv.putInt(60, 96056282)
        dv.putInt(64, -503796128)
        dv.putInt(68, 377911822)
    }

    @Test
    fun `reads the fields little-endian`() {
        val r = record { dv ->
            dv.putInt(0, 135)
            dv.putInt(8, 204329)
            dv.putInt(32, 4)
            dv.putInt(40, 198330)
            withFix(dv)
            dv.putInt(76, 2489)
            dv.putInt(80, 485)
            dv.putInt(84, 18)
            dv.putInt(104, 5544)
            dv.putInt(108, 17)
            dv.putInt(120, 2)
        }
        assertEquals(135L, r.frame)
        assertEquals(204329, r.tsMs)
        assertEquals(4, r.lapCount)
        assertEquals(198330, r.lapMs)
        assertEquals(5544, r.rpm)
        assertEquals(17, r.throttle)
        assertEquals(2, r.gear)
        assertEquals(SmartyCam.Ecef(x = 960562.82, y = -5037961.28, z = 3779118.22), r.ecef)
        assertEquals(25.36, given(r.speedMs), 5e-3)
    }

    @Test
    fun `reads the frame index unsigned and at an offset`() {
        // Not a JS case: the two things a Kotlin port can get wrong that a
        // DataView can't — a u32 past 2^31, and the `offset` argument.
        val buf = ByteBuffer.allocate(8 + SmartyCam.RECORD_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        buf.putInt(8, 0xF0000005.toInt())
        buf.putInt(8 + 104, 6100)
        val r = SmartyCam.readRecord(ByteView(buf.array()), 8)
        assertEquals(0xF0000005L, r.frame)
        assertEquals(6100, r.rpm)
    }

    @Test
    fun `turns NO_VALUE into null and never into a reading`() {
        val r = record { dv ->
            withFix(dv)
            for (o in listOf(32, 40, 104, 108, 120)) dv.putInt(o, SmartyCam.NO_VALUE)
        }
        assertEquals(listOf<Int?>(null, null, null, null, null), listOf(r.lapCount, r.lapMs, r.rpm, r.throttle, r.gear))
    }

    @Test
    fun `has no position without a fix`() {
        assertNull(record { }.ecef) // all zero
        assertNull(record { dv -> listOf(60, 64, 68).forEach { dv.putInt(it, -1) } }.ecef)
        assertNull(record { }.speedMs)
    }

    // ---- lapsFromCounter -------------------------------------------------------

    /** Records 1 s apart on both clocks unless [ts] says otherwise. */
    private fun recs(
        counts: List<Int?>,
        lapMs: Map<Int, Int> = emptyMap(),
        ts: (Int) -> Int = { it * 1000 },
    ): List<SmartyCam.Record> = counts.mapIndexed { i, c ->
        SmartyCam.Record(t = i.toDouble(), tsMs = ts(i), lapCount = c, lapMs = lapMs[i])
    }

    private fun lap(n: Int, timeMs: Int, startT: Double, endT: Double) =
        ParsedLap(lapNumber = n, timeMs = timeMs, estimated = false, startT = startT, endT = endT)

    @Test
    fun `needs two consecutive steps, and puts each boundary one record before its step`() {
        val laps = SmartyCam.lapsFromCounter(
            recs(listOf(0, 0, 1, 1, 1, 1, 2, 2, 3), lapMs = mapOf(2 to 99000, 6 to 4000, 8 to 2000)),
        )
        assertEquals(listOf(lap(1, 4000, 1.0, 5.0), lap(2, 2000, 5.0, 7.0)), laps)
    }

    @Test
    fun `drops the first lap a file closes - it began before the video did`() {
        assertEquals(emptyList<ParsedLap>(), SmartyCam.lapsFromCounter(recs(listOf(3, 3, 4, 4), lapMs = mapOf(2 to 120000))))
    }

    @Test
    fun `opens nothing across a jump, a reset or a missing counter`() {
        val none = emptyList<ParsedLap>()
        assertEquals(none, SmartyCam.lapsFromCounter(recs(listOf(0, 1, 1, 3, 3), lapMs = mapOf(1 to 5000, 3 to 2000))))
        assertEquals(none, SmartyCam.lapsFromCounter(recs(listOf(4, 5, 5, 0, 0, 1), lapMs = mapOf(1 to 5000, 5 to 4000))))
        assertEquals(none, SmartyCam.lapsFromCounter(recs(listOf(0, 1, 1, null, 1, 2), lapMs = mapOf(1 to 5000, 5 to 4000))))
    }

    @Test
    fun `refuses a lap whose logger clock disagrees with its reported time`() {
        fun at(ms: Int) = recs(listOf(0, 1, 1, 1, 1, 2), lapMs = mapOf(1 to 9000, 5 to ms))
        assertEquals(1, SmartyCam.lapsFromCounter(at(4000 + SmartyCam.LAP_CLOCK_TOLERANCE_MS)).size)
        assertEquals(emptyList<ParsedLap>(), SmartyCam.lapsFromCounter(at(4000 + SmartyCam.LAP_CLOCK_TOLERANCE_MS + 10)))
    }

    @Test
    fun `takes the lap time from the logger, not from the video clock`() {
        // 4 s of video, 4.5 s on the logger: frames were dropped.
        val laps = SmartyCam.lapsFromCounter(
            recs(listOf(0, 1, 1, 1, 1, 2), lapMs = mapOf(1 to 9000, 5 to 4500), ts = { it * 1125 }),
        )
        assertEquals(listOf(lap(1, 4500, 0.0, 4.0)), laps)
    }

    // ---- plausibleChannels -----------------------------------------------------

    private fun carRecs(f: (Int, SmartyCam.Record) -> SmartyCam.Record = { _, r -> r }): List<SmartyCam.Record> =
        List(40) { i -> f(i, SmartyCam.Record(rpm = 3000 + i * 100, throttle = i * 2, gear = 2 + (i % 4))) }

    @Test
    fun `keeps fields that look like what they claim`() {
        assertEquals(SmartyCam.Plausible(rpm = true, throttle = true, gear = true), SmartyCam.plausibleChannels(carRecs()))
    }

    @Test
    fun `drops each field on its own`() {
        assertEquals(
            SmartyCam.Plausible(rpm = false, throttle = true, gear = true),
            SmartyCam.plausibleChannels(carRecs { _, r -> r.copy(rpm = 40) }),
        )
        assertFalse(SmartyCam.plausibleChannels(carRecs { _, r -> r.copy(throttle = 20) }).throttle) // never moves
        assertFalse(SmartyCam.plausibleChannels(carRecs { i, r -> r.copy(throttle = i * 5) }).throttle) // past 100
        val badGear = SmartyCam.plausibleChannels(carRecs { i, r -> r.copy(gear = i) })
        assertFalse(badGear.gear)
        assertTrue(badGear.rpm)
        assertEquals(
            SmartyCam.Plausible(rpm = false, throttle = false, gear = false),
            SmartyCam.plausibleChannels(carRecs { _, r -> r.copy(rpm = null, throttle = null, gear = null) }),
        )
    }

    // ---- parseAimMeta ----------------------------------------------------------

    @Test
    fun `reads the date and the time and nothing else`() {
        val xml = """<p n="racer_name">Somebody</p><p n="date">21/11/2026</p><p n="hour">08:58.16</p><p n="nlap">4</p>"""
        assertEquals(SmartyCam.AimMeta(date = "2026-11-21", time = "08:58:16"), SmartyCam.parseAimMeta(xml))
    }

    @Test
    fun `answers nulls for a file without the block`() {
        val none = SmartyCam.AimMeta(date = null, time = null)
        assertEquals(none, SmartyCam.parseAimMeta(""))
        assertEquals(none, SmartyCam.parseAimMeta(null))
        assertEquals(none, SmartyCam.parseAimMeta("""<p n="date">2026-11-21</p>"""))
    }

    // ---- parseSmartyCamFile ----------------------------------------------------

    @Test
    fun `reads the logger's laps, the trace and the car channels`() {
        val out = SmartyCam.parseSmartyCamFile(mov())
        assertEquals(ParsedTelemetry.Kind.SMARTYCAM, out.kind)
        assertEquals("smartycam", out.kind.rawValue)
        assertEquals("SmartyCam", out.kind.label)
        assertFalse(out.needsLine)
        assertEquals("2026-06-20", out.date)
        assertEquals("09:15:00", out.time)
        // Four steps of the counter: the first closes the out-lap, three laps follow.
        assertEquals(listOf(lapMs, lapMs, lapMs), out.laps.map { it.timeMs })
        assertTrue(out.laps.none { it.estimated })
        assertEquals(listOf("rpm", "throttle", "gear"), carKeys(out))
        assertTrue(Math.abs(given(out.metrics?.topSpeedKph) - 144) < 1)
        assertTrue(given(out.metrics?.maxRpm) > 6900)
        assertTrue(given(out.bestLapTrace).size > 100)
        assertEquals(36.56, given(out.traceGeo).lat, 5e-3)
    }

    /** `Object.keys(out.carChannels)`: the channels the file carried, in `CHANNEL_NAMES` order. */
    private fun carKeys(out: ParsedTelemetry): List<String> =
        TelemetryChannels.CHANNEL_NAMES.map { it.first }.filter { out.carChannels[it] != null }

    @Test
    fun `runs on video time - a lap that lost frames is shorter in the file than on the clock`() {
        val out = SmartyCam.parseSmartyCamFile(mov())
        val gps = given(out.gps)
        val videoS = out.laps.map { given(it.endT) - given(it.startT) }
        // The second lap (58.9 s → 106.0 s) holds the 12 s stretch that lost a third of its frames.
        assertEquals(lapMs / 1000.0, videoS[0], 0.5)
        assertEquals(lapMs / 1000.0 - 4, videoS[1], 0.5)
        assertEquals(lapMs, out.laps[1].timeMs)
        // Every record is five frames on from the last, whatever the clock did.
        assertEquals(5 / fps, gps[101].t - gps[100].t, 5e-10)
        assertEquals(gps.size / 6.0, out.durationS, 0.05)
    }

    @Test
    fun `takes position from the ECEF fix, not the stale x1e7 pair`() {
        val gps = given(SmartyCam.parseSmartyCamFile(mov()).gps)
        // The circle's centre is (36.56, -79.2) and the car starts due east of it.
        assertEquals(36.56, gps[0].lat, 5e-7)
        // Speed is the ECEF velocity's magnitude, real however many frames were lost
        // (the fixture's circle is laid out with flat-earth constants, hence the slack).
        assertTrue(gps.all { Math.abs(given(it.v) - 40) < 0.3 })
    }

    @Test
    fun `skips NO_VALUE readings instead of charting them`() {
        val out = SmartyCam.parseSmartyCamFile(mov())
        val rpm = given(out.carChannels.rpm)
        assertTrue(rpm.size < given(out.gps).size)
        assertTrue(rpm.all { it.v > 0 })
    }

    @Test
    fun `starts mid-session, survives a counter reset, and drops an implausible gear`() {
        val out = SmartyCam.parseSmartyCamFile(mov("smartycam-midsession.mov"))
        assertEquals(listOf(lapMs, lapMs), out.laps.map { it.timeMs })
        assertEquals(listOf("rpm", "throttle"), carKeys(out))
        // No XML: the date falls back to the file's own creation time (UTC).
        assertEquals("2026-06-20", out.date)
        assertEquals("13:15:00", out.time)
    }

    @Test
    fun `is not fooled by somebody else's video`() {
        val err = assertThrows(TelemetryParseException::class.java) {
            SmartyCam.parseSmartyCamFile(VideoFixtures.source("gopro.mp4"))
        }
        assertTrue(Regex("No SmartyCam telemetry track").containsMatchIn(err.message), err.message)
        assertTrue(err.isNoTrack)
    }

    // ---- parseTelemetryFile with a SmartyCam .MOV ------------------------------

    @Test
    fun `dispatches it and cuts per-lap channels on the distance grid`() {
        val out = Telemetry.parseTelemetryFile(mov(), "SCHD0001.MOV")
        assertEquals(ParsedTelemetry.Kind.SMARTYCAM, out.kind)
        val laps = given(out.lapChannels).laps
        assertEquals(3, laps.size)
        val lap = laps[1]
        for (name in listOf("speed", "rpm", "throttle", "gear")) given(lap.channel(name), "lap carries $name")
        // The lap that lost frames still measures a full lap of distance and speed.
        val speed = given(lap.channel("speed"))
        assertTrue(Math.abs(speed.size - given(laps[0].channel("speed")).size) <= 1)
        assertTrue(speed.all { Math.abs(it - 144) < 1.5 })
    }

    @Test
    fun `dispatches on the bytes, whatever the file is called`() {
        // Not a JS case: a shared file can arrive with no name the app can read.
        assertEquals(ParsedTelemetry.Kind.SMARTYCAM, Telemetry.parseTelemetryFile(mov()).kind)
        assertEquals(ParsedTelemetry.Kind.SMARTYCAM, Telemetry.parseTelemetryFile(mov(), "clip.mp4").kind)
    }

    @Test
    fun `builds the session the web would`() {
        val parsed = Telemetry.parseTelemetryFile(mov(), "SCHD0001.MOV")
        assertEquals(listOf(lapMs, lapMs, lapMs), parsed.laps.map { it.timeMs })
        val notes = Telemetry.importNotes(parsed, "SCHD0001.MOV")
        assertTrue(notes.startsWith("Imported from SCHD0001.MOV — "), notes)
        assertFalse(Regex("Test Driver|Test Car").containsMatchIn(notes), notes)
        // No lap is estimated, so the notes carry no "~" caveat.
        assertEquals("", Telemetry.estimatedNote(parsed, 0))
        assertEquals("SmartyCam 09:15:00", Telemetry.defaultLabel(parsed, "SCHD0001.MOV"))
        assertEquals("SmartyCam SCHD0001", Telemetry.defaultLabel(parsed.copy(time = null), "SCHD0001.MOV"))
        given(parsed.traceGeo)
    }

    @Test
    fun `still reads a GoPro file renamed mov`() {
        val out = Telemetry.parseTelemetryFile(VideoFixtures.source("gopro.mp4"), "GX010042.MOV")
        assertEquals(ParsedTelemetry.Kind.GOPRO, out.kind)
    }

    @Test
    fun `says so when the camera never finished the file`() {
        val noIndex = bytes("smartycam-laps.mov").copyOfRange(0, 5000) // ftyp and the start of mdat, no moov
        val err = assertThrows(TelemetryParseException::class.java) {
            Telemetry.parseTelemetryFile(ByteArraySource(noIndex), "SCHD0157.MOV")
        }
        assertTrue(err.message.contains("wasn't finished by the camera"), err.message)
        // Only a .mov is the camera's: an .mp4 with no index keeps the reader's own words.
        val mp4 = assertThrows(TelemetryParseException::class.java) {
            Telemetry.parseTelemetryFile(ByteArraySource(noIndex), "clip.mp4")
        }
        assertTrue(mp4.message.contains("No moov box"), mp4.message)
    }

    @Test
    fun `offers no clip yet - the cutters' rule for these files is a later ticket`() {
        assertNull(LapClips.clipCandidate(Telemetry.parseTelemetryFile(mov(), "SCHD0001.MOV")))
    }
}
