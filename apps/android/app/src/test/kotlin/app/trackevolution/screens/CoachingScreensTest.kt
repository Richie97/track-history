package app.trackevolution.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.Entitlement
import app.trackevolution.navigation.PendingInvite
import app.trackevolution.ui.qrModules
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Share with a coach (NS-38): the Coaching page, the profile form's draft, the
 * accept screen's words and the invite held across sign-in.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class CoachingScreensTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = CopyOnWriteArrayList<HttpRequestData>()
    private var preview = PREVIEW

    private val api = ApiClient(
        MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            val get = request.method.value == "GET"
            when {
                path.endsWith("/coaching") -> respond(COACHING, HttpStatusCode.OK, JSON)
                path.endsWith("/me/profile") && get -> respond(PROFILE, HttpStatusCode.OK, JSON)
                path.endsWith("/me/profile") -> respond(
                    """{"ok":true,"profile":{"occupation":"Pilot"}}""", HttpStatusCode.OK, JSON,
                )
                path.endsWith("/coaching/invites") -> respond(INVITE, HttpStatusCode.Created, JSON)
                path.contains("/coaching/invites/") && get -> respond(preview, HttpStatusCode.OK, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
    )

    /**
     * The model's answer comes back on the client's dispatcher and resumes on the
     * main looper, which `waitUntil` alone does not drain here (the note in
     * `GarageTabTest`); sleeping and idling between checks does.
     */
    private fun eventually(condition: () -> Boolean) {
        repeat(400) {
            if (condition()) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        assertTrue("condition never held", condition())
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private fun coaching(entitlement: Entitlement?) {
        val model = CoachingModel(scope, api)
        compose.setContent {
            TrackTheme {
                CoachingScreen(
                    model = model,
                    entitlement = entitlement,
                    onOpenStudent = {},
                    onEditProfile = {},
                    onShare = {},
                    onRequirePro = {},
                )
            }
        }
        eventually { compose.onAllNodesWithTag("coaching").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun `a free account coaches but sees inviting locked in place`() {
        coaching(Entitlement.FREE)
        compose.onNodeWithTag("student-3").assertIsDisplayed()
        compose.onNodeWithText("3 events · last out Jul 4, 2026").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("proLocked").fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodesWithTag("createInvite").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `a Pro account's new invite is shown once, with its QR code`() {
        coaching(Entitlement(tier = Entitlement.Tier.PRO))
        compose.onNodeWithTag("createInvite").performScrollTo().performClick()
        eventually { compose.onAllNodesWithTag("newInvite").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(INVITE_URL).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("inviteQr").performScrollTo().assertIsDisplayed()
        assertTrue(sent.any { it.method.value == "POST" && it.url.encodedPath.endsWith("/coaching/invites") })
    }

    @Test
    fun `the QR code encodes the whole link`() {
        val modules = qrModules(INVITE_URL)
        assertNotNull(modules)
        modules!!
        // Square, and a version big enough for a 64-hex-character token.
        assertEquals(modules.size, modules.first().size)
        assertTrue(modules.size >= 33)
    }

    @Test
    fun `the profile draft survives the model being rebuilt, and a late load never overwrites it`() {
        val handle = SavedStateHandle()
        val first = ProfileFormModel(scope, api, handle)
        first.load()
        eventually { first.value("goals") == "Trail braking into T1" }
        first.set("goals", "Carry more speed in T10")
        first.set("gloves", "no")

        // A configuration change keeps the ViewModel; process death rebuilds it
        // from the handle — which is this.
        val restored = ProfileFormModel(scope, api, handle)
        restored.load()
        assertEquals("Carry more speed in T10", restored.value("goals"))
        assertEquals("no", restored.value("gloves"))
    }

    @Test
    fun `the profile saves as a body the server reads`() {
        val model = ProfileFormModel(scope, api, SavedStateHandle())
        model.load()
        eventually { model.value("goals").isNotEmpty() }
        model.set("occupation", "  Pilot ")
        model.set("shoes", "")
        model.save()
        eventually { model.savedOk }
        val body = (sent.last { it.method.value == "PUT" }.body as TextContent).text
        assertTrue(body, body.contains("\"occupation\":\"Pilot\""))
        assertTrue(body, !body.contains("shoes"))
        assertTrue(body, body.contains("\"gloves\":true"))
    }

    private fun invite(json: String) {
        preview = json
        val model = CoachInviteModel(scope, api, "tok123")
        compose.setContent {
            TrackTheme { CoachInviteScreen(model = model, onAccepted = {}, onOpenStudent = {}, onDone = {}) }
        }
    }

    @Test
    fun `an invite previews the student, and accepting posts it`() {
        invite(PREVIEW)
        eventually { compose.onAllNodesWithTag("acceptInvite").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Alex wants to share their Track Evolution logbook with you, read-only.").assertIsDisplayed()
        compose.onNodeWithTag("acceptInvite").performClick()
        eventually { sent.any { it.url.encodedPath.endsWith("/coaching/invites/tok123/accept") } }
    }

    @Test
    fun `your own invite is said in words, with nothing to accept`() {
        invite(PREVIEW.replace("\"own\":false", "\"own\":true"))
        eventually {
            runCatching { compose.onNodeWithText("This is your own invite link.", substring = true).assertExists() }.isSuccess
        }
        assertTrue(compose.onAllNodesWithTag("acceptInvite").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `an invite from a driver you already coach opens their logbook instead`() {
        invite(PREVIEW.replace("\"already_coach\":false", "\"already_coach\":true"))
        eventually {
            runCatching { compose.onNodeWithText("You already coach Alex.").assertExists() }.isSuccess
        }
        compose.onNodeWithText("Open Alex's logbook").assertIsDisplayed()
    }

    @Test
    fun `an invite link opened signed out is held until it is taken, once`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        PendingInvite(context).park("tok123")
        // A new instance — the process came back from the browser.
        val held = PendingInvite(context)
        assertEquals("tok123", held.token.value)
        assertEquals("tok123", held.take())
        assertNull(held.take())
        assertNull(PendingInvite(context).token.value)
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")
        const val INVITE_URL =
            "https://trackevolution.app/coach/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

        const val COACHING = """
            {"coaches":[{"id":9,"name":"Sam Lee","picture":null,"since":1780000000000,"last_viewed_at":null}],
             "students":[{"id":3,"name":"Alex","picture":null,"since":1780000000000,"event_count":3,
               "last_event_date":"2026-07-04"}],
             "invites":[]}
        """
        const val PROFILE = """
            {"id":1,"name":"Eric","picture":null,"pro":true,
             "profile":{"goals":"Trail braking into T1","gloves":true}}
        """
        const val INVITE = """{"id":4,"url":"$INVITE_URL","expires_at":4102444800000}"""
        const val PREVIEW = """
            {"student":{"id":3,"name":"Alex","picture":null},"expires_at":4102444800000,
             "own":false,"already_coach":false}
        """
    }
}
