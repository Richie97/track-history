package app.trackevolution.screens

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.MapViewer
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TracePoint
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.core.TraceSample
import app.trackevolution.ui.map.LocalMapAvailable
import app.trackevolution.ui.map.MapDraw
import app.trackevolution.ui.map.MapSupport
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The map viewer (NS-53 ticket 3) on the JVM: the Maps SDK cannot run under
 * Robolectric, so [LocalMapAvailable] stands a plain composable in for
 * Google's map and these cover what is ours — the plan, the controls, the
 * read-out and every sentence, word for word the web's.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class TrackMapViewerTest {

    @get:Rule
    val compose = createComposeRule()

    /** A 1 km ring, slower on one side, at Virginia International Raceway's latitude. */
    private val trace = (0 until 40).map { i ->
        val a = 2 * Math.PI * i / 40
        TracePoint(x = 160 * Math.cos(a), y = 160 * Math.sin(a), v = 60.0 + 40 * Math.sin(a))
    }
    private val geo = TraceGeo(36.5607, -79.2064)

    private fun content(geo: TraceGeo?, entry: LapChannels? = null) = MapContent(
        title = "VIR (Full)",
        sub = "2:02.110 · Jun 6, 2026",
        trace = trace,
        geo = geo,
        entry = entry,
        dStepM = entry?.let { 20.0 },
        markers = emptyList(),
    )

    private var lastDraw: MapDraw? = null
    private var backs = 0

    private fun show(content: MapContent, support: MapSupport) {
        compose.setContent {
            CompositionLocalProvider(LocalMapAvailable provides support) {
                TrackTheme {
                    TrackMapViewer(content = content, onBack = { backs++ })
                }
            }
        }
    }

    private fun fakeMap(online: Boolean = true) = MapSupport(
        available = true,
        online = { online },
        drawMap = { d ->
            lastDraw = d
            Text("map:${d.type.key}", Modifier.testTag("fakeMap"))
        },
    )

    @Test
    fun `with no anchor it keeps to the line and says why`() {
        show(content(geo = null), fakeMap())
        compose.onNodeWithText(MapViewer.NOTE_NO_ANCHOR).assertIsDisplayed()
        compose.onNodeWithTag("mapType-line").assertIsEnabled().assertIsSelected()
        compose.onNodeWithTag("mapType-satellite").assertIsNotEnabled()
        compose.onNodeWithTag("mapType-standard").assertIsNotEnabled()
        compose.onNodeWithTag("trackMap").assertIsDisplayed()
        compose.onNodeWithTag("fakeMap").assertDoesNotExist()
        compose.onNodeWithTag("mapFit").assertDoesNotExist()
    }

    @Test
    fun `without Play services or a key it is the line, with the web's sentence`() {
        show(content(geo), MapSupport(available = false))
        compose.onNodeWithText(MapViewer.NOTE_NOT_SET_UP).assertIsDisplayed()
        compose.onNodeWithTag("mapType-satellite").assertIsNotEnabled()
        compose.onNodeWithTag("trackMap").assertIsDisplayed()
    }

    @Test
    fun `offline it is the line, and says imagery needs a connection`() {
        show(content(geo), fakeMap(online = false))
        compose.onNodeWithText(MapViewer.NOTE_OFFLINE).assertIsDisplayed()
        compose.onNodeWithTag("fakeMap").assertDoesNotExist()
    }

    @Test
    fun `an anchored line opens on satellite, switches type and fits on request`() {
        show(content(geo), fakeMap())
        compose.onNodeWithText("map:satellite").assertIsDisplayed()
        compose.onNodeWithTag("mapType-satellite").assertIsSelected()
        compose.onNodeWithTag("mapFit").assertIsDisplayed()
        compose.onNodeWithText(MapViewer.NOTE_APPROX).assertDoesNotExist()

        compose.onNodeWithTag("mapType-standard").performClick()
        compose.onNodeWithText("map:standard").assertIsDisplayed()

        val before = lastDraw!!.fitKey
        compose.onNodeWithTag("mapFit").performClick()
        compose.waitForIdle()
        assertEquals(before + 1, lastDraw!!.fitKey)

        compose.onNodeWithTag("mapType-line").performClick()
        compose.onNodeWithTag("trackMap").assertIsDisplayed()
        compose.onNodeWithTag("mapFit").assertDoesNotExist()
    }

    @Test
    fun `a borrowed anchor is said to be an estimate`() {
        show(content(geo.copy(approx = true)), fakeMap())
        compose.onNodeWithText(MapViewer.NOTE_APPROX).assertIsDisplayed()
        compose.onNodeWithText("map:satellite").assertIsDisplayed()
    }

    @Test
    fun `a tap on the line reads its speed and distance, and a tap off it clears`() {
        val entry = LapChannels(n = 1, timeMs = 122_110, speed = List(51) { 100.0 + it })
        show(content(geo, entry), fakeMap())
        // On the line at its start: 0 % of the lap, the channel's first sample.
        val on = GeoTrace.unprojectTrace(listOf(trace[0]), geo).first()
        compose.runOnIdle { lastDraw!!.onTap(on.lat, on.lon, 1.0) }
        compose.onNodeWithTag("mapReadout").assertIsDisplayed()
        compose.onNodeWithText("62 mph · 0 mi").assertIsDisplayed()
        assertNotNull(lastDraw!!.selected)

        val off = GeoTrace.unprojectTrace(listOf(TracePoint(0.0, 0.0, 0.0)), geo).first()
        compose.runOnIdle { lastDraw!!.onTap(off.lat, off.lon, 1.0) }
        compose.onNodeWithTag("mapReadout").assertDoesNotExist()
    }

    @Test
    fun `the read-out is reachable without a tap, 5 percent of the lap a step`() {
        show(content(geo), fakeMap())
        val config = compose.onNodeWithTag("mapStage").fetchSemanticsNode().config
        assertTrue(config[SemanticsProperties.ContentDescription].single().endsWith("Map type: Satellite."))
        val actions = config[SemanticsActions.CustomActions]
        assertEquals(listOf("Next point", "Previous point"), actions.map { it.label })
        compose.runOnIdle { actions.first().action() }
        compose.onNodeWithTag("mapReadout").assertIsDisplayed()
    }

    @Test
    fun `back leaves`() {
        show(content(geo), fakeMap())
        compose.onNodeWithTag("mapBack").performClick()
        compose.runOnIdle { assertEquals(1, backs) }
        compose.onNodeWithText("VIR (Full)").assertIsDisplayed()
        compose.onNodeWithText("2:02.110 · Jun 6, 2026").assertIsDisplayed()
    }

    @Test
    fun `the track map card offers the map only when asked to`() {
        var opened = 0
        val samples = trace.map { TraceSample(it.x, it.y, it.v) }
        compose.setContent {
            TrackTheme {
                androidx.compose.foundation.layout.Column {
                    TrackMap(trace = samples, onExpand = { opened++ })
                }
            }
        }
        compose.onNodeWithTag("trackMapExpand").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, opened) }
    }

    @Test
    fun `a card with nowhere to open draws no expand control`() {
        val samples = trace.map { TraceSample(it.x, it.y, it.v) }
        compose.setContent { TrackTheme { TrackMap(trace = samples) } }
        compose.onNodeWithTag("trackMap").assertIsDisplayed()
        compose.onNodeWithTag("trackMapExpand").assertDoesNotExist()
    }
}
