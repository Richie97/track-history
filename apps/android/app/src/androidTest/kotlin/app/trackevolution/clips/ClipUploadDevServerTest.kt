package app.trackevolution.clips

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.Pkce
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.clips.ClipManifest
import app.trackevolution.core.clips.ClipUploadQueue
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.SessionDraft
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URLEncoder
import kotlin.random.Random

/**
 * The whole upload against a real Worker (NS-45): `ClipUploadQueue` over the
 * app's own OkHttp transport, two 50 MiB-and-remainder parts with their exact
 * `Content-Length`, `complete`, the clip on the event detail, a ranged read of
 * the signed URL, and delete. Skipped unless the instrumentation is given a dev
 * server (`DEV_MODE=1`, `CLIP_URL_SECRET` set), the emulator's view of the
 * host's `wrangler dev`:
 *
 * ```
 * adb shell am instrument -w -e devServer http://10.0.2.2:8799 \
 *   -e class app.trackevolution.clips.ClipUploadDevServerTest \
 *   app.trackevolution.test/androidx.test.runner.AndroidJUnitRunner
 * ```
 */
@RunWith(AndroidJUnit4::class)
class ClipUploadDevServerTest {

    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val server: String? = InstrumentationRegistry.getArguments().getString("devServer")
    private val http = OkHttpClient.Builder().followRedirects(false).build()

    /** The app's own PKCE exchange against the DEV_MODE bypass, as the iOS suites mint theirs. */
    private fun devToken(base: String): String {
        val pkce = Pkce.generate()
        val login = http.newCall(
            Request.Builder().url("$base/auth/login?client=app&code_challenge=${URLEncoder.encode(pkce.challenge, "UTF-8")}").build(),
        ).execute()
        val location = login.header("Location") ?: error("no redirect from /auth/login: ${login.code}")
        val code = Regex("[?&]code=([^&]+)").find(location)!!.groupValues[1]
        val body = """{"code":"$code","code_verifier":"${pkce.verifier}"}""".toRequestBody("application/json".toMediaType())
        val exchanged = http.newCall(Request.Builder().url("$base/auth/exchange").post(body).build()).execute().body!!.string()
        return Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(exchanged)!!.groupValues[1]
    }

    @Test
    fun uploadsTwoPartsCompletesPlaysAndDeletes() = runBlocking<Unit> {
        val base = server
        assumeTrue("no -e devServer given", base != null)
        base!!
        val token = devToken(base)
        // Declare the tier this test exercises, rather than inherit the dev database's.
        http.newCall(
            Request.Builder().url("$base/auth/dev/entitlement").header("Authorization", "Bearer $token")
                .post("""{"pro":true}""".toRequestBody("application/json".toMediaType())).build(),
        ).execute().close()

        val api = ApiClient(OkHttp.create(), baseUrl = base, tokens = StaticToken(token))
        val eventId = api.createEvent(EventDraft(startDate = "2026-05-09", trackName = "Clip upload test"))
        try {
            val sessionId = api.createSession(eventId, SessionDraft(label = "Clip test", laps = listOf(100_000, 95_000)))

            // 60 MiB: one full 50 MiB part and a 10 MiB remainder. The server
            // checks sizes, not codecs, so random bytes stand in for a cut.
            val dir = File(context.cacheDir, "clip-upload-test").apply { deleteRecursively(); mkdirs() }
            val file = File(dir, "cut.mp4")
            val bytes = Random(45).nextBytes(60 * 1024 * 1024)
            file.writeBytes(bytes)
            val manifest = ClipManifest(dir)
            manifest.put(
                ClipJob(
                    id = "dev-test", sessionId = sessionId, eventId = eventId, timeMs = 95_000, file = file.path,
                    sizeBytes = file.length(), durationMs = 100_000, lapOffsetMs = 3_317,
                    state = ClipJob.State.PENDING, createdAt = System.currentTimeMillis(),
                ),
            )
            val queue = ClipUploadQueue(manifest, ClipUploadQueue.transport(api), ClipUploadQueue.tempIds(api))
            assertEquals(ClipUploadQueue.Outcome.Done, queue.run("dev-test"))

            val lap = api.event(eventId).sessions.single().laps.single { it.timeMs == 95_000 }
            val clip = lap.clip
            assertNotNull("the best lap carries its clip", clip)
            assertEquals(3_317, clip!!.lapOffsetMs)
            assertEquals(bytes.size.toLong(), clip.sizeBytes)
            assertEquals("the local file is gone once complete answered", false, file.exists())

            val signed = api.clipUrl(clip.id)
            val ranged = http.newCall(Request.Builder().url(signed.url).header("Range", "bytes=52428790-52428809").build()).execute()
            assertEquals(206, ranged.code)
            assertArrayEquals("the bytes across the part boundary", bytes.copyOfRange(52_428_790, 52_428_810), ranged.body!!.bytes())

            api.deleteClip(clip.id)
            assertEquals(null, api.event(eventId).sessions.single().laps.single { it.timeMs == 95_000 }.clip)
            dir.deleteRecursively()
        } finally {
            api.deleteEvent(eventId)
        }
    }
}
