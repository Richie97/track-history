package app.trackevolution.screens

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.trackevolution.clips.ClipNetwork
import app.trackevolution.clips.ClipStatus
import app.trackevolution.clips.LocalClipStatus
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Lap
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The lap page's video card over a clip still on this phone (NS-45): *Retry
 * now* after a failed attempt, and an upload given up on said once — with its
 * reason — rather than the video quietly never appearing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class LapVideoCardTest {

    @get:Rule
    val compose = createComposeRule()

    private val api = ApiClient(MockEngine { respond("{}", HttpStatusCode.OK) }, baseUrl = "https://example.test")
    private val lap = Lap(id = 41, sessionId = 501, lapNum = 6, timeMs = 122_110)

    private class FakeClips(jobs: List<ClipJob>) : ClipStatus {
        override val jobs = MutableStateFlow(jobs)
        override val parts: StateFlow<Map<String, Long>> = MutableStateFlow(emptyMap())
        override val network: StateFlow<ClipNetwork> = MutableStateFlow(ClipNetwork.UNKNOWN)
        override val cellularAllowed: Flow<Boolean> = flowOf(false)
        val retried = mutableListOf<String>()
        val acknowledged = mutableListOf<String>()

        override suspend fun setCellularAllowed(allowed: Boolean) = Unit

        override fun retryNow(jobId: String) {
            retried += jobId
        }

        override fun acknowledge(jobId: String) {
            acknowledged += jobId
            jobs.value = jobs.value.filterNot { it.id == jobId }
        }
    }

    private fun job(state: ClipJob.State = ClipJob.State.PENDING) =
        ClipJob(id = "j", sessionId = 501, eventId = 7, timeMs = 122_110, state = state, createdAt = 0)

    private fun show(clips: ClipStatus) {
        compose.setContent {
            CompositionLocalProvider(LocalClipStatus provides clips) {
                TrackTheme {
                    LapVideoCard(
                        api = api,
                        owner = LogbookOwner.Me,
                        viewer = Entitlement(tier = Entitlement.Tier.PRO),
                        sessionId = 501,
                        lap = lap,
                        sessionLaps = listOf(lap),
                        onSubscribe = {},
                        onDeleted = {},
                    )
                }
            }
        }
    }

    @Test
    fun `an interrupted upload says when it tries again and offers Retry now`() {
        val clips = FakeClips(listOf(job().copy(failures = 2, notBeforeMs = System.currentTimeMillis() + 10 * 60_000)))
        show(clips)
        compose.onNodeWithText("Video upload interrupted. Trying again in 10 min.").assertIsDisplayed()
        compose.onNodeWithTag("lapVideoRetry").performClick()
        assertEquals(listOf("j"), clips.retried)
    }

    @Test
    fun `an upload given up on says why once, and keeps saying it on this visit`() {
        val clips = FakeClips(listOf(job(ClipJob.State.DROPPED).copy(dropReason = "clip storage full")))
        show(clips)
        compose.waitForIdle()
        assertEquals("the manifest forgets it as soon as it has been said", listOf("j"), clips.acknowledged)
        compose.onNodeWithText("Couldn't upload this lap's video: your video storage is full.").assertIsDisplayed()
    }

    @Test
    fun `a clip being cut says it is being prepared`() {
        show(FakeClips(listOf(job(ClipJob.State.CUTTING))))
        compose.onNodeWithText("Preparing video").assertIsDisplayed()
    }
}
