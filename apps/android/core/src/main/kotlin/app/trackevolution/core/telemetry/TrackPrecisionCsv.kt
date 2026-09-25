package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TraceSample

/**
 * Porsche Track Precision's CSV export — a line-for-line port of
 * `public/js/import/csv.js`, under the same names, pinned to
 * `contracts/logic/csv-parsers.json` by `TrackPrecisionCsvContractTest` and
 * carrying `test/unit/csv.test.js`'s cases in `TrackPrecisionCsvTest`.
 *
 * The same car, the same channels and the same app as its `.vbo` export
 * ([VBO]), in a plainer layout: one header row of camelCase names, then one
 * comma-separated row per ~10 Hz sample. Newer app versions put a space after
 * every comma; empty fields are columns the car didn't report.
 *
 * Three things differ from the `.vbo` and each is load-bearing:
 *   - Coordinates are decimal degrees, east-positive, so nothing is negated.
 *   - The clock is `timestamp`, epoch milliseconds.
 *   - There is no start/finish line — but there is Track Precision's own lap
 *     timer, `laptime`, the milliseconds since the car last crossed its line.
 *     The crossing is therefore `timestamp - laptime` on the first sample of
 *     each lap, which is exact to the app's own timing ([lapsFromLaptime]) and
 *     needs no line at all. A file whose timer never completes a lap falls
 *     back to the line picker, like a `.vbo` without `[laptiming]`.
 *
 * Units change with the app's firmware and the file never says which: speed is
 * km/h in the 2024 exports and m/s later ([speedToMs] decides against the GPS
 * trace), and the accelerations are m/s² then G ([VBO.accelToG], whose _PTPA
 * columns changed the same way).
 */
public object TrackPrecisionCsv {

    /** A car channel column: its stored name, its lowercased header, the conversion. */
    private class CarColumn(val name: String, val header: String, val f: (Double) -> Double)

    /**
     * Car channels, by lowercased header → `channels.js` name, converted as
     * [VBO]'s `CAR_COLUMNS` are. `yawVelocity` is mapped for parity with the
     * `.vbo`'s `yaw` column; every sample so far writes it as 0, which
     * [VBO.finishCarChannels]' `varies` drops.
     */
    private val CAR_COLUMNS: List<CarColumn> = listOf(
        CarColumn("rpm", "enginespeed") { it },
        // stored as a magnitude, like PDR
        CarColumn("latG", "lateralacceleration") { Math.abs(it) },
        CarColumn("longG", "longitudinalacceleration") { it },
        CarColumn("steering", "steeringwheelangle") { it },
        // Math.round on 1..8 — positive, so java.lang.Math.round has the JS semantics.
        CarColumn("gear", "currentgear") { v -> if (v >= 1 && v <= 8) java.lang.Math.round(v).toDouble() else 0.0 },
        CarColumn("yaw", "yawvelocity") { it },
    )
    private const val THROTTLE_COLUMN = "pedalforce" // 0-1
    private const val BRAKE_COLUMN = "brakingpressure" // bar

    /** Tire pressures, bar → kPa. 3276.8 (0x7FFF / 10) is "no reading", as in the `.vbo`. */
    private val TYRE_COLUMNS: List<Pair<String, String>> = listOf(
        "tyreKpaLF" to "tirepressurefl",
        "tyreKpaRF" to "tirepressurefr",
        "tyreKpaLR" to "tirepressurerl",
        "tyreKpaRR" to "tirepressurerr",
    )
    private const val MAX_TYRE_BAR = 10.0

    /** Speed-column units, as the column's value for 1 m/s. */
    public val SPEED_UNITS: List<Pair<String, Double>> = listOf(
        "m/s" to 1.0,
        "km/h" to 3.6,
        "mph" to 2.2369362920544,
    )

    /** GPS steps shorter than this don't count towards [speedToMs]. */
    private const val MIN_STEP_M = 0.5

    /**
     * The `speed` column's factor to m/s, decided by comparing it with the GPS
     * trace: Σ speed·dt over Σ distance driven is the column's value for 1 m/s,
     * and the nearest unit (in ratio, not difference) wins. Only steps where the
     * car moved at least [MIN_STEP_M] count, so a parked stretch of GPS jitter
     * can't pull the ratio. Km/h when there's nothing to go on — the older
     * exports' unit.
     */
    public fun speedToMs(trace: List<TracePoint>, speeds: List<Double?>): Double {
        var driven = 0.0
        var integrated = 0.0
        for (i in 1 until trace.size) {
            val d = Math.hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y)
            val dt = trace[i].t - trace[i - 1].t
            val v = speeds[i]
            if (d < MIN_STEP_M || !(dt > 0) || v == null) continue
            driven += d
            integrated += v * dt
        }
        if (!(driven > 0) || !(integrated > 0)) return 1 / 3.6
        val ratio = integrated / driven
        var best = SPEED_UNITS[1]
        for (u in SPEED_UNITS) {
            if (Math.abs(Math.log(ratio / u.second)) < Math.abs(Math.log(ratio / best.second))) best = u
        }
        return 1 / best.second
    }

    /** One sample of the lap timer: the timer, its lap distance (m) and speed (m/s), each null where empty. */
    public data class TimerRow(val t: Double, val lapMs: Double?, val lapM: Double?, val v: Double?)

    /**
     * How far the last value of a lap's counter may sit from the lap's length.
     */
    public const val LAPTIME_TOL_S: Double = 1.0

    /** How far short of (or past) the line a recording's last sample may be and still close its lap. */
    public const val EDGE_M: Double = 30.0

    /** The share of the timed laps' average speed a last lap must still be doing to be closed. */
    public const val EDGE_PACE: Double = 0.5

    /**
     * Laps from Track Precision's lap timer. [rows] are in time order.
     *
     * A lap starts wherever the counter goes backwards or sits at 0 — some
     * firmware writes a single 0 row at the line, some goes straight to a small
     * value — and its crossing is placed at `t - lapMs` on the first sample
     * after, which is finer than the 10 Hz rows. A lap between two crossings is
     * kept only when the counter ran the whole way: its last value before the
     * second crossing must be within [LAPTIME_TOL_S] of the lap's length. That
     * is what drops the stretch before the first crossing, a pit stop (the
     * counter sits at 0 for minutes) and a recording stopped mid-lap. The
     * timer's laps are exact to the app, so `estimated` is false.
     *
     * Track Precision also stops recording *at* the line, so the last lap's
     * counter runs to within metres of a full lap and never resets. When the
     * final sample's lap distance is within [EDGE_M] of the timed laps' length
     * (their median, each carried from its last sample to its crossing) —
     * either side, since a lap's length varies by a few metres with the line
     * taken and the last sample may already be past it without the reset
     * having been written — the difference is covered at the final sample's
     * speed, the same allowance [VBO] makes for its edge crossings, and that one
     * lap is marked estimated. Only at pace, though: the car must still be
     * doing at least [EDGE_PACE] of the timed laps' average speed. A session
     * usually ends with the cool-down lap rolling down the pit lane, which runs
     * alongside the line — its lap distance reaches a full lap at 30 km/h
     * without the car ever crossing the line, and the app rightly never counted
     * it.
     */
    public fun lapsFromLaptime(rows: List<TimerRow>, minLapS: Double = 30.0, maxLapS: Double = 3600.0): List<ParsedLap> {
        class Crossing(val t: Double, val counted: Double?)
        val crossings = ArrayList<Crossing>()
        val lapM = ArrayList<Double>() // each timed run's length in metres, carried on to its crossing
        var prev: Double? = null
        var pending = true
        var runMax: Double? = null
        var last: TimerRow? = null // the last sample with the timer running
        for (row in rows) {
            val lapMs = row.lapMs ?: continue
            val t = row.t
            if (lapMs <= 0) {
                if (prev != null && prev > 0) runMax = prev
                pending = true
                prev = 0.0
                continue
            }
            if (prev != null && lapMs < prev) {
                runMax = prev
                pending = true
            }
            if (pending) {
                val ct = t - lapMs / 1000
                val l = last
                if (runMax != null && l != null && l.lapM != null && l.v != null) lapM.add(l.lapM + l.v * (ct - l.t))
                crossings.add(Crossing(ct, runMax))
                pending = false
                runMax = null
            }
            prev = lapMs
            last = row
        }
        val laps = ArrayList<ParsedLap>()
        fun keep(startT: Double, endT: Double, estimated: Boolean) {
            val s = endT - startT
            if (s < minLapS || s > maxLapS) return
            laps.add(ParsedLap(timeMs = Math.round(s * 1000).toInt(), estimated = estimated, startT = startT, endT = endT))
        }
        for (i in 1 until crossings.size) {
            val counted = crossings[i].counted
            val s = crossings[i].t - crossings[i - 1].t
            if (counted == null || Math.abs(s - counted / 1000) > LAPTIME_TOL_S) continue
            keep(crossings[i - 1].t, crossings[i].t, false)
        }
        fun median(xs: List<Double>): Double = xs.sorted()[xs.size / 2]
        val l = last
        if (l != null && !pending && laps.isNotEmpty() && lapM.isNotEmpty() && l.lapM != null && l.v != null && l.v > 0) {
            val lapLenM = median(lapM)
            val paceMs = lapLenM / (median(laps.map { it.timeMs.toDouble() }) / 1000)
            val short = lapLenM - l.lapM
            if (Math.abs(short) <= EDGE_M && l.v >= EDGE_PACE * paceMs) keep(crossings.last().t, l.t + short / l.v, true)
        }
        return laps
    }

    private val LINE_BREAK = Regex("\\r?\\n")
    private val NAME_TIME = Regex("\\d{4}-\\d{2}-\\d{2}[-_ T](\\d{2})[-:](\\d{2})[-:](\\d{2})")

    /**
     * `"recording-2026-06-06-09-53-45.csv"` → `"09:53:45"`, the recording's local
     * start. The timestamp column is UTC and the file carries no zone, so the
     * name is the only source of a wall-clock time.
     */
    internal fun timeFromName(name: String?): String? {
        val m = NAME_TIME.find(name ?: "") ?: return null
        return "${m.groupValues[1]}:${m.groupValues[2]}:${m.groupValues[3]}"
    }

    private fun pad2(n: Int): String = n.toString().padStart(2, '0')

    /** JS's `trim()`, which also strips the BOM that `String.trim()` keeps. */
    private fun jsTrim(s: String): String = s.trim { it.isWhitespace() || it == '﻿' }

    public fun parseTrackPrecisionCsv(text: String, fileName: String? = null): ParsedTelemetry {
        val lines = text.split(LINE_BREAK).filter { jsTrim(it).isNotEmpty() }
        if (lines.isEmpty()) throw TelemetryParseException("Not a Porsche Track Precision CSV (empty file)")
        val names = lines[0].split(",").map { jsTrim(it).lowercase() }
        fun col(name: String): Int = names.indexOf(name)
        val iTs = col("timestamp")
        val iLat = col("latitude")
        val iLon = col("longitude")
        if (iTs < 0 || iLat < 0 || iLon < 0) {
            throw TelemetryParseException("Not a Porsche Track Precision CSV (no timestamp/latitude/longitude columns)")
        }
        val iSpeed = col("speed")
        val iLap = col("laptime")
        val iLapM = col("lapdistance")
        val carCols = CAR_COLUMNS.map { it to col(it.header) }.filter { it.second >= 0 }
        val iThrottle = col(THROTTLE_COLUMN)
        val iBrake = col(BRAKE_COLUMN)
        val tyreCols = TYRE_COLUMNS.map { (name, n) -> name to col(n) }.filter { it.second >= 0 }

        // First pass: the rows as numbers. The speed column's unit is only known
        // once the whole GPS trace is in (speedToMs), and the car-silence check
        // needs speed in m/s, so the channels are collected in a second pass.
        class Row(val t: Double, val lat: Double, val lon: Double, val f: List<String>) {
            fun num(i: Int): Double? {
                if (i < 0 || i >= f.size) return null
                val s = jsTrim(f[i])
                if (s.isEmpty()) return null
                val v = VBO.number(s)
                return if (v.isFinite()) v else null
            }
        }
        val rows = ArrayList<Row>()
        var ts0: Double? = null
        for (r in 1 until lines.size) {
            val f = lines[r].split(",")
            val probe = Row(0.0, 0.0, 0.0, f)
            val ts = probe.num(iTs)
            val lat = probe.num(iLat)
            val lon = probe.num(iLon)
            if (ts == null || lat == null || lon == null) continue
            if (lat == 0.0 && lon == 0.0) continue // no GPS fix
            if (ts0 == null) ts0 = ts
            val t = (ts - ts0) / 1000
            if (rows.isNotEmpty() && t <= rows.last().t) continue // duplicate or out-of-order row
            rows.add(Row(t, lat, lon, f))
        }
        if (rows.size < 10) throw TelemetryParseException("Track Precision CSV contains no usable GPS data")

        val bare = rows.map { GpsPoint(t = it.t, lat = it.lat, lon = it.lon, v = null) }
        val trace = GeoTrace.projectTrace(bare, bare[0])
        val k = if (iSpeed >= 0) speedToMs(trace, rows.map { it.num(iSpeed) }) else null

        val points = ArrayList<GpsPoint>(rows.size)
        val lapRows = ArrayList<TimerRow>(rows.size)
        val car = LinkedHashMap<String, MutableList<ChannelPoint>>()
        for ((c, _) in carCols) car[c.name] = ArrayList()
        val throttle = ArrayList<ChannelPoint>()
        val brake = ArrayList<ChannelPoint>()
        val tires = LinkedHashMap<String, MutableList<ChannelPoint>>()
        for ((name, _) in tyreCols) tires[name] = ArrayList()
        val iRpm = carCols.firstOrNull { it.first.name == "rpm" }?.second ?: -1
        for (row in rows) {
            val t = row.t
            val speed = if (k == null) null else row.num(iSpeed)
            val v = if (speed == null) null else speed * k!!
            points.add(GpsPoint(t = t, lat = row.lat, lon = row.lon, v = v))
            lapRows.add(TimerRow(t = t, lapMs = row.num(iLap), lapM = row.num(iLapM), v = v))
            if (iRpm >= 0 && VBO.carSilent(row.num(iRpm), v)) continue
            for ((c, i) in carCols) {
                val x = row.num(i)
                if (x != null) car[c.name]!!.add(ChannelPoint(t = t, v = c.f(x)))
            }
            val th = row.num(iThrottle)
            if (th != null) throttle.add(ChannelPoint(t = t, v = th))
            val br = row.num(iBrake)
            if (br != null) brake.add(ChannelPoint(t = t, v = Math.max(0.0, br)))
            for ((name, i) in tyreCols) {
                val x = row.num(i)
                if (x != null && x > 0 && x < MAX_TYRE_BAR) tires[name]!!.add(ChannelPoint(t = t, v = x * 100))
            }
        }

        val (carChannels, lapScalarChannels, sessionMeta) =
            VBO.finishCarChannels(car, throttle, brake, tires, emptyList())

        val laps = if (iLap >= 0) lapsFromLaptime(lapRows) else emptyList()
        var bestLapTrace: List<TraceSample>? = null
        if (laps.isNotEmpty()) {
            val best = laps.reduce { a, b -> if (b.timeMs < a.timeMs) b else a }
            bestLapTrace = GeoTrace.lapTrace(GeoTrace.projectTrace(points), best.startT!!, best.endT!!)
        }

        // The name's date and time are the recording's own, in local time; the
        // UTC timestamp is the fallback, which can land on the neighbouring day.
        val d0 = java.time.Instant.ofEpochMilli(Math.floor(ts0!!).toLong()).atZone(java.time.ZoneOffset.UTC)
        val date = VBO.dateFromName(fileName) ?: "${d0.year}-${pad2(d0.monthValue)}-${pad2(d0.dayOfMonth)}"
        val time = timeFromName(fileName) ?: "${pad2(d0.hour)}:${pad2(d0.minute)}:${pad2(d0.second)}"

        return ParsedTelemetry(
            kind = ParsedTelemetry.Kind.TRACK_PRECISION,
            date = date,
            time = time,
            durationS = points.last().t,
            laps = laps,
            bestLapTrace = bestLapTrace,
            gps = points,
            carChannels = carChannels,
            lapScalarChannels = lapScalarChannels,
            sessionMeta = sessionMeta,
            needsLine = laps.isEmpty(),
        )
    }
}
