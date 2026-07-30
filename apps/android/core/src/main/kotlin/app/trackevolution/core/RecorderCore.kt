package app.trackevolution.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Live lap-recording core — the pure logic behind the in-app GPS recorder.
 *
 * A direct port of `public/js/record/core.js`. **Function names, constant names
 * and constant values are deliberately identical to the JavaScript original** so
 * the three implementations (web, iOS, Android) can be diffed by eye. That is the
 * only drift defense for logic no contract test covers — see
 * `docs/specs/native/NS-12-android-recorder-core.md`.
 *
 * Do not "improve" the algorithms here. If you find a genuine bug, fix it in the
 * JavaScript first so all three clients inherit the fix together.
 *
 * The recorder collects fixes from the platform's background location watcher
 * (NS-16 owns that lifecycle); everything here is data in, data out, so it unit
 * tests on the JVM with no emulator. [toParsed] emits the same shape a telemetry
 * file parser produces, so a finished recording drops into the existing import
 * review + line-picker pipeline unchanged.
 */
public object RecorderCore {

    /** Checkpoint format version. Bumping this invalidates older checkpoints. */
    public const val RECORDING_V: Int = 1

    /**
     * Fixes with worse reported accuracy than this are noise (parking garages,
     * cold starts) — dropping them beats feeding them to the gate math.
     */
    public const val MAX_ACC_M: Double = 100.0

    /**
     * Above this speed the car has clearly been on track (m/s, ~54 km/h).
     * Auto-stop is armed only after this, so a long grid wait before the first
     * lap never kills the recording.
     */
    public const val DRIVEN_MPS: Double = 15.0

    /** "Stationary" for trimming and auto-stop (m/s, brisk walking pace). */
    public const val IDLE_MPS: Double = 2.0

    /** Auto-stop after this long stationary once the car has been driven. */
    public const val AUTO_STOP_IDLE_S: Double = 15.0 * 60.0

    /** Absolute cap — a forgotten recorder must not run all day. */
    public const val MAX_DURATION_S: Double = 4.0 * 3600.0

    public const val MAX_FIXES: Int = 20_000

    /** Default margin kept either side of the driving when trimming idle tails. */
    public const val TRIM_MARGIN_S: Double = 30.0

    // -----------------------------------------------------------------------
    // construction and ingest
    // -----------------------------------------------------------------------

    /**
     * A new empty recording.
     *
     * [eventId] is the event this recording attaches to, or null for an
     * event-less recording (started from CarPlay/Android Auto before the event
     * exists — see NS-19/NS-20). It is an opaque id: a numeric string for a
     * synced event, or `tmp-N` for one created offline.
     */
    public fun createRecording(eventId: String?, startedAtMs: Double): Recording =
        Recording(eventId = eventId, startedAtMs = startedAtMs)

    // -----------------------------------------------------------------------
    // derived values
    // -----------------------------------------------------------------------

    public fun elapsedS(rec: Recording, nowMs: Double): Double =
        Math.max(0.0, (nowMs - rec.startedAtMs) / 1000.0)

    /**
     * Per-fix speed in m/s: the source's own speed when reported, else the
     * displacement rate to the neighbouring fix (equirectangular meters — fine
     * at track scale, the same approximation as `public/js/import/geo.js`).
     */
    public fun fixSpeeds(fixes: List<Fix>): List<Double> {
        if (fixes.isEmpty()) return emptyList()
        val kx = 111_320.0 * Math.cos(fixes[0].lat * Math.PI / 180.0)
        val ky = 110_540.0
        return fixes.mapIndexed { i, f ->
            val reported = f.speed
            if (reported != null) {
                reported
            } else {
                val a = fixes[Math.max(0, i - 1)]
                val b = fixes[Math.min(fixes.size - 1, i + 1)]
                val dt = b.t - a.t
                if (dt <= 0.0) {
                    0.0
                } else {
                    Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky) / dt
                }
            }
        }
    }

    /**
     * Should the recorder stop itself? Two independent triggers:
     *
     *  - the car was driven at track pace at some point and has now been
     *    stationary for [idleS] (driver forgot to stop after the session) — a
     *    pre-session grid wait never trips this, because nothing fast has been
     *    seen yet;
     *  - the hard duration cap, driven or not.
     *
     * The "driven first" condition is load-bearing. Removing it makes the
     * recorder shut down during a long grid wait, before the session starts.
     */
    public fun shouldAutoStop(
        rec: Recording,
        nowMs: Double,
        idleS: Double = AUTO_STOP_IDLE_S,
        drivenMps: Double = DRIVEN_MPS,
        idleMps: Double = IDLE_MPS,
        maxS: Double = MAX_DURATION_S,
    ): Boolean {
        val elapsed = elapsedS(rec, nowMs)
        if (elapsed > maxS) return true
        val speeds = fixSpeeds(rec.fixes)
        var driven = false
        var lastMovingT = 0.0
        for (i in speeds.indices) {
            if (speeds[i] >= drivenMps) driven = true
            if (speeds[i] >= idleMps) lastMovingT = rec.fixes[i].t
        }
        if (!driven) return false
        return elapsed - lastMovingT > idleS
    }

    /**
     * Cut the stationary paddock/grid tails off the fix list, keeping [marginS]
     * of context on each side so the out-lap start and cool-down are preserved.
     */
    public fun trimIdle(
        fixes: List<Fix>,
        idleMps: Double = IDLE_MPS,
        marginS: Double = TRIM_MARGIN_S,
    ): List<Fix> {
        if (fixes.size < 2) return fixes
        val speeds = fixSpeeds(fixes)
        var first = -1
        var last = -1
        for (i in speeds.indices) {
            if (speeds[i] >= idleMps) {
                if (first < 0) first = i
                last = i
            }
        }
        if (first < 0) return emptyList()
        val t0 = fixes[first].t - marginS
        val t1 = fixes[last].t + marginS
        return fixes.filter { it.t >= t0 && it.t <= t1 }
    }

    /**
     * A recording as a parsed-import object, matching the `js/import/parse.js`
     * contract: `{kind, date, time, durationS, laps: [], gps, needsLine: true}`.
     *
     * `needsLine` is always true: a live recording has no lap markers, so the
     * review panel's line picker derives laps from start/finish crossings exactly
     * as for a GoPro or plain-VBO file (NS-14 ports that geometry).
     *
     * Returns null when there is too little data to time anything. [zone] is
     * injectable only so tests can pin a timezone; production uses the device's,
     * because track time is phone time.
     */
    public fun toParsed(rec: Recording, zone: ZoneId = ZoneId.systemDefault()): ParsedRecording? {
        val fixes = trimIdle(rec.fixes)
        if (fixes.size < 30) return null
        val gps = fixes.map { GpsPoint(t = it.t, lat = it.lat, lon = it.lon, v = it.speed) }
        val durationS = gps.last().t - gps.first().t
        if (durationS < 60.0) return null
        val local = Instant.ofEpochMilli(rec.startedAtMs.toLong()).atZone(zone)
        return ParsedRecording(
            kind = "live",
            date = DATE_FMT.format(local),
            time = TIME_FMT.format(local),
            durationS = durationS,
            laps = emptyList(),
            gps = gps,
            needsLine = true,
        )
    }

    // -----------------------------------------------------------------------
    // checkpoint (de)serialization
    // -----------------------------------------------------------------------

    /**
     * The checkpoint JSON, byte-identical to what the web app writes for the
     * same recording. Hand-built rather than generated, because JSON number
     * formatting has to match JavaScript's — see [JsJson].
     */
    public fun serializeRecording(rec: Recording): String {
        val sb = StringBuilder(64 + rec.fixes.size * 48)
        sb.append("{\"v\":").append(RECORDING_V)
        sb.append(",\"eventId\":").append(JsJson.id(rec.eventId))
        sb.append(",\"startedAtMs\":").append(JsJson.number(rec.startedAtMs))
        sb.append(",\"fixes\":[")
        rec.fixes.forEachIndexed { i, f ->
            if (i > 0) sb.append(',')
            sb.append('[')
                .append(JsJson.number(f.t)).append(',')
                .append(JsJson.number(f.lat)).append(',')
                .append(JsJson.number(f.lon)).append(',')
                .append(f.speed?.let { JsJson.number(it) } ?: "null").append(',')
                .append(f.accuracy?.let { JsJson.number(it) } ?: "null")
                .append(']')
        }
        sb.append("]}")
        return sb.toString()
    }

    /**
     * Parses a checkpoint, returning null for anything that isn't a plausible
     * recording — wrong version, non-finite start, malformed fixes, not even JSON.
     *
     * **Never throws.** A corrupt checkpoint is read during app start-up, and
     * crashing there would leave the user unable to open the app at all.
     */
    public fun deserializeRecording(json: String?): Recording? {
        if (json.isNullOrEmpty()) return null
        return runCatching { parseCheckpoint(json) }.getOrNull()
    }

    private fun parseCheckpoint(json: String): Recording? {
        val root = LENIENT.parseToJsonElement(json) as? JsonObject ?: return null

        val version = (root["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
        if (version != RECORDING_V) return null

        val startedAtMs = (root["startedAtMs"] as? JsonPrimitive)?.doubleOrNull ?: return null
        if (!startedAtMs.isFinite()) return null

        val rawFixes = root["fixes"] as? JsonArray ?: return null

        val eventId = when (val raw = root["eventId"]) {
            null, JsonNull -> null
            is JsonPrimitive -> raw.content
            else -> return null
        }

        val fixes = ArrayList<Fix>(rawFixes.size)
        for (entry in rawFixes) {
            // JS validates: Array.isArray(f) && f.length >= 3 && every value is
            // null or finite. A tuple may legitimately carry only 3 elements;
            // missing speed/accuracy read as null.
            val tuple = entry as? JsonArray ?: return null
            if (tuple.size < 3) return null
            val values = ArrayList<Double?>(tuple.size)
            for (v in tuple) {
                when {
                    v is JsonNull -> values.add(null)
                    v is JsonPrimitive && !v.isString -> {
                        val d = v.doubleOrNull ?: return null
                        if (!d.isFinite()) return null
                        values.add(d)
                    }
                    else -> return null
                }
            }
            // t, lat and lon are structural — a null there is not a recording.
            val t = values[0] ?: return null
            val lat = values[1] ?: return null
            val lon = values[2] ?: return null
            fixes.add(
                Fix(
                    t = t,
                    lat = lat,
                    lon = lon,
                    speed = values.getOrNull(3),
                    accuracy = values.getOrNull(4),
                )
            )
        }
        return Recording(eventId = eventId, startedAtMs = startedAtMs, initialFixes = fixes)
    }

    private val LENIENT = Json { isLenient = false; ignoreUnknownKeys = true }
    private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
}

/**
 * One accepted GPS fix, stored relative to the recording start.
 *
 * The wire form is a tuple — `[tRelS, lat, lon, speed|null, accuracy|null]` —
 * which keeps the checkpoint around 50 bytes per fix. The rounding applied on
 * ingest ([Recording.addFix]) is part of that format, not cosmetic.
 */
public data class Fix(
    /** Seconds since the recording started, 2dp. */
    val t: Double,
    /** Degrees, 6dp. */
    val lat: Double,
    /** Degrees, 6dp. */
    val lon: Double,
    /** m/s as reported by the platform, 2dp; null when it reported none. */
    val speed: Double?,
    /** Reported accuracy in meters, 1dp; null when it reported none. */
    val accuracy: Double?,
)

/** A raw fix as delivered by the platform location watcher, before validation. */
public data class LocationFix(
    /**
     * Epoch milliseconds **of the fix itself**, not of delivery.
     *
     * Modelled as a Double to mirror the JavaScript original's finiteness check,
     * and so a platform that hands us a bogus value is rejected here rather than
     * further downstream. Callers pass `location.time.toDouble()`.
     */
    val timeMs: Double,
    val lat: Double,
    val lon: Double,
    /** m/s, or null. Platforms signal "no speed" differently — normalize before calling. */
    val speed: Double? = null,
    /** Reported horizontal accuracy in meters, or null. */
    val accuracy: Double? = null,
)

/** A point on the trace handed to the import/review pipeline. */
public data class GpsPoint(val t: Double, val lat: Double, val lon: Double, val v: Double?)

/**
 * The parser contract shared with telemetry file imports. `laps` is always empty
 * and `needsLine` always true for a live recording.
 */
public data class ParsedRecording(
    val kind: String,
    val date: String,
    val time: String,
    val durationS: Double,
    val laps: List<Nothing>,
    val gps: List<GpsPoint>,
    val needsLine: Boolean,
)

/**
 * An in-progress or finished recording.
 *
 * Appends are cheap because the location callback runs at ~10Hz for hours; the
 * caller (NS-16's foreground service) owns thread confinement. Use [snapshot] to
 * hand an immutable copy to another thread or to the UI, rather than sharing
 * this instance.
 */
public class Recording internal constructor(
    public val eventId: String?,
    public val startedAtMs: Double,
    initialFixes: List<Fix> = emptyList(),
) {
    private val mutableFixes: MutableList<Fix> = ArrayList(initialFixes)

    /** Read-only view. Not a defensive copy — see [snapshot]. */
    public val fixes: List<Fix> get() = mutableFixes

    /**
     * Append a watcher fix. Returns true when the fix was kept.
     *
     * Invalid, out-of-order, or hopeless-accuracy fixes are dropped. The
     * validation order matches the JavaScript original exactly, and the rounding
     * is part of the checkpoint format.
     */
    public fun addFix(fix: LocationFix): Boolean {
        if (!fix.timeMs.isFinite() || !fix.lat.isFinite() || !fix.lon.isFinite()) return false
        if (Math.abs(fix.lat) > 90.0 || Math.abs(fix.lon) > 180.0) return false
        val accuracy = fix.accuracy
        if (accuracy != null && accuracy.isFinite() && accuracy > RecorderCore.MAX_ACC_M) return false
        val t = (fix.timeMs - startedAtMs) / 1000.0
        if (t < 0.0) return false
        val last = mutableFixes.lastOrNull()
        if (last != null && t <= last.t) return false
        if (mutableFixes.size >= RecorderCore.MAX_FIXES) return false
        val speed = fix.speed
        mutableFixes.add(
            Fix(
                t = JsMath.round(t, 100.0),
                lat = JsMath.round(fix.lat, 1e6),
                lon = JsMath.round(fix.lon, 1e6),
                speed = if (speed != null && speed.isFinite() && speed >= 0.0) {
                    JsMath.round(speed, 100.0)
                } else {
                    null
                },
                accuracy = if (accuracy != null && accuracy.isFinite()) {
                    JsMath.round(accuracy, 10.0)
                } else {
                    null
                },
            )
        )
        return true
    }

    /** An immutable copy, safe to hand across threads. */
    public fun snapshot(): Recording =
        Recording(eventId, startedAtMs, java.util.List.copyOf(mutableFixes))

    override fun equals(other: Any?): Boolean =
        other is Recording &&
            other.eventId == eventId &&
            other.startedAtMs == startedAtMs &&
            other.fixes == fixes

    override fun hashCode(): Int =
        (eventId?.hashCode() ?: 0) * 31 + startedAtMs.hashCode() * 31 + fixes.hashCode()

    override fun toString(): String =
        "Recording(eventId=$eventId, startedAtMs=$startedAtMs, fixes=${fixes.size})"
}
