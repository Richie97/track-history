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
import app.trackevolution.core.model.CoachComment
import app.trackevolution.core.model.CommentAuthor
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.charts.CommentMark

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

    @Test
    fun `a session's placed comments mark each lap at its own channel index and grid place`() {
        val laps = listOf(Lap(21, 11, 1, 121_900), Lap(22, 11, 2, 120_400))
        val grid = List(41) { it * 4.0 } // 40 steps of 20 m: an 800 m lap
        val session = Session(
            id = 11, sort = 0, laps = laps,
            channels = SessionChannels(v = 1, dStepM = 20.0, laps = listOf(LapChannels(n = 1, timeMs = 121_900, speed = grid), LapChannels(n = 2, timeMs = 120_400, speed = grid))),
        )
        fun c(id: Int, lapId: Int?, distM: Int?, mine: Boolean = false) = CoachComment(
            id = id, coachId = 3, sessionId = 11, lapId = lapId, distM = distM, body = "x", createdAt = 0,
            author = CommentAuthor(3, "Sam"), mine = mine, seen = false,
        )
        val marks = sessionCommentMarks(
            listOf(c(1, 21, 400), c(2, 22, 2000, mine = true), c(3, 22, null), c(4, null, null)),
            session,
        )
        // 400 m of 800 is grid index 20 on lap 1; past the end clamps to 40 on lap 2.
        assertEquals(listOf(CommentMark(0, 20.0, false), CommentMark(1, 40.0, true)), marks)
        assertEquals(emptyList<CommentMark>(), sessionCommentMarks(emptyList(), session))
    }
}

