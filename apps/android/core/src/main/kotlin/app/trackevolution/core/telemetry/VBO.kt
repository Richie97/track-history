package app.trackevolution.core.telemetry

import app.trackevolution.core.Gate
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.Point
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TraceSample

/**
 * Racelogic `.vbo` parser — a line-for-line port of `public/js/import/vbo.js`,
 * under the same names, pinned to `contracts/logic/vbo-parsers.json` by
 * `VBOContractTest` and carrying `test/unit/vbo.test.js`'s cases in `VBOTest`.
 *
 * Plain ASCII: an optional "File created ..." line, `[section]` blocks —
 * `[column names]` for the data layout, `[laptiming]` for the start/finish
 * line, `[data]` for the samples. Written by VBOX hardware and by RaceChrono /
 * TrackAddict / Harry's LapTimer / Porsche Track Precision exports — the last
 * of which is an app on the phone, which is why this left the web-only list.
 *
 * Two layouts of `[column names]` exist in the wild: VBOX hardware writes every
 * name on one line separated by spaces; Porsche's Track Precision App writes
 * one name per line, and its names contain spaces ("steering wheel angle"). A
 * section of more than one line is read as one name per line.
 *
 * Coordinates are in minutes (degrees × 60) and Racelogic longitude is
 * west-positive, so it is negated here into the usual east-positive degrees
 * every other source uses — otherwise the stored racing line draws mirrored.
 * An exporter that ignores the convention still times correctly (lap
 * derivation is geometry within the file) and [Telemetry.applyGate]'s
 * mirroring fallback still matches it to a batch-mate.
 *
 * Unlike the JS, which reads a `Blob`, this takes the text: the whole file is
 * the input, and [Telemetry.parseTelemetryFile] reads it from the byte source.
 */
public object VBO {

    /** A car channel column: its stored name, the column names it may go by, the conversion. */
    private class CarColumn(val name: String, val names: List<String>, val f: (Double) -> Double)

    /**
     * Car channels, by `[column names]` entry → `channels.js` name. The first
     * name present wins, so Porsche's `LatAcc_PTPA` is preferred over its
     * `latacc` column, which on current firmware holds G / 9.81 despite a
     * "latAccel g" header. The _PTPA columns are not always G either — see
     * [accelToG]. `f` converts to the stored unit (see `CHANNEL_NAMES`).
     */
    private val CAR_COLUMNS: List<CarColumn> = listOf(
        CarColumn("rpm", listOf("engine", "rpm", "engine speed", "enginespeed")) { it },
        // stored as a magnitude, like PDR
        CarColumn("latG", listOf("latacc_ptpa", "latacc", "lat_acc", "latg")) { Math.abs(it) },
        CarColumn("longG", listOf("longacc_ptpa", "longacc", "long_acc", "longg")) { it },
        CarColumn("steering", listOf("steering wheel angle", "steering", "steer", "steering angle")) { it },
        // Math.round on 1..8 — positive, so java.lang.Math.round has the JS semantics.
        CarColumn("gear", listOf("current gear", "gear")) { v ->
            if (v >= 1 && v <= 8) java.lang.Math.round(v).toDouble() else 0.0
        },
        CarColumn("yaw", listOf("yaw", "yaw rate", "yawrate")) { it },
    )

    /**
     * Throttle is a pedal position; exporters write it as a 0–1 fraction or a
     * percentage, decided per file by the column's own peak.
     */
    private val THROTTLE_COLUMNS = listOf("pedal", "throttle", "throttle position", "accelerator")

    /**
     * Brake is a *pressure* in these files (bar), not a pedal position. Stored as
     * a percentage of the file's own peak, so the trace keeps its shape on the
     * 0–100 brake axis PDR's pedal position uses.
     */
    private val BRAKE_COLUMNS = listOf("braking", "brake", "brake pressure", "braking pressure")

    /** Tire pressures, bar → kPa, one reading per lap (the lap-end value). */
    private val TYRE_COLUMNS: List<Pair<String, String>> = listOf(
        "tyreKpaLF" to "tire pressure front left",
        "tyreKpaRF" to "tire pressure front right",
        "tyreKpaLR" to "tire pressure rear left",
        "tyreKpaRR" to "tire pressure rear right",
    )

    /** Track Precision writes 3276.8 (0x7FFF / 10) when the car sent no reading. */
    internal const val MAX_TYRE_BAR: Double = 10.0

    /**
     * The line a file carries can be short — Track Precision's is ~15 m and sits
     * mostly to one side of the racing line — so it is stretched to at least this
     * either side of its midpoint (the width of a hand-picked gate).
     */
    internal const val MIN_GATE_HALF_M: Double = 20.0

    /**
     * How far past (or short of) the line a recording's first (last) fix may sit
     * and still have a crossing extrapolated — well under a second at track pace.
     */
    internal const val EDGE_M: Double = 30.0

    private val WS = Regex("\\s+")
    private val LINE_BREAK = Regex("\\r?\\n")
    private val TIME_OF_DAY = Regex("^(\\d{2})(\\d{2})(\\d{2}(?:\\.\\d+)?)$")
    private val NAME_DATE = Regex("(\\d{4})-(\\d{2})-(\\d{2})")
    private val CREATED_ON = Regex(
        "created on (\\d{2})/(\\d{2})/(\\d{4})(?: at| @)? (\\d{2}):(\\d{2})(?::(\\d{2}))?",
        RegexOption.IGNORE_CASE,
    )
    private val CREATED_AT = Regex("created at (\\d{4})-(\\d{2})-(\\d{2})", RegexOption.IGNORE_CASE)
    private val SECTION = Regex("^\\[(.+)]$")
    private val VELOCITY_LINE = Regex("^velocity\\b", RegexOption.IGNORE_CASE)
    private val MPH = Regex("mph", RegexOption.IGNORE_CASE)
    private val KNOTS = Regex("kts|knots", RegexOption.IGNORE_CASE)
    private val START_LINE = Regex("^start\\s", RegexOption.IGNORE_CASE)

    /** `"095512.30"` (time-of-day) → seconds. */
    internal fun timeOfDayS(s: String): Double? {
        val m = TIME_OF_DAY.find(s) ?: return null
        return number(m.groupValues[1]) * 3600 + number(m.groupValues[2]) * 60 + number(m.groupValues[3])
    }

    /** Porsche's own factor: PTPA = latacc × 9.81 exactly. */
    public const val GRAVITY_MS2: Double = 9.81
    public const val MS2_P99_MIN: Double = 3.0
    private val ACCEL_CHANNELS = listOf("latG", "longG")

    /**
     * Acceleration columns change unit with Track Precision's firmware: the 2024
     * exports write the _PTPA columns (and the CSV export's
     * `lateralAcceleration` / `longitudinalAcceleration`) in m/s² — a 1.2 G
     * corner reads 11.8 — and later ones in G. Nothing in the file says which,
     * so the file's own 99th-percentile magnitude decides: no car on a track
     * day sustains 3 G, and any lap of one pulls well over 3 m/s². A percentile
     * rather than the peak, so one kerb spike can't flip the unit. Returns the
     * factor to G: 1, or 1 / [GRAVITY_MS2].
     */
    public fun accelToG(pts: List<ChannelPoint>): Double {
        if (pts.isEmpty()) return 1.0
        val mags = pts.map { Math.abs(it.v) }.sorted()
        return if (mags[Math.floor(0.99 * (mags.size - 1)).toInt()] > MS2_P99_MIN) 1 / GRAVITY_MS2 else 1.0
    }

    /**
     * A car that stops talking to the recorder mid-session doesn't blank its
     * columns: Track Precision goes on writing every car channel as exactly 0
     * while the GPS keeps going, so a dropout would chart as a flat line at
     * 0 rpm / 0 G for the rest of the session. An engine at 0 rpm in a car
     * moving faster than this is that dropout, and the row's car values are
     * skipped — every channel, not just rpm, since they fail together.
     */
    public const val CAR_SILENT_MS: Double = 5.0

    public fun carSilent(rpm: Double?, speedMs: Double?): Boolean =
        rpm == 0.0 && speedMs != null && speedMs > CAR_SILENT_MS

    /**
     * A column that never changes (Track Precision writes every column it knows,
     * zeroed when the car doesn't report it) is no channel at all.
     */
    internal fun varies(pts: List<ChannelPoint>): Boolean {
        for (i in 1 until pts.size) if (pts[i].v != pts[0].v) return true
        return false
    }

    /**
     * `"recording-2026-06-06-09-53-45.vbo"` → `"2026-06-06"`. Track Precision's
     * "File created at" line is the *export* time, so the name is the better
     * source for the session's date when it carries one.
     */
    public fun dateFromName(name: String?): String? {
        val m = NAME_DATE.find(name ?: "") ?: return null
        return "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]}"
    }

    /**
     * Stretch a file's line about its own midpoint to at least [MIN_GATE_HALF_M]
     * either side, keeping its angle, and give it the direction of travel where
     * the trace passes closest, so the wider line can't also count a nearby
     * stretch of track driven the other way.
     */
    internal fun widenGate(gate: Gate, trace: List<TracePoint>): Gate {
        val dx = gate.x2 - gate.x1
        val dy = gate.y2 - gate.y1
        val len = Math.hypot(dx, dy)
        if (len == 0.0 || len.isNaN()) return gate
        val half = Math.max(len / 2, MIN_GATE_HALF_M)
        val ux = dx / len
        val uy = dy / len
        var k = 0
        var best = Double.POSITIVE_INFINITY
        for (i in trace.indices) {
            val ex = trace[i].x - gate.x
            val ey = trace[i].y - gate.y
            val d = ex * ex + ey * ey
            if (d < best) {
                best = d
                k = i
            }
        }
        val a = trace[Math.max(0, k - 2)]
        val b = trace[Math.min(trace.size - 1, k + 2)]
        val moving = Math.hypot(b.x - a.x, b.y - a.y) > 1
        return Gate(
            x = gate.x,
            y = gate.y,
            hx = if (moving) b.x - a.x else null,
            hy = if (moving) b.y - a.y else null,
            x1 = gate.x - ux * half,
            y1 = gate.y - uy * half,
            x2 = gate.x + ux * half,
            y2 = gate.y + uy * half,
        )
    }

    /**
     * Track Precision starts and stops recording *at* the start/finish line, so
     * the first fix sits a few metres past it and the last a few metres short:
     * the line is never seen crossed at either end, and the first and last
     * flying laps would be lost. A fix within [EDGE_M] of the line, inside its
     * width and moving through it, gets a crossing extrapolated at its own speed
     * — estimated, like every GPS lap.
     */
    internal fun edgeCrossings(trace: List<TracePoint>, gate: Gate): List<Double> {
        val crossings = ArrayList(GeoTrace.gateCrossings(trace, gate))
        val hx = gate.hx
        val hy = gate.hy
        if (hx == null || hy == null || trace.size < 2) return crossings
        val gx = gate.x2 - gate.x1
        val gy = gate.y2 - gate.y1
        val half = Math.hypot(gx, gy) / 2
        val ux = gx / (2 * half)
        val uy = gy / (2 * half)
        // unit normal pointing the way the car crosses
        var nx = -uy
        var ny = ux
        if (nx * hx + ny * hy < 0) {
            nx = -nx
            ny = -ny
        }
        fun speed(i: Int, j: Int): Double {
            val v = trace[i].v
            if (v != null && v.isFinite()) return v
            val dt = Math.abs(trace[j].t - trace[i].t)
            return if (dt != 0.0 && !dt.isNaN()) Math.hypot(trace[j].x - trace[i].x, trace[j].y - trace[i].y) / dt else 0.0
        }
        // (past, v), or null when the fix isn't on the line's span or isn't moving.
        fun at(i: Int, j: Int): Pair<Double, Double>? {
            val p = trace[i]
            val along = (p.x - gate.x) * ux + (p.y - gate.y) * uy
            val past = (p.x - gate.x) * nx + (p.y - gate.y) * ny
            val v = speed(i, j)
            return if (Math.abs(along) <= half && v > 5) past to v else null
        }
        val first = at(0, 1)
        if (first != null && first.first > 0 && first.first < EDGE_M) {
            crossings.add(0, trace[0].t - first.first / first.second)
        }
        val n = trace.size - 1
        val last = at(n, n - 1)
        if (last != null && last.first < 0 && -last.first < EDGE_M) {
            crossings.add(trace[n].t - last.first / last.second)
        }
        return crossings
    }

    /**
     * Parse a `.vbo` file's text. [fileName] supplies the date when it carries
     * one (Track Precision's own header line is the export time).
     *
     * Throws [TelemetryParseException] for a file that isn't a VBO or holds no
     * usable GPS.
     */
    public fun parseVboText(text: String, fileName: String? = null): ParsedTelemetry {
        val lines = text.split(LINE_BREAK)
        val firstLine = lines.firstOrNull() ?: ""

        var date = dateFromName(fileName)
        var time: String? = null
        // VBOX: "File created on 20/06/2026 at 09:15:00" — the recording's own
        // start, so its time is used as well as its date.
        val created = CREATED_ON.find(firstLine)
        if (created != null) {
            val g = created.groups
            if (date == null) date = "${g[3]!!.value}-${g[2]!!.value}-${g[1]!!.value}"
            time = "${g[4]!!.value}:${g[5]!!.value}:${g[6]?.value ?: "00"}"
        }
        // Track Precision: "File created at 2026-09-22 21:59:37 -0600" — when it
        // was exported, so only a last resort for the date and never the time.
        val exported = CREATED_AT.find(firstLine)
        if (exported != null && date == null) {
            date = "${exported.groupValues[1]}-${exported.groupValues[2]}-${exported.groupValues[3]}"
        }

        // Collect sections.
        val sections = HashMap<String, MutableList<String>>()
        var current: MutableList<String>? = null
        for (raw in lines) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val sec = SECTION.find(line)
            if (sec != null) {
                current = ArrayList()
                sections[sec.groupValues[1].lowercase()] = current
                continue
            }
            current?.add(line)
        }

        val nameLines = sections["column names"] ?: emptyList()
        val colNames = (if (nameLines.size > 1) nameLines else (nameLines.firstOrNull() ?: "").split(WS))
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
        if (colNames.isEmpty()) throw TelemetryParseException("Not a valid VBO file (no [column names] section)")
        fun col(name: String): Int = colNames.indexOf(name)
        fun firstCol(names: List<String>): Int = names.map { col(it) }.firstOrNull { it >= 0 } ?: -1
        val iTime = col("time")
        val iLat = col("lat")
        val iLon = col("long")
        val iVel = firstCol(listOf("velocity", "speed"))
        if (iTime < 0 || iLat < 0 || iLon < 0) {
            throw TelemetryParseException("VBO file is missing time/lat/long columns")
        }
        // gps.v is m/s across all parsers (channels depend on it). The [header]
        // section names the velocity unit — "velocity kmh" in VBOX files and the
        // common exporters; handle mph/knots variants, default km/h.
        val velLine = (sections["header"] ?: emptyList()).firstOrNull { VELOCITY_LINE.containsMatchIn(it) } ?: ""
        val velToMs = when {
            MPH.containsMatchIn(velLine) -> 0.44704
            KNOTS.containsMatchIn(velLine) -> 0.514444
            else -> 1 / 3.6
        }

        val iHeight = firstCol(listOf("height", "alt", "altitude"))
        val carCols = CAR_COLUMNS.map { it to firstCol(it.names) }.filter { it.second >= 0 }
        val iRpm = carCols.firstOrNull { it.first.name == "rpm" }?.second ?: -1
        val iThrottle = firstCol(THROTTLE_COLUMNS)
        val iBrake = firstCol(BRAKE_COLUMNS)
        val tyreCols = TYRE_COLUMNS.map { (name, n) -> name to col(n) }.filter { it.second >= 0 }

        // Data rows -> GPS points (+ car channels on the same clock). VBO
        // coordinates are minutes -> /60 to degrees. The time column is a
        // time-of-day; make t relative to the first sample (handling a midnight
        // wrap).
        val points = ArrayList<GpsPoint>()
        val car = LinkedHashMap<String, MutableList<ChannelPoint>>()
        for ((c, _) in carCols) car[c.name] = ArrayList()
        val throttle = ArrayList<ChannelPoint>()
        val brake = ArrayList<ChannelPoint>()
        val tires = LinkedHashMap<String, MutableList<ChannelPoint>>()
        for ((name, _) in tyreCols) tires[name] = ArrayList()
        val heights = ArrayList<Double>()
        var t0: Double? = null
        for (row in sections["data"] ?: emptyList()) {
            val f = row.split(WS)
            if (f.size < colNames.size) continue
            val tod = timeOfDayS(f[iTime])
            val lat = number(f[iLat])
            val lon = number(f[iLon])
            if (tod == null || !lat.isFinite() || !lon.isFinite()) continue
            if (lat == 0.0 && lon == 0.0) continue // no GPS fix
            if (t0 == null) t0 = tod
            var t = tod - t0
            if (t < 0) t += 86400
            points.add(
                GpsPoint(t = t, lat = lat / 60, lon = -lon / 60, v = if (iVel >= 0) number(f[iVel]) * velToMs else null),
            )

            fun num(i: Int): Double? {
                val v = number(f[i])
                return if (v.isFinite()) v else null
            }
            if (iHeight >= 0) {
                val v = num(iHeight)
                if (v != null) heights.add(v)
            }
            if (iRpm >= 0 && carSilent(num(iRpm), points.last().v)) continue
            for ((c, i) in carCols) {
                val v = num(i)
                if (v != null) car[c.name]!!.add(ChannelPoint(t = t, v = c.f(v)))
            }
            if (iThrottle >= 0) {
                val v = num(iThrottle)
                if (v != null) throttle.add(ChannelPoint(t = t, v = v))
            }
            if (iBrake >= 0) {
                val v = num(iBrake)
                if (v != null) brake.add(ChannelPoint(t = t, v = Math.max(0.0, v)))
            }
            for ((name, i) in tyreCols) {
                val v = num(i)
                if (v != null && v > 0 && v < MAX_TYRE_BAR) tires[name]!!.add(ChannelPoint(t = t, v = v * 100))
            }
        }
        if (points.size < 10) throw TelemetryParseException("VBO file contains no usable GPS data")

        if (time == null && t0 != null) {
            val h = Math.floor(t0 / 3600).toLong()
            val mi = Math.floor((t0 % 3600) / 60).toLong()
            val se = Math.floor(t0 % 60).toLong()
            time = "${pad2(h)}:${pad2(mi)}:${pad2(se)}"
        }

        val (carChannels, lapScalarChannels, sessionMeta) = finishCarChannels(car, throttle, brake, tires, heights)

        // [laptiming]: "Start <lon1> <lat1> <lon2> <lat2>" (minutes, two
        // endpoints of the start/finish line) per Racelogic, though some
        // exporters write latitude first. Both readings are tried and the one
        // lying on the driven trace is kept. If present, laps come for free.
        var laps: List<ParsedLap> = emptyList()
        var lapTracePts: List<TraceSample>? = null
        val startLine = (sections["laptiming"] ?: emptyList()).firstOrNull { START_LINE.containsMatchIn(it) }
        if (startLine != null) {
            val n = startLine.split(WS).drop(1).take(4).map { number(it) }
            if (n.size == 4 && n.all { it.isFinite() }) {
                val origin = points[0]
                val trace = GeoTrace.projectTrace(points, origin)
                fun endpoints(lonFirst: Boolean): List<TracePoint> = GeoTrace.projectTrace(
                    if (lonFirst) {
                        listOf(
                            GpsPoint(t = 0.0, lat = n[1] / 60, lon = -n[0] / 60, v = null),
                            GpsPoint(t = 0.0, lat = n[3] / 60, lon = -n[2] / 60, v = null),
                        )
                    } else {
                        listOf(
                            GpsPoint(t = 0.0, lat = n[0] / 60, lon = -n[1] / 60, v = null),
                            GpsPoint(t = 0.0, lat = n[2] / 60, lon = -n[3] / 60, v = null),
                        )
                    },
                    origin,
                )
                fun nearest(ends: List<TracePoint>): Double {
                    val (a, b) = ends
                    val mx = (a.x + b.x) / 2
                    val my = (a.y + b.y) / 2
                    var best = Double.POSITIVE_INFINITY
                    for (p in trace) {
                        val ex = p.x - mx
                        val ey = p.y - my
                        best = Math.min(best, ex * ex + ey * ey)
                    }
                    return best
                }
                val lonFirst = endpoints(true)
                val latFirst = endpoints(false)
                val (end1, end2) = if (nearest(lonFirst) <= nearest(latFirst)) lonFirst else latFirst
                val gate = widenGate(GeoTrace.gateFromSegment(Point(end1.x, end1.y), Point(end2.x, end2.y)), trace)
                laps = GeoTrace.lapsFromCrossings(edgeCrossings(trace, gate)).map { ParsedLap.of(it) }
                if (laps.isNotEmpty()) {
                    val best = laps.reduce { a, b -> if (b.timeMs < a.timeMs) b else a }
                    lapTracePts = GeoTrace.lapTrace(trace, best.startT!!, best.endT!!)
                }
            }
        }

        return ParsedTelemetry(
            kind = ParsedTelemetry.Kind.VBO,
            date = date,
            time = time,
            durationS = points.last().t,
            laps = laps,
            bestLapTrace = lapTracePts,
            gps = points,
            carChannels = carChannels,
            lapScalarChannels = lapScalarChannels,
            sessionMeta = sessionMeta,
            // A [laptiming] line that yields no laps (wrong circuit, odd layout)
            // falls back to manual line picking.
            needsLine = laps.isEmpty(),
        )
    }

    /** What [finishCarChannels] hands back: the parsed shape's three car fields. */
    public data class FinishedCarChannels(
        val carChannels: ParsedTelemetry.CarChannels,
        val lapScalarChannels: Map<String, List<ChannelPoint>>,
        val sessionMeta: ParsedTelemetry.SessionMeta?,
    )

    /**
     * The raw per-sample series a Track Precision file carries → the parsed
     * shape's `carChannels` / `lapScalarChannels` / `sessionMeta`. Shared by this
     * parser and the CSV one ([TrackPrecisionCsv]), which read the same car's
     * same channels out of a different layout, so the rules below apply to both
     * exports:
     *   - [car]: rpm, latG, longG, steering, gear, yaw, already converted by
     *     `CAR_COLUMNS`' `f` (latG a magnitude, gear 0–8), in that order
     *   - [throttle]: pedal position, 0–1 or 0–100
     *   - [brake]: pressure, ≥ 0
     *   - [tires]: tyreKpaLF… in kPa, sentinels already dropped
     *   - [heights]: metres, or empty
     */
    public fun finishCarChannels(
        car: Map<String, List<ChannelPoint>>,
        throttle: List<ChannelPoint>,
        brake: List<ChannelPoint>,
        tires: Map<String, List<ChannelPoint>>,
        heights: List<Double>,
    ): FinishedCarChannels {
        var carChannels = ParsedTelemetry.CarChannels()
        for ((name, pts) in car) {
            if (pts.size < 10 || !varies(pts)) continue
            val k = if (ACCEL_CHANNELS.contains(name)) accelToG(pts) else 1.0
            carChannels = carChannels.with(name, if (k == 1.0) pts else pts.map { ChannelPoint(t = it.t, v = it.v * k) })
        }
        if (throttle.size >= 10 && varies(throttle)) {
            val peak = throttle.maxOf { it.v }
            val scale = if (peak <= 1.0001) 100.0 else 1.0
            carChannels = carChannels.with(
                "throttle",
                throttle.map { ChannelPoint(t = it.t, v = Math.min(100.0, Math.max(0.0, it.v * scale))) },
            )
        }
        if (brake.size >= 10 && varies(brake)) {
            val peak = brake.maxOf { it.v }
            carChannels = carChannels.with("brake", brake.map { ChannelPoint(t = it.t, v = (it.v / peak) * 100) })
        }
        val lapScalarChannels = LinkedHashMap<String, List<ChannelPoint>>()
        for ((name, pts) in tires) if (pts.size >= 10) lapScalarChannels[name] = pts
        val sessionMeta = if (heights.size > 10) {
            ParsedTelemetry.SessionMeta(elevationM = heights.maxOf { it } - heights.minOf { it })
        } else {
            null
        }
        return FinishedCarChannels(carChannels, lapScalarChannels, sessionMeta)
    }

    private fun pad2(v: Long): String = v.toString().padStart(2, '0')

    // ---- JavaScript's Number() -------------------------------------------------

    private val DECIMAL = Regex("^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?$")
    private val RADIX = Regex("^0([xXoObB])([0-9a-fA-F]+)$")

    /**
     * `Number(s)`: what the JS parser runs every field through, and not what
     * `String.toDouble` accepts — Kotlin takes "1f", "1d", "NaN" and hex floats,
     * which JS reads as NaN, while JS reads `""` as 0 and `"0x1A"` as 26 and
     * Kotlin rejects both. Every token here comes from a
     * whitespace split, so it is never blank, but the rule is kept whole so the
     * two diff by behaviour as well as by eye.
     */
    internal fun number(raw: String): Double {
        val s = raw.trim()
        if (s.isEmpty()) return 0.0
        when (s) {
            "Infinity", "+Infinity" -> return Double.POSITIVE_INFINITY
            "-Infinity" -> return Double.NEGATIVE_INFINITY
        }
        if (DECIMAL.matches(s)) return s.toDouble()
        val radix = RADIX.find(s) ?: return Double.NaN
        val base = when (radix.groupValues[1].lowercase()) {
            "x" -> 16
            "o" -> 8
            else -> 2
        }
        var out = 0.0
        for (ch in radix.groupValues[2]) {
            val d = Character.digit(ch, base)
            if (d < 0) return Double.NaN
            out = out * base + d
        }
        return out
    }
}
