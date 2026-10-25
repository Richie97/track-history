package app.trackevolution.recording

import android.Manifest
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.app.ActivityOptionsCompat
import app.trackevolution.core.telemetry.LapClips.ClipOffer
import app.trackevolution.core.telemetry.ParsedLap
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The review asks for notification permission before a save that hands a
 * best-lap video to the uploader — otherwise a driver who only imports is never
 * asked, and the upload's foreground notification is invisible on API 33+.
 */
class ClipNotificationAskTest {

    @Test
    fun `asks only when a clip will upload on 33+ without the permission`() {
        assertTrue(ClipNotificationAsk.shouldAsk(ClipOffer.ON, saveClips = true, sdkInt = 33, granted = false))
        assertTrue(ClipNotificationAsk.shouldAsk(ClipOffer.ON, saveClips = true, sdkInt = 36, granted = false))
    }

    @Test
    fun `never asks when nothing will upload or nothing is missing`() {
        assertFalse(ClipNotificationAsk.shouldAsk(ClipOffer.ON, saveClips = true, sdkInt = 36, granted = true))
        assertFalse(ClipNotificationAsk.shouldAsk(ClipOffer.ON, saveClips = false, sdkInt = 36, granted = false))
        assertFalse(ClipNotificationAsk.shouldAsk(ClipOffer.ON, saveClips = true, sdkInt = 32, granted = false))
        for (offer in listOf(ClipOffer.NONE, ClipOffer.LOCKED, ClipOffer.FULL)) {
            assertFalse(offer.name, ClipNotificationAsk.shouldAsk(offer, saveClips = true, sdkInt = 36, granted = false))
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReviewNotificationAskTest {

    @get:Rule
    val compose = createComposeRule()

    /** Records what was launched and answers it with [grant]. */
    private class FakeRegistry(private val grant: Boolean) : ActivityResultRegistry() {
        val launched = mutableListOf<Any?>()
        override fun <I, O> onLaunch(
            requestCode: Int,
            contract: ActivityResultContract<I, O>,
            input: I,
            options: ActivityOptionsCompat?,
        ) {
            launched += input
            dispatchResult(requestCode, grant)
        }
    }

    private val state = ReviewUiState(
        items = listOf(
            ReviewItem(
                file = "clip.mp4",
                parsed = ParsedTelemetry(
                    kind = ParsedTelemetry.Kind.PDR,
                    laps = listOf(ParsedLap(timeMs = 121_000, estimated = false)),
                ),
                include = true,
                label = "Session 1",
            ),
        ),
        isImport = true,
        forNewEvent = true,
    )

    private fun show(registry: FakeRegistry, offer: ClipOffer, onSave: () -> Unit) {
        val owner = object : ActivityResultRegistryOwner {
            override val activityResultRegistry = registry
        }
        compose.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner) {
                TrackTheme {
                    ReviewScreen(
                        state = state,
                        onPick = {},
                        onLabelChange = { _, _ -> },
                        onIncludeChange = { _, _ -> },
                        onNotesChange = {},
                        onSelectEvent = {},
                        onSave = onSave,
                        onDiscard = {},
                        clipOffer = offer,
                    )
                }
            }
        }
    }

    @Test
    fun `a save with a clip asks first, then saves even when denied`() {
        val registry = FakeRegistry(grant = false)
        var saves = 0
        show(registry, ClipOffer.ON) { saves++ }
        compose.onNodeWithTag("reviewSave").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(listOf<Any?>(Manifest.permission.POST_NOTIFICATIONS), registry.launched)
        assertEquals(1, saves)
    }

    @Test
    fun `a save with no clip to upload never asks`() {
        val registry = FakeRegistry(grant = true)
        var saves = 0
        show(registry, ClipOffer.NONE) { saves++ }
        compose.onNodeWithTag("reviewSave").performScrollTo().performClick()
        compose.waitForIdle()
        assertTrue(registry.launched.isEmpty())
        assertEquals(1, saves)
    }
}
