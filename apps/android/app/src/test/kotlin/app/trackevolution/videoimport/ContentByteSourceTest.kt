package app.trackevolution.videoimport

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.core.telemetry.Telemetry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * The no-copy read path, against a real file through a real `ContentResolver`.
 *
 * `:core`'s tests prove the parsers over bytes in memory; this proves the seam
 * `:app` supplies — a seekable descriptor from a URI, positional reads, the
 * clamp at end of file, and the cancellation hook — hands those parsers the same
 * bytes. The fixture is one of the committed contract clips, so a decode here
 * that disagreed with `VideoContractTest` would be the byte source's fault.
 */
@RunWith(RobolectricTestRunner::class)
class ContentByteSourceTest {

    private val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver

    private fun fixture(name: String): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, "package.json").isFile) dir = dir.parentFile
        return File(dir ?: error("repository root not found"), "contracts/logic/video/$name")
    }

    @Test
    fun `parses a PDR clip through a file URI without copying it`() {
        val file = fixture("pdr-delta.mp4")
        ContentByteSource.open(resolver, Uri.fromFile(file)).use { source ->
            assertEquals(file.length(), source.size)
            val parsed = Telemetry.parseTelemetryFile(source)
            assertEquals(ParsedTelemetry.Kind.PDR, parsed.kind)
            assertEquals(listOf(47124, 47124), parsed.laps.map { it.timeMs })
            assertNotNull(parsed.lapChannels)
        }
    }

    @Test
    fun `clamps a read past the end rather than throwing, as Blob slice does`() {
        val file = fixture("gopro.mp4")
        ContentByteSource.open(resolver, Uri.fromFile(file)).use { source ->
            val tail = source.read(source.size - 4, 16)
            assertEquals(4, tail.size)
            assertEquals(0, source.read(source.size, 16).size)
            assertEquals(0, source.read(-1, 16).size)
            assertEquals(file.readBytes().copyOfRange(0, 8).toList(), source.read(0, 8).toList())
        }
    }

    @Test
    fun `a cancelled import stops at the next read`() {
        var cancelled = false
        ContentByteSource.open(resolver, Uri.fromFile(fixture("gopro.mp4"))) { cancelled }.use { source ->
            assertEquals(16, source.read(0, 16).size)
            cancelled = true
            assertThrows(CancellationException::class.java) { source.read(0, 16) }
        }
    }

    @Test
    fun `names the file the way the review and the notes will`() {
        assertEquals("pdr-delta.mp4", ContentByteSource.displayName(resolver, Uri.fromFile(fixture("pdr-delta.mp4"))))
    }

    @Test
    fun `the importer reports an unreadable clip by name instead of failing the batch`() = runBlocking {
        val clips = TelemetryImporter.parse(
            resolver,
            listOf(Uri.fromFile(fixture("gopro.mp4")), Uri.fromFile(File("/nonexistent/clip.mp4"))),
        )
        // Sorted by the clock the file carries; the unreadable one has none and sorts first.
        assertEquals(2, clips.size)
        val broken = clips.first { it.file == "clip.mp4" }
        assertNull(broken.parsed)
        assertTrue(broken.error!!.startsWith("Couldn't read this video"))
        val good = clips.first { it.file == "gopro.mp4" }
        assertEquals(ParsedTelemetry.Kind.GOPRO, good.parsed?.kind)
        assertNull(good.error)
    }
}
