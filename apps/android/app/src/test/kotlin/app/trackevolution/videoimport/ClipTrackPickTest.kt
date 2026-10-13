package app.trackevolution.videoimport

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which tracks [ClipCutter] copies (NS-45). The cut itself needs a real
 * `MediaMuxer` and runs on a device (`ClipCutterTest`); the choice is a plain
 * function over the tracks' MIME types and is pinned here, on the JVM, because
 * getting it wrong fails no build: a PDR 2.5 file's MJPEG cover image is a
 * video track too, and copying it puts a still frame in the clip.
 */
class ClipTrackPickTest {

    @Test
    fun `a Corvette PDR - video, audio and the telemetry track`() {
        assertEquals(0 to 1, ClipCutter.pickTracks(listOf("video/avc", "audio/mp4a-latm", "application/octet-stream")))
    }

    @Test
    fun `a PDR 2_5 file's cover image is never the video, wherever it sits`() {
        assertEquals(1 to 2, ClipCutter.pickTracks(listOf("video/mjpeg", "video/avc", "audio/mp4a-latm", "application/adco")))
        assertEquals(0 to 1, ClipCutter.pickTracks(listOf("video/avc", "audio/mp4a-latm", "application/adco", "video/mjpeg")))
    }

    @Test
    fun `a GoPro - HEVC, audio, and the metadata tracks left out`() {
        assertEquals(0 to 1, ClipCutter.pickTracks(listOf("video/hevc", "audio/mp4a-latm", "application/gpmd", "application/tmcd")))
    }

    @Test
    fun `another real codec is taken when there is no H_264 or HEVC, and silence is allowed`() {
        assertEquals(0 to null, ClipCutter.pickTracks(listOf("video/x-vnd.on2.vp9")))
        assertEquals(null to 0, ClipCutter.pickTracks(listOf("audio/mp4a-latm", "video/mjpeg")))
    }
}
