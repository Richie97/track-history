package app.trackevolution.core

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Durable, per-fix storage for an in-progress recording.
 *
 * The web recorder checkpoints the whole recording every ~10 s, driven by fix
 * arrival because `setInterval` throttles with the screen off — so a WebView
 * death costs up to 10 s of track time. Here every accepted fix is appended as
 * it arrives, so the worst case is zero.
 *
 * **Deviation from NS-16 worth knowing about:** the spec calls for Room, shared
 * with NS-22's store. This is an append-only journal instead — no dependency, no
 * schema migration to own before NS-22 exists, and a better fit for a
 * write-per-fix hot path whose only query is "read it all back". The requirement
 * it exists to satisfy (durable per fix, not per interval) is met either way,
 * and NS-22 can swap the implementation behind this type if it wants one
 * database for both. iOS made the same call against NS-15 for the same reasons.
 *
 * Format — one line each, so a half-written final line costs one fix rather than
 * the recording:
 *
 *     {"v":1,"eventId":"3","startedAtMs":1750000000000}
 *     [0.1,36.56,-79.2,25.4,4.2]
 *     [0.2,36.560002,-79.199998,25.5,4.2]
 *
 * The tuples are byte-identical to the ones [RecorderCore.serializeRecording]
 * writes, [JsJson] and all, so a journal and a checkpoint of the same recording
 * carry the same digits.
 *
 * Flushed but **not** `fsync`ed: a force-stop or a crash leaves the writes in the
 * page cache and they survive, which is what the acceptance criterion asks for.
 * Only losing power mid-session could drop the tail, and paying an fsync at 10 Hz
 * to cover that is not worth the battery.
 *
 * Lives in `:core` because it is plain `java.io` — no Android types — which is
 * what lets it be unit-tested against a real temp file with no emulator. The
 * caller (NS-16's foreground service) owns thread confinement; this is not
 * synchronized.
 */
public class RecordingJournal(private val file: File) {

    private var writer: Writer? = null

    /** Starts a new journal, replacing anything already there. */
    public fun begin(recording: Recording) {
        close()
        file.parentFile?.mkdirs()
        val out = OutputStreamWriter(FileOutputStream(file, false), Charsets.UTF_8)
        out.write(header(recording))
        out.write("\n")
        out.flush()
        writer = out
    }

    /**
     * Appends one accepted fix. Called from the location callback, so it must
     * never throw: a failed append leaves the in-memory recording intact and
     * still saveable, and taking the recording down would turn a disk hiccup
     * into a lost session.
     */
    public fun append(fix: Fix) {
        val out = writer ?: return
        runCatching {
            out.write(tuple(fix))
            out.write("\n")
            // Flushed per fix, so a force-stop keeps everything. This is a
            // buffered write to the page cache, not a disk sync.
            out.flush()
        }
    }

    /**
     * Rewrites the journal from a recording — used when the event id is attached
     * after the fact, the way an Android Auto recording is adopted by an event.
     */
    public fun rewrite(recording: Recording) {
        begin(recording)
        recording.fixes.forEach { append(it) }
    }

    /**
     * The recording left behind by a previous launch, if any.
     *
     * **Never throws.** This is read during start-up, and a corrupt journal must
     * not be able to stop the app opening. A truncated or unreadable line ends
     * the read rather than failing it — the fixes before it are still a
     * recording.
     */
    public fun recover(): Recording? = runCatching { read() }.getOrNull()

    private fun read(): Recording? {
        if (!file.isFile) return null
        file.bufferedReader().use { reader ->
            val headerLine = reader.readLine() ?: return null
            val root = LENIENT.parseToJsonElement(headerLine) as? JsonObject ?: return null
            val version = (root["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
            if (version != RecorderCore.RECORDING_V) return null
            val startedAtMs = (root["startedAtMs"] as? JsonPrimitive)?.doubleOrNull ?: return null
            if (!startedAtMs.isFinite()) return null
            val eventId = when (val raw = root["eventId"]) {
                null, JsonNull -> null
                is JsonPrimitive -> raw.content
                else -> return null
            }

            val fixes = ArrayList<Fix>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) continue
                // A half-written tail line is the expected shape of a crash, so
                // it ends the read instead of failing it.
                fixes.add(parseFix(line) ?: break)
            }
            return if (fixes.isEmpty()) {
                null
            } else {
                Recording(eventId = eventId, startedAtMs = startedAtMs, initialFixes = fixes)
            }
        }
    }

    /** Forgets the in-progress recording — after it is saved, or discarded. */
    public fun clear() {
        close()
        file.delete()
    }

    public fun close() {
        runCatching { writer?.close() }
        writer = null
    }

    private fun header(recording: Recording): String = buildString {
        append("{\"v\":").append(RecorderCore.RECORDING_V)
        append(",\"eventId\":").append(JsJson.id(recording.eventId))
        append(",\"startedAtMs\":").append(JsJson.number(recording.startedAtMs))
        append('}')
    }

    private fun tuple(fix: Fix): String = buildString {
        append('[')
        append(JsJson.number(fix.t)).append(',')
        append(JsJson.number(fix.lat)).append(',')
        append(JsJson.number(fix.lon)).append(',')
        append(fix.speed?.let { JsJson.number(it) } ?: "null").append(',')
        append(fix.accuracy?.let { JsJson.number(it) } ?: "null")
        append(']')
    }

    private fun parseFix(line: String): Fix? {
        val tuple = runCatching { LENIENT.parseToJsonElement(line) }.getOrNull() as? JsonArray
            ?: return null
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
        val t = values[0] ?: return null
        val lat = values[1] ?: return null
        val lon = values[2] ?: return null
        return Fix(t, lat, lon, values.getOrNull(3), values.getOrNull(4))
    }

    private companion object {
        val LENIENT = Json { isLenient = false; ignoreUnknownKeys = true }
    }
}
