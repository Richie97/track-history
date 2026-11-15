package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Coach comments on sessions and laps (NS-52,
// docs/specs/native/NS-52-coach-comments.md).
//
// Pinned by the golden contract from the server PR on; the Android screens
// (ticket 3) read them. A comment sits in one coach's private thread
// ([coachId]) on a session, a lap of it ([lapId]) or a place on that lap
// ([distM], whole metres from the start/finish line).

@Serializable
public data class CommentAuthor(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
)

@Serializable
public data class CoachComment(
    @SerialName("id") val id: Int,
    /** Whose thread this is — not necessarily who wrote it. */
    @SerialName("coach_id") val coachId: Int,
    @SerialName("session_id") val sessionId: Int,
    @SerialName("lap_id") val lapId: Int? = null,
    @SerialName("dist_m") val distM: Int? = null,
    @SerialName("body") val body: String,
    @SerialName("created_at") val createdAt: Long,
    @SerialName("edited_at") val editedAt: Long? = null,
    @SerialName("author") val author: CommentAuthor,
    /** The caller wrote it. */
    @SerialName("mine") val mine: Boolean,
    /**
     * Its one reader has read it: the read receipt on a comment the caller
     * wrote, the caller's own unread mark on any other.
     */
    @SerialName("seen") val seen: Boolean,
)

/** A thread's coach, and whether they can still read it (a closed thread takes no reply). */
@Serializable
public data class CommentCoach(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
    @SerialName("active") val active: Boolean,
)

/**
 * `GET /api/events/:id/comments` (the owner: every thread, with [coaches]) and
 * `GET /api/coaching/students/:sid/events/:eid/comments` (a coach: their own
 * thread, no [coaches]).
 */
@Serializable
public data class EventComments(
    @SerialName("comments") val comments: List<CoachComment>,
    @SerialName("coaches") val coaches: List<CommentCoach>? = null,
)

/** A comment created (201) or edited. */
@Serializable
public data class CommentSaved(
    @SerialName("comment") val comment: CoachComment,
)

/** `POST …/comments/seen`: how many it marked read. */
@Serializable
public data class CommentsSeen(
    @SerialName("ok") val ok: Boolean,
    @SerialName("seen") val seen: Int,
)

@Serializable
public data class FeedStudent(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
)

/** One row of the feed: a comment plus where it is. */
@Serializable
public data class FeedComment(
    @SerialName("id") val id: Int,
    @SerialName("coach_id") val coachId: Int,
    @SerialName("session_id") val sessionId: Int,
    @SerialName("lap_id") val lapId: Int? = null,
    @SerialName("dist_m") val distM: Int? = null,
    @SerialName("body") val body: String,
    @SerialName("created_at") val createdAt: Long,
    @SerialName("edited_at") val editedAt: Long? = null,
    @SerialName("author") val author: CommentAuthor,
    @SerialName("mine") val mine: Boolean,
    @SerialName("seen") val seen: Boolean,
    /** Null on the caller's own logbook; otherwise the student whose logbook it is. */
    @SerialName("student") val student: FeedStudent? = null,
    @SerialName("event_id") val eventId: Int,
    @SerialName("track_name") val trackName: String? = null,
    @SerialName("start_date") val startDate: String,
    @SerialName("session_label") val sessionLabel: String? = null,
    @SerialName("lap_num") val lapNum: Int? = null,
)

/** `GET /api/coaching/comments`: what was said to the caller, newest first. */
@Serializable
public data class CommentFeed(
    @SerialName("unread") val unread: Int,
    @SerialName("comments") val comments: List<FeedComment>,
)
