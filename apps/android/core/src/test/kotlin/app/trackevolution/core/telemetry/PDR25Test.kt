package app.trackevolution.core.telemetry

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * `test/unit/pdr25.test.js`, ported case for case and asked of the same
 * committed files: `pdr25-laps.mp4` is
 * `buildPdr25Mp4({ lapCrossings: [30, 30 + lapS, 30 + 2·lapS] })` and
 * `pdr25-nolaps.mp4` is `buildPdr25Mp4()`. [VideoContractTest] pins the whole
 * output to the JS; these say what each part of it means.
 */
class PDR25Test {

    private val lapMs = 47124 // Math.round(LAP_S() * 1000)

    private fun parse(file: String = "pdr25-nolaps.mp4") = PDR25.parsePdr25File(VideoFixtures.source(file))

    private fun range(arr: List<ChannelPoint>?): Pair<Double, Double> {
        val v = requireNotNull(arr).map { it.v }
        return v.min() to v.max()
    }

    /** The `adco` sample entry's child boxes. */
    private fun adcoParts(): Pair<ByteView, List<MP4.Box>> {
        val moov = MP4.readMoov(VideoFixtures.source("pdr25-nolaps.mp4"))
        val dv = moov.view
        val trak = MP4.boxes(dv, moov.root.body, moov.root.size).first { it.type == "trak" }
        val stbl = MP4.child(dv, MP4.child(dv, MP4.child(dv, trak, "mdia")!!, "minf")!!, "stbl")!!
        val stsd = MP4.child(dv, stbl, "stsd")!!
        val adco = MP4.boxes(dv, stsd.body + 8, stsd.start + stsd.size).first()
        return dv to MP4.boxes(dv, adco.body + 8, adco.start + adco.size)
    }

    // ---- The self-description ------------------------------------------------------

    @Test
    fun `reads every channel entry, numeric scalings and enum labels alike`() {
        val (dv, parts) = adcoParts()
        val b = parts.first { it.type == "adcp" }
        val chans = PDR25.parseChannelTable(dv, b.body, b.start + b.size)
        val byName = chans.values.associateBy { it.name }
        assertEquals(1, byName.getValue("speed").kind)
        assertEquals(1 / 230.4, byName.getValue("speed").mult)
        assertEquals(233.15, byName.getValue("engine.temperature.oil").off, 1e-9)
        val gear = requireNotNull(byName.getValue("gear").labels)
        assertEquals(listOf(0.0, 1.0, 10.0, 13.0), listOf("notsupported", "first", "tenth", "neutral").map { gear[it] })
        // the reversed status: read by label, never assumed
        assertEquals(
            mapOf("unknown" to 3.0, "active" to 0.0, "inactive" to 1.0),
            byName.getValue("stability.vehiclestabilityenhancement").labels,
        )
        assertNotNull(chans[58])
    }

    @Test
    fun `reads the record schedule with each group's byte size`() {
        val (dv, parts) = adcoParts()
        val b = parts.first { it.type == "adcr" }
        val groups = PDR25.parseSchedule(dv, b.body, b.start + b.size)
        assertEquals(listOf(500_000.0, 1_000_000.0, 2_000_000.0, 10_000_000.0), groups.map { it.period })
        // brake u8 + rpm u16 + steering s16 + yaw s16
        assertEquals(7.0, groups[0].bytes)
    }

    // ---- parsePdr25File ------------------------------------------------------------

    @Test
    fun `times laps from lap start and lap end events, exactly`() {
        val out = parse("pdr25-laps.mp4")
        assertEquals(listOf(lapMs, lapMs), out.laps.map { it.timeMs })
        assertTrue(out.laps.none { it.estimated })
        assertEquals(listOf(1, 2), out.laps.map { it.lapNumber })
        assertEquals(30.0, requireNotNull(out.laps[0].startT), 1e-6)
        // three crossings; the lap opened at the last one never closes
        assertEquals(3, out.beaconCount)
    }

    @Test
    fun `takes the recorder's timestamp as local wall-clock time`() {
        val out = parse()
        assertEquals("2026-07-17", out.date)
        assertEquals("11:22:47", out.time)
    }

    @Test
    fun `converts every car channel to parsePdrFile's display units`() {
        val out = parse()
        val c = out.carChannels
        assertEquals(136.8, range(c.speed).first, 0.5)
        assertEquals(151.2, range(c.speed).second, 0.5)
        assertEquals(3000.0, range(c.rpm).first, 1e-6)
        assertEquals(6000.0, range(c.rpm).second, 1e-6)
        // the axis swap: lateral from vehicle.x (v²/r), longitudinal from -vehicle.y
        assertEquals(42.0 * 42 / 300 / 9.80665, range(c.latG).second, 0.005)
        assertEquals(-0.8, range(c.longG).first, 0.001)
        assertEquals(0.8, requireNotNull(out.metrics?.maxBrakeG), 0.001)
        assertEquals(0.0 to 100.0, range(c.throttle))
        assertEquals(30.0, range(c.steering).second, 0.05)
        assertTrue(range(c.yaw).first > 7)
        assertEquals(-60.0 to 60.0, range(c.boost))
        // rear wheels 2% over the fronts
        assertEquals(2.0, range(c.wheelSlip).first, 0.001)
    }

    @Test
    fun `reads gears and the stability flags by label`() {
        val c = parse().carChannels
        // neutral (13) is the no-gear state, never a thirteenth gear
        assertEquals(setOf(0.0, 1.0, 2.0, 3.0, 4.0, 5.0), requireNotNull(c.gear).map { it.v }.toSet())
        val bits = requireNotNull(c.flags).fold(0) { m, p -> m or p.v.toInt() }
        assertEquals(1, bits and 1) // ABS
        assertEquals(2, bits and 2) // traction control
        assertEquals(4, bits and 4) // stability control
    }

    @Test
    fun `reduces the slow channels to per-lap scalars and session context`() {
        val out = parse()
        val s = out.lapScalarChannels
        assertEquals(43.0 to 130.0, range(s["oilC"]))
        assertEquals(224.0 to 336.0, range(s["oilKpa"]))
        assertEquals(144.0 to 220.0, range(s["tyreKpaLF"]))
        assertEquals(77.0, range(s["tyreCRR"]).second, 1e-6)
        assertNull(s["battV"]) // the recorder has no battery channel
        assertEquals(15.0, requireNotNull(out.sessionMeta?.ambientC), 1e-6)
        assertTrue(requireNotNull(out.sessionMeta?.odometerKm) > 71000)
        assertNull(out.channels)
    }

    @Test
    fun `keeps only GPS fixes that have a position`() {
        val gps = requireNotNull(parse().gps)
        assertTrue(gps[0].t >= 2)
        assertEquals(36.56, gps[0].lat, 0.01)
        assertEquals(40.0, requireNotNull(gps[0].v), 0.5) // m/s, like a PDR trace
    }

    @Test
    fun `refuses a file without the adrv track as not its own`() {
        val e = assertThrows(TelemetryParseException::class.java) {
            PDR25.parsePdr25File(VideoFixtures.source("pdr-delta.mp4"))
        }
        assertTrue(e.isNoTrack)
    }

    // ---- Through the import dispatch -----------------------------------------------

    @Test
    fun `arrives as a PDR session with exact laps, a trace and channels`() {
        val out = Telemetry.parseTelemetryFile(VideoFixtures.source("pdr25-laps.mp4"))
        assertEquals(ParsedTelemetry.Kind.PDR, out.kind)
        assertFalse(out.needsLine)
        assertTrue(requireNotNull(out.bestLapTrace).size > 50)
        assertEquals(2, out.lapChannels?.laps?.size)
    }

    @Test
    fun `sends a recording with no lap events to the line picker`() {
        val out = Telemetry.parseTelemetryFile(VideoFixtures.source("pdr25-nolaps.mp4"))
        assertTrue(out.laps.isEmpty())
        assertTrue(out.needsLine)
        assertNull(out.lapRecovery)
    }
}
