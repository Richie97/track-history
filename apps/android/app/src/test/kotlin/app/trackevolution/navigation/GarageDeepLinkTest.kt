package app.trackevolution.navigation

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.DeepLink
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.LayoutClass
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Where a car link lands (NS-37): in the **Garage** graph, with the Garage root
 * beneath it, at compact and at expanded width — and a logbook link from the
 * Garage tab goes back to Events. The wiring, not the arithmetic: the same
 * `showDeepLink` the scaffold calls, over the real graph.
 */
@RunWith(RobolectricTestRunner::class)
class GarageDeepLinkTest {

    @get:Rule
    val compose = createComposeRule()

    private lateinit var nav: NavHostController
    private var layoutClass: LayoutClass? = null

    private object NoTemplate : ChecklistTemplateStore {
        override val items: List<String> = emptyList()
        override suspend fun set(items: List<String>) = Unit
    }

    private object NoUnits : UnitsStore {
        override val units: UnitSystem = UnitSystem.IMPERIAL
        override suspend fun set(units: UnitSystem) = Unit
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp")
    fun `a vehicle link lands in the Garage graph at compact width`() {
        assertVehicleLinkLandsInGarage(expectExpanded = false)
    }

    @Test
    @Config(qualifiers = "w1400dp-h1000dp")
    fun `a vehicle link lands in the Garage graph at expanded width`() {
        assertVehicleLinkLandsInGarage(expectExpanded = true)
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp")
    fun `a logbook link from the Garage tab goes back to Events`() {
        show(expanded = false)
        compose.runOnIdle { nav.showDeepLink(routeFor(DeepLink.Vehicle(1))!!) }
        compose.runOnIdle { nav.showDeepLink(routeFor(DeepLink.Settings)!!) }
        compose.runOnIdle {
            assertTrue(nav.currentDestination?.hasRoute(Route.Settings::class) == true)
            assertEquals(AppTab.Events, nav.currentDestination.appTab)
            nav.popBackStack()
        }
        compose.runOnIdle {
            assertTrue(nav.currentDestination?.hasRoute(Route.Dashboard::class) == true)
        }
    }

    private fun assertVehicleLinkLandsInGarage(expectExpanded: Boolean) {
        show(expanded = expectExpanded)
        compose.runOnIdle {
            assertEquals(expectExpanded, layoutClass == LayoutClass.Expanded)
            nav.showDeepLink(routeFor(DeepLink.Vehicle(1))!!)
        }
        compose.runOnIdle {
            assertTrue(nav.currentDestination?.hasRoute(Route.Vehicle::class) == true)
            assertEquals(AppTab.Garage, nav.currentDestination.appTab)
            // Back from an arrival opens the tab's root, not a stack never walked.
            nav.popBackStack()
        }
        compose.runOnIdle {
            assertTrue(nav.currentDestination?.hasRoute(Route.Garage::class) == true)
        }
    }

    private fun show(expanded: Boolean) {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/vehicles") -> """[{"id":1,"name":"Corvette Z06","is_default":1}]"""
                path.endsWith("/events") || path.endsWith("/tracks") || path.endsWith("/garage") ||
                    path.endsWith("/car-catalog") -> "[]"
                path.endsWith("/me") ->
                    """{"user":{"id":1,"email":"e@example.test","name":"Eric"},"totals":{"events":0,"track_days":0}}"""
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = ApiClient(engine, baseUrl = "https://example.test")
        compose.setContent {
            ProvideLayoutMetrics {
                layoutClass = LocalLayoutMetrics.current.layoutClass
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
                        // What the scaffold passes at expanded width, where both
                        // roots are the detail pane's placeholders.
                        dashboardAsDetailPlaceholder = expanded,
                        garageAsDetailPlaceholder = expanded,
                    )
                }
            }
        }
    }
}
