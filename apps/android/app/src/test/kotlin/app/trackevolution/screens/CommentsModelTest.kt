package app.trackevolution.screens

import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The comment drafts (NS-52) live in the destination's `SavedStateHandle`,
 * keyed by target: a model rebuilt over the same handle — what a rotation, a
 * fold or the system restoring the process hands back — has the text, the lap
 * and the place, and two targets never share a draft.
 */
class CommentsModelTest {

    private val api = ApiClient(
        MockEngine { respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json")) },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
    )

    private fun model(handle: SavedStateHandle) =
        CommentsModel(TestScope(UnconfinedTestDispatcher()), api, LogbookOwner.Me, 5, handle)

    @Test
    fun `a draft, its lap and its place survive the model being rebuilt over the same handle`() {
        val handle = SavedStateHandle()
        val key = CommentsModel.lapKey(11, 21, 3)
        model(handle).apply {
            setDraft(key, "Brake later")
            setPlace(key, 1240)
            setLap(CommentsModel.sessionKey(11, 3), 22)
            setDraft(CommentsModel.sessionKey(11, 3), "Whole day")
        }
        val restored = model(handle)
        assertEquals("Brake later", restored.draft(key))
        assertEquals(1240, restored.place(key))
        assertEquals(22, restored.lap(CommentsModel.sessionKey(11, 3)))
        assertEquals("Whole day", restored.draft(CommentsModel.sessionKey(11, 3)))
        // Keyed by target: another lap's composer starts empty.
        assertEquals("", restored.draft(CommentsModel.lapKey(11, 22, 3)))
    }

    @Test
    fun `a place belongs to the lap it was marked on`() {
        val m = model(SavedStateHandle())
        val key = CommentsModel.sessionKey(11, null)
        m.setLap(key, 21)
        m.setPlace(key, 300)
        m.setLap(key, 22)
        assertNull(m.place(key))
    }
}
