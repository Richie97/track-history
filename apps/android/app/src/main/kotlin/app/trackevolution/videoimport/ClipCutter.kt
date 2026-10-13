package app.trackevolution.videoimport

import android.content.ContentResolver
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import app.trackevolution.core.telemetry.LapClips
import java.io.File
import java.io.FileDescriptor
import java.nio.ByteBuffer
import kotlin.math.roundToInt

/**
 * Cuts a session's best lap out of the source video, on the device, without
 * re-encoding (NS-45).
 *
 * `MediaExtractor` reads the samples through the same seekable descriptor
 * [ContentByteSource] opens — the video is still never copied whole — and
 * `MediaMuxer` writes the window's samples into a new MPEG-4 file in the app's
 * `clips/` directory. Passthrough: the clip keeps the source's codec and
 * bitrate, and costs seconds rather than the minutes a transcode would.
 *
 * What goes in, and what doesn't:
 *
 * - **The first real video track** — H.264 or HEVC, never "every video
 *   track": a PDR 2.5 (Cadillac) file carries an MJPEG cover image as a
 *   second video stream (the spec's *As built*, from #403's review on real
 *   footage), and copying it would put a still frame in the clip.
 * - **The first audio track**, if the muxer can take it; a clip without
 *   sound is better than no clip.
 * - **Nothing else.** The telemetry track (PDR's `marl`, PDR 2.5's `adco`,
 *   GoPro's `gpmd`) is never selected, and `MediaMuxer` writes no location or
 *   other file-level metadata unless asked to — so the clip carries no GPS.
 *
 * **The lap's offset is measured, not assumed.** A passthrough cut can only
 * start on a keyframe, so the extractor seeks to the one at or before the
 * window's start: on a Corvette PDR, whose keyframes are 1.475 s apart, the lap
 * can land ~3.3 s into the clip rather than 3 s, while PDR 2.5 (a keyframe on
 * every frame) lands exactly. [Cut.lapOffsetMs] is the lap's start minus that
 * first sample's presentation time — which is what the server stores and the
 * players seek to.
 *
 * Blocking; the caller runs it on `Dispatchers.IO`, outside the save's job.
 * Robolectric has no `MediaMuxer`, so this is tested on a device
 * (`ClipCutterTest`, androidTest).
 */
object ClipCutter {

    /** What the cut produced. */
    data class Cut(val file: File, val sizeBytes: Long, val durationMs: Int, val lapOffsetMs: Int)

    /** Codecs that are a real picture stream rather than a cover image. */
    private val PREFERRED_VIDEO = listOf(MediaFormat.MIMETYPE_VIDEO_AVC, MediaFormat.MIMETYPE_VIDEO_HEVC)

    /** Big enough for a 4K keyframe; grown if a sample says otherwise. */
    private const val DEFAULT_BUFFER = 4 * 1024 * 1024

    /**
     * Cuts [window] out of [uri] into [out]. Throws on anything that leaves no
     * usable clip — after deleting whatever was written.
     */
    fun cut(resolver: ContentResolver, uri: Uri, window: LapClips.ClipWindow, out: File): Cut {
        val pfd = resolver.openFileDescriptor(uri, "r") ?: throw java.io.FileNotFoundException("Couldn't open $uri")
        return pfd.use { cut(it.fileDescriptor, window, out) }
    }

    /** The same over a descriptor — what the instrumented test drives with a plain file. */
    fun cut(fd: FileDescriptor, window: LapClips.ClipWindow, out: File): Cut {
        out.parentFile?.mkdirs()
        out.delete()
        val extractor = MediaExtractor()
        var muxer: MediaMuxer? = null
        var started = false
        try {
            extractor.setDataSource(fd)
            val (videoTrack, audioTrack) = pickTracks(extractor)
            val video = videoTrack ?: throw IllegalStateException("No video track to cut")

            val startUs = (window.startS * 1_000_000).toLong()
            val endUs = (window.endS * 1_000_000).toLong()
            val lapStartUs = ((window.startS + window.lapOffsetS) * 1_000_000).toLong()

            // 1. Where the cut can actually start: the keyframe at or before the
            //    window, found with the video track alone selected.
            extractor.selectTrack(video)
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            val baseUs = extractor.sampleTime
            if (baseUs < 0) throw IllegalStateException("The window is past the end of the video")

            muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val videoFormat = extractor.getTrackFormat(video)
            if (videoFormat.containsKey(MediaFormat.KEY_ROTATION)) {
                muxer.setOrientationHint(videoFormat.getInteger(MediaFormat.KEY_ROTATION))
            }
            val outVideo = muxer.addTrack(videoFormat)
            // An audio codec MPEG-4 can't hold is dropped, not fatal.
            val outAudio = audioTrack?.let { a -> runCatching { muxer.addTrack(extractor.getTrackFormat(a)) }.getOrNull() }

            // 2. Both tracks from that keyframe, interleaved by time — so the
            //    muxer never has to hold one track's whole run in memory while
            //    it waits for the other's.
            if (outAudio != null) extractor.selectTrack(audioTrack)
            extractor.seekTo(baseUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            muxer.start()
            started = true

            var buffer = ByteBuffer.allocateDirect(bufferSize(extractor, video, audioTrack))
            val info = MediaCodec.BufferInfo()
            var videoDone = false
            var audioDone = outAudio == null
            var lastUs = baseUs
            var videoSamples = 0
            while (!(videoDone && audioDone)) {
                val track = extractor.sampleTrackIndex
                if (track < 0) break
                val time = extractor.sampleTime
                val isVideo = track == video
                val keep = when {
                    isVideo && time > endUs -> { videoDone = true; false }
                    !isVideo && time > endUs -> { audioDone = true; false }
                    time < baseUs -> false
                    isVideo -> !videoDone
                    else -> !audioDone
                }
                if (keep) {
                    val size = extractor.sampleSize.toInt()
                    if (size > buffer.capacity()) buffer = ByteBuffer.allocateDirect(size)
                    buffer.clear()
                    val read = extractor.readSampleData(buffer, 0)
                    if (read >= 0) {
                        val sync = extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0
                        info.set(0, read, time - baseUs, if (sync) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                        muxer.writeSampleData(if (isVideo) outVideo else outAudio!!, buffer, info)
                        if (isVideo) videoSamples++
                        if (time > lastUs) lastUs = time
                    }
                }
                if (!extractor.advance()) break
            }
            // A window the file doesn't reach (a telemetry clock that ran past
            // the video) seeks to the last keyframe and would make a clip of
            // the file's tail: refuse it rather than save the wrong footage.
            if (videoSamples == 0 || lastUs < lapStartUs) throw IllegalStateException("The lap isn't in the video")
            muxer.stop()
            started = false
            muxer.release()
            muxer = null

            val measured = runCatching { durationMs(out) }.getOrNull()
            return Cut(
                file = out,
                sizeBytes = out.length(),
                durationMs = measured ?: ((lastUs - baseUs) / 1000).toInt(),
                lapOffsetMs = ((lapStartUs - baseUs) / 1000.0).roundToInt(),
            )
        } catch (e: Throwable) {
            if (started) runCatching { muxer?.stop() }
            runCatching { muxer?.release() }
            out.delete()
            throw e
        } finally {
            extractor.release()
        }
    }

    /**
     * The first real video track and the first audio track. A cover image is
     * a video track too (`video/mjpeg` on PDR 2.5), so H.264 / HEVC is
     * preferred, and any other video codec is taken only when there is none.
     */
    internal fun pickTracks(extractor: MediaExtractor): Pair<Int?, Int?> {
        val mimes = (0 until extractor.trackCount).map { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME).orEmpty() }
        return pickTracks(mimes)
    }

    /** The decision alone, over the tracks' MIME types — a plain function the unit test drives. */
    fun pickTracks(mimes: List<String>): Pair<Int?, Int?> {
        val video = mimes.indexOfFirst { it in PREFERRED_VIDEO }.takeIf { it >= 0 }
            ?: mimes.indexOfFirst { it.startsWith("video/") && !it.contains("mjpeg") && !it.contains("jpeg") }.takeIf { it >= 0 }
        val audio = mimes.indexOfFirst { it.startsWith("audio/") }.takeIf { it >= 0 }
        return video to audio
    }

    private fun bufferSize(extractor: MediaExtractor, video: Int, audio: Int?): Int {
        val declared = listOfNotNull(video, audio).maxOfOrNull { t ->
            val f = extractor.getTrackFormat(t)
            if (f.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) f.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
        } ?: 0
        return maxOf(DEFAULT_BUFFER, declared)
    }

    private fun durationMs(file: File): Int? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.path)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toIntOrNull()
        } finally {
            retriever.release()
        }
    }
}
