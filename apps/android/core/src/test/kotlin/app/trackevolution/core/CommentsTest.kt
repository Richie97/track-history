package app.trackevolution.core

import app.trackevolution.core.model.CoachComment
import app.trackevolution.core.model.CommentAuthor
import app.trackevolution.core.model.CommentCoach
import app.trackevolution.core.model.CommentFeed
import app.trackevolution.core.model.FeedComment
import app.trackevolution.core.model.FeedStudent
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.UnitSystem
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Coach comments (NS-52): the port of `public/js/comments.js`, carrying the JS
 * cases from `test/unit/comments-client.test.js` and asserting every row of
 * `contracts/logic/comments.json` — the fixture the iOS Kit asserts against
 * too, generated from the web implementation by `npm run contracts:logic`.
 */
class CommentsTest {

    // ---- The JS cases --------------------------------------------------------

    private fun c(
        id: Int,
        coachId: Int = 2,
        sessionId: Int = 10,
        lapId: Int? = null,
        distM: Int? = null,
        createdAt: Long = id * 1000L,
        author: CommentAuthor = CommentAuthor(2, "Sam Lee"),
        mine: Boolean = false,
        seen: Boolean = false,
    ) = CoachComment(
        id = id, coachId = coachId, sessionId = sessionId, lapId = lapId, distM = distM, body = "c$id",
        createdAt = createdAt, author = author, mine = mine, seen = seen,
    )

    private val laps = listOf(Lap(101, 10, 1, 95_000), Lap(102, 10, 2, 94_000))

    @Test
    fun `the limit is the server's, counted the server's way`() {
        assertEquals(1000, Comments.COMMENT_MAX_CHARS)
        assertEquals(6, Comments.commentLength("  🏁🏁\r\n ok "))
        assertEquals(0, Comments.commentLength(null))
    }

    @Test
    fun `commentThreads splits by coach, in the order each first spoke`() {
        val out = Comments.commentThreads(listOf(c(1, coachId = 7), c(2), c(3, coachId = 7)))
        assertEquals(listOf(7 to listOf(1, 3), 2 to listOf(2)), out.map { it.coachId to it.comments.map { x -> x.id } })
        assertEquals(emptyList<Comments.Thread>(), Comments.commentThreads(null))
    }

    @Test
    fun `groupComments puts the session's first, then laps in lap order, a lap's by place then time`() {
        val list = listOf(
            c(1, lapId = 102), c(2, lapId = 102, distM = 900), c(3), c(4, lapId = 101),
            c(5, lapId = 102, distM = 300), c(6, sessionId = 11), c(7, lapId = 999),
        )
        val out = Comments.groupComments(list, 10, laps)
        assertEquals(listOf(3), out.session.map { it.id })
        assertEquals(listOf(1 to listOf(4), 2 to listOf(5, 2, 1)), out.laps.map { it.lapNum to it.comments.map { x -> x.id } })
    }

    @Test
    fun `commentCounts counts per session and lap, and never counts your own as unread`() {
        val out = Comments.commentCounts(
            listOf(c(1), c(2, lapId = 101, seen = true), c(3, lapId = 101), c(4, lapId = 101, mine = true)),
        )
        assertEquals(Comments.Count(4, 2), out.bySession[10])
        assertEquals(Comments.Count(3, 1), out.byLap[101])
        assertEquals("3 comments, 1 unread", Comments.commentCountText(out.byLap[101]))
        assertEquals("1 comment", Comments.commentCountText(Comments.Count(1, 0)))
        assertEquals("", Comments.commentCountText(null))
    }

    private val corners = listOf(Corners.Corner(1, 10, 20, 0.0, 0), Corners.Corner(2, 55, 70, 0.0, 0))

    @Test
    fun `places say the corner and the distance`() {
        assertEquals("in T2 · 1.2 km", Comments.commentPlace(1240.0, 20.0, corners, UnitSystem.METRIC))
        assertEquals("after T1 · 600 m", Comments.commentPlace(600.0, 20.0, corners, UnitSystem.METRIC))
        assertEquals("600 m", Comments.commentPlace(600.0, 20.0, emptyList(), UnitSystem.METRIC))
        assertNull(Comments.commentPlace(null, 20.0, corners, UnitSystem.METRIC))
    }

    @Test
    fun `a cursor turns into whole metres`() {
        assertEquals(1241, Comments.placeFromCursor(62.04, 20.0))
        assertEquals(0, Comments.placeFromCursor(-1.0, 20.0))
        assertNull(Comments.placeFromCursor(Double.NaN, 20.0))
        assertNull(Comments.placeFromCursor(3.0, 0.0))
    }

    @Test
    fun `a lap's placed comments are marked, clamped to the lap`() {
        val list = listOf(c(1, lapId = 101, distM = 2000, mine = true), c(2, lapId = 101, distM = 500), c(3, lapId = 101), c(4, lapId = 102, distM = 5))
        assertEquals(
            listOf(Comments.Marker(2, 0.5, false), Comments.Marker(1, 1.0, true)),
            Comments.commentMarkers(list, 101, 1000.0),
        )
        assertEquals(emptyList<Comments.Marker>(), Comments.commentMarkers(list, 101, 0.0))
    }

    @Test
    fun `the words`() {
        assertEquals("Sam Lee", Comments.threadTitle(CommentCoach(2, "Sam Lee", active = true), true))
        assertEquals("Sam Lee · no longer your coach", Comments.threadTitle(CommentCoach(2, "Sam Lee", active = false), true))
        assertEquals("Your coach", Comments.threadTitle(null, true))
        assertEquals("Your comments", Comments.threadTitle(CommentCoach(2, "Sam Lee", active = true), false))
        assertTrue(Comments.canReply(CommentCoach(2, active = true)))
        assertFalse(Comments.canReply(CommentCoach(2, active = false)))
        assertFalse(Comments.canReply(null))
        assertEquals("Commenting needs a connection.", Comments.commentError(null, null))
        assertTrue(Comments.commentError(429, null).contains("minute"))
        assertTrue(Comments.commentError(409, null).contains("as many comments"))
        assertTrue(Comments.commentError(404, null).contains("any more"))
        assertEquals("a comment can't be empty", Comments.commentError(400, "a comment can't be empty"))
    }

    @Test
    fun `when, until a date says it better`() {
        val now = 10 * 24 * 3_600_000L
        assertEquals("just now", Comments.commentWhen(now - 5000, now))
        assertEquals("5 min ago", Comments.commentWhen(now - 5 * 60_000, now))
        assertEquals("1 hour ago", Comments.commentWhen(now - 3_600_000, now))
        assertEquals("3 days ago", Comments.commentWhen(now - 3 * 86_400_000L, now))
        assertNull(Comments.commentWhen(now - 8 * 86_400_000L, now))
    }

    private fun feed(
        id: Int, author: CommentAuthor = CommentAuthor(2, "Sam Lee"), student: FeedStudent? = null,
        lapNum: Int? = 6, seen: Boolean = false,
    ) = FeedComment(
        id = id, coachId = 2, sessionId = 10, body = "c$id", createdAt = 0, author = author, mine = false, seen = seen,
        student = student, eventId = 3, trackName = "VIR", startDate = "2026-05-01", sessionLabel = "Session 2", lapNum = lapNum,
    )

    @Test
    fun `the feed's words`() {
        val mine = feed(1)
        val theirs = feed(2, CommentAuthor(9, "Alex R."), FeedStudent(9, "Alex R."), lapNum = null)
        assertEquals("Sam Lee commented on Lap 6 · VIR", Comments.feedLine(mine))
        assertEquals("Alex R. replied on Session 2 · VIR", Comments.feedLine(theirs))
        assertNull(Comments.unreadLine(CommentFeed(0, listOf(feed(1, seen = true)))))
        assertEquals("Sam Lee commented on Lap 6 · VIR", Comments.unreadLine(CommentFeed(1, listOf(mine))))
        assertEquals("2 new comments from Sam Lee", Comments.unreadLine(CommentFeed(2, listOf(mine, feed(5)))))
        assertEquals("2 new comments from 2 people", Comments.unreadLine(CommentFeed(2, listOf(mine, theirs))))
        assertEquals("60 new comments from Sam Lee", Comments.unreadLine(CommentFeed(60, listOf(mine))))
    }

    // ---- The fixture -----------------------------------------------------------

    private val json = Json { ignoreUnknownKeys = false }
    private val fixture: JsonObject =
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/comments.json").readText()).jsonObject

    private fun rows(name: String): List<Pair<JsonArray, JsonElement>> =
        fixture[name]!!.jsonArray.map { it.jsonObject["args"]!!.jsonArray to it.jsonObject["expected"]!! }

    private fun comments(e: JsonElement): List<CoachComment> =
        json.decodeFromJsonElement(ListSerializer(CoachComment.serializer()), e)

    private fun feedRow(e: JsonElement): FeedComment = json.decodeFromJsonElement(FeedComment.serializer(), e)

    private fun str(e: JsonElement): String? = if (e is JsonNull) null else e.jsonPrimitive.contentOrNull

    private fun units(e: JsonElement) = if (str(e) == "metric") UnitSystem.METRIC else UnitSystem.IMPERIAL

    private fun ids(e: JsonElement): List<Int> = e.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.int }

    private fun coach(e: JsonElement): CommentCoach? = if (e is JsonNull) null else e.jsonObject.let {
        CommentCoach(
            id = 0,
            name = it["name"]?.let(::str),
            active = it["active"]!!.jsonPrimitive.booleanOrNull!!,
        )
    }

    private fun count(e: JsonElement): Comments.Count? = if (e is JsonNull) null else e.jsonObject.let {
        Comments.Count(it["count"]!!.jsonPrimitive.int, it["unread"]!!.jsonPrimitive.int)
    }

    @Test
    fun `constants match the fixture`() {
        val k = fixture["constants"]!!.jsonObject
        assertEquals(k["COMMENT_MAX_CHARS"]!!.jsonPrimitive.int, Comments.COMMENT_MAX_CHARS)
        assertEquals(str(k["COMMENTS_HEADING"]!!), Comments.COMMENTS_HEADING)
        assertEquals(str(k["COMMENT_PLACEHOLDER"]!!), Comments.COMMENT_PLACEHOLDER)
        assertEquals(str(k["REPLY_PLACEHOLDER"]!!), Comments.REPLY_PLACEHOLDER)
        assertEquals(str(k["WHOLE_SESSION"]!!), Comments.WHOLE_SESSION)
        assertEquals(str(k["COMMENT_OFFLINE"]!!), Comments.COMMENT_OFFLINE)
        assertEquals(str(k["THREAD_CLOSED"]!!), Comments.THREAD_CLOSED)
        assertEquals(str(k["REPORT_LABEL"]!!), Comments.REPORT_LABEL)
        assertEquals(str(k["REPORT_EMAIL"]!!), Comments.REPORT_EMAIL)
    }

    @Test
    fun `commentLength matches the fixture`() {
        for ((args, expected) in rows("commentLength")) {
            assertEquals(expected.jsonPrimitive.int, Comments.commentLength(str(args[0])), args.toString())
        }
    }

    @Test
    fun `commentThreads matches the fixture`() {
        for ((args, expected) in rows("commentThreads")) {
            val want = expected.jsonArray.map {
                it.jsonObject["coach_id"]!!.jsonPrimitive.int to ids(it.jsonObject["comments"]!!)
            }
            assertEquals(want, Comments.commentThreads(comments(args[0])).map { it.coachId to it.comments.map { c -> c.id } })
        }
    }

    @Test
    fun `groupComments matches the fixture`() {
        for ((args, expected) in rows("groupComments")) {
            val s = args[1].jsonObject
            val laps = s["laps"]!!.jsonArray.map {
                val o = it.jsonObject
                Lap(o["id"]!!.jsonPrimitive.int, s["id"]!!.jsonPrimitive.int, o["lap_num"]!!.jsonPrimitive.int, o["time_ms"]!!.jsonPrimitive.int)
            }
            val got = Comments.groupComments(comments(args[0]), s["id"]!!.jsonPrimitive.int, laps)
            val e = expected.jsonObject
            assertEquals(ids(e["session"]!!), got.session.map { it.id })
            assertEquals(
                e["laps"]!!.jsonArray.map {
                    val o = it.jsonObject
                    listOf(o["lap_id"]!!.jsonPrimitive.int, o["lap_num"]!!.jsonPrimitive.int, o["time_ms"]!!.jsonPrimitive.int, ids(o["comments"]!!))
                },
                got.laps.map { listOf(it.lapId, it.lapNum, it.timeMs, it.comments.map { c -> c.id }) },
            )
        }
    }

    @Test
    fun `commentCounts and commentCountText match the fixture`() {
        for ((args, expected) in rows("commentCounts")) {
            val got = Comments.commentCounts(comments(args[0]))
            fun map(e: JsonElement) = e.jsonObject.mapKeys { it.key.toInt() }.mapValues { count(it.value)!! }
            assertEquals(map(expected.jsonObject["bySession"]!!), got.bySession)
            assertEquals(map(expected.jsonObject["byLap"]!!), got.byLap)
        }
        for ((args, expected) in rows("commentCountText")) {
            assertEquals(str(expected), Comments.commentCountText(count(args[0])))
        }
    }

    @Test
    fun `commentPlace matches the fixture`() {
        for ((args, expected) in rows("commentPlace")) {
            val cs = args[2].jsonArray.map {
                val o = it.jsonObject
                Corners.Corner(o["n"]!!.jsonPrimitive.int, o["k0"]!!.jsonPrimitive.int, o["k1"]!!.jsonPrimitive.int, 0.0, 0)
            }
            val got = Comments.commentPlace(args[0].jsonPrimitive.doubleOrNull, args[1].jsonPrimitive.double, cs, units(args[3]))
            assertEquals(str(expected), got, args.toString())
        }
    }

    @Test
    fun `placeFromCursor matches the fixture`() {
        for ((args, expected) in rows("placeFromCursor")) {
            val got = Comments.placeFromCursor(args[0].jsonPrimitive.double, args[1].jsonPrimitive.double)
            assertEquals(if (expected is JsonNull) null else expected.jsonPrimitive.int, got, args.toString())
        }
    }

    @Test
    fun `commentMarkers matches the fixture`() {
        for ((args, expected) in rows("commentMarkers")) {
            val got = Comments.commentMarkers(comments(args[0]), args[1].jsonPrimitive.int, args[2].jsonPrimitive.double)
            val want = expected.jsonArray.map {
                val o = it.jsonObject
                Comments.Marker(o["id"]!!.jsonPrimitive.int, o["frac"]!!.jsonPrimitive.double, o["mine"]!!.jsonPrimitive.booleanOrNull!!)
            }
            assertEquals(want, got, args.toString())
        }
    }

    @Test
    fun `the sentences match the fixture`() {
        for ((args, expected) in rows("canReply")) {
            assertEquals(expected.jsonPrimitive.booleanOrNull, Comments.canReply(coach(args[0])))
        }
        for ((args, expected) in rows("threadTitle")) {
            assertEquals(str(expected), Comments.threadTitle(coach(args[0]), args[1].jsonPrimitive.booleanOrNull!!))
        }
        for ((args, expected) in rows("coachAudienceNote")) {
            assertEquals(str(expected), Comments.coachAudienceNote(str(args[0])))
        }
        for ((args, expected) in rows("reportSubject")) {
            assertEquals(str(expected), Comments.reportSubject(args[0].jsonPrimitive.int))
        }
        for ((args, expected) in rows("reportBody")) {
            assertEquals(str(expected), Comments.reportBody(args[0].jsonPrimitive.int))
        }
        for ((args, expected) in rows("commentError")) {
            assertEquals(str(expected), Comments.commentError(args[0].jsonPrimitive.intOrNull, str(args[1])), args.toString())
        }
        for ((args, expected) in rows("commentWhen")) {
            assertEquals(str(expected), Comments.commentWhen(args[0].jsonPrimitive.long, args[1].jsonPrimitive.long), args.toString())
        }
    }

    @Test
    fun `the feed's words match the fixture`() {
        for ((args, expected) in rows("feedLine")) {
            assertEquals(str(expected), Comments.feedLine(feedRow(args[0])))
        }
        for ((args, expected) in rows("unreadLine")) {
            val feed = if (args[0] is JsonNull) null else args[0].jsonObject.let {
                CommentFeed(it["unread"]!!.jsonPrimitive.int, it["comments"]!!.jsonArray.map(::feedRow))
            }
            assertEquals(str(expected), Comments.unreadLine(feed), args.toString())
        }
    }
}
