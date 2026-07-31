// Live lap-recording core: the pure logic behind the in-app GPS recorder.
//
// A line-for-line port of public/js/record/core.js (NS-12). The function names,
// constants and validation order are deliberately identical to the JS so the
// three clients can be diffed by eye — that is the drift defense for logic no
// contract test covers. Do not "improve" the algorithm here: a genuine bug gets
// fixed in the JS first, so web, iOS and Android all inherit it.
//
// Everything is plain data in → data out, with no android.* dependency, so it
// runs as a fast JVM unit test. The Android location service (NS-16) feeds
// addFix; the recording UI (NS-18) consumes toParsed.
//
// Recording shape (also the checkpoint format persisted to preferences):
//   { v: 1, eventId, startedAtMs, fixes: [[tRelS, lat, lon, v|null, acc|null]] }
// tRelS is seconds since startedAtMs; v is m/s; acc is reported accuracy in
// meters. Tuples keep the checkpoint JSON small (~50 bytes/fix).

package app.trackevolution.core

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneId
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Checkpoint format version. Bumping it invalidates every stored checkpoint. */
public const val RECORDING_V: Int = 1

// Fixes with worse reported accuracy than this are noise (parking garages,
// cold starts) — dropping them beats feeding them to the gate math.
public const val MAX_ACC_M: Double = 100.0

// Above this speed the car has clearly been on track (m/s, ~54 km/h) —
// auto-stop is armed only after this, so a long grid wait before the first
// lap never kills the recording.
public const val DRIVEN_MPS: Double = 15.0

/** "Stationary" for trimming and auto-stop (m/s, brisk walking pace). */
public const val IDLE_MPS: Double = 2.0

/** Auto-stop after this long stationary once the car has been driven. */
public const val AUTO_STOP_IDLE_S: Double = 15.0 * 60

/** Absolute cap — a forgotten recorder must not run all day. */
public const val MAX_DURATION_S: Double = 4.0 * 3600

public const val MAX_FIXES: Int = 20_000

/** Seconds of context kept either side of the driving when trimming idle tails. */
public const val TRIM_MARGIN_S: Double = 30.0

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One stored fix — the JSON tuple `[tRelS, lat, lon, v|null, acc|null]` given
 * Kotlin names.
 *
 * The *wire* format stays a bare array (see [serializeRecording]); this type
 * exists only so the Kotlin code is readable. Promoting the JSON to named
 * fields would break byte compatibility with the web and iOS clients, which
 * read and write the same checkpoints.
 */
public data class Fix(
    /** Seconds since [RecordingView.startedAtMs], rounded to 2dp. */
    val t: Double,
    /** Degrees, rounded to 6dp. */
    val lat: Double,
    /** Degrees, rounded to 6dp. */
    val lon: Double,
    /** Source-reported ground speed in m/s, rounded to 2dp; null when absent. */
    val speed: Double?,
    /** Source-reported horizontal accuracy in meters, rounded to 1dp; null when absent. */
    val accuracy: Double?,
)

/**
 * A raw fix as it arrives from the platform location watcher, before
 * validation and rounding.
 *
 * [timeMs] is a `Double` rather than a `Long` because [addFix]'s first job is
 * rejecting non-finite input — the JS receives whatever the watcher hands it,
 * and this port reproduces that validation rather than assuming it away.
 */
public data class GpsFix(
    val timeMs: Double,
    val lat: Double,
    val lon: Double,
    val speed: Double? = null,
    val accuracy: Double? = null,
)

/** The read side of a recording, implemented by both [Recording] and [RecordingBuilder]. */
public interface RecordingView {
    /** The event this recording belongs to, or null for one started without one (Android Auto). */
    public val eventId: Long?

    /** Epoch milliseconds at which recording started. */
    public val startedAtMs: Double

    /** Fixes in strictly increasing [Fix.t] order. */
    public val fixes: List<Fix>
}

/**
 * An immutable snapshot of a recording. This is the type that crosses the
 * service/UI boundary in NS-16 — value semantics mean the location service can
 * keep appending while the UI renders what it was handed.
 */
public data class Recording(
    val v: Int,
    override val eventId: Long?,
    override val startedAtMs: Double,
    override val fixes: List<Fix>,
) : RecordingView

/**
 * The append side: the JS mutates one recording object as fixes arrive, and
 * copying a 20 000-element list per fix would be absurd. Confine the mutation
 * here and hand [snapshot] to anything on another thread.
 *
 * Not thread-safe. The location service owns one of these and is the only
 * writer; everyone else gets snapshots.
 */
public class RecordingBuilder(
    /**
     * Mutable because a recording started without an event (Android Auto,
     * before the event existed) is adopted by the first event whose record
     * screen it is opened from — mirrors `bindRecorder` in js/record/ui.js.
     */
    override var eventId: Long?,
    override val startedAtMs: Double,
    initialFixes: List<Fix> = emptyList(),
) : RecordingView {

    private val stored = ArrayList(initialFixes)

    override val fixes: List<Fix> get() = java.util.Collections.unmodifiableList(stored)

    public val size: Int get() = stored.size

    /**
     * Append a watcher fix. Returns true when the fix was kept; invalid,
     * out-of-order, or hopeless-accuracy fixes are dropped. Time is stored
     * relative to [startedAtMs].
     *
     * The order of the checks is load-bearing — it is the JS's order, and the
     * [MAX_FIXES] cap deliberately comes last so a capped recording still
     * rejects garbage the same way an uncapped one does.
     */
    public fun addFix(fix: GpsFix): Boolean {
        val (timeMs, lat, lon, speed, accuracy) = fix
        if (!timeMs.isFinite() || !lat.isFinite() || !lon.isFinite()) return false
        if (abs(lat) > 90 || abs(lon) > 180) return false
        if (accuracy != null && accuracy.isFinite() && accuracy > MAX_ACC_M) return false
        val t = (timeMs - startedAtMs) / 1000
        if (t < 0) return false
        val last = stored.lastOrNull()
        if (last != null && t <= last.t) return false
        if (stored.size >= MAX_FIXES) return false
        stored.add(
            Fix(
                t = JsMath.round(t, 100.0),
                lat = JsMath.round(lat, 1e6),
                lon = JsMath.round(lon, 1e6),
                speed = if (speed != null && speed.isFinite() && speed >= 0) JsMath.round(speed, 100.0) else null,
                accuracy = if (accuracy != null && accuracy.isFinite()) JsMath.round(accuracy, 10.0) else null,
            ),
        )
        return true
    }

    /** An immutable copy, safe to hand to another thread. */
    public fun snapshot(): Recording = Recording(RECORDING_V, eventId, startedAtMs, stored.toList())
}

/** A point of the trace handed to the review/line-picker pipeline. */
public data class GpsPoint(val t: Double, val lat: Double, val lon: Double, val v: Double?)

/**
 * A finished recording in the shape a telemetry file parser returns
 * (`{kind, date, time, durationS, laps: [], gps, needsLine}` in
 * js/import/parse.js), so it flows into the identical review + line-picker path
 * as an imported file.
 *
 * The JS contract also carries `laps: []`. A live recording never has laps —
 * [needsLine] is always true and the line picker derives them — so the field is
 * omitted here rather than inventing a lap type ahead of the lap-geometry port
 * (NS-14), which owns it.
 */
public data class ParsedRecording(
    val kind: String,
    /** Local-time `yyyy-MM-dd`, not UTC. */
    val date: String,
    /** Local-time `HH:mm`, not UTC. */
    val time: String,
    val durationS: Double,
    val gps: List<GpsPoint>,
    val needsLine: Boolean,
)

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

public fun createRecording(eventId: Long?, startedAtMs: Double): RecordingBuilder =
    RecordingBuilder(eventId, startedAtMs)

public fun elapsedS(rec: RecordingView, nowMs: Double): Double =
    max(0.0, (nowMs - rec.startedAtMs) / 1000)

/**
 * Per-fix speed in m/s: the source's own speed when reported, else the
 * displacement rate to the neighbouring fix (equirectangular meters — fine at
 * track scale, same approximation as js/import/geo.js).
 *
 * The neighbour window is clamped at both ends, so the first and last fix
 * measure over a one-sided window rather than dropping out.
 */
public fun fixSpeeds(fixes: List<Fix>): DoubleArray {
    if (fixes.isEmpty()) return DoubleArray(0)
    val kx = 111320 * cos(fixes[0].lat * PI / 180)
    val ky = 110540.0
    return DoubleArray(fixes.size) { i ->
        val f = fixes[i]
        if (f.speed != null) {
            f.speed
        } else {
            val a = fixes[max(0, i - 1)]
            val b = fixes[min(fixes.size - 1, i + 1)]
            val dt = b.t - a.t
            if (dt <= 0) {
                0.0
            } else {
                val dx = (b.lon - a.lon) * kx
                val dy = (b.lat - a.lat) * ky
                hypot(dx, dy) / dt
            }
        }
    }
}

/**
 * Should the recorder stop itself? Two independent triggers:
 *  - the car was driven at track pace at some point and has now been
 *    stationary for [idleS] (driver forgot to stop after the session) — a
 *    pre-session grid wait never trips this because nothing fast has been seen
 *    yet;
 *  - the hard duration cap, driven or not.
 *
 * The `driven` gate is the whole point. Do not simplify it into a plain
 * idle timeout.
 */
public fun shouldAutoStop(
    rec: RecordingView,
    nowMs: Double,
    idleS: Double = AUTO_STOP_IDLE_S,
    drivenMps: Double = DRIVEN_MPS,
    idleMps: Double = IDLE_MPS,
    maxS: Double = MAX_DURATION_S,
): Boolean {
    if (elapsedS(rec, nowMs) > maxS) return true
    val speeds = fixSpeeds(rec.fixes)
    var driven = false
    var lastMovingT = 0.0
    for (i in speeds.indices) {
        if (speeds[i] >= drivenMps) driven = true
        if (speeds[i] >= idleMps) lastMovingT = rec.fixes[i].t
    }
    if (!driven) return false
    return elapsedS(rec, nowMs) - lastMovingT > idleS
}

/**
 * Cut the stationary paddock/grid tails off the fix list, keeping [marginS] of
 * context on each side so the out-lap start and cool-down are preserved.
 * Returns an empty list for a recording that never moved.
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
    return fixes.filter { it.t in t0..t1 }
}

/**
 * A recording as a parsed-import object. Returns null when there is too little
 * data to time anything: fewer than 30 fixes after trimming, or under 60 s of
 * driving.
 *
 * [zone] exists for tests; production always wants the device's own zone,
 * because the date and time here are what the user saw on the clock at the
 * track, not UTC.
 */
public fun toParsed(rec: RecordingView, zone: ZoneId = ZoneId.systemDefault()): ParsedRecording? {
    val fixes = trimIdle(rec.fixes)
    if (fixes.size < 30) return null
    val gps = fixes.map { GpsPoint(it.t, it.lat, it.lon, it.speed) }
    val durationS = gps.last().t - gps.first().t
    if (durationS < 60) return null
    // JS `new Date(ms)` truncates a fractional epoch toward zero; so does this.
    val d = Instant.ofEpochMilli(rec.startedAtMs.toLong()).atZone(zone)
    val pad = { n: Int -> n.toString().padStart(2, '0') }
    return ParsedRecording(
        kind = "live",
        date = "${d.year}-${pad(d.monthValue)}-${pad(d.dayOfMonth)}",
        time = "${pad(d.hour)}:${pad(d.minute)}",
        durationS = durationS,
        gps = gps,
        needsLine = true,
    )
}

// ---------------------------------------------------------------------------
// Checkpoint (de)serialization
// ---------------------------------------------------------------------------

/**
 * The checkpoint JSON, byte-identical to what `JSON.stringify` produces in the
 * web client: same key order, same tuple encoding, same number formatting (see
 * [jsNumber]). A checkpoint written here is readable by the web and iOS clients
 * and vice versa.
 */
public fun serializeRecording(rec: RecordingView): String {
    val obj = buildJsonObject {
        put("v", JsonPrimitive(RECORDING_V))
        put("eventId", rec.eventId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("startedAtMs", jsonNumber(rec.startedAtMs))
        put(
            "fixes",
            buildJsonArray {
                for (f in rec.fixes) {
                    add(
                        buildJsonArray {
                            add(jsonNumber(f.t))
                            add(jsonNumber(f.lat))
                            add(jsonNumber(f.lon))
                            add(f.speed?.let { jsonNumber(it) } ?: JsonNull)
                            add(f.accuracy?.let { jsonNumber(it) } ?: JsonNull)
                        },
                    )
                }
            },
        )
    }
    return Json.encodeToString(JsonObject.serializer(), obj)
}

/**
 * Parse a checkpoint. Returns null — never throws — for anything that is not a
 * plausible recording: wrong version, non-finite `startedAtMs`, malformed
 * fixes, or not JSON at all. **A corrupt checkpoint must not crash launch.**
 */
public fun deserializeRecording(json: String?): Recording? {
    if (json.isNullOrEmpty()) return null
    return runCatching { decodeRecording(json) }.getOrNull()
}

private fun decodeRecording(json: String): Recording? {
    val root = Json.parseToJsonElement(json) as? JsonObject ?: return null
    // Compared as a Double, not truncated to Int: the JS uses `!==`, so a
    // version of 1.5 is corrupt, not "close enough to 1".
    if (finiteNumber(root["v"]) != RECORDING_V.toDouble()) return null
    val startedAtMs = finiteNumber(root["startedAtMs"]) ?: return null
    val rawFixes = root["fixes"] as? JsonArray ?: return null

    val fixes = ArrayList<Fix>(rawFixes.size)
    for (element in rawFixes) {
        val tuple = element as? JsonArray ?: return null
        if (tuple.size < 3) return null
        // Every slot must be null or a finite number. A tuple of 3 is legal —
        // speed and accuracy are simply absent, as they are when the watcher
        // reports neither.
        val values = arrayOfNulls<Double>(5)
        for (i in tuple.indices) {
            val slot = tuple[i]
            if (slot is JsonNull) continue
            val n = finiteNumber(slot) ?: return null
            // Slots past the tuple we understand are validated but dropped;
            // the format has never had a sixth.
            if (i < values.size) values[i] = n
        }
        val t = values[0] ?: return null
        val lat = values[1] ?: return null
        val lon = values[2] ?: return null
        fixes.add(Fix(t, lat, lon, values[3], values[4]))
    }
    return Recording(RECORDING_V, eventId(root["eventId"]), startedAtMs, fixes)
}

/**
 * A finite JSON *number*, or null.
 *
 * Explicitly rejects string primitives: the JS compares the version with `!==`,
 * so `{"v": "1"}` is a corrupt checkpoint, not a valid one. kotlinx's
 * `intOrNull` would happily parse the string and silently accept it.
 */
private fun finiteNumber(element: JsonElement?): Double? {
    val primitive = element as? JsonPrimitive ?: return null
    if (primitive.isString || primitive is JsonNull) return null
    return primitive.content.toDoubleOrNull()?.takeIf { it.isFinite() }
}

/**
 * Event ids are integers from the API. A checkpoint carrying anything else
 * (or nothing) yields null, which means "not attached to an event yet" — the
 * recording is then adopted by the first event whose record screen it is
 * opened from, which is the safe degradation rather than losing the fixes.
 */
private fun eventId(element: JsonElement?): Long? =
    (element as? JsonPrimitive)?.content?.toLongOrNull()

@OptIn(ExperimentalSerializationApi::class)
private fun jsonNumber(v: Double): JsonElement =
    if (!v.isFinite()) JsonNull else JsonUnquotedLiteral(jsNumber(v))

/**
 * Format a Double the way `JSON.stringify` does.
 *
 * `Double.toString()` on JDK 19+ is the shortest representation that
 * round-trips, same as JavaScript's — but it differs in two places that appear
 * in real checkpoints:
 *
 *  - integral values: Java writes `1.0` and `1.75E12`, JS writes `1` and
 *    `1750000000000`. Every epoch timestamp hits this.
 *  - magnitudes below 1e-3: Java writes `1.0E-4`, JS writes `0.0001`. Only
 *    reachable for coordinates within ~100 m of (0, 0), but free to handle.
 *    Below 1e-6 both switch to exponent notation, and rounding to 6dp means no
 *    non-zero coordinate gets there anyway.
 *
 * Without this, a checkpoint written on Android would parse identically but not
 * *compare* identically against one written on the web, which is the property
 * that makes cross-client checkpoint bugs obvious rather than subtle.
 */
internal fun jsNumber(v: Double): String = when {
    v == 0.0 -> "0" // also normalizes -0.0, which JSON.stringify writes as 0
    v == floor(v) && abs(v) < 1e21 -> BigDecimal(v).toBigIntegerExact().toString()
    abs(v) < 1e-3 -> BigDecimal(v.toString()).stripTrailingZeros().toPlainString()
    else -> v.toString()
}
