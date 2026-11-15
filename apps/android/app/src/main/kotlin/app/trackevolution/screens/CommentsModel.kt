package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.Comments
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.model.CoachComment
import app.trackevolution.core.model.CommentCoach
import app.trackevolution.core.model.EventComments
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Coach comments on one event's sessions and laps (NS-52), for whichever
 * screen shows them — the event page, a lap, the session composer.
 *
 * **The read-only exception.** In a student's logbook every screen reads
 * through the scoped client, which refuses every write. Comments are the one
 * write a coach makes there, so every call here goes through the comment
 * routes on [ApiClient], which always use the account's own client
 * (`ApiClient.own`) whatever view they are called on. Nothing else on the page
 * gains a write: `readOnly` still hides every other control.
 *
 * **Drafts survive.** The typed text, the lap it is about and its place are
 * kept in the destination's [SavedStateHandle], keyed by target ([key]), so a
 * rotation, a fold or the two-pane swap keeps them — and so does a failed
 * send: nothing is cleared until the server has said 201. Every write is live
 * and never queued (the comment routes are off the offline whitelist), so a
 * send with no connection is "Commenting needs a connection." and the draft
 * waits for another try.
 */
class CommentsModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    /** Whose logbook — the account's own, or a student's read by their coach. */
    val owner: LogbookOwner,
    eventId: Int,
    private val saved: SavedStateHandle? = null,
) {
    var eventId: Int = eventId
        private set

    var data by mutableStateOf<EventComments?>(null)
        private set

    /** Set when the read failed with nothing to show — the block then says nothing. */
    var loadFailed by mutableStateOf(false)
        private set

    val isOwner: Boolean get() = owner == LogbookOwner.Me

    val comments: List<CoachComment> get() = data?.comments.orEmpty()

    /** The owner's coaches with a thread here; empty for a coach. */
    val coaches: List<CommentCoach> get() = data?.coaches.orEmpty()

    val counts: Comments.Counts get() = Comments.commentCounts(comments)

    fun coach(id: Int): CommentCoach? = coaches.firstOrNull { it.id == id }

    /** The draft target currently sending, so its button can stand down. */
    var sending by mutableStateOf<String?>(null)
        private set

    /** A failed send's words, by draft target, until the next try. */
    val errors = mutableStateMapOf<String, String>()

    private var seenPosted = false

    /** The server's answer to `/seen`, for the badge's sake; 0 until one. */
    var seenCount by mutableStateOf(0)
        private set

    fun load() {
        scope.launch {
            try {
                data = api.eventComments(owner, eventId)
                loadFailed = false
            } catch (_: ApiException) {
                if (data == null) loadFailed = true
            }
        }
    }

    /** An offline-created event whose id arrived: read it under the real one. */
    fun follow(realId: Int) {
        if (realId == eventId) return
        eventId = realId
        load()
    }

    /**
     * Tell the server the thread on screen has been read — once per model,
     * and only when something here is unread. The rows keep their unread look
     * for this visit, so what is new is still visible as new.
     */
    fun markSeen() {
        if (seenPosted) return
        if (comments.none { !it.mine && !it.seen }) return
        seenPosted = true
        scope.launch {
            try {
                seenCount = api.markCommentsSeen(owner, eventId).seen
                // Every surface's count follows at once, then settles on the
                // server's own figure.
                CommentsBadge.noteSeen(eventId, (owner as? LogbookOwner.Student)?.id, seenCount)
                runCatching { api.commentFeed() }.getOrNull()?.let(CommentsBadge::note)
            } catch (_: ApiException) {
                seenPosted = false
            }
        }
    }

    // ---- drafts ------------------------------------------------------------------

    private val texts = mutableStateMapOf<String, String>()
    private val places = mutableStateMapOf<String, Int?>()
    private val laps = mutableStateMapOf<String, Int?>()

    fun draft(key: String): String = if (key in texts) texts[key].orEmpty() else saved?.get<String>("draft:$key") ?: ""

    fun setDraft(key: String, text: String) {
        texts[key] = text
        saved?.set("draft:$key", text)
        errors.remove(key)
    }

    /** Whole metres from the line on [lap], or null for no place. */
    fun place(key: String): Int? = if (key in places) places[key] else saved?.get<Int>("place:$key")

    fun setPlace(key: String, distM: Int?) {
        places[key] = distM
        saved?.set("place:$key", distM)
    }

    /** The lap a session composer is about; null is the whole session. */
    fun lap(key: String): Int? = if (key in laps) laps[key] else saved?.get<Int>("lap:$key")

    fun setLap(key: String, lapId: Int?) {
        if (lap(key) != lapId) setPlace(key, null) // a place belongs to the lap it was marked on
        laps[key] = lapId
        saved?.set("lap:$key", lapId)
    }

    // ---- writes ------------------------------------------------------------------

    /**
     * Sends [key]'s draft as a comment on [sessionId] — about [lapId] at its
     * [place] when given. On the owner's logbook it is a reply into [coachId]'s
     * thread. [onSent] runs after the 201, once the draft is cleared.
     */
    fun send(key: String, sessionId: Int, coachId: Int?, lapId: Int?, onSent: () -> Unit = {}) {
        val body = draft(key).trim()
        if (body.isEmpty() || sending != null) return
        if (Comments.commentLength(body) > Comments.COMMENT_MAX_CHARS) {
            errors[key] = "A comment can be at most ${"%,d".format(Comments.COMMENT_MAX_CHARS)} characters."
            return
        }
        val distM = if (lapId != null) place(key) else null
        sending = key
        errors.remove(key)
        scope.launch {
            try {
                api.postComment(owner, sessionId, body, lapId = lapId, distM = distM, coachId = coachId)
                setDraft(key, "")
                setPlace(key, null)
                sending = null
                onSent()
                load()
            } catch (e: ApiException) {
                sending = null
                errors[key] = Comments.commentError(e.status, e.message)
            }
        }
    }

    /** The comment being edited in place, by id — saved, so a rotation keeps the edit open. */
    var editing: Int?
        get() = editingState
        set(value) {
            editingState = value
            saved?.set("editing", value)
        }
    private var editingState by mutableStateOf(saved?.get<Int>("editing"))

    fun startEdit(c: CoachComment) {
        editing = c.id
        if (draft("edit:${c.id}").isEmpty()) setDraft("edit:${c.id}", c.body)
    }

    fun cancelEdit() {
        editing?.let { setDraft("edit:$it", "") }
        editing = null
    }

    fun saveEdit(id: Int) {
        val key = "edit:$id"
        val body = draft(key).trim()
        if (body.isEmpty() || sending != null) return
        sending = key
        scope.launch {
            try {
                api.editComment(id, body)
                setDraft(key, "")
                editing = null
                sending = null
                load()
            } catch (e: ApiException) {
                sending = null
                errors[key] = Comments.commentError(e.status, e.message)
            }
        }
    }

    /** The error a failed delete or block left, shown at the head of the block. */
    var actionError by mutableStateOf<String?>(null)
        private set

    fun delete(id: Int) {
        scope.launch {
            try {
                api.deleteComment(id)
                actionError = null
                load()
            } catch (e: ApiException) {
                actionError = Comments.commentError(e.status, e.message)
            }
        }
    }

    /**
     * The block control (Play's UGC policy): the owner removes a coach, which
     * ends their access and closes the thread; a coach stops coaching, after
     * which [onGone] takes them out of a logbook they can no longer read.
     */
    fun block(coachId: Int?, onGone: () -> Unit = {}) {
        scope.launch {
            try {
                when (owner) {
                    LogbookOwner.Me -> api.own.removeCoach(coachId ?: return@launch)
                    is LogbookOwner.Student -> {
                        api.own.leaveStudent(owner.id)
                        api.own.forgetStudent(owner.id)
                    }
                }
                actionError = null
                if (owner is LogbookOwner.Student) onGone() else load()
            } catch (e: ApiException) {
                actionError = e.message ?: "Couldn't do that."
            }
        }
    }

    companion object {
        /** The draft target of a session's composer: one per thread. */
        fun sessionKey(sessionId: Int, coachId: Int?): String = "s$sessionId:${coachId ?: "me"}"

        /** The draft target of a lap's composer: one per thread per lap. */
        fun lapKey(sessionId: Int, lapId: Int, coachId: Int?): String = "s$sessionId:l$lapId:${coachId ?: "me"}"
    }
}
