package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.TraceSample
import app.trackevolution.core.model.TraceGeo
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

/**
 * AiM SmartyCam telemetry parser (NS-55, `docs/specs/native/NS-55-smartycam-import.md`).
 *
 * A port of `public/js/import/smartycam.js`, function for function and name for
 * name ([ecefToGeodetic], [readRecord], [lapsFromCounter], [plausibleChannels],
 * [parseAimMeta], [parseSmartyCamFile]), with its test cases
 * (`test/unit/smartycam.test.js` → `SmartyCamTest`) and a cross-language fixture
 * of its own (`contracts/logic/smartycam-parsers.json`) pinning it to the JS
 * output.
 *
 * A SmartyCam `.MOV` is QuickTime with three tracks: the picture (`avc1`), the
 * sound (`sowt` PCM) and a third, handler `free`, that is *declared* as PCM
 * audio and is really the telemetry: one chunk every five video frames (6 Hz),
 * of which only the first [RECORD_BYTES] are a little-endian record — the rest
 * is noise. The layout is reverse-engineered from one camera (SmartyCam GP HD,
 * firmware 01.03.30, slave to an AiM logger); the offsets are in [readRecord].
 *
 * Three traps, each inherited from the JS:
 *
 * - **Video time is not real time.** The camera drops frames (about 3 s at the
 *   start of every file, and up to 3 % after), so a 128 s lap can be 125 s of
 *   video. `t` here is *video* seconds — frame / fps — on purpose: every lap's
 *   `startT` / `endT` then cuts the clip where the lap is in the file. Lap
 *   *times* are the logger's own (offset 40), never `endT − startT`.
 * - **The lap counter trails the crossing by one record** ([LAP_LATENCY_RECORDS]).
 * - **The trailing XML's `nlap` / `best` are the logger's totals for the day**,
 *   not this file's. Only the date and the time are read from it, and never the
 *   driver's name, the vehicle or a serial number.
 *
 * Like the other video parsers, only the index and the records are read through
 * the [TelemetryByteSource]; the video itself is never read or uploaded.
 */
public object SmartyCam {

    public const val RECORD_BYTES: Int = 124

    /** The camera's "no reading" in any car field. */
    public const val NO_VALUE: Int = -12290
    public const val LAP_LATENCY_RECORDS: Int = 1
    public const val LAP_CLOCK_TOLERANCE_MS: Int = 1500

    private const val MIN_CHANNEL_SAMPLES = 10
    private const val META_TAIL_BYTES = 4096

    // WGS-84.
    private const val WGS84_A = 6378137.0
    private const val WGS84_E2 = 6.69437999014e-3

    /** Fixed, so every port lands on the same digits. */
    private const val GEODETIC_ITERATIONS = 5

    /** Degrees. */
    public data class Geodetic(val lat: Double, val lon: Double)

    /** Metres. */
    public data class Ecef(val x: Double, val y: Double, val z: Double)

    /**
     * `Math.hypot` as V8 computes it — scaled by the largest magnitude, with a
     * compensated sum — rather than `java.lang.Math.hypot`, which takes two
     * arguments and may differ from it in the last bit. With `StrictMath`'s
     * fdlibm `atan2` / `sin` (the library V8's are ported from), that is what
     * lets [ecefToGeodetic] land on the reference's digits and not merely near
     * them.
     */
    private fun hypot(vararg values: Double): Double {
        var max = 0.0
        for (v in values) {
            val a = Math.abs(v)
            if (a.isNaN()) return Double.NaN
            if (a > max) max = a
        }
        if (max == Double.POSITIVE_INFINITY) return max
        if (max == 0.0) return 0.0
        var sum = 0.0
        var compensation = 0.0
        for (v in values) {
            val n = Math.abs(v) / max
            val summand = n * n - compensation
            val preliminary = sum + summand
            compensation = (preliminary - sum) - summand
            sum = preliminary
        }
        return Math.sqrt(sum) * max
    }

    /** ECEF metres → latitude / longitude in degrees. */
    public fun ecefToGeodetic(xM: Double, yM: Double, zM: Double): Geodetic {
        val lon = StrictMath.atan2(yM, xM)
        val p = hypot(xM, yM)
        var lat = StrictMath.atan2(zM, p * (1 - WGS84_E2))
        for (i in 0 until GEODETIC_ITERATIONS) {
            val s = StrictMath.sin(lat)
            val n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s)
            lat = StrictMath.atan2(zM + WGS84_E2 * n * s, p)
        }
        return Geodetic(lat = (lat * 180) / Math.PI, lon = (lon * 180) / Math.PI)
    }

    /**
     * One record. Car fields and the lap fields are null when the camera wrote
     * [NO_VALUE]; [ecef] and [speedMs] are null when the fix isn't one. [t] —
     * video seconds — is not in the record: the file parser sets it from
     * [frame] and the picture's frame rate.
     */
    public data class Record(
        val frame: Long = 0,
        val tsMs: Int = 0,
        val lapCount: Int? = null,
        val lapMs: Int? = null,
        val ecef: Ecef? = null,
        val speedMs: Double? = null,
        val rpm: Int? = null,
        val throttle: Int? = null,
        val gear: Int? = null,
        val t: Double = 0.0,
    )

    private fun car(v: Int): Int? = if (v == NO_VALUE) null else v

    /** [ByteView] reads big-endian, as an MP4 is; a record is little-endian. */
    private fun u32le(dv: ByteView, o: Int): Long =
        dv.getUint8(o).toLong() or
            (dv.getUint8(o + 1).toLong() shl 8) or
            (dv.getUint8(o + 2).toLong() shl 16) or
            (dv.getUint8(o + 3).toLong() shl 24)

    /**
     * One record at [offset] of a view. Car fields and the lap fields are null
     * when the camera wrote [NO_VALUE]; `ecef` (metres) and `speedMs` are null
     * when the fix isn't one — all zero, a -1, or nowhere near the Earth's
     * surface.
     *
     * ```
     *    0 u32  video frame index (0, 5, 10, …)
     *    8 i32  logger clock, ms
     *   32 i32  completed-lap counter        40 i32  time of the lap just completed, ms
     *   60/64/68 i32  ECEF position, cm      76/80/84 i32  ECEF velocity, cm/s
     *  104 i32  rpm    108 i32  throttle %   120 i32  gear
     * ```
     *
     * Not read: the ×1e7 latitude / longitude at 16 / 24 (2 Hz, and up to 45 m
     * behind the ECEF fix), the float at 112 (its meaning changes with the
     * camera's configuration) and four slow channels nobody has identified.
     */
    public fun readRecord(dv: ByteView, offset: Int = 0): Record {
        fun i32(o: Int): Int = u32le(dv, offset + o).toInt()
        val x = i32(60)
        val y = i32(64)
        val z = i32(68)
        val r = hypot(x.toDouble(), y.toDouble(), z.toDouble()) / 100
        val fix = x != -1 && y != -1 && z != -1 && r > 6.3e6 && r < 6.4e6
        val lapCount = car(i32(32))
        val lapMs = car(i32(40))
        return Record(
            frame = u32le(dv, offset),
            tsMs = i32(8),
            lapCount = if (lapCount != null && lapCount >= 0) lapCount else null,
            lapMs = if (lapMs != null && lapMs > 0) lapMs else null,
            ecef = if (fix) Ecef(x = x / 100.0, y = y / 100.0, z = z / 100.0) else null,
            speedMs = if (fix) hypot(i32(76).toDouble(), i32(80).toDouble(), i32(84).toDouble()) / 100 else null,
            rpm = car(i32(104)),
            throttle = car(i32(108)),
            gear = car(i32(120)),
        )
    }

    /** The crossing that began the lap in progress. */
    private class Open(val count: Int, val t: Double, val tsMs: Int)

    /**
     * The laps a file holds, from records that carry `t` (video seconds).
     *
     * The counter steps to `c` one record after the car crossed the line, with
     * the time of lap `c` beside it. A lap needs both its crossings in the file,
     * so it is two *consecutive* steps: the first step seen closes a lap that
     * began before the video did (the out-lap, timed from when the logger
     * started) and only opens the next. A counter that jumps, goes backwards or
     * goes missing opens nothing. A lap whose logger-clock length disagrees with
     * its reported time is a glitch, not a lap.
     */
    public fun lapsFromCounter(records: List<Record>): List<ParsedLap> {
        val laps = ArrayList<ParsedLap>()
        var open: Open? = null
        var prev: Int? = null
        for (i in records.indices) {
            val r = records[i]
            val count = r.lapCount
            if (count == null) {
                open = null
                prev = null
                continue
            }
            if (prev != null && count != prev) {
                if (count == prev + 1) {
                    val at = records[Math.max(0, i - LAP_LATENCY_RECORDS)]
                    val o = open
                    val lapMs = r.lapMs
                    if (
                        o != null &&
                        o.count == prev &&
                        lapMs != null &&
                        // Long: two i32 clocks apart can leave an Int.
                        Math.abs(at.tsMs.toLong() - o.tsMs.toLong() - lapMs.toLong()) <= LAP_CLOCK_TOLERANCE_MS &&
                        at.t > o.t
                    ) {
                        laps.add(
                            ParsedLap(lapNumber = laps.size + 1, timeMs = lapMs, estimated = false, startT = o.t, endT = at.t),
                        )
                    }
                    open = Open(count = count, t = at.t, tsMs = at.tsMs)
                } else {
                    open = null
                }
            }
            prev = count
        }
        return laps
    }

    /** Which car fields [plausibleChannels] keeps. */
    public data class Plausible(val rpm: Boolean, val throttle: Boolean, val gear: Boolean) {
        /** `ok[k]` in the JS. */
        public operator fun get(name: String): Boolean = when (name) {
            "rpm" -> rpm
            "throttle" -> throttle
            "gear" -> gear
            else -> false
        }
    }

    /**
     * Whether each car field looks like what it is taken to be, over the whole
     * file. Their meaning is confirmed on one camera configuration only, so a
     * field that fails is left out — the import never fails on it.
     */
    public fun plausibleChannels(records: List<Record>): Plausible {
        fun enough(v: List<Int>): Boolean = v.size >= MIN_CHANNEL_SAMPLES
        val rpm = records.mapNotNull { it.rpm }
        val throttle = records.mapNotNull { it.throttle }
        val gear = records.mapNotNull { it.gear }
        // Guarded by `enough`, so never asked of an empty list. Long, so a
        // field that isn't a throttle can't overflow the "moves by 30" test.
        fun max(v: List<Int>): Long = v.max().toLong()
        fun min(v: List<Int>): Long = v.min().toLong()
        return Plausible(
            rpm = enough(rpm) && min(rpm) >= 0 && max(rpm) >= 1000 && max(rpm) <= 20000,
            throttle = enough(throttle) && min(throttle) >= 0 && max(throttle) <= 100 &&
                max(throttle) - min(throttle) >= 30,
            gear = enough(gear) && min(gear) >= 0 && max(gear) <= 8,
        )
    }

    /** What [parseAimMeta] reads — and all it reads. */
    public data class AimMeta(val date: String?, val time: String?)

    private val DATE_RE = Regex("^(\\d{2})/(\\d{2})/(\\d{4})$")
    private val HOUR_RE = Regex("^(\\d{2}):(\\d{2})[.:](\\d{2})$")

    /**
     * The trailing `<aim_meta_data>` block → date `yyyy-mm-dd` and time
     * `hh:mm:ss`, each null when absent. Nothing else in it is read.
     */
    public fun parseAimMeta(text: String?): AimMeta {
        fun field(n: String): String? =
            Regex("<p n=\"${Regex.escape(n)}\">([^<]*)</p>").find(text ?: "")?.groupValues?.get(1)
        val d = DATE_RE.find(field("date") ?: "")?.groupValues
        val h = HOUR_RE.find(field("hour") ?: "")?.groupValues
        return AimMeta(
            date = if (d != null) "${d[3]}-${d[2]}-${d[1]}" else null,
            time = if (h != null) "${h[1]}:${h[2]}:${h[3]}" else null,
        )
    }

    /** A trak's handler subtype, sample-entry type and tables. */
    private class TrackInfo(
        val handler: String,
        val entry: String?,
        val timescale: Long,
        val duration: Long,
        val stbl: MP4.Box,
    )

    private fun trackInfo(moov: ByteView, trak: MP4.Box): TrackInfo? {
        val mdia = MP4.child(moov, trak, "mdia") ?: return null
        val hdlr = MP4.child(moov, mdia, "hdlr") ?: return null
        val mdhd = MP4.child(moov, mdia, "mdhd") ?: return null
        val minf = MP4.child(moov, mdia, "minf") ?: return null
        val stbl = MP4.child(moov, minf, "stbl") ?: return null
        val stsd = MP4.child(moov, stbl, "stsd")
        val v1 = moov.getUint8(mdhd.body) == 1
        return TrackInfo(
            handler = MP4.fourcc(moov, hdlr.body + 8),
            entry = if (stsd != null && stsd.size >= 24) MP4.fourcc(moov, stsd.body + 12) else null,
            timescale = moov.getUint32(mdhd.body + (if (v1) 20 else 12)),
            duration = if (v1) moov.getBigUint64(mdhd.body + 24) else moov.getUint32(mdhd.body + 16),
            stbl = stbl,
        )
    }

    private class Chunk(val offset: Long, val bytes: Long)

    /**
     * Where each chunk of a track starts and how many bytes it holds, for a
     * track of fixed-size samples (which is what a track declared as PCM is).
     */
    private fun chunkTable(moov: ByteView, stbl: MP4.Box): List<Chunk> {
        val stco = MP4.child(moov, stbl, "stco") ?: MP4.child(moov, stbl, "co64") ?: return emptyList()
        val stsc = MP4.child(moov, stbl, "stsc") ?: return emptyList()
        val stsz = MP4.child(moov, stbl, "stsz") ?: return emptyList()
        val sampleBytes = moov.getUint32(stsz.body + 4)
        if (sampleBytes == 0L) return emptyList()
        val is64 = stco.type == "co64"
        // The counts a table declares, held to what its box can hold: a read
        // past the view answers zero rather than failing, so a corrupt count
        // would otherwise be walked to its end.
        val nChunks = minOf(moov.getUint32(stco.body + 4), entriesIn(stco, if (is64) 8 else 4))
        val nRuns = minOf(moov.getUint32(stsc.body + 4), entriesIn(stsc, 12)).toInt()
        val out = ArrayList<Chunk>()
        for (e in 0 until nRuns) {
            val first = moov.getUint32(stsc.body + 8 + e * 12)
            val perChunk = moov.getUint32(stsc.body + 12 + e * 12)
            val next = if (e + 1 < nRuns) moov.getUint32(stsc.body + 8 + (e + 1) * 12) else nChunks + 1
            var c = first
            while (c < next && c <= nChunks) {
                val at = (c - 1).toInt()
                val offset = if (is64) moov.getBigUint64(stco.body + 8 + at * 8) else moov.getUint32(stco.body + 8 + at * 4)
                out.add(Chunk(offset = offset, bytes = perChunk * sampleBytes))
                c++
            }
        }
        return out
    }

    /** How many [width]-byte entries fit in a full box after its version/flags and count. */
    private fun entriesIn(box: MP4.Box, width: Int): Long =
        Math.max(0, (box.start + box.size - (box.body + 8)) / width).toLong()

    /** Seconds since 1904 (QuickTime's epoch) → date and time in UTC. */
    private fun mvhdStamp(moov: ByteView, moovBox: MP4.Box): AimMeta {
        val none = AimMeta(date = null, time = null)
        val mvhd = MP4.child(moov, moovBox, "mvhd") ?: return none
        val v1 = moov.getUint8(mvhd.body) == 1
        val s = if (v1) moov.getBigUint64(mvhd.body + 4) else moov.getUint32(mvhd.body + 4)
        if (s <= 2082844800L) return none
        val iso = try {
            Instant.ofEpochSecond(s - 2082844800L).atOffset(ZoneOffset.UTC)
        } catch (_: DateTimeException) {
            return none
        }
        if (iso.year > 9999) return none
        return AimMeta(
            date = "%04d-%02d-%02d".format(Locale.ROOT, iso.year, iso.monthValue, iso.dayOfMonth),
            time = "%02d:%02d:%02d".format(Locale.ROOT, iso.hour, iso.minute, iso.second),
        )
    }

    private val CAR_FIELDS = listOf("rpm", "throttle", "gear")

    private fun carValue(r: Record, name: String): Int? = when (name) {
        "rpm" -> r.rpm
        "throttle" -> r.throttle
        "gear" -> r.gear
        else -> null
    }

    public fun parseSmartyCamFile(source: TelemetryByteSource): ParsedTelemetry {
        val index = MP4.readMoov(source)
        val moov = index.view
        val moovBox = index.root
        val tracks = MP4.boxes(moov, moovBox.body, moovBox.start + moovBox.size)
            .filter { it.type == "trak" }
            .mapNotNull { trackInfo(moov, it) }

        // The telemetry: handler `free`, declared as `sowt`, in chunks long
        // enough to hold a record. The chunk length is the file's own — never a
        // constant.
        val data = tracks.firstOrNull { it.handler == "free" && it.entry == "sowt" }
        val chunks = if (data != null) chunkTable(moov, data.stbl).filter { it.bytes >= RECORD_BYTES } else emptyList()
        if (chunks.isEmpty()) {
            throw TelemetryParseException("No SmartyCam telemetry track in this video", isNoTrack = true)
        }

        // The picture's frame rate turns a record's frame index into video seconds.
        val video = tracks.firstOrNull { it.handler == "vide" }
        val stts = video?.let { MP4.child(moov, it.stbl, "stts") }
        val frameDelta = if (stts != null && moov.getUint32(stts.body + 4) != 0L) moov.getUint32(stts.body + 12) else 0L
        if (video == null || video.timescale == 0L || frameDelta == 0L) {
            throw TelemetryParseException("SmartyCam video track is missing its timing")
        }
        val fps = video.timescale.toDouble() / frameDelta.toDouble()
        val durationS = video.duration.toDouble() / video.timescale.toDouble()

        val records = ArrayList<Record>(chunks.size)
        var lastFrame = -1L
        for (c in chunks) {
            val dv = bufAt(source, c.offset, RECORD_BYTES.toLong())
            if (dv.byteLength < RECORD_BYTES) continue
            val r = readRecord(dv)
            if (r.frame <= lastFrame) continue // a record out of order is not a record
            lastFrame = r.frame
            records.add(r.copy(t = r.frame / fps))
        }

        val gps = ArrayList<GpsPoint>()
        for (r in records) {
            val ecef = r.ecef ?: continue
            val (lat, lon) = ecefToGeodetic(ecef.x, ecef.y, ecef.z)
            gps.add(GpsPoint(t = r.t, lat = lat, lon = lon, v = r.speedMs))
        }
        if (gps.size < 10) throw TelemetryParseException("No GPS data in this SmartyCam video")

        val laps = lapsFromCounter(records)

        val ok = plausibleChannels(records)
        var carChannels = ParsedTelemetry.CarChannels()
        for (k in CAR_FIELDS) {
            if (!ok[k]) continue
            carChannels = carChannels.with(
                k,
                records.mapNotNull { r -> carValue(r, k)?.let { ChannelPoint(t = r.t, v = it.toDouble()) } },
            )
        }

        val topKph = gps.fold(0.0) { m, p -> Math.max(m, (p.v ?: 0.0) * 3.6) }
        val metrics = ParsedTelemetry.Metrics(
            topSpeedKph = if (topKph >= 30 && topKph < 500) topKph else null,
            maxRpm = carChannels.rpm?.fold(0.0) { m, p -> Math.max(m, p.v) },
        )

        val tail = bufAt(source, Math.max(0L, source.size - META_TAIL_BYTES), META_TAIL_BYTES.toLong())
        val meta = parseAimMeta(tail.latin1(0, tail.byteLength))
        val stamp = if (meta.date != null) meta else mvhdStamp(moov, moovBox)

        var bestLapTrace: List<TraceSample>? = null
        var traceGeo: TraceGeo? = null
        if (laps.isNotEmpty()) {
            val best = laps.reduce { a, b -> if (b.timeMs < a.timeMs) b else a }
            val startT = best.startT
            val endT = best.endT
            if (startT != null && endT != null) {
                bestLapTrace = GeoTrace.lapTrace(GeoTrace.projectTrace(gps), startT, endT)
                traceGeo = if (bestLapTrace != null) GeoTrace.traceOrigin(gps) else null
            }
        }

        return ParsedTelemetry(
            kind = ParsedTelemetry.Kind.SMARTYCAM,
            date = stamp.date,
            time = stamp.time,
            durationS = durationS,
            laps = laps,
            gps = gps,
            carChannels = carChannels,
            metrics = metrics,
            bestLapTrace = bestLapTrace,
            traceGeo = traceGeo,
            needsLine = false,
        )
    }
}
