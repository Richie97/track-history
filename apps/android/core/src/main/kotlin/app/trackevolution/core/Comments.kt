package app.trackevolution.core

import app.trackevolution.core.model.CoachComment
import app.trackevolution.core.model.CommentCoach
import app.trackevolution.core.model.CommentFeed
import app.trackevolution.core.model.FeedComment
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.UnitSystem

/**
 * Coach comments on sessions and laps (NS-52): the pure half — how a thread is
 * grouped and ordered, where a placed comment is, and every fixed sentence, so
 * no client words one differently. The port of `public/js/comments.js` under
 * the same names, pinned case for case by `contracts/logic/comments.json` (the
 * fixture the iOS Kit asserts against too).
 *
 * Dateless in the way ported logic here is: anything that says a calendar
 * date takes the client's own formatter.
 *
 * Not to be confused with `model.EventComments` and friends, the responses.
 */
public object Comments {

    /**
     * Mirrors `COMMENT_MAX_CHARS` in `src/lib/comments.ts` — code points, after
     * trimming.
     */
    public const val COMMENT_MAX_CHARS: Int = 1000

    private const val MIN_MS: Long = 60L * 1000
    private const val HOUR_MS: Long = 60 * MIN_MS
    private const val DAY_MS: Long = 24 * HOUR_MS

    private fun plural(n: Long, one: String, many: String = "${one}s"): String =
        "$n ${if (n == 1L) one else many}"

    /** How many characters a draft is, the way the server counts them. */
    public fun commentLength(text: String?): Int {
        val s = (text ?: "").replace(Regex("\r\n?"), "\n").let(::jsTrim)
        return s.codePointCount(0, s.length)
    }

    /**
     * JavaScript's `String.prototype.trim`: whitespace and line terminators,
     * which for the drafts a phone can produce is what Kotlin's `trim()` takes
     * too — spelled out so a port reader can see the rule.
     */
    private fun jsTrim(s: String): String = s.trim { it.isWhitespace() || it == '﻿' }

    /** One coach's thread. */
    public data class Thread(val coachId: Int, val comments: List<CoachComment>)

    /**
     * The comments on an event split into one thread per coach, in the order
     * each coach first spoke. A coach's own read holds one thread; the owner's
     * holds one per coach who has commented.
     */
    public fun commentThreads(comments: List<CoachComment>?): List<Thread> {
        val byCoach = LinkedHashMap<Int, MutableList<CoachComment>>()
        for (c in comments.orEmpty()) byCoach.getOrPut(c.coachId) { mutableListOf() }.add(c)
        return byCoach.map { (coachId, list) -> Thread(coachId, list) }
    }

    private val byTime = compareBy<CoachComment>({ it.createdAt }, { it.id })

    /** One lap's comments within [Grouped]. */
    public data class LapComments(
        val lapId: Int,
        val lapNum: Int,
        val timeMs: Int,
        val comments: List<CoachComment>,
    )

    /** [groupComments]'s answer: the whole-session comments, then each lap's. */
    public data class Grouped(val session: List<CoachComment>, val laps: List<LapComments>)

    /**
     * One session's comments in reading order: what was said about the whole
     * session first, then each lap's in lap order — a lap's own by place along
     * the lap (an unplaced one last), then by time. A comment whose lap is no
     * longer in the session is left out.
     */
    public fun groupComments(comments: List<CoachComment>?, sessionId: Int, laps: List<Lap>): Grouped {
        val mine = comments.orEmpty().filter { it.sessionId == sessionId }
        val out = laps.mapNotNull { lap ->
            val list = mine.filter { it.lapId == lap.id }.sortedWith(
                compareBy<CoachComment> { it.distM?.toDouble() ?: Double.POSITIVE_INFINITY }.then(byTime),
            )
            if (list.isEmpty()) null else LapComments(lap.id, lap.lapNum, lap.timeMs, list)
        }
        return Grouped(mine.filter { it.lapId == null }.sortedWith(byTime), out)
    }

    /** [groupComments] over a session's own laps. */
    public fun groupComments(comments: List<CoachComment>?, session: Session): Grouped =
        groupComments(comments, session.id, session.laps)

    /** How many comments, and how many of them the viewer has not read. */
    public data class Count(val count: Int, val unread: Int)

    /** [commentCounts]'s answer, keyed by session id and by lap id. */
    public data class Counts(val bySession: Map<Int, Count>, val byLap: Map<Int, Count>)

    /**
     * Counts for the markers: per session and per lap, each with how many the
     * viewer has not read. A row the viewer wrote is never unread to them.
     */
    public fun commentCounts(comments: List<CoachComment>?): Counts {
        val bySession = LinkedHashMap<Int, Count>()
        val byLap = LinkedHashMap<Int, Count>()
        fun bump(into: MutableMap<Int, Count>, key: Int, c: CoachComment) {
            val at = into[key] ?: Count(0, 0)
            into[key] = Count(at.count + 1, at.unread + if (!c.mine && !c.seen) 1 else 0)
        }
        for (c in comments.orEmpty()) {
            bump(bySession, c.sessionId, c)
            c.lapId?.let { bump(byLap, it, c) }
        }
        return Counts(bySession, byLap)
    }

    /** What a lap's marker says aloud: "2 comments, 1 unread". */
    public fun commentCountText(count: Count?): String {
        if (count == null || count.count == 0) return ""
        val unread = if (count.unread != 0) ", ${count.unread} unread" else ""
        return "${plural(count.count.toLong(), "comment")}$unread"
    }

    /**
     * Where a placed comment is, in the reader's units and the session's own
     * corner numbering: "in T4 · 1.24 km". [corners] is `Corners.sessionCorners`
     * — derived when it is drawn, never stored. The distance alone without
     * corners; null with no place.
     */
    public fun commentPlace(
        distM: Double?,
        dStepM: Double,
        corners: List<Corners.Corner>?,
        units: UnitSystem,
    ): String? {
        if (distM == null || !distM.isFinite()) return null
        val dist = Units.fmtDist(java.lang.Math.round(distM).toDouble(), units)
        val where = if (dStepM > 0) VideoSync.cornerPlace(corners, distM / dStepM) else null
        return if (where != null) "$where · $dist" else dist
    }

    /**
     * The place a cursor at fractional grid index [k] is, as a comment stores
     * it: whole metres from the line. `Math.round`, ties toward +infinity, as
     * `java.lang.Math.round` does.
     */
    public fun placeFromCursor(k: Double?, dStepM: Double): Int? {
        if (k == null || !k.isFinite() || !(dStepM > 0)) return null
        return maxOf(0L, java.lang.Math.round(k * dStepM)).toInt()
    }

    /** One placed comment's mark along its lap: [frac] of the lap's own length. */
    public data class Marker(val id: Int, val frac: Double, val mine: Boolean)

    /**
     * A lap's placed comments as marks along it, clamped — a place past the
     * end of a lap that was re-imported shorter still marks its end.
     */
    public fun commentMarkers(comments: List<CoachComment>?, lapId: Int, lapLengthM: Double): List<Marker> {
        if (!(lapLengthM > 0)) return emptyList()
        return comments.orEmpty()
            .filter { it.distM != null && it.lapId == lapId }
            .map { Marker(it.id, (it.distM!! / lapLengthM).coerceIn(0.0, 1.0), it.mine) }
            .sortedWith(compareBy<Marker>({ it.frac }, { it.id }))
    }

    /** A thread takes a reply only while its coach still has access. */
    public fun canReply(coach: CommentCoach?): Boolean = coach?.active == true

    /** A thread's heading. The owner sees whose it is; the coach sees their own. */
    public fun threadTitle(coach: CommentCoach?, isOwner: Boolean): String {
        if (!isOwner) return "Your comments"
        val name = coach?.name?.takeIf { it.isNotEmpty() } ?: "Your coach"
        return if (coach != null && !coach.active) "$name · no longer your coach" else name
    }

    public const val COMMENTS_HEADING: String = "Comments"
    public const val COMMENT_PLACEHOLDER: String = "Add a comment…"
    public const val REPLY_PLACEHOLDER: String = "Reply…"
    public const val WHOLE_SESSION: String = "Whole session"
    public const val COMMENT_OFFLINE: String = "Commenting needs a connection."
    public const val THREAD_CLOSED: String =
        "They no longer have access to your logbook, so this thread is closed."

    /** What a coach is told before the first comment: who reads it. */
    public fun coachAudienceNote(studentName: String?): String =
        "Only you and ${studentName?.takeIf { it.isNotEmpty() } ?: "this driver"} see what you write here."

    public const val REPORT_LABEL: String = "Report"
    public const val REPORT_EMAIL: String = "eric@speedshift.io"

    public fun reportSubject(commentId: Int): String = "Report a comment (#$commentId)"

    public fun reportBody(commentId: Int): String =
        "I'd like to report comment #$commentId on Track Evolution.\n\nWhat's wrong with it:\n"

    /**
     * What a failed send says. [status] is the server's, null when the request
     * never got an answer.
     */
    public fun commentError(status: Int?, message: String?): String = when (status) {
        null -> COMMENT_OFFLINE
        429 -> "Too many comments at once — try again in a minute."
        409 -> "This session has as many comments as it can hold."
        404 -> "That can't be commented on any more — the session or the coaching link is gone."
        else -> message?.takeIf { it.isNotEmpty() } ?: "Couldn't send that comment."
    }

    /**
     * When a comment was written, in words while it is recent; null once it is
     * old enough that the client should say the date.
     */
    public fun commentWhen(createdAt: Long, now: Long): String? {
        val ago = maxOf(0L, now - createdAt)
        return when {
            ago < MIN_MS -> "just now"
            ago < HOUR_MS -> "${ago / MIN_MS} min ago"
            ago < DAY_MS -> "${plural(ago / HOUR_MS, "hour")} ago"
            ago < 7 * DAY_MS -> "${plural(ago / DAY_MS, "day")} ago"
            else -> null
        }
    }

    /** What a feed row is about: "Lap 6 · VIR" or "Session 2 · VIR". */
    public fun feedTarget(row: FeedComment): String {
        val what = if (row.lapNum != null) "Lap ${row.lapNum}" else row.sessionLabel?.takeIf { it.isNotEmpty() } ?: "a session"
        val track = row.trackName?.takeIf { it.isNotEmpty() }
        return if (track != null) "$what · $track" else what
    }

    /**
     * One feed row's line. On your own logbook a coach commented; on a
     * student's, the student replied.
     */
    public fun feedLine(row: FeedComment): String {
        val who = row.author.name?.takeIf { it.isNotEmpty() } ?: if (row.student != null) "Your student" else "Your coach"
        return "$who ${if (row.student != null) "replied on" else "commented on"} ${feedTarget(row)}"
    }

    /**
     * The dashboard card's one line over the feed (`GET /coaching/comments`),
     * or null with nothing unread: the comment itself when there is one, a
     * count when there are more.
     */
    public fun unreadLine(feed: CommentFeed?): String? {
        val unread = feed?.comments.orEmpty().filter { !it.seen }
        val n = maxOf(feed?.unread ?: 0, unread.size)
        if (n == 0) return null
        if (n == 1 && unread.size == 1) return feedLine(unread[0])
        val people = unread.map { it.author.id }.toSet()
        val only = if (people.size == 1) unread[0].author.name?.takeIf { it.isNotEmpty() } else null
        val from = when {
            only != null -> " from $only"
            people.size > 1 -> " from ${people.size} people"
            else -> ""
        }
        return "$n new comments$from"
    }
}
