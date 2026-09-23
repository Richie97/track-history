package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import app.trackevolution.core.WrappedStory
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.Wrapped
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * Season Wrapped on Android (NS-36): the story is wired to `:core`'s card rules
 * and navigates, a free account's Pro cards draw locked with the paywall behind
 * them, and the poster renders at the two sizes the share targets want. What the
 * cards *say* is pinned in `:core` by `WrappedStoryTest` against the web.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h900dp")
class WrappedStoryTest {

    @get:Rule
    val compose = createComposeRule()

    /** The golden capture, so this reads a real server response rather than a hand-typed one. */
    private val golden: Wrapped by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null && !File(dir, "package.json").isFile) dir = dir.parentFile
        val body = Json.parseToJsonElement(File(dir!!, "contracts/golden/wrapped.json").readText())
            .let { (it as kotlinx.serialization.json.JsonObject)["body"]!! }
        Json.decodeFromJsonElement(Wrapped.serializer(), body)
    }

    private fun show(data: Wrapped, onSubscribe: () -> Unit = {}) {
        compose.setContent {
            TrackTheme {
                var index by remember { mutableIntStateOf(0) }
                WrappedStoryView(data = data, index = index, onIndex = { index = it }, shareUrl = null, onSubscribe = onSubscribe)
            }
        }
    }

    @Test
    fun `opens on the cover and steps through the cards`() {
        show(golden)
        compose.onNodeWithText("Your ${golden.year}").assertIsDisplayed()
        compose.onNodeWithContentDescription("Next card").performClick()
        compose.onNodeWithText("THE NUMBERS").assertIsDisplayed()
        compose.onNodeWithContentDescription("Previous card").performClick()
        compose.onNodeWithText("Your ${golden.year}").assertIsDisplayed()
    }

    @Test
    fun `a progress segment jumps straight to its card`() {
        show(golden)
        val cards = WrappedStory.wrappedCards(golden)
        compose.onNodeWithContentDescription("Card ${cards.size}: Your season").performClick()
        compose.onNodeWithText("Share image").assertIsDisplayed()
    }

    @Test
    fun `a free account's Pro cards are locked, with the paywall behind a button`() {
        var asked = 0
        val free = golden.copy(pro = null)
        show(free) { asked++ }
        val cards = WrappedStory.wrappedCards(free)
        val tire = cards.indexOfFirst { it.kind == WrappedStory.Kind.TIRE }
        compose.onNodeWithContentDescription("Card ${tire + 1}: Favourite tyre").performClick()
        compose.onNodeWithText("FAVOURITE TYRE").assertIsDisplayed()
        compose.onNodeWithTag("wrappedProUpsell").performClick()
        assertEquals(1, asked)
    }

    @Test
    fun `the poster draws a story and a landscape`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val story = WrappedPoster.draw(context, golden, UnitSystem.IMPERIAL, dark = true, wide = false)
        val wide = WrappedPoster.draw(context, golden, UnitSystem.METRIC, dark = false, wide = true)
        assertEquals(1080 to 1920, story.width to story.height)
        assertEquals(1200 to 630, wide.width to wide.height)
    }

    @Test
    fun `the poster wraps words the way the web image does`() {
        val measure = { s: String -> s.length.toFloat() }
        assertEquals(
            listOf("Virginia International", "Raceway (Full)"),
            WrappedPoster.wrapWords("Virginia International Raceway (Full)", 24f, measure),
        )
        assertEquals(listOf("Supercalifragilistic", "lap"), WrappedPoster.wrapWords("Supercalifragilistic lap", 10f, measure))
    }
}
