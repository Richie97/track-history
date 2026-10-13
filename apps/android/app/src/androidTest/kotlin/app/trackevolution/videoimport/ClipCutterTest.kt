package app.trackevolution.videoimport

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.trackevolution.core.telemetry.LapClips
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/**
 * The passthrough cut (NS-45), on a device: Robolectric has no `MediaMuxer`,
 * so this is the one instrumented suite in the app. Run it with
 * `./gradlew :app:connectedDebugAndroidTest` against an emulator; no CI job
 * does.
 *
 * `assets/clip-source.mp4` is synthetic (ffmpeg's test pattern and a sine
 * tone, never footage), built to carry the three traps real recorders set:
 *
 * ```
 * ffmpeg -f lavfi -i color=c=red:size=64x64:rate=1:duration=1 \
 *   -f lavfi -i testsrc=size=160x120:rate=25:duration=20 \
 *   -f lavfi -i sine=frequency=440:duration=20 \
 *   -map 0:v -map 1:v -map 2:a -c:v:0 mjpeg \
 *   -c:v:1 libx264 -preset veryfast -g 37 -keyint_min 37 -sc_threshold 0 -bf 0 -pix_fmt yuv420p \
 *   -c:a aac -b:a 32k -metadata location="+37.7749-122.4194/" clip-source.mp4
 * ```
 *
 * - an MJPEG still as the **first** video track (a PDR 2.5 cover image);
 * - keyframes only every 1.48 s (the Corvette PDR writes one every 1.475 s),
 *   so the cut starts before the window and the offset must be measured;
 * - a location tag, which the clip must not carry.
 *
 * The real-footage cases run only when a recording has been pushed to the
 * app's private `files/footage/`, and are skipped otherwise — the
 * repository never holds footage.
 */
@RunWith(AndroidJUnit4::class)
class ClipCutterTest {

    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val testContext: Context = InstrumentationRegistry.getInstrumentation().context

    private fun tracks(file: File): List<String> {
        val extractor = MediaExtractor()
        return try {
            extractor.setDataSource(file.path)
            (0 until extractor.trackCount).map { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME).orEmpty() }
        } finally {
            extractor.release()
        }
    }

    /** The first video sample's time and whether it is a keyframe. */
    private fun firstVideoSample(file: File): Pair<Long, Boolean> {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.path)
            val v = (0 until extractor.trackCount).first {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("video/")
            }
            extractor.selectTrack(v)
            return extractor.sampleTime to (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
        } finally {
            extractor.release()
        }
    }

    /**
     * Whether the file carries a location box anywhere: 3GPP `loci` (what
     * ffmpeg writes), QuickTime `©xyz` (what phones and Android read), or the
     * coordinates themselves.
     */
    private fun carriesLocation(file: File): Boolean {
        val bytes = file.readBytes()
        val needles = listOf("loci".toByteArray(), byteArrayOf(0xA9.toByte()) + "xyz".toByteArray(), "+37.7749".toByteArray())
        return needles.any { needle -> (0..bytes.size - needle.size).any { i -> needle.indices.all { bytes[i + it] == needle[it] } } }
    }

    private fun location(file: File): String? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.path)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION)
        } finally {
            retriever.release()
        }
    }

    @Test
    fun cutsTheRealVideoAndAudioFromTheKeyframeBeforeTheWindow() {
        val source = File(context.cacheDir, "clip-source.mp4")
        testContext.assets.open("clip-source.mp4").use { input -> source.outputStream().use { input.copyTo(it) } }
        assertTrue("the source carries a location, so its absence below means something", carriesLocation(source))

        // A lap from 8 s to 10 s, padded 3 s before and 2 s after.
        val window = LapClips.clipWindow(
            app.trackevolution.core.telemetry.ParsedLap(timeMs = 2000, estimated = false, startT = 8.0, endT = 10.0),
            20.0,
        )!!
        assertEquals(5.0, window.startS, 1e-9)
        val out = File(context.filesDir, "clips/test-cut.mp4")
        val cut = ClipCutter.cut(context.contentResolver, Uri.fromFile(source), window, out)

        assertEquals("exactly one picture track and one audio track", listOf("video/avc", "audio/mp4a-latm"), tracks(out))
        // Keyframes every 1.48 s: the one at or before 5 s is 4.44 s, so the
        // lap starts 8 − 4.44 = 3.56 s in, not 3.
        assertEquals(3560, cut.lapOffsetMs)
        val (first, sync) = firstVideoSample(out)
        assertEquals("the clip starts at its own zero", 0L, first)
        assertTrue("on a keyframe", sync)
        assertTrue("about 12 − 4.44 s long: ${cut.durationMs}", abs(cut.durationMs - 7560) <= 100)
        assertEquals(out.length(), cut.sizeBytes)
        assertTrue("no location metadata", !carriesLocation(out) && location(out) == null)
        out.delete()
    }

    @Test
    fun aWindowPastTheEndLeavesNothingBehind() {
        val source = File(context.cacheDir, "clip-source.mp4")
        testContext.assets.open("clip-source.mp4").use { input -> source.outputStream().use { input.copyTo(it) } }
        val out = File(context.filesDir, "clips/test-past-end.mp4")
        val thrown = runCatching {
            ClipCutter.cut(context.contentResolver, Uri.fromFile(source), LapClips.ClipWindow(40.0, 50.0, 3.0), out)
        }
        assertTrue(thrown.isFailure)
        assertTrue("a failed cut writes nothing", !out.exists())
    }

    // ---- Real footage, when it has been pushed ------------------------------

    /**
     * The whole path on a real recording: parse it as the importer does, take
     * `clipCandidate`, cut. Push with
     * `adb exec-in run-as app.trackevolution sh -c 'mkdir -p files/footage && cat > files/footage/<name>' < <file>`
     * (a file `adb push`ed into the app's external dir is invisible to it).
     */
    private fun realFootage(name: String, expectTimeMs: Int, expectStartT: Double, keyframeSlackMs: Int) {
        val file = File(context.filesDir, "footage/$name")
        assumeTrue("$name not pushed to ${file.parent}", file.isFile)
        val clip = TelemetryImporter.parseOne(name) { ContentByteSource.open(context.contentResolver, Uri.fromFile(file)) }
        val parsed = clip.parsed
        assertNotNull(clip.error, parsed)
        val candidate = LapClips.clipCandidate(parsed)!!
        assertEquals(expectTimeMs, candidate.lap.timeMs)
        assertEquals(expectStartT, candidate.lap.startT!!, 0.01)
        val window = LapClips.clipWindow(candidate.lap, parsed!!.durationS)!!
        val estimate = LapClips.estimateClipBytes(candidate.lap, file.length(), parsed.durationS)!!

        val out = File(context.filesDir, "footage-out/${name.substringBeforeLast('.')}-lap.mp4")
        val started = System.nanoTime()
        val cut = ClipCutter.cut(context.contentResolver, Uri.fromFile(file), window, out)
        val seconds = (System.nanoTime() - started) / 1e9
        Log.i(
            "ClipCutterTest",
            "$name: lap ${candidate.index + 1} ${candidate.lap.timeMs} ms from ${candidate.lap.startT} s; " +
                "window ${window.startS}–${window.endS}; cut ${cut.sizeBytes} bytes (estimate $estimate), " +
                "${cut.durationMs} ms, lap at ${cut.lapOffsetMs} ms, in ${"%.1f".format(seconds)} s → ${out.path}",
        )
        assertEquals(listOf("video/avc", "audio/mp4a-latm"), tracks(out))
        assertNull(location(out))
        assertTrue("never before the requested pre-roll: ${cut.lapOffsetMs}", cut.lapOffsetMs >= 3000 - 1)
        assertTrue("within a keyframe interval of it: ${cut.lapOffsetMs}", cut.lapOffsetMs <= 3000 + keyframeSlackMs)
        assertTrue("estimate within 15%: $estimate vs ${cut.sizeBytes}", abs(estimate - cut.sizeBytes) < cut.sizeBytes * 0.15)
    }

    @Test
    fun aCorvettePdrLap() = realFootage("260509_085740_00010_.mp4", 122_110, 681.544, keyframeSlackMs = 1500)

    @Test
    fun aBlackwingPdr25Lap() = realFootage("ADV_1635.mp4", 81_345, 283.234, keyframeSlackMs = 40)
}
