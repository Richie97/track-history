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
)

/**
 * Parsing a selection of videos, off the main thread.
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
                parseOne(name) { ContentByteSource.open(resolver, uri) { !job.isActive } },
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
            return ImportedClip(file = name, parsed = Telemetry.parseTelemetryFile(source))
        } catch (e: TelemetryParseException) {
            return ImportedClip(file = name, parsed = null, error = e.message)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "could not read $name", e)
            return ImportedClip(
                file = name,
                parsed = null,
                error = "Couldn't read this video: ${e.message ?: e.javaClass.simpleName}",
            )
        } finally {
            (source as? java.io.Closeable)?.close()
        }
    }
}
