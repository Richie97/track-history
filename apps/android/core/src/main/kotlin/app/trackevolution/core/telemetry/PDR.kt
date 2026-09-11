package app.trackevolution.core.telemetry

import app.trackevolution.core.GpsPoint
import app.trackevolution.core.JsMath

/**
 * Corvette PDR (Cosworth "Marlin PDR") video telemetry parser.
 *
 * A port of `public/pdr.js`, line for line and name for name ([gpsFromChannels],
 * [UNIT_CONV], [parsePdrFile]), with its test cases (`test/unit/pdr.test.js` →
 * `PDRTest`) and a cross-language fixture (`contracts/logic/video-parsers.json`)
 * pinning lap times to the JS implementation's to the millisecond — the *same*
 * fixture the iOS Kit's `PDR.swift` asserts against, so the two ports are
 * checked against the web implementation rather than against each other.
 *
 * **This decoder is reverse-engineered.** Its JS comment block is the only
 * specification that exists, so it is reproduced below rather than summarised,
 * and the structure here follows the JS's step for step. Resist restructuring
 * it: the pinned fixtures, not readability, are what say whether the port is
 * right.
 *
 * PDR MP4s carry a third track (handler `ctbx`, sample format `marl`) holding
 * telemetry. This reads only the MP4 index and the ~5 MB of telemetry samples
 * through [TelemetryByteSource] — the video itself is never read or uploaded.
 *
 * Lap extraction (validated against Cosworth Toolbox lap times from real
 * sessions):
 *   - "Beacon" events mark start/finish crossings with millisecond-exact
 *     timestamps and an absolute crossing number — but the recorder drops some.
 *   - "Recording Event Odometer" is cumulative distance (metres, ~7 Hz).
 *     Beacon-to-beacon distance / crossing count = lap length, so missing
 *     crossings are recovered at the time distance passes D0 + k·lapLength
 *     (validated accuracy: ~50–150 ms; flagged `estimated`).
 *   - Crossings before the first / after the last beacon are extrapolated by
 *     distance and accepted only if GPS latitude matches the beacon-calibrated
 *     start/finish latitude.
 *
 * Record framing inside a telemetry sample (this matches ExifTool's GM.pm, the
 * reference decoder for the Marlin format —
 * https://exiftool.org/forum/index.php?topic=11335):
 *   - 16-byte full record: hi 2 bits of first byte = 11 (hi byte 0xff ends the
 *     sample): `[flags:u4|chan:u28][value:s32][ts:u64 100ns]`
 *   - 8-byte delta record: hi 2 bits = 01:
 *     `[chanDiff:s6][valueDiff:s24][tsDiff:u32 100ns]` applied to the running
 *     channel/value/timestamp state, which persists **across samples**. Any
 *     other record is skipped 8 bytes at a time.
 *
 * Most of the stream is delta records: a channel gets one full record and then
 * streams diffs. (An earlier version of the JS read only full records, which
 * made it look like GPS wasn't recorded — longitude gets exactly one full record
 * at recording start, with everything after arriving as deltas. Decoding deltas
 * yields ~11 Hz lat/lon plus Speed, RPM, accelerations, etc.)
 *
 * Channel definitions live in the `mrld` table (448-byte entries: id u32 at +0,
 * units chars at +12, min/max s32 at +88/+92, multiplier/offset f64 at
 * +112/+120, name chars at +128). raw·multiplier + offset gives SI units
 * (radians for lat/lon, m/s for speed); a per-unit factor converts to display
 * units. Session local date/time is in `mrlv`.
 *
 * JS number semantics where they bite: raw channel values accumulate as [Long]
 * (a JS number never wraps at 32 bits, and neither did the Swift port's `Int`),
 * the 64-bit tick counter is assembled as `hi · 2^32 + lo` in a [Double] exactly
 * as the JS does so a corrupt high word compares as *larger* than [MAX_TICKS]
 * rather than wrapping negative, and `Math.round` goes through [JsMath].
 */
public object PDR {

    /**
     * Conversions from the SI value (raw · multiplier + offset) to the unit
     * named in the channel dictionary, as (factor, offset) — mirrors ExifTool
     * GM.pm's conversions for the units this app surfaces (lat/lon in radians →
     * degrees, m/s → km/h, m/s² → G, and Cosworth's factor-of-10 rpm).
     *
     * Three of these are units the dictionary *labels* in display terms while
     * storing SI, and getting them wrong is silent rather than obvious: `"°C"`
     * channels are Kelvin (the channel's own `off` carries 233.15/253.15),
     * which is why this table holds an offset and not just a factor; `"kPa"`
     * channels hold Pascals; `"km"` channels hold metres. The odometer is
     * deliberately not run through this table — it stays raw because it is the
     * driven-distance axis, not a displayed value.
     */
    public val UNIT_CONV: Map<String, Pair<Double, Double>> = mapOf(
        "deg" to (180.0 / Math.PI to 0.0),
        "deg/sec" to (180.0 / Math.PI to 0.0),
        "kph" to (3.6 to 0.0),
        "G" to (1.0 / 9.80665 to 0.0),
        "rpm" to (10.0 to 0.0),
        "%" to (100.0 to 0.0),
        "degC" to (1.0 to -273.15),
        "kPa" to (0.001 to 0.0),
        "km" to (0.001 to 0.0),
    )

    internal fun normUnits(u: String): String = when (u) {
        "°" -> "deg"
        "°/sec" -> "deg/sec"
        "°C" -> "degC"
        else -> u
    }

    /**
     * Channel-dictionary name → the key this parser knows it by. `CHANNEL_TAGS`
     * in the JS, kept ordered because the JS builds its bucket map by walking
     * the keys in insertion order and letting a later one win.
     *
     * Channels deliberately left out: the recorder's own CPU/disk housekeeping,
     * values constant across a session, Boost Pressure Ind (redundant with
     * Intake Boost Pressure), Vertical Acceleration, Heading, Engine Torque Req,
     * and the four suspension displacements plus Clutch Pos, whose scaling needs
     * a second car to validate.
     */
    public val CHANNEL_TAGS: List<Pair<String, String>> = listOf(
        "Beacon" to "beacon",
        "Recording Event Odometer" to "odometer",
        "Latitude" to "latitude",
        "Longitude" to "longitude",
        "Speed" to "speed",
        "RPM" to "rpm",
        "Lateral Acceleration" to "latAcc",
        "Accel Pos" to "throttle",
        "Brake Pos" to "brake",
        "Steering Angle" to "steering",
        "Longitudinal Acceleration" to "longAcc",
        "Yaw Rate" to "yaw",
        "Gear" to "gear",
        "Intake Boost Pressure" to "boost",
        "Wheelspeed Left Non-Driven" to "wsLN",
        "Wheelspeed Right Non-Driven" to "wsRN",
        "Wheelspeed Left Driven" to "wsLD",
        "Wheelspeed Right Driven" to "wsRD",
        "ABS Active" to "absActive",
        "Traction Control Active" to "tcActive",
        "Vehicle Stability Active" to "vscActive",
        "Oil Temp" to "oilC",
        "Oil Pressure" to "oilKpa",
        "Coolant Temp" to "coolantC",
        "Trans Oil Temp" to "transC",
        "Fuel Level" to "fuelPct",
        "Battery Voltage" to "battV",
        "LF Tyre Pressure" to "tyreKpaLF",
        "RF Tyre Pressure" to "tyreKpaRF",
        "LR Tyre Pressure" to "tyreKpaLR",
        "RR Tyre Pressure" to "tyreKpaRR",
        "LF Tyre Temp" to "tyreCLF",
        "RF Tyre Temp" to "tyreCRF",
        "LR Tyre Temp" to "tyreCLR",
        "RR Tyre Temp" to "tyreCRR",
        "Outside Air Temperature" to "ambientC",
        "Intake Air Temperature" to "intakeC",
        "Altitude" to "altitude",
        "Distance" to "carOdo", // the car's lifetime odometer
    )

    /**
     * The [CHANNEL_TAGS] keys reduced to one value per lap rather than a trace.
     * `SCALAR_CHANNEL_KEYS` in the JS.
     */
    public val SCALAR_CHANNEL_KEYS: List<String> = listOf(
        "oilC", "oilKpa", "coolantC", "transC", "fuelPct", "battV",
        "tyreKpaLF", "tyreKpaRF", "tyreKpaLR", "tyreKpaRR",
        "tyreCLF", "tyreCRF", "tyreCLR", "tyreCRR",
    )

    /**
     * The insertion order of the JS's `tags` object: the four observed defaults,
     * then whatever the dictionary named. Two keys resolving to one tag id is
     * pathological but possible, and the JS's Map lets the later key win — so
     * the bucket table is built in this order for the same reason.
     */
    internal val TAG_KEY_ORDER: List<String> =
        (listOf("beacon", "odometer", "latitude", "longitude") + CHANNEL_TAGS.map { it.second })
            .distinct()

    internal val CHANNEL_TAG_BY_NAME: Map<String, String> =
        CHANNEL_TAGS.associate { it.first to it.second }

    /** 24 h in 100 ns units: anything above is corrupt. */
    internal const val MAX_TICKS: Long = 864_000_000_000L

    /** One `mrld` channel-dictionary entry. */
    internal class ChannelDef(
        val name: String,
        val units: String,
        val min: Int,
        val max: Int,
        val mult: Double,
        val off: Double,
    )

    /**
     * A lat/lon interpretation: how a raw s32 becomes degrees. Lat and lon must
     * decode under the same one.
     */
    public class Decoder(
        public val lat: (Long) -> Double,
        public val lon: (Long) -> Double,
    )

    // -----------------------------------------------------------------------
    // GPS decoding
    // -----------------------------------------------------------------------

    /**
     * Decode raw Latitude/Longitude channel samples (`{t, v: s32}`) into a GPS
     * trace in decimal degrees.
     *
     * When the file's channel dictionary supplies lat/lon multipliers, that
     * conversion (radians → degrees) is tried first; then the heuristics —
     * degrees · 1e7 in the s32, or IEEE float degrees in the same 4 bytes. Every
     * interpretation is accepted only when the result actually looks like a car
     * on a track (coordinates in range, extent between ~1 m and ~1 degree).
     * Returns null rather than garbage.
     *
     * [speedS] (optional Speed-channel series, m/s) or [odo] (optional odometer
     * series) supplies speed in m/s for the racing line.
     */
    public fun gpsFromChannels(
        latPts: List<ChannelPoint>,
        lonPts: List<ChannelPoint>,
        odo: Series? = null,
        dictConv: Decoder? = null,
        speedS: Series? = null,
    ): List<GpsPoint>? {
        if (latPts.size < 10 || lonPts.size < 10) return null

        val shared: List<(Long) -> Double> = listOf(
            { v -> v / 1e7 },
            // The same four bytes read as an IEEE float; `setInt32` wraps an
            // out-of-range value to 32 bits, as `toInt()` does here.
            { v -> java.lang.Float.intBitsToFloat(v.toInt()).toDouble() },
        )
        // Lat and lon must decode under the same interpretation — a device
        // doesn't mix encodings, and float bits of one channel can masquerade as
        // plausible scaled integers of the other. The dictionary conversion
        // counts as one interpretation (each channel has its own multiplier).
        val decoders = ArrayList<Decoder>()
        if (dictConv != null) decoders.add(dictConv)
        for (conv in shared) decoders.add(Decoder(lat = conv, lon = conv))

        fun decode(pts: List<ChannelPoint>, conv: (Long) -> Double, limit: Double): List<ChannelPoint>? {
            var min = Double.POSITIVE_INFINITY
            var max = Double.NEGATIVE_INFINITY
            val out = ArrayList<ChannelPoint>(pts.size)
            for (p in pts) {
                val deg = conv(p.v.toLong())
                if (deg < min) min = deg
                if (deg > max) max = deg
                out.add(ChannelPoint(t = p.t, v = deg))
            }
            val span = max - min
            if (!span.isFinite() || Math.max(Math.abs(min), Math.abs(max)) > limit) return null
            return if (span > 1e-5 && span < 1) out else null
        }

        for (conv in decoders) {
            val lat = decode(latPts, conv.lat, 90.0) ?: continue
            val lon = decode(lonPts, conv.lon, 180.0) ?: continue
            val lonS = series(lon)
            val t0 = Math.max(lat[0].t, lon[0].t)
            val t1 = Math.min(lat[lat.size - 1].t, lon[lon.size - 1].t)
            val gps = lat.filter { it.t >= t0 && it.t <= t1 }.map { p ->
                GpsPoint(
                    t = p.t,
                    lat = p.v,
                    lon = lonS.at(p.t),
                    v = when {
                        speedS != null -> Math.max(0.0, speedS.at(p.t))
                        odo != null -> Math.max(0.0, odo.rate(p.t))
                        else -> null
                    },
                )
            }
            return if (gps.size >= 10) gps else null
        }
        return null
    }

    // -----------------------------------------------------------------------
    // The file
    // -----------------------------------------------------------------------

    /** `.replace(/[^\x20-\x7e].*$/, "")` — a dictionary name is ASCII up to the first byte that isn't, then junk. */
    private val NAME_JUNK = Regex("[^\\x20-\\x7e].*$")
    private val LDAT = Regex("ldatdate(\\d{4}-\\d{2}-\\d{2})")
    private val DATE = Regex("datedate(\\d{4}-\\d{2}-\\d{2})")
    private val LTIM = Regex("ltimtime(\\d{2}-\\d{2}-\\d{2})")

    /** One start/finish crossing: the recorder's absolute crossing number, when it happened, and whether a beacon timed it or distance placed it. */
    private class Crossing(val v: Double, val t: Double, val exact: Boolean)

    public fun parsePdrFile(source: TelemetryByteSource): ParsedTelemetry {
        // 1. Locate moov among top-level boxes (usually at file end).
        val moovBox = MP4.readMoov(source)
        val moov = moovBox.view
        val root = moovBox.root

        // 2. Find the telemetry track (handler 'ctbx').
        var stbl: MP4.Box? = null
        for (trak in MP4.boxes(moov, root.body, root.size).filter { it.type == "trak" }) {
            val mdia = MP4.child(moov, trak, "mdia") ?: continue
            val hdlr = MP4.child(moov, mdia, "hdlr")
            if (hdlr == null || MP4.fourcc(moov, hdlr.body + 8) != "ctbx") continue
            val minf = MP4.child(moov, mdia, "minf")
            stbl = minf?.let { MP4.child(moov, it, "stbl") }
        }
        if (stbl == null) throw TelemetryParseException("No PDR telemetry track in this video", isNoTrack = true)

        val stco = MP4.child(moov, stbl, "stco") ?: MP4.child(moov, stbl, "co64")
        val stsz = MP4.child(moov, stbl, "stsz")
        val stsd = MP4.child(moov, stbl, "stsd")
        if (stco == null || stsz == null || stsd == null) {
            throw TelemetryParseException("Telemetry track is missing sample tables")
        }

        val is64 = stco.type == "co64"
        val nChunks = moov.getUint32(stco.body + 4).toInt()
        val offsets = LongArray(nChunks) { i ->
            if (is64) moov.getBigUint64(stco.body + 8 + i * 8) else moov.getUint32(stco.body + 8 + i * 4)
        }
        val fixedSize = moov.getUint32(stsz.body + 4)
        fun sizeAt(i: Int): Long = if (fixedSize != 0L) fixedSize else moov.getUint32(stsz.body + 12 + i * 4)

        // 3. Channel table (mrld) -> event tag ids; session metadata (mrlv).
        val subs = MP4.boxes(moov, stsd.body + 8 + 16, stsd.start + stsd.size)
        val mrld = subs.firstOrNull { it.type == "mrld" }
        val mrlv = subs.firstOrNull { it.type == "mrlv" }

        // Observed defaults, overridden by the dictionary when the file has one.
        val tags = LinkedHashMap<String, Long>()
        tags["beacon"] = 0x36L
        tags["odometer"] = 0x42L
        tags["latitude"] = 0x31L
        tags["longitude"] = 0x32L

        val dict = HashMap<Long, ChannelDef>() // channel id -> {name, units, min, max, mult, off}
        if (mrld != null) {
            val STRIDE = 448
            val UNITS_OFF = 12
            val NAME_OFF = 128
            var e = mrld.body
            while (e + STRIDE <= mrld.start + mrld.size) {
                val name = moov.utf8String(e + NAME_OFF, 63).replaceFirst(NAME_JUNK, "")
                val ch = ChannelDef(
                    name = name,
                    units = normUnits(moov.utf8String(e + UNITS_OFF, 63)),
                    min = moov.getInt32(e + 88),
                    max = moov.getInt32(e + 92),
                    mult = moov.getFloat64(e + 112),
                    off = moov.getFloat64(e + 120),
                )
                val tagId = moov.getUint32(e)
                dict[tagId] = ch
                CHANNEL_TAG_BY_NAME[name]?.let { tags[it] = tagId }
                e += STRIDE
            }
        }
        val beaconTag = tags.getValue("beacon")
        val odometerTag = tags.getValue("odometer")
        val latitudeTag = tags.getValue("latitude")
        val longitudeTag = tags.getValue("longitude")
        // raw -> display units (deg, km/h, rpm, G, °C, kPa) via the dictionary
        // entry. The conversion carries an offset as well as a factor, which is
        // what temperatures need.
        fun scaler(tagId: Long?): ((Long) -> Double)? {
            val ch = tagId?.let { dict[it] } ?: return null
            if (!ch.mult.isFinite() || ch.mult == 0.0) return null
            val (f, add) = UNIT_CONV[ch.units] ?: (1.0 to 0.0)
            val mult = ch.mult
            val off = ch.off
            return { v -> (v * mult + off) * f + add }
        }

        var date: String? = null
        var time: String? = null
        if (mrlv != null) {
            val raw = moov.latin1(mrlv.body, mrlv.size - 8)
            val ldat = LDAT.find(raw) ?: DATE.find(raw)
            val ltim = LTIM.find(raw)
            if (ldat != null) date = ldat.groupValues[1]
            if (ltim != null) time = ltim.groupValues[1].replace('-', ':')
        }

        // 4. Decode the telemetry samples. Full records carry an absolute
        // channel / value / timestamp; delta records adjust the running state
        // (which persists across samples). Values accumulate in raw
        // (pre-multiplier) units.
        val beacons = ArrayList<ChannelPoint>()
        // One bucket per known channel, keyed by the name CHANNEL_TAGS gave it.
        // Built in TAG_KEY_ORDER so a duplicate id resolves the same way the
        // JS Map does: a later `set` wins, and the beacon test runs first.
        val pts = LinkedHashMap<String, MutableList<ChannelPoint>>()
        val buckets = HashMap<Long, MutableList<ChannelPoint>>()
        for (key in TAG_KEY_ORDER) {
            if (key == "beacon") continue
            val arr = ArrayList<ChannelPoint>()
            pts[key] = arr
            tags[key]?.let { buckets[it] = arr }
        }
        /** The raw samples of a named channel, empty when the file lacks it. */
        fun rawPts(key: String): List<ChannelPoint> = pts[key] ?: emptyList()
        val odoPts = pts.getValue("odometer")
        val latPts = pts.getValue("latitude")
        val lonPts = pts.getValue("longitude")

        var lastTicks = 0L
        val vals = HashMap<Long, Long>() // running raw value per channel
        var chan: Long? = null
        var ticks = -1L
        fun emit(ch: Long, v: Long, tk: Long) {
            if (tk < 0 || tk > MAX_TICKS) return
            if (tk > lastTicks) lastTicks = tk
            val t = tk / 1e7
            if (ch == beaconTag) beacons.add(ChannelPoint(t = t, v = v.toDouble()))
            else buckets[ch]?.add(ChannelPoint(t = t, v = v.toDouble()))
        }
        for (i in 0 until nChunks) {
            val s = bufAt(source, offsets[i], sizeAt(i))
            val n = s.byteLength
            var q = 0
            while (q + 8 <= n) {
                val a0 = s.getUint32(q)
                val hi = (a0 ushr 24).toInt()
                if ((hi and 0xc0) == 0xc0) {
                    // full record
                    if (hi == 0xff) break // empty record: end of this sample
                    if (q + 16 > n) break
                    val c = a0 and 0x0fffffffL
                    chan = c
                    val v = s.getInt32(q + 4).toLong()
                    vals[c] = v
                    // Assembled as a Double, exactly as the JS does: a corrupt
                    // high word makes this larger than MAX_TICKS rather than
                    // wrapping a signed Long negative.
                    val tk = s.getUint32(q + 8).toDouble() * 4294967296.0 + s.getUint32(q + 12).toDouble()
                    q += 16
                    if (tk > MAX_TICKS) continue // corrupt timestamp: keep the value, skip the point
                    ticks = tk.toLong()
                    emit(c, v, ticks)
                } else if ((hi and 0xc0) == 0x40 && chan != null) {
                    // delta record
                    ticks += s.getUint32(q + 4)
                    val c = chan + (hi and 0x3f) - (if ((hi and 0x20) != 0) 0x40 else 0)
                    chan = c
                    q += 8
                    if (!vals.containsKey(c)) {
                        val ch = dict[c] ?: continue // no full record and no dictionary entry to seed from
                        // Math.trunc((min + max) / 2): integer division truncates toward zero too.
                        vals[c] = (ch.min.toLong() + ch.max.toLong()) / 2
                    }
                    val d = a0 and 0xffffffL
                    val v = vals.getValue(c) + (d - (if ((a0 and 0x800000L) != 0L) 0x1000000L else 0L))
                    vals[c] = v
                    emit(c, v, ticks)
                } else {
                    q += 8
                }
            }
        }
        // `Array.prototype.sort` is stable, and so is `sortBy`.
        beacons.sortBy { it.t }
        for (arr in pts.values) arr.sortBy { it.t }

        // Scale the car channels to display units and take session maxima.
        fun scaleAll(arr: List<ChannelPoint>, conv: ((Long) -> Double)?): List<ChannelPoint> =
            if (conv != null) arr.map { ChannelPoint(t = it.t, v = conv(it.v.toLong())) } else emptyList()
        /** `scaled("speed")` — that channel's samples in display units. */
        fun scaled(key: String): List<ChannelPoint> = scaleAll(rawPts(key), scaler(tags[key]))
        val speed = scaled("speed") // km/h
        val rpm = scaled("rpm")
        val latAcc = scaled("latAcc") // G
        val throttle = scaled("throttle") // % (dict units "%" -> x100)
        val brake = scaled("brake") // %
        val longAcc = scaled("longAcc") // G, signed: negative under braking
        val yaw = scaled("yaw") // deg/s, signed
        val boost = scaled("boost") // kPa gauge
        // Real firmware stores steering wheel angle in radians with an *empty*
        // units string, so UNIT_CONV's deg conversion never fires — apply it
        // here unless the dictionary already declared degrees.
        val steeringRad = tags["steering"]?.let { dict[it] }?.units != "deg"
        val steering = scaled("steering").map {
            ChannelPoint(t = it.t, v = if (steeringRad) (it.v * 180.0) / Math.PI else it.v)
        } // deg, signed

        // Gear is an enum, not a measurement: 1-8 are gears, and every other
        // value (13 on a real C7, with the clutch down) means "in transition /
        // no gear". Stored as 0 rather than dropped, so the array stays on the
        // grid with its neighbours.
        val gear = scaled("gear").map {
            ChannelPoint(t = it.t, v = if (it.v >= 1 && it.v <= 8) Math.round(it.v).toDouble() else 0.0)
        }

        // Wheel slip from the four wheelspeeds, as one channel rather than four:
        // (driven − non-driven) / non-driven, positive under wheelspin and
        // negative under lockup. Below 5 km/h the ratio is noise over a
        // near-zero divisor.
        val wheel = listOf("wsLN", "wsRN", "wsLD", "wsRD").map { scaled(it) }
        val wheelSlip = if (wheel.all { it.size > 10 }) {
            val ln = series(wheel[0])
            val rn = series(wheel[1])
            val ld = series(wheel[2])
            val rd = series(wheel[3])
            wheel[0].map { p ->
                val nd = (ln.at(p.t) + rn.at(p.t)) / 2
                val dr = (ld.at(p.t) + rd.at(p.t)) / 2
                val v = if (nd < 5) 0.0 else ((dr - nd) / nd) * 100
                ChannelPoint(t = p.t, v = Math.max(-100.0, Math.min(100.0, v)))
            }
        } else {
            emptyList()
        }

        // ABS / traction control / stability control packed into one bitfield
        // (bit 0 / 1 / 2) — three near-always-zero channels are not worth three
        // slots in the storage budget. Anchored on ABS's timestamps: the three
        // ship together at the same rate, and ABS is the one that fires.
        val absPts = scaled("absActive")
        val tcPts = scaled("tcActive")
        val vscPts = scaled("vscActive")
        val flags = if (absPts.size > 10) {
            val tc = if (tcPts.size > 10) series(tcPts) else null
            val vsc = if (vscPts.size > 10) series(vscPts) else null
            absPts.map { p ->
                var bits = if (p.v > 0.5) 1 else 0
                if (tc != null && tc.at(p.t) > 0.5) bits = bits or 2
                if (vsc != null && vsc.at(p.t) > 0.5) bits = bits or 4
                ChannelPoint(t = p.t, v = bits.toDouble())
            }
        } else {
            emptyList()
        }

        // Slow housekeeping (0.5-1.4 Hz). At one real sample every 40-90 m these
        // cannot fill a 20 m distance grid, so they are reduced to one value per
        // lap instead (`LapChannels.SCALAR_NAMES`).
        val lapScalarChannels = LinkedHashMap<String, List<ChannelPoint>>()
        for (key in SCALAR_CHANNEL_KEYS) {
            val arr = scaled(key)
            if (arr.isNotEmpty()) lapScalarChannels[key] = arr
        }

        fun maxOf(pts: List<ChannelPoint>, cap: Double): Double? {
            var m = Double.NEGATIVE_INFINITY
            for (p in pts) if (p.v > m) m = p.v
            return if (m > 0 && m < cap) m else null
        }
        val odoS = if (odoPts.size > 10) series(odoPts) else null
        var topSpeedKph = maxOf(speed, 500.0)
        if (topSpeedKph == null && odoS != null) {
            // no Speed channel: top speed from the odometer slope (m/s -> km/h).
            // Below 30 km/h it's paddock crawling, not a session top speed.
            var m = 0.0
            var t = odoS.first.t + 2
            while (t <= odoS.last.t - 2) {
                m = Math.max(m, odoS.rate(t))
                t += 1
            }
            topSpeedKph = if (m * 3.6 >= 30 && m * 3.6 < 500) m * 3.6 else null
        }
        fun absSeries(arr: List<ChannelPoint>): List<ChannelPoint> =
            arr.map { ChannelPoint(t = it.t, v = Math.abs(it.v)) }
        val metrics = ParsedTelemetry.Metrics(
            topSpeedKph = topSpeedKph,
            maxRpm = maxOf(rpm, 20000.0),
            maxLatG = maxOf(absSeries(latAcc), 5.0),
            // Braking is the negative half of longitudinal G; reported positive,
            // the way a driver talks about it.
            maxBrakeG = maxOf(longAcc.map { ChannelPoint(t = it.t, v = -it.v) }, 5.0),
            maxBoostKpa = maxOf(boost, 400.0),
            maxOilC = maxOf(lapScalarChannels["oilC"] ?: emptyList(), 250.0),
        )

        // Session-level numbers: one value each for the whole recording, stored
        // inside the channel blob's `meta` rather than in their own columns —
        // they are context for the graphs, not queryable facts.
        fun median(arr: List<ChannelPoint>): Double? {
            if (arr.size < 3) return null
            val v = arr.map { it.v }.sorted()
            return v[v.size shr 1]
        }
        val altitude = scaled("altitude")
        val carOdo = scaled("carOdo") // km, the car's lifetime odometer
        val sessionMeta = ParsedTelemetry.SessionMeta(
            ambientC = median(scaled("ambientC")),
            intakeC = median(scaled("intakeC")),
            elevationM = if (altitude.size > 10) {
                (altitude.maxOf { it.v }) - (altitude.minOf { it.v })
            } else {
                null
            },
            odometerKm = if (carOdo.isEmpty()) null else carOdo.maxOf { it.v },
        )

        // GPS trace: dictionary conversion first (radians -> degrees), then the
        // heuristic decoders. Speed channel (km/h -> m/s) beats odometer slope
        // for the racing-line speeds.
        val latConv = scaler(latitudeTag)
        val lonConv = scaler(longitudeTag)
        val gps = gpsFromChannels(
            latPts, lonPts, odoS,
            dictConv = if (latConv != null && lonConv != null) Decoder(lat = latConv, lon = lonConv) else null,
            speedS = if (speed.size > 10) series(speed.map { ChannelPoint(t = it.t, v = it.v / 3.6) }) else null,
        )

        // A channel is worth handing on only when it actually has a series behind
        // it; ten samples is the same floor buildLapChannels applies.
        fun dense(arr: List<ChannelPoint>): List<ChannelPoint>? = if (arr.size > 10) arr else null

        // 5. Build the full crossing list.
        val crossings = ArrayList<Crossing>()
        for (b in beacons) crossings.add(Crossing(v = b.v, t = b.t, exact = true))

        if (beacons.size >= 2 && odoPts.size > 10) {
            val odo = series(odoPts)
            val lat = if (latPts.size > 10) series(latPts) else null
            val d = beacons.map { odo.at(it.t) }
            val first = beacons[0]
            val last = beacons[beacons.size - 1]
            val lapLen = (d[d.size - 1] - d[0]) / (last.v - first.v)

            // beacon-calibrated line signature for validating extrapolated crossings
            val latAtLine = lat?.let { l -> beacons.sumOf { l.at(it.t) } / beacons.size }
            val latSpan = if (lat != null) latPts.maxOf { it.v } - latPts.minOf { it.v } else 0.0
            val odoRateAtLine = beacons.sumOf { odo.rate(it.t) } / beacons.size

            // fill gaps between known beacons using per-gap lap length
            for (i in 1 until beacons.size) {
                val a = beacons[i - 1]
                val b = beacons[i]
                val gap = b.v - a.v
                if (gap <= 1) continue
                val da = odo.at(a.t)
                val lg = (odo.at(b.t) - da) / gap
                var k = 1.0
                while (k < gap) {
                    crossings.add(Crossing(v = a.v + k, t = odo.timeAt(da + k * lg), exact = false))
                    k += 1
                }
            }

            // extrapolate before first / after last beacon while the car is still lapping
            fun tryExtrapolate(v: Double, dTarget: Double): Crossing? {
                if (dTarget < odo.first.v + lapLen * 0.02 || dTarget > odo.last.v - lapLen * 0.02) return null
                val t = odo.timeAt(dTarget)
                // car must be at pace (not in pits/paddock)
                if (odo.rate(t) < 0.4 * odoRateAtLine) return null
                // GPS latitude must match the line (within 4% of the track's lat extent)
                if (lat != null && latAtLine != null && Math.abs(lat.at(t) - latAtLine) > 0.04 * latSpan) return null
                return Crossing(v = v, t = t, exact = false)
            }
            var v = first.v - 1
            var k = 1.0
            while (v >= 0) {
                val c = tryExtrapolate(v, d[0] - k * lapLen) ?: break
                crossings.add(c)
                v -= 1
                k += 1
            }
            v = last.v + 1
            k = 1.0
            while (true) {
                val c = tryExtrapolate(v, d[d.size - 1] + k * lapLen) ?: break
                crossings.add(c)
                v += 1
                k += 1
            }
        }
        crossings.sortBy { it.t }

        // 6. Laps = deltas between consecutive crossings. startT/endT are on the
        // telemetry clock (seconds), same clock as the gps trace's t.
        val laps = ArrayList<ParsedLap>()
        for (i in 1 until crossings.size) {
            laps.add(
                ParsedLap(
                    lapNumber = JsMath.roundToInt(crossings[i].v),
                    timeMs = JsMath.roundToInt((crossings[i].t - crossings[i - 1].t) * 1000),
                    estimated = !(crossings[i].exact && crossings[i - 1].exact),
                    startT = crossings[i - 1].t,
                    endT = crossings[i].t,
                ),
            )
        }

        return ParsedTelemetry(
            kind = ParsedTelemetry.Kind.PDR,
            date = date, // "2025-10-27" (local) or null
            time = time, // "09:23:26" (local) or null
            durationS = lastTicks / 1e7,
            laps = laps,
            gps = gps, // degrees, or null
            needsLine = false,
            metrics = metrics, // each null when unavailable
            beaconCount = beacons.size,
            channels = ParsedTelemetry.RawChannels(latPts = latPts, odoPts = odoPts), // raw series for lap recovery
            // scaled car channels (km/h / rpm / G / % / deg) for per-lap channel
            // graphs; each null when the file lacks them
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
