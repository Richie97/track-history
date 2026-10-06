package app.trackevolution.core.telemetry

import app.trackevolution.core.GpsPoint
import app.trackevolution.core.JsMath

/**
 * Cosworth "AliveDrive PDR 2.5" video telemetry parser — the recorder in
 * 2025-on GM performance cars (first seen on a Cadillac CT5-V Blackwing).
 *
 * A port of `public/js/import/pdr25.js`, step for step and name for name
 * ([STORAGE_WIDTH], [readStored], [CHANNELS_25], [parseChannelTable],
 * [parseSchedule], [parsePdr25File]), pinned to it by
 * `contracts/logic/video-parsers.json` (`pdr25-*.mp4`) — the same fixture the
 * iOS Kit's `PDR25.swift` asserts against. Like [PDR] it reads only the MP4
 * index and the telemetry samples, and it resolves to the shape
 * [PDR.parsePdrFile] does — same `kind`, same channels in the same display
 * units — so the review and the stored session are unchanged.
 *
 * It is a different format from the Corvette's Marlin `ctbx` track, not a new
 * revision of it: nothing is delta-encoded, and the file describes itself
 * completely. The JS header is the specification; in short:
 *
 * The track has handler `adrv` and sample entry `adco`, whose child boxes are
 * `adop` (outing properties: `name\0` + 4cc type + value; `timestamp` is a
 * 25-character `dtim` that is **local** wall-clock time despite its `+00:00`),
 * `adcp` (channels: `[u16 id] com.cosworth.channel.<name>\0 [u16 unit][u8 kind]
 * [u8 fmt]`, then for kind 1 f64 mult and f64 off to SI, for kind 2 an enum
 * whose storage code is `fmt`), `adcr` (u8 version, u16 nGroups, per group u64
 * period in 100 ns, u16 n, n × [u16 id, u8 storage]) and `adeg` (`[u16 id]
 * com.cosworth.event.<name>\0`). Storage codes: 1 s8, 2 u8, 3 s16, 4 u16,
 * 5 s32, 6 u32, 9 f32.
 *
 * The samples are one stream of blocks: `[u64 ts][u8 type]`, then for type 1
 * `[u8 0][u32 length]` and one second of **untagged** records — at every tick of
 * the fastest group, each group whose period divides the tick's offset writes
 * its fields, groups in `adcr` order — and for type 2 a `u16` event id. Laps
 * are `lap.start` / `lap.end` events.
 *
 * Traps the port inherits: `accelerometer.vehicle.x` is **lateral** and
 * `vehicle.y` **longitudinal with braking positive**; enums are read by label
 * (the stability-enhancement channel numbers active as 0); wheel speeds are
 * front/rear; there is no battery-voltage channel and no recording odometer.
 */
public object PDR25 {

    /** Storage code → byte width. Anything else can't be framed. */
    public val STORAGE_WIDTH: Map<Int, Int> = mapOf(1 to 1, 2 to 1, 3 to 2, 4 to 2, 5 to 4, 6 to 4, 9 to 4)

    public fun readStored(dv: ByteView, off: Int, code: Int): Double = when (code) {
        1 -> dv.getInt8(off).toDouble()
        2 -> dv.getUint8(off).toDouble()
        3 -> dv.getInt16(off).toDouble()
        4 -> dv.getUint16(off).toDouble()
        5 -> dv.getInt32(off).toDouble()
        6 -> dv.getUint32(off).toDouble()
        9 -> dv.getFloat32(off)
        else -> Double.NaN
    }

    private const val RAD = 180 / Math.PI
    private const val G = 9.80665
    private const val K = -273.15

    /** How one channel's SI value becomes its display unit: × [f] + [add]. */
    public data class Conversion(val key: String, val f: Double, val add: Double)

    /**
     * Cosworth channel name → the key this parser knows it by and the
     * conversion to the display unit [PDR.parsePdrFile] hands on. Enum channels
     * carry no conversion; they are read by label.
     */
    public val CHANNELS_25: Map<String, Conversion> = mapOf(
        "speed" to Conversion("speed", 3.6, 0.0),
        "location.latitude" to Conversion("latitude", RAD, 0.0),
        "location.longitude" to Conversion("longitude", RAD, 0.0),
        "location.altitude" to Conversion("altitude", 1.0, 0.0),
        "location.fixquality" to Conversion("fix", 1.0, 0.0),
        "enginespeed" to Conversion("rpm", 60 / (2 * Math.PI), 0.0),
        // the axis swap — see the object comment
        "accelerometer.vehicle.x" to Conversion("latAcc", 1 / G, 0.0),
        "accelerometer.vehicle.y" to Conversion("longAcc", -1 / G, 0.0),
        "throttle.position" to Conversion("throttle", 100.0, 0.0),
        "brake.position" to Conversion("brake", 100.0, 0.0),
        "steeringangle" to Conversion("steering", RAD, 0.0),
        "gyro.vehicle.yaw" to Conversion("yaw", RAD, 0.0),
        "gear" to Conversion("gear", 1.0, 0.0),
        "engine.pressure.airintake.boost" to Conversion("boost", 0.001, 0.0),
        "wheel.speed.front.left" to Conversion("wsFL", 3.6, 0.0),
        "wheel.speed.front.right" to Conversion("wsFR", 3.6, 0.0),
        "wheel.speed.rear.left" to Conversion("wsRL", 3.6, 0.0),
        "wheel.speed.rear.right" to Conversion("wsRR", 3.6, 0.0),
        "stability.antilockbrakingsystem" to Conversion("absActive", 1.0, 0.0),
        "stability.tractioncontrolsystem" to Conversion("tcActive", 1.0, 0.0),
        "stability.electronicstabilitycontrol" to Conversion("vscActive", 1.0, 0.0),
        "engine.temperature.oil" to Conversion("oilC", 1.0, K),
        "engine.pressure.oil" to Conversion("oilKpa", 0.001, 0.0),
        "engine.temperature.coolant" to Conversion("coolantC", 1.0, K),
        "transmission.oil.temperature" to Conversion("transC", 1.0, K),
        "engine.level.fuel" to Conversion("fuelPct", 100.0, 0.0),
        "tire.pressure.front.left" to Conversion("tyreKpaLF", 0.001, 0.0),
        "tire.pressure.front.right" to Conversion("tyreKpaRF", 0.001, 0.0),
        "tire.pressure.rear.left" to Conversion("tyreKpaLR", 0.001, 0.0),
        "tire.pressure.rear.right" to Conversion("tyreKpaRR", 0.001, 0.0),
        "tire.temperature.front.left" to Conversion("tyreCLF", 1.0, K),
        "tire.temperature.front.right" to Conversion("tyreCRF", 1.0, K),
        "tire.temperature.rear.left" to Conversion("tyreCLR", 1.0, K),
        "tire.temperature.rear.right" to Conversion("tyreCRR", 1.0, K),
        "temperature.outsideair" to Conversion("ambientC", 1.0, K),
        "engine.temperature.airintake" to Conversion("intakeC", 1.0, K),
        "odometer.distance" to Conversion("carOdo", 0.001, 0.0), // the car's lifetime odometer
    )

    internal val GEAR_LABELS = listOf(
        "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
    )

    private const val CHANNEL_PREFIX = "com.cosworth.channel."
    private const val EVENT_PREFIX = "com.cosworth.event."
    private const val MAX_TICKS = 864_000_000_000.0 // 24h in 100 ns units: anything above is corrupt
    private val TIMESTAMP = Regex("outingproperty\\.timestamp\u0000dtim(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})")

    /** One `adcp` entry. [labels] is an enum's first field, default label included. */
    public data class Channel(
        val name: String,
        val kind: Int,
        val mult: Double,
        val off: Double,
        val labels: Map<String, Double>?,
    )

    /** One `adcr` field: which channel, and how it is stored. */
    public data class Field(val id: Int, val code: Int)

    /** One `adcr` group: how often it writes, and what. [bytes] is NaN for an unknown storage code. */
    public data class Group(val period: Double, val fields: List<Field>, val bytes: Double)

    // -----------------------------------------------------------------------
    // The self-description
    // -----------------------------------------------------------------------

    /** A NUL-terminated latin-1 string at [p], and where the byte after its NUL is. */
    private fun cstr(dv: ByteView, p: Int, end: Int): Pair<String, Int> {
        var e = p
        while (e < end && dv.getUint8(e) != 0) e++
        return dv.latin1(p, e - p) to e + 1
    }

    /**
     * The channel table, found entry by entry by name — the id sits in the two
     * bytes before it — since entries can't be walked end to end without every
     * enum's grammar.
     */
    public fun parseChannelTable(dv: ByteView, start: Int, end: Int): Map<Int, Channel> {
        val out = LinkedHashMap<Int, Channel>()
        val text = dv.latin1(start, end - start)
        var i = text.indexOf(CHANNEL_PREFIX)
        while (i >= 0) {
            val at = start + i
            val (s, p) = cstr(dv, at, end)
            if (at - 2 >= start && p + 4 <= end) {
                val id = dv.getUint16(at - 2)
                val kind = dv.getUint8(p + 2)
                val fmt = dv.getUint8(p + 3)
                var ch = Channel(s.substring(CHANNEL_PREFIX.length), kind, 1.0, 0.0, null)
                if (kind == 1 && p + 20 <= end) {
                    ch = ch.copy(mult = dv.getFloat64(p + 4), off = dv.getFloat64(p + 12))
                } else if (kind == 2) {
                    ch = ch.copy(labels = enumLabels(dv, p + 4, end, fmt))
                }
                out[id] = ch
            }
            i = text.indexOf(CHANNEL_PREFIX, i + CHANNEL_PREFIX.length)
        }
        return out
    }

    /** The first field of an enum entry; null when its storage width is unknown or the entry runs out. */
    private fun enumLabels(dv: ByteView, start: Int, end: Int, code: Int): Map<String, Double>? {
        val w = STORAGE_WIDTH[code] ?: return null
        if (start + 1 > end) return null
        val labels = LinkedHashMap<String, Double>()
        var p = start + 1 // nFields: every enum this reads has one
        p = cstr(dv, p, end).second // the field's name
        p += w // its mask
        val (def, afterDef) = cstr(dv, p, end)
        p = afterDef
        if (p + w + 1 > end) return null
        labels[def] = readStored(dv, p, code)
        p += w
        val count = dv.getUint8(p)
        p += 1
        repeat(count) {
            val (label, next) = cstr(dv, p, end)
            p = next
            if (p + w > end) return null
            labels[label] = readStored(dv, p, code)
            p += w
        }
        return labels
    }

    /** The record schedule. */
    public fun parseSchedule(dv: ByteView, start: Int, end: Int): List<Group> {
        val groups = ArrayList<Group>()
        var p = start + 1 // version
        if (p + 2 > end) return groups
        val n = dv.getUint16(p)
        p += 2
        var g = 0
        while (g < n && p + 10 <= end) {
            val period = dv.getUint32(p).toDouble() * 4_294_967_296.0 + dv.getUint32(p + 4).toDouble()
            val count = dv.getUint16(p + 8)
            p += 10
            val fields = ArrayList<Field>()
            var bytes = 0.0
            var k = 0
            while (k < count && p + 3 <= end) {
                val code = dv.getUint8(p + 2)
                fields.add(Field(dv.getUint16(p), code))
                bytes += STORAGE_WIDTH[code]?.toDouble() ?: Double.NaN
                p += 3
                k++
            }
            groups.add(Group(period, fields, bytes))
            g++
        }
        return groups
    }

    private fun parseEvents(dv: ByteView, start: Int, end: Int): Map<Int, String> {
        val out = HashMap<Int, String>()
        var p = start
        while (p + 2 < end) {
            val id = dv.getUint16(p)
            val (s, next) = cstr(dv, p + 2, end)
            if (s.startsWith(EVENT_PREFIX)) out[id] = s.substring(EVENT_PREFIX.length)
            p = next
        }
        return out
    }

    // -----------------------------------------------------------------------
    // The file
    // -----------------------------------------------------------------------

    /** Where one channel's decoded samples go, and how they are scaled there. */
    private class Sink(val arr: ArrayList<ChannelPoint>, val f: Double, val add: Double, val mult: Double, val off: Double)

    public fun parsePdr25File(source: TelemetryByteSource): ParsedTelemetry {
        // 1. Locate moov among top-level boxes (usually at file end).
        val moovBox = MP4.readMoov(source)
        val moov = moovBox.view
        val root = moovBox.root

        // 2. Find the telemetry track (handler 'adrv').
        var stbl: MP4.Box? = null
        for (trak in MP4.boxes(moov, root.body, root.size).filter { it.type == "trak" }) {
            val mdia = MP4.child(moov, trak, "mdia") ?: continue
            val hdlr = MP4.child(moov, mdia, "hdlr")
            if (hdlr == null || MP4.fourcc(moov, hdlr.body + 8) != "adrv") continue
            val minf = MP4.child(moov, mdia, "minf")
            stbl = minf?.let { MP4.child(moov, it, "stbl") }
        }
        if (stbl == null) throw TelemetryParseException("No PDR 2.5 telemetry track in this video", isNoTrack = true)

        val stco = MP4.child(moov, stbl, "stco") ?: MP4.child(moov, stbl, "co64")
        val stsz = MP4.child(moov, stbl, "stsz")
        val stsc = MP4.child(moov, stbl, "stsc")
        val stsd = MP4.child(moov, stbl, "stsd")
        if (stco == null || stsz == null || stsc == null || stsd == null) {
            throw TelemetryParseException("Telemetry track is missing sample tables")
        }

        // 3. The self-description inside the 'adco' sample entry.
        val entry = MP4.boxes(moov, stsd.body + 8, stsd.start + stsd.size).firstOrNull()
        val parts = entry?.let { MP4.boxes(moov, it.body + 8, it.start + it.size) } ?: emptyList()
        fun part(type: String) = parts.firstOrNull { it.type == type }
        val adcp = part("adcp")
        val adcr = part("adcr")
        if (adcp == null || adcr == null) throw TelemetryParseException("PDR 2.5 telemetry is missing its channel table")
        val chans = parseChannelTable(moov, adcp.body, adcp.start + adcp.size)
        val groups = parseSchedule(moov, adcr.body, adcr.start + adcr.size).filter { it.fields.isNotEmpty() }
        if (groups.isEmpty() || groups.any { !it.bytes.isFinite() || !(it.period > 0) }) {
            throw TelemetryParseException("This PDR 2.5 recording uses a record layout this importer can't read")
        }
        val eventNames = part("adeg")?.let { parseEvents(moov, it.body, it.start + it.size) } ?: emptyMap()

        var date: String? = null
        var time: String? = null
        part("adop")?.let { adop ->
            val raw = moov.latin1(adop.body, adop.size - 8)
            TIMESTAMP.find(raw)?.let {
                date = it.groupValues[1]
                time = it.groupValues[2]
            }
        }

        // 4. Decode the samples. One bucket per channel this parser reads, in
        // display units; every other field is stepped over by its width.
        val pts = HashMap<String, ArrayList<ChannelPoint>>()
        val sinks = HashMap<Int, Sink>()
        for ((id, ch) in chans) {
            val spec = CHANNELS_25[ch.name] ?: continue
            val arr = ArrayList<ChannelPoint>()
            pts[spec.key] = arr
            sinks[id] = Sink(arr, spec.f, spec.add, ch.mult, ch.off)
        }
        // Each scheduled field carries its sink, so the decode loop does no lookup.
        val plan = groups.map { g ->
            Triple(g.period, g.bytes.toInt(), g.fields.map { Triple(it.code, STORAGE_WIDTH.getValue(it.code), sinks[it.id]) })
        }
        val tick = groups.minOf { it.period }
        val events = ArrayList<Pair<Double, String>>()
        var lastT = 0.0

        // Chunks hold whole samples and samples hold whole blocks, but nothing
        // promises a block never straddles a sample, so the stream is read whole.
        val is64 = stco.type == "co64"
        val nChunks = moov.getUint32(stco.body + 4).toInt()
        val fixedSize = moov.getUint32(stsz.body + 4)
        val nSamples = moov.getUint32(stsz.body + 8).toInt()
        fun sizeAt(i: Int): Long = if (fixedSize != 0L) fixedSize else moov.getUint32(stsz.body + 12 + i * 4)
        val nRuns = moov.getUint32(stsc.body + 4).toInt()
        fun runFirst(r: Int): Long = moov.getUint32(stsc.body + 8 + r * 12) // 1-based chunk
        fun runPer(r: Int): Long = moov.getUint32(stsc.body + 12 + r * 12)
        val stream = java.io.ByteArrayOutputStream()
        var sample = 0
        var r = 0
        var c = 0
        while (c < nChunks && sample < nSamples) {
            while (r + 1 < nRuns && runFirst(r + 1) <= c + 1) r++
            val off = if (is64) moov.getBigUint64(stco.body + 8 + c * 8) else moov.getUint32(stco.body + 8 + c * 4)
            var len = 0L
            var k = 0L
            while (k < runPer(r) && sample < nSamples) {
                len += sizeAt(sample)
                sample++
                k++
            }
            stream.write(bufAt(source, off, len).bytes)
            c++
        }
        val s = ByteView(stream.toByteArray())

        var q = 0
        while (q + 9 <= s.byteLength) {
            val ts = s.getUint32(q).toDouble() * 4_294_967_296.0 + s.getUint32(q + 4).toDouble()
            val type = s.getUint8(q + 8)
            if (type == 2) {
                if (q + 11 > s.byteLength) break
                val name = eventNames[s.getUint16(q + 9)]
                if (ts <= MAX_TICKS && name != null) events.add(ts / 1e7 to name)
                q += 11
                continue
            }
            if (type != 1 || q + 14 > s.byteLength) break // a block that can't be framed
            val end = minOf(q.toLong() + 14 + s.getUint32(q + 10), s.byteLength.toLong()).toInt()
            var p = q + 14
            if (ts <= MAX_TICKS) {
                var k = 0.0
                while (p < end) {
                    val at = k * tick
                    for ((period, bytes, fields) in plan) {
                        if (at % period != 0.0) continue
                        if (p + bytes > end) {
                            p = end
                            break
                        }
                        val t = (ts + at) / 1e7
                        for ((code, width, sink) in fields) {
                            if (sink != null) {
                                val raw = readStored(s, p, code)
                                sink.arr.add(ChannelPoint(t, (raw * sink.mult + sink.off) * sink.f + sink.add))
                            }
                            p += width
                        }
                        if (t > lastT) lastT = t
                    }
                    k += 1
                }
            }
            q = end
        }
        for ((t) in events) if (t > lastT) lastT = t

        fun got(key: String): List<ChannelPoint> = pts[key] ?: emptyList()
        fun labelsOf(key: String): Map<String, Double>? =
            chans.values.firstOrNull { CHANNELS_25[it.name]?.key == key }?.labels

        // Scale and derive the car channels, exactly as PDR.parsePdrFile does.
        val speed = got("speed") // km/h
        val rpm = got("rpm")
        val latAcc = got("latAcc") // G
        val throttle = got("throttle") // %
        val brake = got("brake") // %
        val longAcc = got("longAcc") // G, signed: negative under braking
        val yaw = got("yaw") // deg/s, signed
        val boost = got("boost") // kPa gauge
        val steering = got("steering") // deg, signed

        // Gear by label: first..tenth are gears, anything else is the no-gear 0.
        val gearOf = HashMap<Double, Double>()
        labelsOf("gear")?.let { labels ->
            GEAR_LABELS.forEachIndexed { i, l -> labels[l]?.let { gearOf[it] = (i + 1).toDouble() } }
        }
        val gear = if (gearOf.isEmpty()) emptyList() else got("gear").map { ChannelPoint(it.t, gearOf[it.v] ?: 0.0) }

        // Wheel slip, rear over front, as one channel.
        val wheel = listOf("wsFL", "wsFR", "wsRL", "wsRR").map(::got)
        val wheelSlip = if (wheel.all { it.size > 10 }) {
            val fl = series(wheel[0])
            val fr = series(wheel[1])
            val rl = series(wheel[2])
            val rr = series(wheel[3])
            wheel[0].map { p ->
                val nd = (fl.at(p.t) + fr.at(p.t)) / 2
                val dr = (rl.at(p.t) + rr.at(p.t)) / 2
                val v = if (nd < 5) 0.0 else ((dr - nd) / nd) * 100
                ChannelPoint(p.t, maxOf(-100.0, minOf(100.0, v)))
            }
        } else {
            emptyList()
        }

        // ABS / traction control / stability control, each 1 while "active".
        fun active(key: String): List<ChannelPoint> {
            val v = labelsOf(key)?.get("active") ?: return emptyList()
            return got(key).map { ChannelPoint(it.t, if (it.v == v) 1.0 else 0.0) }
        }
        val absPts = active("absActive")
        val tcPts = active("tcActive")
        val vscPts = active("vscActive")
        val flags = if (absPts.size > 10) {
            val tc = if (tcPts.size > 10) series(tcPts) else null
            val vsc = if (vscPts.size > 10) series(vscPts) else null
            absPts.map { p ->
                var bits = if (p.v > 0.5) 1 else 0
                if (tc != null && tc.at(p.t) > 0.5) bits = bits or 2
                if (vsc != null && vsc.at(p.t) > 0.5) bits = bits or 4
                ChannelPoint(p.t, bits.toDouble())
            }
        } else {
            emptyList()
        }

        val lapScalarChannels = LinkedHashMap<String, List<ChannelPoint>>()
        for (key in PDR.SCALAR_CHANNEL_KEYS) {
            val arr = got(key)
            if (arr.isNotEmpty()) lapScalarChannels[key] = arr
        }

        fun maxOf(pts: List<ChannelPoint>, cap: Double): Double? {
            var m = Double.NEGATIVE_INFINITY
            for (p in pts) if (p.v > m) m = p.v
            return if (m > 0 && m < cap) m else null
        }
        fun absSeries(arr: List<ChannelPoint>) = arr.map { ChannelPoint(it.t, Math.abs(it.v)) }
        val metrics = ParsedTelemetry.Metrics(
            topSpeedKph = maxOf(speed, 500.0),
            maxRpm = maxOf(rpm, 20000.0),
            maxLatG = maxOf(absSeries(latAcc), 5.0),
            maxBrakeG = maxOf(longAcc.map { ChannelPoint(it.t, -it.v) }, 5.0),
            maxBoostKpa = maxOf(boost, 400.0),
            maxOilC = maxOf(got("oilC"), 250.0),
        )

        // GPS: one record group carries position, fix quality and speed, so the
        // samples line up by index; fixes without a position are dropped.
        val lat = got("latitude")
        val lon = got("longitude")
        val alt = got("altitude")
        val fix = got("fix")
        val gps = ArrayList<GpsPoint>()
        val fixedAlt = ArrayList<ChannelPoint>()
        for (i in lat.indices) {
            val t = lat[i].t
            if (i >= lon.size || lon[i].t != t || i >= fix.size || fix[i].t != t || !(fix[i].v > 0)) continue
            val la = lat[i].v
            val lo = lon[i].v
            if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || (la == 0.0 && lo == 0.0)) continue
            val v = if (i < speed.size && speed[i].t == t) speed[i].v / 3.6 else null
            gps.add(GpsPoint(t, la, lo, v))
            if (i < alt.size && alt[i].t == t) fixedAlt.add(alt[i])
        }

        fun median(arr: List<ChannelPoint>): Double? {
            if (arr.size < 3) return null
            val v = arr.map { it.v }.sorted()
            return v[v.size shr 1]
        }
        val carOdo = got("carOdo")
        val sessionMeta = ParsedTelemetry.SessionMeta(
            ambientC = median(got("ambientC")),
            intakeC = median(got("intakeC")),
            elevationM = if (fixedAlt.size > 10) fixedAlt.maxOf { it.v } - fixedAlt.minOf { it.v } else null,
            odometerKm = if (carOdo.isEmpty()) null else carOdo.maxOf { it.v },
        )

        // 5. Laps between a lap.start and the next lap.end; ends sort first at a
        // shared timestamp, and a start with no end is not a lap.
        data class LapEvent(val t: Double, val isEnd: Boolean, val i: Int)
        val lapEvents = events.withIndex()
            .filter { it.value.second == "lap.start" || it.value.second == "lap.end" }
            .map { LapEvent(it.value.first, it.value.second == "lap.end", it.index) }
            .sortedWith(compareBy<LapEvent> { it.t }.thenBy { if (it.isEnd) 0 else 1 }.thenBy { it.i })
        val laps = ArrayList<ParsedLap>()
        var open: Double? = null
        for (e in lapEvents) {
            if (e.isEnd) {
                val start = open
                if (start != null && e.t > start) {
                    laps.add(
                        ParsedLap(
                            lapNumber = laps.size + 1,
                            timeMs = JsMath.roundToInt((e.t - start) * 1000),
                            estimated = false,
                            startT = start,
                            endT = e.t,
                        ),
                    )
                }
                open = null
            } else {
                open = e.t
            }
        }

        fun dense(arr: List<ChannelPoint>): List<ChannelPoint>? = if (arr.size > 10) arr else null

        return ParsedTelemetry(
            kind = ParsedTelemetry.Kind.PDR,
            date = date,
            time = time,
            durationS = lastT,
            laps = laps,
            gps = if (gps.size > 10) gps else null,
            metrics = metrics,
            beaconCount = lapEvents.map { it.t }.toSet().size,
            channels = null, // no recording odometer, so nothing for PDRLaps
            carChannels = ParsedTelemetry.CarChannels(
                speed = dense(speed),
                rpm = dense(rpm),
                latG = dense(absSeries(latAcc)),
                throttle = dense(throttle),
                brake = dense(brake),
                steering = dense(steering),
                longG = dense(longAcc),
                yaw = dense(yaw),
                gear = dense(gear),
                wheelSlip = dense(wheelSlip),
                boost = dense(boost),
                flags = dense(flags),
            ),
            lapScalarChannels = lapScalarChannels,
            sessionMeta = sessionMeta,
        )
    }
}
