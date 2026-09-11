package app.trackevolution.videoimport

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import app.trackevolution.core.telemetry.TelemetryByteSource
import kotlinx.coroutines.CancellationException
import java.io.Closeable
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel

/**
 * A [TelemetryByteSource] over a video that stays exactly where it is.
 *
 * This is the load-bearing half of the import's first requirement, inherited
 * from NS-30: **the video is never uploaded and never copied whole.** Both
 * parsers read the MP4 index plus the telemetry track's own samples — a few MB
 * for PDR, tens for a long GoPro `gpmd` track — against an essence one to two
 * orders of magnitude larger that is never touched. A temp copy of a 4 GB clip
 * would take minutes and may not fit in app storage, so anything that
 * materialises the file first is the wrong design here.
 *
 * On Android that is the *default* rather than something to engineer around:
 * `ContentResolver.openFileDescriptor` hands back a real, seekable descriptor
 * for a `content://` URI from the Storage Access Framework, the photo picker or
 * a share-sheet `ACTION_SEND`, and positional reads on its [FileChannel] are the
 * whole implementation. (iOS had to route around `PhotosPicker`, which copies.)
 *
 * The one provider shape that *doesn't* work is a pipe — a provider that
 * streams rather than serves a file. Positional reads on it throw, which
 * surfaces as a per-clip error naming the problem rather than a hang.
 *
 * Reads check [isCancelled] first and throw [CancellationException], which is
 * how a driver backs out of the wrong 4 GB clip: the parsers in `:core` know
 * nothing about coroutines and stay identical to the JS.
 */
class ContentByteSource private constructor(
    private val descriptor: ParcelFileDescriptor,
    private val channel: FileChannel,
    override val size: Long,
    private val isCancelled: () -> Boolean,
) : TelemetryByteSource, Closeable {

    override fun read(offset: Long, count: Int): ByteArray {
        if (isCancelled()) throw CancellationException("Import cancelled")
        if (offset < 0 || offset >= size || count <= 0) return ByteArray(0)
        val want = minOf(count.toLong(), size - offset).toInt()
        val buffer = ByteBuffer.allocate(want)
        var position = offset
        while (buffer.hasRemaining()) {
            val n = channel.read(buffer, position)
            if (n <= 0) break
            position += n
        }
        return if (buffer.position() == want) buffer.array() else buffer.array().copyOf(buffer.position())
    }

    override fun close() {
        try {
            channel.close()
        } finally {
            descriptor.close()
        }
    }

    companion object {
        /**
         * Open [uri] for random access. Throws whatever the resolver throws
         * (`FileNotFoundException`, `SecurityException` for a grant that has
         * lapsed), which the importer turns into that clip's error line.
         */
        fun open(resolver: ContentResolver, uri: Uri, isCancelled: () -> Boolean = { false }): ContentByteSource {
            val pfd = resolver.openFileDescriptor(uri, "r")
                ?: throw java.io.FileNotFoundException("Couldn't open $uri")
            val channel = FileInputStream(pfd.fileDescriptor).channel
            // statSize is -1 for a provider that doesn't know; the channel does.
            val size = pfd.statSize.takeIf { it >= 0 } ?: channel.size()
            return ContentByteSource(pfd, channel, size, isCancelled)
        }

        /**
         * The file's own name — "GX010042.MP4" — which is what the review shows
         * and what the session's notes record ("Imported from GX010042.MP4").
         * Falls back to the last path segment for providers that don't publish
         * a display name.
         */
        fun displayName(resolver: ContentResolver, uri: Uri): String {
            if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
                runCatching {
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (column >= 0 && cursor.moveToFirst()) {
                            cursor.getString(column)?.takeIf { it.isNotBlank() }?.let { return it }
                        }
                    }
                }
            }
            return uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "video.mp4"
        }
    }
}
