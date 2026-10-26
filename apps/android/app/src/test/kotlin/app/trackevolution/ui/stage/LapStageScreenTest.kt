package app.trackevolution.ui.stage

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import app.trackevolution.core.VideoSync
import app.trackevolution.core.VideoSync.SideKey
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.TracePoint
import app.trackevolution.screens.EventModel
import app.trackevolution.screens.LapDetailScreen
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The lap stage on screen (NS-51): the holder outliving a configuration change
 * and an activity recreation — `MainActivity` declares no `configChanges`, so a
 * rotation is one — and the lap page in each shape the spec names: a phone in
 * portrait, the same phone on its side (full-bleed), and a tablet (wide).
 */
@RunWith(RobolectricTestRunner::class)
class LapStageScreenTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val n = 40
    private fun entry(num: Int, ms: Int, slow: Double) = LapChannels(
        n = num,
        timeMs = ms,
        speed = List(n) { k -> if (k in 12..18) 90.0 - slow else 160.0 - slow },
        latG = List(n) { k -> if (k in 12..18) 1.1 else 0.05 },
        throttle = List(n) { k -> if (k in 12..18) 20.0 else 100.0 },
        brake = List(n) { k -> if (k == 11) 70.0 else 0.0 },
    )

    private val channels = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = listOf(entry(1, 124_000, 6.0), entry(2, 121_500, 0.0), entry(3, 122_700, 3.0)),
    )

    private fun binding() = LapStageHolder.Binding(
        key = "t",
        a = stageSide(SideKey.A, channels.laps[0], 20.0, 1, LapClip(9, 30_000, 3_000), false, 0)!!,
        b = stageSide(SideKey.B, channels.laps[1], 20.0, 2, null, true, 1),
        corners = emptyList(),
    )

    @Test
    fun `the holder keeps the playhead and the mode through a configuration change`() {
        val restoration = StateRestorationTester(compose)
        var holder: LapStageHolder? = null
        restoration.setContent {
            CompositionLocalProvider(LocalStagePlayerFactory provides { FakeStagePlayer() }) {
                holder = rememberLapStageHolder("restore")
            }
        }
        val first = compose.runOnIdle {
            holder!!.bind(binding(), { "https://clips.test/$it.mp4" })
            holder!!.seekElapsed(8.0)
            holder!!.changeMode(VideoSync.SyncMode.TIME)
            holder!!
        }
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            assertSame(first, holder)
            assertEquals(8.0, holder!!.eMaster, 1e-9)
            assertEquals(VideoSync.SyncMode.TIME, holder!!.mode)
        }
    }

    @Test
    fun `the holder outlives the activity being recreated`() {
        var holder: LapStageHolder? = null
        compose.activityRule.scenario.onActivity { activity ->
            activity.setContent {
                CompositionLocalProvider(LocalStagePlayerFactory provides { FakeStagePlayer() }) {
                    holder = rememberLapStageHolder("recreate")
                }
            }
        }
        compose.waitForIdle()
        val first = holder!!
        compose.runOnIdle {
            first.bind(binding(), { "https://clips.test/$it.mp4" })
            first.seekElapsed(8.0)
            first.changeMode(VideoSync.SyncMode.TIME)
        }
        holder = null
        compose.activityRule.scenario.recreate()
        compose.activityRule.scenario.onActivity { activity ->
            activity.setContent {
                CompositionLocalProvider(LocalStagePlayerFactory provides { FakeStagePlayer() }) {
                    holder = rememberLapStageHolder("recreate")
                }
            }
        }
        compose.waitForIdle()
        assertSame("the same holder, from the retained ViewModelStore", first, holder)
        assertEquals(8.0, holder!!.eMaster, 1e-9)
        assertEquals(VideoSync.SyncMode.TIME, holder!!.mode)
    }

    // ---- the lap page --------------------------------------------------------

    private fun showLapPage() {
        val model = loadedModel()
        val api = ApiClient(engine, baseUrl = "https://example.test")
        compose.setContent {
            CompositionLocalProvider(LocalStagePlayerFactory provides { FakeStagePlayer() }) {
                ProvideLayoutMetrics {
                    TrackTheme {
                        LapDetailScreen(
                            model = model,
                            sessionId = 10,
                            lapId = 101,
                            canViewChannels = true,
                            onCompare = {},
                            videoApi = api,
                            viewer = Entitlement(tier = Entitlement.Tier.PRO),
                        )
                    }
                }
            }
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("stageTransport").fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodesWithTag("stageFullBleed").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp-port")
    fun `a phone in portrait gets the compact stage over the panel`() {
        showLapPage()
        compose.onNodeWithTag("stageSlot:A").assertIsDisplayed()
        compose.onNodeWithTag("stageScrubber").assertIsDisplayed()
        compose.onNodeWithTag("nowStrip").assertIsDisplayed()
        compose.onNodeWithTag("stageMap").assertDoesNotExist()
        compose.onNodeWithTag("stageFullBleed").assertDoesNotExist()
        // A tap on play starts the clock, and a tap on a chart pauses it again.
        compose.onNodeWithTag("stagePlay").performClick()
    }

    @Test
    @Config(qualifiers = "w891dp-h411dp-land")
    fun `the same phone on its side goes full-bleed with the video`() {
        showLapPage()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("stageFullBleed").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("stageBack").assertIsDisplayed()
        compose.onNodeWithTag("stageBack").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("stageFullBleed").fetchSemanticsNodes().isEmpty() }
    }

    @Test
    @Config(qualifiers = "w1400dp-h1000dp-land")
    fun `a tablet gets the wide stage with the map and the now-strip beside it`() {
        showLapPage()
        compose.onNodeWithTag("stageMap").assertIsDisplayed()
        compose.onNodeWithTag("nowStrip").assertIsDisplayed()
        compose.onNodeWithTag("stageFullBleed").assertDoesNotExist()
    }

    private val detailJson: String by lazy {
        val event = Json.parseToJsonElement(goldenBody).jsonObject.let { body ->
            JsonObject(body.filterKeys { it != "sessions" && it != "setups" })
        }
        val detail = EventDetail(
            event = json.decodeFromJsonElement(Event.serializer(), event),
            sessions = listOf(
                Session(
                    id = 10,
                    label = "Session 2",
                    sort = 1,
                    channels = channels,
                    trace = List(12) { TracePoint(x = it * 10.0, y = (it % 4) * 7.0, v = 30.0 + it) },
                    laps = listOf(
                        Lap(id = 101, sessionId = 10, lapNum = 1, timeMs = 124_000, clip = LapClip(9, 30_000, 3_000)),
                        Lap(id = 102, sessionId = 10, lapNum = 2, timeMs = 121_500),
                        Lap(id = 103, sessionId = 10, lapNum = 3, timeMs = 122_700),
                    ),
                ),
            ),
            setups = emptyList(),
        )
        Json.encodeToString(EventDetail.serializer(), detail)
    }

    private val engine = MockEngine { request ->
        val path = request.url.encodedPath
        val body = when {
            path.endsWith("/tracks") -> "[]"
            path.contains("/clips/") -> """{"url":"https://clips.test/9.mp4","expires_at":0}"""
            else -> detailJson
        }
        respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
    }

    private fun loadedModel(): EventModel = runBlocking {
        val model = EventModel(CoroutineScope(Dispatchers.Default), ApiClient(engine, baseUrl = "https://example.test"), 1)
        model.load()
        withTimeout(5_000) { while (model.state != LoadState.Ready) delay(5) }
        model
    }

    private companion object {
        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("repository root not found above ${System.getProperty("user.dir")}")
        }

        private val json = Json { ignoreUnknownKeys = false }

        private val goldenBody: String = Json.parseToJsonElement(
            File(repoRoot, "contracts/golden/event-detail.json").readText(),
        ).jsonObject["body"].toString()
    }
}
