package app.trackevolution.navigation

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A coach reading a student's logbook (NS-38), composed as the app composes it:
 * the real graph over a mock server whose `/api/students/7/…` is the coach
 * mount.
 *
 * The decisions pinned here are the ones the reuse of the owner's screens puts
 * at risk: the channel panel opening by the **student's** tier rather than the
 * viewer's, every write door gone, no `/garage` read under the mount, and a
 * revoked grant purging what the device kept.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class CoachingNavTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = CopyOnWriteArrayList<HttpRequestData>()
    private val store = OfflineStore(InMemoryOfflinePersistence())
    private lateinit var nav: NavHostController

    private object NoTemplate : ChecklistTemplateStore {
        override val items: List<String> = emptyList()
        override suspend fun set(items: List<String>) = Unit
    }

    private object NoUnits : UnitsStore {
        override val units: UnitSystem = UnitSystem.IMPERIAL
        override suspend fun set(units: UnitSystem) = Unit
    }

    @Test
    fun `a free coach of a Pro student reads the full panel — Grip unlocked`() {
        show(viewer = Entitlement.FREE, studentPro = true, start = Route.SessionCompare(5, 11, student = 7))
        await("channelTabs")
        compose.onNodeWithContentDescription("Grip").performClick()
        await("frictionCircle")
        assertTrue(compose.onAllNodesWithTag("channelProCard").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithTag("channelStudentFreeNote").fetchSemanticsNodes().isEmpty())
        // The page read through the mount (the coach's own dashboard is
        // underneath, warming its own cache, which is why this is not `all`).
        assertTrue(sent.any { it.url.encodedPath == "/api/students/7/events/5" })
        assertTrue(sent.any { it.url.encodedPath == "/api/students/7/me/profile" })
    }

    @Test
    fun `a Pro coach of a free student sees the free half, with a note rather than a paywall`() {
        show(viewer = PRO, studentPro = false, start = Route.SessionCompare(5, 11, student = 7))
        await("channelTabs")
        await("channelStudentFreeNote")
        assertTrue(compose.onAllNodesWithTag("channelProCard").fetchSemanticsNodes().isEmpty())
        compose.onNodeWithContentDescription("Grip").performClick()
        assertTrue(compose.onAllNodesWithTag("frictionCircle").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `a student's event page says whose it is and offers no write, recorder or import`() {
        show(viewer = Entitlement.FREE, studentPro = true, start = Route.Event(5, student = 7))
        await("studentBanner")
        compose.onNodeWithText("You're viewing Alex's logbook · read-only").assertIsDisplayed()
        await("lap-21")
        for (text in listOf("Edit event", "Delete event", "Delete", "Add a session", "Prep checklist")) {
            assertTrue(text, compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty())
        }
        assertTrue(compose.onAllNodesWithTag("eventImportVideo").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithContentDescription("✕").fetchSemanticsNodes().isEmpty())
        assertTrue(sent.none { it.method.value != "GET" })
    }

    @Test
    fun `a student's car page reads no garage and edits nothing`() {
        show(viewer = PRO, studentPro = true, start = Route.StudentVehicle(7, 1))
        await("studentCarSpecs")
        compose.onNodeWithText("2710 mm").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Edit car").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithTag("deleteCar").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithTag("proLocked").fetchSemanticsNodes().isEmpty())
        assertTrue(sent.none { it.url.encodedPath.startsWith("/api/students/") && it.url.encodedPath.endsWith("/garage") })
    }

    @Test
    fun `the student home reads the profile and opens their pages inside the mount`() {
        show(viewer = Entitlement.FREE, studentPro = true, start = Route.Student(7))
        await("studentHome")
        compose.onNodeWithTag("studentHome").performScrollToNode(hasText("Trail braking into T1"))
        compose.onNodeWithText("Trail braking into T1").assertIsDisplayed()
        compose.onNodeWithTag("studentHome").performScrollToNode(hasTestTag("studentCar-1"))
        compose.onNodeWithTag("studentCar-1").performClick()
        await("studentCarSpecs")
    }

    @Test
    fun `a revoked grant says so and purges the student's cache`() {
        runBlocking { store.cachePut("/students/7/events", "[]") }
        show(viewer = Entitlement.FREE, studentPro = true, start = Route.Event(5, student = 7), revoked = true)
        await("studentGone")
        compose.onNodeWithText("Not shared with you").assertIsDisplayed()
        assertNull(runBlocking { store.cachedGet("/students/7/events") })
    }

    /**
     * Loads resume on the main looper, which `waitUntil` alone does not drain
     * here (the note in `GarageTabTest`); sleeping and idling between checks does.
     */
    private fun await(tag: String) {
        repeat(400) {
            if (compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        compose.onNodeWithTag(tag).assertExists()
    }

    private fun show(viewer: Entitlement, studentPro: Boolean, start: Route, revoked: Boolean = false) {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            when {
                path.endsWith("/me/profile") && revoked ->
                    respond("""{"error":"not found"}""", HttpStatusCode.NotFound, JSON)
                path.endsWith("/me/profile") -> respond(profile(studentPro), HttpStatusCode.OK, JSON)
                path.endsWith("/events/5") -> respond(DETAIL, HttpStatusCode.OK, JSON)
                path.endsWith("/events") -> respond(EVENTS, HttpStatusCode.OK, JSON)
                path.endsWith("/tracks") -> respond(TRACKS, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") -> respond(VEHICLES, HttpStatusCode.OK, JSON)
                path.endsWith("/car-catalog") -> respond("[]", HttpStatusCode.OK, JSON)
                // The coach's own dashboard, underneath as the start destination.
                path == "/api/me" -> respond(ME, HttpStatusCode.OK, JSON)
                path == "/api/garage" -> respond("""{"error":"pro required"}""", HttpStatusCode.PaymentRequired, JSON)
                else -> respond("""{"error":"not found"}""", HttpStatusCode.NotFound, JSON)
            }
        }
        val api = ApiClient(engine, baseUrl = "https://example.test", tokens = StaticToken("tok"), offline = store)
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    nav = rememberNavController()
                    AppNavHost(
                        nav = nav,
                        api = api,
                        auth = NoTemplate,
                        unitsStore = NoUnits,
                        checklistTemplate = emptyList(),
                        hasCustomChecklistTemplate = false,
                        themeChoice = ThemeChoice.System,
                        onThemeChange = {},
                        serverUrl = "https://example.test",
                        recorderState = RecorderState(),
                        recorderIdle = true,
                        onStartRecording = {},
                        onStopRecording = {},
                        onSignOut = {},
                        entitlement = viewer,
                    )
                }
            }
        }
        compose.runOnIdle { nav.navigate(start) }
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")
        val PRO = Entitlement(tier = Entitlement.Tier.PRO)

        const val ME = """
            {"user":{"id":1,"email":"c@example.test","name":"Coach","share_slug":null},
             "totals":{"events":0,"track_days":0}}
        """

        fun profile(pro: Boolean) = """
            {"id":7,"name":"Alex","picture":null,"pro":$pro,
             "profile":{"goals":"Trail braking into T1","gloves":true}}
        """

        fun ramp(n: Int, scale: Double) = (0 until n).joinToString(",", "[", "]") { String.format(java.util.Locale.US, "%.3f", it * scale) }

        val DETAIL = """
            {"id":5,"track_id":100,"track_name":"VIR","start_date":"2026-04-11","days":1,"updated_at":1,
             "lap_count":2,"session_count":1,"best_ms":120400,"hours":1,"notes":null,"checklist":null,
             "sessions":[{"id":11,"label":"Session 1","notes":null,"sort":0,
               "laps":[{"id":21,"session_id":11,"lap_num":1,"time_ms":121900},
                       {"id":22,"session_id":11,"lap_num":2,"time_ms":120400}],
               "channels":{"v":1,"dStepM":20,"laps":[
                 {"n":1,"timeMs":121900,"speed":${ramp(40, 4.0)},"latG":${ramp(40, 0.03)},"longG":${ramp(40, -0.02)}},
                 {"n":2,"timeMs":120400,"speed":${ramp(40, 4.1)},"latG":${ramp(40, 0.031)},"longG":${ramp(40, -0.021)}}]}}],
             "setups":[]}
        """

        const val EVENTS = """
            [{"id":5,"track_id":100,"track_name":"VIR","start_date":"2026-04-11","days":1,
              "vehicle_id":1,"updated_at":1,"lap_count":2,"session_count":1,"best_ms":120400,"hours":1}]
        """

        const val TRACKS = """
            [{"id":100,"name":"VIR","updated_at":1,"event_count":1,"track_days":1,"best_ms":120400,
              "last_date":"2026-04-11","series":[]}]
        """

        const val VEHICLES = """
            [{"id":1,"name":"Corvette Z06","is_default":1,"notes":"Stock but for pads",
              "wheelbase_mm":2710,"steering_ratio":15.8}]
        """
    }
}
