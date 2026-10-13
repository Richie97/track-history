package app.trackevolution.videoimport

import android.content.ContentResolver
import android.net.Uri
import android.util.Log
import app.trackevolution.core.telemetry.PDRLaps
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.core.telemetry.Telemetry
import app.trackevolution.core.telemetry.TelemetryByteSource
import app.trackevolution.core.telemetry.TelemetryChannels
import app.trackevolution.core.telemetry.TelemetryParseException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

/**
 * One picked clip after parsing: either telemetry, or the reason there wasn't
 * any. Both are shown — a file that yielded nothing has to say so by name.
 */
data class ImportedClip(
    val file: String,
    val parsed: ParsedTelemetry?,
    val error: String? = null,
    /**
     * Where the file is, kept so a best-lap clip (NS-45) can be cut from it at
     * save time. The grant on a picked `content://` URI lasts as long as the
     * activity's task, which outlives the review; null for a file with no
     * source left to read (the tests' in-memory clips).
     */
    val uri: Uri? = null,
    /** The file's size, for the clip's size estimate ("about 150 MB each"). */
    val fileBytes: Long? = null,
)

/**
 * Parsing a selection of videos (and `.vbo` / Track Precision `.csv` logs), off the main thread.
 *
 * The `importFiles` half of `public/js/import/ui.js`: parse each file, sort by
 * the clock the recorder wrote, then run the batch pass that re-anchors a
 * beacon-less PDR recording against a beacon-timed one of the same track (and
 * re-cuts its per-lap channels, because anchoring moves the lap boundaries).
 */
object TelemetryImporter {
    private const val TAG = "import"

    /**
     * Parse every picked clip. Never throws for a bad file — that becomes a
     * per-clip error the review screen shows — but does propagate cancellation,
     * so backing out of a 4 GB clip actually stops the read.
     */
    suspend fun parse(resolver: ContentResolver, uris: List<Uri>): List<ImportedClip> = withContext(Dispatchers.IO) {
        val job = currentCoroutineContext()
        val clips = ArrayList<ImportedClip>()
        for (uri in uris) {
            job.ensureActive()
            val name = ContentByteSource.displayName(resolver, uri)
            clips.add(
                parseOne(name) { ContentByteSource.open(resolver, uri) { !job.isActive } }.copy(uri = uri),
            )
        }
        finish(clips)
    }

    /**
     * The part after the files are read: order, anchor, re-cut channels. Split
     * out so a test can hand it in-memory sources without a `ContentResolver`.
     */
    fun finish(parsedClips: List<ImportedClip>): List<ImportedClip> {
        // Sorted by the file's own start time, so a batch reads in the order it
        // was driven rather than the order it was tapped.
        val clips = parsedClips.sortedBy { it.parsed?.time ?: "" }
        val anchored = PDRLaps.anchorPdrBatch(clips.map { it.parsed })
        return clips.mapIndexed { i, clip ->
            val p = anchored[i]
            if (p != null && p.kind == ParsedTelemetry.Kind.PDR && p.lapRecovery != null) {
                clip.copy(parsed = TelemetryChannels.attachLapChannels(p))
            } else {
                clip.copy(parsed = p)
            }
        }
    }

    /** Parse one clip from whatever [open] yields, closing it afterwards. */
    fun parseOne(name: String, open: () -> TelemetryByteSource): ImportedClip {
        var source: TelemetryByteSource? = null
        try {
            source = open()
            // The name decides the parser, as it does on the web: a `.vbo` has no
            // registered MIME type and a `.csv` could be anything, so the
            // provider's guess at one means nothing.
            return ImportedClip(file = name, parsed = Telemetry.parseTelemetryFile(source, name), fileBytes = source.size)
        } catch (e: TelemetryParseException) {
            return ImportedClip(file = name, parsed = null, error = e.message)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "could not read $name", e)
            return ImportedClip(
                file = name,
                parsed = null,
                error = "Couldn't read this ${if (isLog(name)) "file" else "video"}: " +
                    (e.message ?: e.javaClass.simpleName),
            )
        } finally {
            (source as? java.io.Closeable)?.close()
        }
    }

    private fun isLog(name: String): Boolean = name.lowercase().let { it.endsWith(".vbo") || it.endsWith(".csv") }
}
