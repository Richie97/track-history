package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.JsMath
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer

/** `test/unit/gpmf.test.js`, over the committed `gopro.mp4` the JS built. */
class GPMFTest {

    private val lapS = 2 * Math.PI * 300 / 40
    private val lapMs = JsMath.roundToInt(lapS * 1000)

    @Test
    fun `extracts the GPS trace and UTC date from the gpmd track`() {
        val out = GPMF.parseGpmfFile(VideoFixtures.source("gopro.mp4"))
        assertEquals(ParsedTelemetry.Kind.GOPRO, out.kind)
        assertTrue(out.needsLine)
        assertTrue(out.laps.isEmpty())
        assertEquals("2026-06-20", out.date)
        assertEquals("09:15:00", out.time)
        val gps = given(out.gps)
        // circleTrace() is 3.3 revolutions at 10 Hz — 1556 points; the parser
        // must keep essentially all of them
        assertTrue(gps.size > 1556 * 0.95)
        assertEquals(36.56, gps[0].lat, 1e-4)
        assertEquals(40.0, given(gps[0].v), 0.1)
    }

    @Test
    fun `supports line picking end to end`() {
        val out = GPMF.parseGpmfFile(VideoFixtures.source("gopro.mp4"))
        val gps = given(out.gps)
        val trace = GeoTrace.projectTrace(gps, gps[0])
        // pick the trace point nearest a quarter revolution
        val gate = given(GeoTrace.buildGate(trace, JsMath.roundToInt(0.25 * lapS * 10)))
        val laps = GeoTrace.deriveLaps(trace, gate)
        assertEquals(3, laps.size)
        for (lap in laps) assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
    }

    @Test
    fun `rejects MP4s without a GPMF track`() {
        val err = assertThrows(TelemetryParseException::class.java) {
            GPMF.parseGpmfFile(ByteArraySource(emptyMp4()))
        }
        assertTrue(err.isNoTrack)
        assertTrue(err.message.contains("telemetry track"))
    }

    companion object {
        /** A structurally-valid MP4 with an ftyp and an empty moov, no tracks. */
        fun emptyMp4(): ByteArray {
            val buf = ByteBuffer.allocate(32)
            buf.putInt(0, 16)
            "ftyp".forEachIndexed { i, ch -> buf.put(4 + i, ch.code.toByte()) }
            buf.putInt(16, 16)
            "moov".forEachIndexed { i, ch -> buf.put(20 + i, ch.code.toByte()) } // moov with 8 zero bytes of body
            return buf.array()
        }
    }
}
