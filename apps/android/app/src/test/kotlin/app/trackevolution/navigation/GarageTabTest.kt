package app.trackevolution.navigation

import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.runtime.collectAsState
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The Garage tab (NS-37), composed the way the scaffold composes it: the
 * navigation suite around the real graph, over a mock server.
 *
 * Free is the case the tab exists for — before it, a free account's garage was
 * a paywall with no front door — so it is asserted end to end: the tab, a car's
 * tile with its logbook line, **+ Add car** posting a car, and the Pro half
 * locked in place rather than missing. Pro adds the badge.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class GarageTabTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = CopyOnWriteArrayList<HttpRequestData>()
    private lateinit var nav: NavHostController

    private object NoTemplate : ChecklistTemplateStore {
        override val items: List<String> = emptyList()
        override suspend fun set(items: List<String>) = Unit
    }

    private object NoUnits : UnitsStore {
        override val units: UnitSystem = UnitSystem.IMPERIAL
        override suspend fun set(units: UnitSystem) = Unit
    }

    @Before
    fun resetBadge() = GarageBadge.clear()

    @Test
    fun `a free account gets the tab, its cars, the add tile and the Pro half locked`() {
        show(Entitlement.FREE, pro = false)
        openGarage()

        compose.onNodeWithTag("carTile-1").assertIsDisplayed()
        compose.onNodeWithText("3 track days · last at VIR").assertIsDisplayed()
        compose.onNodeWithTag("addCar").assertIsDisplayed()
        assertTrue(
            "the Pro half should be locked in place, not missing",
            compose.onAllNodesWithTag("proLocked").fetchSemanticsNodes().isNotEmpty(),
        )
        // No badge for free, whatever the count would be.
        assertTrue(
            compose.onAllNodes(hasTestTag("tabGarage") and SemanticsMatcher.keyIsDefined(SemanticsProperties.StateDescription))
                .fetchSemanticsNodes().isEmpty(),
        )
    }

    @Test
    fun `adding a car posts it and opens its page`() {
        show(Entitlement.FREE, pro = false)
        openGarage()

        compose.onNodeWithTag("addCar").performClick()
        compose.onNodeWithTag("addCarName").performScrollTo().performTextInput("GR86")
        compose.onNodeWithTag("addCarSubmit").performScrollTo().performClick()

        compose.waitUntil(10_000) { sent.any { it.method.value == "POST" } }
        val post = sent.first { it.method.value == "POST" }
        assertTrue(post.url.encodedPath.endsWith("/vehicles"))
        assertTrue((post.body as TextContent).text.contains("\"name\":\"GR86\""))
        // The create's answer comes back on the client's dispatcher and resumes
        // on the main looper, which `waitUntil` alone does not always drain here.
        repeat(200) {
            if (nav.currentDestination?.hasRoute(Route.Vehicle::class) == true) return@repeat
            Thread.sleep(25)
            compose.waitForIdle()
        }
        assertTrue(nav.currentDestination?.hasRoute(Route.Vehicle::class) == true)
        assertEquals(AppTab.Garage, nav.currentDestination.appTab)
    }

    @Test
    fun `a free car page shows its logbook and locks the rest`() {
        show(Entitlement.FREE, pro = false)
        openGarage()
        compose.onNodeWithTag("carTile-1").performClick()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("bestsInCar").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Best in this car").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("proLocked").fetchSemanticsNodes().isNotEmpty())
        // The whole-screen paywall is gone.
        assertTrue(compose.onAllNodesWithText("Garage wear tracking is Pro").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `Pro counts due and low parts on the Garage tab`() {
        show(Entitlement(tier = Entitlement.Tier.PRO), pro = true)
        openGarage()

        // Said on the tab item itself — Material clears a badge's own semantics.
        val announced = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "1 maintenance reminder")
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasTestTag("tabGarage") and announced).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(compose.onAllNodesWithTag("proLocked").fetchSemanticsNodes().isEmpty())
    }

    private fun openGarage() {
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("tabGarage").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("tabGarage").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("carTile-1").fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun show(entitlement: Entitlement, pro: Boolean) {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            val get = request.method.value == "GET"
            when {
                path.endsWith("/garage") ->
                    if (pro) {
                        respond(GARAGE, HttpStatusCode.OK, JSON)
                    } else {
                        respond("""{"error":"pro required"}""", HttpStatusCode.PaymentRequired, JSON)
                    }
                path.endsWith("/vehicles") && get -> respond(VEHICLES, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") -> respond(CREATED, HttpStatusCode.Created, JSON)
                path.endsWith("/events") -> respond(EVENTS, HttpStatusCode.OK, JSON)
                path.endsWith("/tracks") -> respond("[]", HttpStatusCode.OK, JSON)
                path.endsWith("/car-catalog") -> respond("[]", HttpStatusCode.OK, JSON)
                path.endsWith("/me") -> respond(ME, HttpStatusCode.OK, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
        }
        val api = ApiClient(engine, baseUrl = "https://example.test")
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    nav = rememberNavController()
                    val entry by nav.currentBackStackEntryAsState()
                    val badge by GarageBadge.count.collectAsState()
                    val tab = entry?.destination.appTab
                    AppNavigationSuite(
                        selected = tab,
                        onSelect = { if (it != tab) nav.selectTab(it) },
                        // The scaffold's gate, verbatim: a number for everyone,
                        // shown only for Pro.
                        garageBadge = if (Entitlement.canUseGarage(entitlement)) badge else 0,
                        showNavigation = true,
                    ) {
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
                            entitlement = entitlement,
                        )
                    }
                }
            }
        }
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":null},
             "totals":{"events":2,"track_days":3}}
        """

        const val VEHICLES = """[{"id":1,"name":"Corvette Z06","is_default":1}]"""

        const val CREATED = """{"id":2,"name":"GR86","is_default":0}"""

        const val EVENTS = """
            [{"id":5,"track_id":100,"track_name":"NCM","start_date":"2026-04-11","days":2,
              "vehicle_id":1,"updated_at":1,"lap_count":0,"session_count":0,"best_ms":141000,"hours":4},
             {"id":6,"track_id":101,"track_name":"VIR","start_date":"2026-05-02","days":1,
              "vehicle_id":1,"updated_at":1,"lap_count":0,"session_count":0,"best_ms":125000,"hours":2}]
        """

        /** One part due on the car. */
        const val GARAGE = """
            [{"id":1,"name":"Corvette Z06","is_default":1,"updated_at":1,"hours":6,
              "event_count":2,"event_days":3,"parts":[
                {"id":10,"vehicle_id":1,"kind":"pads_front","name":"Hawk DTC-60",
                 "installed_on":"2026-01-01","measurements":[],
                 "wear":{"hours":9,"events":3,"cycles":4,"remaining_hours":0.5,"pct_used":0.95}}]}]
        """
    }
}
