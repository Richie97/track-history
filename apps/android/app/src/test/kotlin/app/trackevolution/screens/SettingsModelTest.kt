package app.trackevolution.screens

import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.ui.LoadState
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Settings' two jobs that have consequences: reordering the prep template, and
 * claiming the public share slug.
 *
 * The template is written **whole** — the API takes the array, not a diff — so
 * every edit is really "here is the new list", and getting a move or a delete
 * wrong writes a list the user never asked for. The slug is claimed against
 * every other user's, so a rejection has to leave the old one standing rather
 * than optimistically adopting a name that isn't yours.
 */
class SettingsModelTest {

    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    /** The template, standing in for `AuthController` — see [ChecklistTemplateStore]. */
    private class FakeTemplate(start: List<String>) : ChecklistTemplateStore {
        override var items: List<String> = start
            private set

        override suspend fun set(items: List<String>) {
            this.items = items
        }
    }

    private fun api(slugStatus: HttpStatusCode = HttpStatusCode.OK): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            when {
                path.endsWith("/me") -> respond(ME, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") -> respond(VEHICLES, HttpStatusCode.OK, JSON)
                path.endsWith("/share") && slugStatus != HttpStatusCode.OK ->
                    respond("""{"error":"That link name is taken."}""", slugStatus, JSON)
                path.endsWith("/share") -> respond("""{"slug":"eric"}""", HttpStatusCode.OK, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    private fun model(
        template: ChecklistTemplateStore = FakeTemplate(listOf("Tech inspection", "Torque lug nuts")),
        api: ApiClient = api(),
    ) = SettingsModel(CoroutineScope(Dispatchers.Default), api, template)

    private fun <T> await(timeoutMs: Long = 5_000, block: () -> T?): T = runBlocking {
        withTimeout(timeoutMs) {
            var value = block()
            while (value == null) {
                delay(5)
                value = block()
            }
            value
        }
    }

    // ---- The prep-checklist template ---------------------------------------

    @Test
    fun `moving an item down swaps it with its neighbour, and writes the whole list`() {
        val template = FakeTemplate(listOf("Tech inspection", "Torque lug nuts", "Top off fuel"))
        val model = model(template)
        model.moveChecklistItem(index = 0, offset = 1)

        await { template.items.takeIf { it.first() == "Torque lug nuts" } }
        assertEquals(listOf("Torque lug nuts", "Tech inspection", "Top off fuel"), template.items)
    }

    @Test
    fun `moving off either end is a no-op rather than a crash`() {
        val start = listOf("Tech inspection", "Torque lug nuts")
        val template = FakeTemplate(start)
        val model = model(template)
        model.moveChecklistItem(index = 0, offset = -1)
        model.moveChecklistItem(index = 1, offset = 1)

        Thread.sleep(50)
        assertEquals(start, template.items)
    }

    @Test
    fun `removing an item writes the list without it`() {
        val template = FakeTemplate(listOf("Tech inspection", "Torque lug nuts"))
        val model = model(template)
        model.removeChecklistItem(0)

        await { template.items.takeIf { it.size == 1 } }
        assertEquals(listOf("Torque lug nuts"), template.items)
    }

    @Test
    fun `resetting clears the stored list, which is what puts the default back`() {
        val template = FakeTemplate(listOf("Something of my own"))
        val model = model(template)
        model.resetChecklistTemplate()

        // Empty, not "the built-in list written out": the server treats `[]` as
        // cleared, and the client falls back to its own default from there. A
        // written-out copy would freeze today's default into the account.
        await { template.items.takeIf { it.isEmpty() } }
        assertEquals(emptyList<String>(), template.items)
    }

    @Test
    fun `an added item is trimmed and the field is cleared`() {
        val template = FakeTemplate(listOf("Tech inspection"))
        val model = model(template)
        model.newChecklistItem = "  Charge the lap timer  "
        model.addChecklistItem()

        await { template.items.takeIf { it.size == 2 } }
        assertEquals(listOf("Tech inspection", "Charge the lap timer"), template.items)
        assertEquals("", model.newChecklistItem)
    }

    @Test
    fun `a blank item is not added`() {
        val template = FakeTemplate(listOf("Tech inspection"))
        val model = model(template)
        model.newChecklistItem = "   "
        model.addChecklistItem()

        Thread.sleep(50)
        assertEquals(listOf("Tech inspection"), template.items)
    }

    // ---- The share slug ----------------------------------------------------

    @Test
    fun `a claimed slug becomes the link`() {
        val model = model()
        model.slugDraft = " eric "
        model.saveSlug()

        await { model.slug }
        assertEquals("https://example.test/share/eric", model.shareUrl("https://example.test"))
        // Trimmed on the way out: a trailing space in a URL path is not a name
        // anyone typed on purpose.
        assertEquals("eric", model.slugDraft)
    }

    @Test
    fun `a rejected slug surfaces the server's message and claims nothing`() {
        val model = model(api = api(slugStatus = HttpStatusCode.Conflict))
        model.slugDraft = "taken"
        model.saveSlug()

        await { model.shareError }
        assertEquals("That link name is taken.", model.shareError)
        assertNull(model.slug)
        assertNull(model.shareUrl("https://example.test"))
    }

    @Test
    fun `a failing garage costs the vehicle list and nothing else`() {
        // /me answers, /vehicles does not: the account, the legal links and the
        // share panel must still be there.
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            when {
                path.endsWith("/me") -> respond(ME, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") ->
                    respond("""{"error":"nope"}""", HttpStatusCode.InternalServerError, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
        }
        val model = model(api = ApiClient(engine, baseUrl = "https://example.test"))
        model.load()

        await { model.state.takeIf { it == LoadState.Ready } }
        assertEquals(emptyList<Any>(), model.vehicles)
        assertEquals("eric", model.slug)
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":4,"track_days":6}}
        """

        const val VEHICLES = """[{"id":1,"name":"Corvette Z06","is_default":1}]"""
    }
}
