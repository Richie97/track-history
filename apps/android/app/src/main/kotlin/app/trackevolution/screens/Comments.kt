package app.trackevolution.screens

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import app.trackevolution.ui.charts.CommentMark
import app.trackevolution.core.ChannelGraphs
import androidx.compose.runtime.remember
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.State
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import app.trackevolution.push.CommentPushAsk
import app.trackevolution.push.CommentPushOffer
import app.trackevolution.push.LocalCommentPush
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Comments
import app.trackevolution.core.Corners
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.CoachComment
import app.trackevolution.core.model.CommentCoach
import app.trackevolution.core.model.CommentFeed
import app.trackevolution.core.model.FeedComment
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import java.time.Instant
import java.time.ZoneId

// Coach comments on sessions and laps (NS-52): the cards, the composer and the
// threads, shared by the event page, the lap page and the session composer.
// Every sentence comes from `Comments` in `:core` — the port of
// `public/js/comments.js` — so no client words one differently.

/** When a comment was written: "2 hours ago" while recent, then the date. */
internal fun commentWhenText(createdAt: Long, now: Long): String =
    Comments.commentWhen(createdAt, now)
        ?: EventDates.fmtDate(Instant.ofEpochMilli(createdAt).atZone(ZoneId.systemDefault()).toLocalDate().toString())

/** Where a placed comment is on [session]: "in T4 · 1.24 km", or null for no place. */
internal fun commentPlaceText(c: CoachComment, session: Session?, units: UnitSystem): String? {
    val dist = c.distM ?: return null
    val channels = session?.channels
    val corners = channels?.let { runCatching { Corners.sessionCorners(it) }.getOrNull() }
    return Comments.commentPlace(dist.toDouble(), channels?.dStepM ?: 0.0, corners, units)
}

/**
 * What *Report* does (NS-52; App Review 1.2 and Play's UGC policy): a mail to
 * the operator naming the comment, in the web's words. Nothing is sent until
 * the reporter sends it.
 */
internal fun reportComment(context: Context, commentId: Int) {
    val uri = Uri.parse(
        "mailto:${Comments.REPORT_EMAIL}?subject=${Uri.encode(Comments.reportSubject(commentId))}" +
            "&body=${Uri.encode(Comments.reportBody(commentId))}",
    )
    runCatching {
        context.startActivity(Intent(Intent.ACTION_SENDTO, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** What one comment card says aloud — the whole card is one element. */
internal fun commentSpoken(c: CoachComment, place: String?, now: Long): String = buildString {
    append(if (c.mine) "You" else c.author.name ?: "Someone")
    append(", ")
    append(commentWhenText(c.createdAt, now))
    if (c.editedAt != null) append(", edited")
    if (place != null) append(", at $place")
    if (c.mine && c.seen) append(", seen")
    if (!c.mine && !c.seen) append(", unread")
    append(": ")
    append(c.body)
}

/**
 * One comment: who, when, where on the lap, and what was said — with the
 * controls its reader may use. **One accessibility element** with named
 * actions (*Show on lap*, *Reply*, *Edit*, *Delete*, *Report*, and the block
 * control), the chart-card rule: the same functions the visible buttons call.
 *
 * *Report* is on every comment someone else wrote, and the block control —
 * *Remove coach* for the owner, *Stop coaching* for a coach — beside it:
 * Play's user-generated-content policy asks for both in the build that shows
 * another person's words.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CommentCard(
    c: CoachComment,
    model: CommentsModel,
    place: String?,
    now: Long,
    modifier: Modifier = Modifier,
    /** Move the stage or the panel's cursor to this comment's place. Null hides it. */
    onShowOnLap: (() -> Unit)? = null,
    /** Focus this thread's composer. Null hides it. */
    onReply: (() -> Unit)? = null,
    /** The block control's words and action; null hides it. */
    block: Pair<String, () -> Unit>? = null,
) {
    val colors = TrackTheme.colors
    val context = LocalContext.current
    val canDelete = c.mine || model.isOwner
    var confirmDelete by rememberSaveable(c.id) { mutableStateOf(false) }
    var confirmBlock by rememberSaveable(c.id) { mutableStateOf(false) }

    if (model.editing == c.id && c.mine) {
        CommentEditor(c, model, modifier)
        return
    }
    val report = { reportComment(context, c.id) }
    val actions = buildList {
        onShowOnLap?.let { add(CustomAccessibilityAction("Show on lap") { it(); true }) }
        onReply?.let { add(CustomAccessibilityAction("Reply") { it(); true }) }
        if (c.mine) add(CustomAccessibilityAction("Edit") { model.startEdit(c); true })
        if (canDelete) add(CustomAccessibilityAction("Delete") { confirmDelete = true; true })
        if (!c.mine) add(CustomAccessibilityAction(Comments.REPORT_LABEL) { report(); true })
        if (!c.mine && block != null) add(CustomAccessibilityAction(block.first) { confirmBlock = true; true })
    }
    val spoken = commentSpoken(c, place, now)
    val unread = !c.mine && !c.seen
    TrackCard(
        modifier
            .fillMaxWidth()
            .testTag("comment-${c.id}")
            .clearAndSetSemantics {
                contentDescription = spoken
                customActions = actions
            },
        color = if (unread) colors.accentTint else null,
        contentPadding = 12.dp,
    ) {
        val meta = listOfNotNull(
            if (c.mine) "You" else c.author.name ?: "Someone",
            commentWhenText(c.createdAt, now) + if (c.editedAt != null) " · edited" else "",
            if (c.mine && c.seen) "seen" else null,
            if (unread) "new" else null,
        ).joinToString(" · ")
        Text(meta, style = TrackTheme.typography.xs, color = colors.textMuted)
        if (place != null) {
            Text(
                "◆ $place",
                style = TrackTheme.typography.xs,
                color = if (onShowOnLap != null) colors.accentInk else colors.textMuted,
                modifier = if (onShowOnLap != null) Modifier.clickable(onClick = onShowOnLap) else Modifier,
            )
        }
        Text(c.body, style = TrackTheme.typography.sm, color = colors.textStrong, modifier = Modifier.padding(top = 2.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            if (onReply != null) SmallAction("Reply", onClick = onReply)
            if (c.mine) SmallAction("Edit") { model.startEdit(c) }
            if (canDelete) SmallAction("Delete") { confirmDelete = true }
            if (!c.mine) SmallAction(Comments.REPORT_LABEL, onClick = report)
            if (!c.mine && block != null) SmallAction(block.first) { confirmBlock = true }
        }
    }
    if (confirmDelete) {
        TEConfirmDialog(
            text = "Delete this comment?",
            confirm = "Delete",
            onConfirm = { confirmDelete = false; model.delete(c.id) },
            onDismiss = { confirmDelete = false },
        )
    }
    if (confirmBlock && block != null) {
        TEConfirmDialog(
            text = if (model.isOwner) {
                "Remove ${c.author.name ?: "this coach"}? They lose access to your logbook, and this thread closes. Their comments stay."
            } else {
                "Stop coaching? You lose access to this logbook and these comments."
            },
            confirm = block.first,
            onConfirm = { confirmBlock = false; block.second() },
            onDismiss = { confirmBlock = false },
        )
    }
}

@Composable
private fun SmallAction(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Text(label, style = TrackTheme.typography.xs, color = TrackTheme.colors.accentInk)
    }
}

/** A comment being edited in place: its text, Save and Cancel. */
@Composable
private fun CommentEditor(c: CoachComment, model: CommentsModel, modifier: Modifier) {
    val colors = TrackTheme.colors
    val key = "edit:${c.id}"
    TrackCard(modifier.fillMaxWidth().testTag("commentEdit-${c.id}"), contentPadding = 12.dp) {
        OutlinedTextField(
            value = model.draft(key),
            onValueChange = { model.setDraft(key, it) },
            label = { Text("Edit your comment", style = TrackTheme.typography.xs) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth().testTag("commentEditField"),
        )
        model.errors[key]?.let { Text(it, style = TrackTheme.typography.xs, color = colors.danger) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(
                onClick = { model.saveEdit(c.id) },
                enabled = model.draft(key).isNotBlank() && model.sending != key,
                modifier = Modifier.testTag("commentEditSave"),
            ) { Text("Save", style = TrackTheme.typography.sm, color = colors.accentInk) }
            TextButton(onClick = model::cancelEdit) {
                Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
        }
    }
}

/**
 * The composer's text box and send, with [extra] (a lap picker, a place chip)
 * between them. The draft is the model's, so it survives rotation and a
 * failed send keeps it.
 */
@Composable
fun CommentComposer(
    model: CommentsModel,
    key: String,
    sendLabel: String,
    placeholder: String,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    extra: @Composable () -> Unit = {},
) {
    val colors = TrackTheme.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            value = model.draft(key),
            onValueChange = { model.setDraft(key, it) },
            placeholder = { Text(placeholder, style = TrackTheme.typography.sm) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth().testTag("commentField"),
        )
        extra()
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onSend,
                enabled = model.draft(key).isNotBlank() && model.sending == null,
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
                modifier = Modifier.testTag("commentSend"),
            ) { Text(sendLabel, style = TrackTheme.typography.bodyStrong) }
            val n = Comments.commentLength(model.draft(key))
            if (n > Comments.COMMENT_MAX_CHARS - 100) {
                Text(
                    "$n / ${Comments.COMMENT_MAX_CHARS}",
                    style = TrackTheme.typography.xxs,
                    color = if (n > Comments.COMMENT_MAX_CHARS) colors.danger else colors.textFaint,
                )
            }
        }
        model.errors[key]?.let {
            Text(it, style = TrackTheme.typography.xs, color = colors.danger, modifier = Modifier.testTag("commentError"))
        }
    }
}

/** The block control for a thread: the owner removes its coach, a coach stops coaching. */
private fun blockFor(model: CommentsModel, coachId: Int?, onGone: () -> Unit): Pair<String, () -> Unit> =
    if (model.isOwner) "Remove coach" to { model.block(coachId) } else "Stop coaching" to { model.block(null, onGone) }

/**
 * The threads a target shows: for a coach, their own — always, empty or not,
 * since it is where they start; for the owner, one per coach who has spoken
 * here, plus (with [withOpenCoaches]) an empty one for each other coach whose
 * thread on this event is still open, so a reply can start on a lap that has
 * nothing on it yet. The owner never opens a thread with a coach who has not
 * written on the event (NS-52: the owner replies).
 */
private fun threadsOf(
    model: CommentsModel,
    mine: List<CoachComment>,
    withOpenCoaches: Boolean = false,
): List<Comments.Thread> {
    if (!model.isOwner) return listOf(Comments.Thread(coachId = -1, comments = mine))
    val spoken = Comments.commentThreads(mine)
    if (!withOpenCoaches) return spoken
    val have = spoken.map { it.coachId }.toSet()
    return spoken + model.coaches.filter { it.active && it.id !in have }.map { Comments.Thread(it.id, emptyList()) }
}

/**
 * The in-context notification ask (NS-54) under a thread, when
 * [CommentPushAsk.shouldOffer] says it means something here: the owner has a
 * coach's comment in [comments], or a coach has sent one. Named for the other
 * person — the coach who spoke, or the student.
 */
@Composable
private fun PushOfferFor(model: CommentsModel, comments: List<CoachComment>, studentName: String?) {
    val push = LocalCommentPush.current
    val enabled by push.enabled.collectAsState()
    val asked by push.asked.collectAsState()
    val theirs = comments.firstOrNull { !it.mine }
    if (!CommentPushAsk.shouldOffer(model.isOwner, theirs != null, comments.any { it.mine }, enabled, asked)) return
    CommentPushOffer(
        name = if (model.isOwner) theirs?.author?.name else studentName,
        modifier = Modifier.padding(top = 6.dp),
    )
}

/**
 * A session card's comments on the event page (NS-52): each thread's
 * whole-session comments and, inline under them, its composer — a text box
 * and a row of chips for what the comment is about (*Whole session* or a lap),
 * its draft in the destination's saved state, keyed by thread. Collapsed to a
 * button until it is opened or holds a draft. A lap's comments are on the
 * lap's page; its row here carries the count.
 *
 * The owner sees nothing until a coach has spoken (the owner replies, and does
 * not open a thread); a coach always has their thread, empty or not.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SessionComments(
    session: Session,
    model: CommentsModel,
    /** A coach who stops coaching is taken out of the logbook. */
    onGone: () -> Unit = {},
    studentName: String? = null,
) {
    val colors = TrackTheme.colors
    val data = model.data ?: return
    val mine = data.comments.filter { it.sessionId == session.id }
    val threads = threadsOf(model, mine)
    if (threads.isEmpty()) return
    val now = System.currentTimeMillis()
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).testTag("sessionComments-${session.id}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(Comments.COMMENTS_HEADING, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        for (t in threads) {
            val coach: CommentCoach? = if (model.isOwner) model.coach(t.coachId) else null
            val coachId = if (model.isOwner) t.coachId else null
            val open = if (model.isOwner) Comments.canReply(coach) else true
            val key = CommentsModel.sessionKey(session.id, coachId)
            var composing by rememberSaveable(key) { mutableStateOf(false) }
            Text(Comments.threadTitle(coach, model.isOwner), style = TrackTheme.typography.xs, color = colors.textMuted)
            val g = Comments.groupComments(t.comments, session)
            if (!model.isOwner && t.comments.isEmpty()) {
                Text(Comments.coachAudienceNote(studentName), style = TrackTheme.typography.xs, color = colors.textFaint)
            }
            for (c in g.session) {
                CommentCard(
                    c = c,
                    model = model,
                    place = null,
                    now = now,
                    onReply = if (open && !c.mine) ({ composing = true }) else null,
                    block = blockFor(model, coachId, onGone),
                )
            }
            val onLaps = g.laps.sumOf { it.comments.size }
            if (onLaps > 0) {
                Text(
                    "${fmtCount(onLaps, "comment")} on laps — open a lap to read ${if (onLaps == 1) "it" else "them"}.",
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                )
            }
            if (!open) {
                Text(Comments.THREAD_CLOSED, style = TrackTheme.typography.xs, color = colors.textFaint)
            } else if (composing || model.draft(key).isNotEmpty()) {
                CommentComposer(
                    model = model,
                    key = key,
                    sendLabel = if (model.isOwner) "Reply" else "Comment",
                    placeholder = if (model.isOwner) Comments.REPLY_PLACEHOLDER else Comments.COMMENT_PLACEHOLDER,
                    onSend = { model.send(key, session.id, coachId, model.lap(key), onSent = { composing = false }) },
                    modifier = Modifier.testTag("sessionComposer-${session.id}"),
                ) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val chosen = model.lap(key)
                        FilterChip(
                            selected = chosen == null,
                            onClick = { model.setLap(key, null) },
                            label = { Text(Comments.WHOLE_SESSION, style = TrackTheme.typography.xs) },
                            modifier = Modifier.testTag("commentTarget-session"),
                        )
                        for (lap in session.laps) {
                            FilterChip(
                                selected = chosen == lap.id,
                                onClick = { model.setLap(key, lap.id) },
                                label = { Text("Lap ${lap.lapNum} · ${LapTime.fmtMs(lap.timeMs)}", style = TrackTheme.typography.xs) },
                                modifier = Modifier.testTag("commentTarget-${lap.id}"),
                            )
                        }
                    }
                }
            } else {
                TextButton(
                    onClick = { composing = true },
                    modifier = Modifier.testTag("composeSessionComment-${session.id}"),
                ) {
                    Text(
                        if (model.isOwner) Comments.REPLY_PLACEHOLDER else Comments.COMMENT_PLACEHOLDER,
                        style = TrackTheme.typography.sm,
                        color = colors.accentInk,
                    )
                }
            }
        }
        // The notification ask once on the page — on the first session whose
        // thread makes it mean something, not on every card.
        val firstAsk = data.comments.firstOrNull { if (model.isOwner) !it.mine else it.mine }?.sessionId
        if (firstAsk == session.id) PushOfferFor(model, mine, studentName)
        model.actionError?.let { Text(it, style = TrackTheme.typography.xs, color = colors.danger) }
    }
}

/**
 * The lap page's *Comments* card (NS-52): what was said about this lap, in
 * place order, each thread with its composer — the owner's under a coach's
 * thread as *Reply*, a coach's own as *Comment*.
 *
 * [currentPlace] is read only when *At the marked place* is tapped — the
 * stage's playhead (side A) or the panel's parked mark, in whole metres — so
 * nothing here recomposes with the video. [onShowOnLap] takes a placed
 * comment back there: a seek on a stage, the cursor otherwise.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LapComments(
    session: Session,
    lap: Lap,
    model: CommentsModel,
    currentPlace: (() -> Int?)?,
    onShowOnLap: ((distM: Int) -> Unit)?,
    modifier: Modifier = Modifier,
    onGone: () -> Unit = {},
    studentName: String? = null,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val data = model.data
    LaunchedEffect(data) { if (data != null) model.markSeen() }
    TrackCard(modifier.fillMaxWidth().testTag("lapComments"), contentPadding = 12.dp) {
        Text(Comments.COMMENTS_HEADING, style = TrackTheme.typography.h3, color = colors.textStrong)
        if (data == null) {
            Text(
                if (model.loadFailed) "Comments couldn't be loaded." else "Loading comments…",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
            return@TrackCard
        }
        val forLap = data.comments.filter { it.sessionId == session.id && it.lapId == lap.id }
        val threads = threadsOf(model, forLap, withOpenCoaches = true)
        if (forLap.isEmpty()) {
            Text("No comments on this lap yet.", style = TrackTheme.typography.xs, color = colors.textFaint)
        }
        if (threads.isEmpty()) return@TrackCard
        val now = System.currentTimeMillis()
        for (t in threads) {
            val coach: CommentCoach? = if (model.isOwner) model.coach(t.coachId) else null
            val coachId = if (model.isOwner) t.coachId else null
            val open = if (model.isOwner) Comments.canReply(coach) else true
            if (model.isOwner) {
                Text(
                    Comments.threadTitle(coach, true),
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 6.dp),
                )
            } else if (t.comments.isEmpty()) {
                Text(Comments.coachAudienceNote(studentName), style = TrackTheme.typography.xs, color = colors.textFaint)
            }
            val ordered = Comments.groupComments(t.comments, session.id, listOf(lap)).laps.firstOrNull()?.comments.orEmpty()
            val key = CommentsModel.lapKey(session.id, lap.id, coachId)
            for (c in ordered) {
                val place = commentPlaceText(c, session, units)
                CommentCard(
                    c = c,
                    model = model,
                    place = place,
                    now = now,
                    modifier = Modifier.padding(top = 6.dp),
                    onShowOnLap = if (place != null && onShowOnLap != null) ({ onShowOnLap(c.distM!!) }) else null,
                    onReply = null,
                    block = blockFor(model, coachId, onGone),
                )
            }
            if (!open) {
                Text(Comments.THREAD_CLOSED, style = TrackTheme.typography.xs, color = colors.textFaint, modifier = Modifier.padding(top = 6.dp))
            } else {
            var hint by rememberSaveable(key) { mutableStateOf<String?>(null) }
            CommentComposer(
                model = model,
                key = key,
                sendLabel = if (model.isOwner) "Reply" else "Comment",
                placeholder = if (model.isOwner) Comments.REPLY_PLACEHOLDER else Comments.COMMENT_PLACEHOLDER,
                onSend = { model.send(key, session.id, coachId, lap.id) },
                modifier = Modifier.padding(top = 8.dp),
            ) {
                val placed = model.place(key)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (placed != null) {
                        val text = Comments.commentPlace(
                            placed.toDouble(),
                            session.channels?.dStepM ?: 0.0,
                            session.channels?.let { runCatching { Corners.sessionCorners(it) }.getOrNull() },
                            units,
                        )
                        FilterChip(
                            selected = true,
                            onClick = { model.setPlace(key, null) },
                            label = { Text("◆ at $text  ✕", style = TrackTheme.typography.xs) },
                            modifier = Modifier.testTag("commentPlace").semantics {
                                contentDescription = "At $text. Remove the place."
                            },
                        )
                    } else if (currentPlace != null) {
                        TextButton(
                            onClick = {
                                val at = currentPlace()
                                if (at == null) {
                                    hint = "Mark a place first: tap a chart, or play the lap and pause where you mean."
                                } else {
                                    hint = null
                                    model.setPlace(key, at)
                                }
                            },
                            modifier = Modifier.testTag("commentPlacePin"),
                        ) { Text("◆ At the marked place", style = TrackTheme.typography.xs, color = colors.accentInk) }
                    }
                }
                hint?.let { Text(it, style = TrackTheme.typography.xs, color = colors.textFaint) }
            }
            }
        }
        PushOfferFor(model, forLap, studentName)
        model.actionError?.let { Text(it, style = TrackTheme.typography.xs, color = colors.danger) }
    }
}

/** The ids the dashboard card opens: the event, in whichever logbook it is. */
data class FeedTarget(val eventId: Int, val studentId: Int?)

/**
 * The dashboard's card while something is unread (NS-52): the comment itself
 * when there is one — tapping opens its event — and a count otherwise, which
 * opens Coaching's list. The web's `commentsCardHtml`.
 */
@Composable
fun UnreadCommentsCard(feed: CommentFeed, onOpenEvent: (FeedTarget) -> Unit, onOpenCoaching: () -> Unit) {
    val colors = TrackTheme.colors
    val line = Comments.unreadLine(feed) ?: return
    val unread = feed.comments.filter { !it.seen }
    val single = if (feed.unread == 1 && unread.size == 1) unread[0] else null
    val open = { if (single != null) onOpenEvent(FeedTarget(single.eventId, single.student?.id)) else onOpenCoaching() }
    TrackCard(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = open)
            .testTag("unreadComments")
            .semantics(mergeDescendants = true) {
                stateDescription = "${feed.unread} unread"
            },
        color = colors.accentTint,
        contentPadding = 12.dp,
    ) {
        Text("💬 $line", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        single?.let { Text(it.body, style = TrackTheme.typography.sm, color = colors.textMuted, maxLines = 3) }
        Text(if (single != null) "Open →" else "See them all →", style = TrackTheme.typography.xs, color = colors.accentInk)
    }
}

/** One row of Coaching's *Recent comments* list. */
@Composable
fun FeedRow(row: FeedComment, now: Long, onOpen: () -> Unit) {
    val colors = TrackTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(vertical = 6.dp)
            .testTag("feedRow-${row.id}")
            .semantics(mergeDescendants = true) { },
    ) {
        Text(Comments.feedLine(row), style = TrackTheme.typography.sm, color = colors.textStrong)
        Text(
            commentWhenText(row.createdAt, now) + if (row.seen) "" else " · new",
            style = TrackTheme.typography.xxs,
            color = if (row.seen) colors.textFaint else colors.accentInk,
        )
        Text(row.body, style = TrackTheme.typography.xs, color = colors.textMuted, maxLines = 2)
    }
}

/** A channel lap's grid length: its speed trace's, else its first gridded series'. */
private fun gridSteps(entry: app.trackevolution.core.model.LapChannels): Int =
    (entry.speed?.size ?: entry.latG?.size ?: entry.throttle?.size ?: entry.brake?.size ?: 0) - 1

/**
 * Every placed comment on [session]'s laps as chart marks (NS-52), for a
 * multi-lap panel — the event page's analysis column, the session compare.
 * Each lap's marks sit at its own channel index and grid place; the panel
 * draws only the lit laps'. A derived `State` the charts read in their draw
 * phase, never their samples.
 */
@Composable
fun rememberSessionCommentMarks(comments: CommentsModel?, session: Session?): State<List<CommentMark>>? {
    if (comments == null || session == null || session.channels?.laps.isNullOrEmpty()) return null
    return remember(comments, session) { derivedStateOf { sessionCommentMarks(comments.comments, session) } }
}

/** [rememberSessionCommentMarks]'s value: each placed comment at its lap's channel index and grid place. */
internal fun sessionCommentMarks(comments: List<CoachComment>, session: Session): List<CommentMark> {
    val channels = session.channels?.takeIf { it.laps.isNotEmpty() } ?: return emptyList()
    val placed = comments.filter { it.sessionId == session.id && it.distM != null }
    if (placed.isEmpty()) return emptyList()
    return ChannelGraphs.matchLapsToChannels(session.laps, channels.laps).filter { it.hasChannels }.flatMap { m ->
        val steps = gridSteps(channels.laps[m.chIdx])
        if (steps < 1) return@flatMap emptyList()
        Comments.commentMarkers(placed, m.lap.id, steps * channels.dStepM).map {
            CommentMark(chIdx = m.chIdx, k = it.frac * steps, mine = it.mine)
        }
    }
}

/**
 * Every placed comment on [session] as fractions of its lap, for the map —
 * the session's best-lap line, on which every lap's place falls by fraction,
 * as the panel's cursor dots do (the web's `setNotes`).
 */
fun sessionCommentPins(comments: CommentsModel?, session: Session?): List<Double> {
    val channels = session?.channels?.takeIf { it.laps.isNotEmpty() } ?: return emptyList()
    if (comments == null) return emptyList()
    val placed = comments.comments.filter { it.sessionId == session.id && it.distM != null }
    if (placed.isEmpty()) return emptyList()
    return ChannelGraphs.matchLapsToChannels(session.laps, channels.laps).filter { it.hasChannels }.flatMap { m ->
        val steps = gridSteps(channels.laps[m.chIdx])
        if (steps < 1) emptyList() else Comments.commentMarkers(placed, m.lap.id, steps * channels.dStepM).map { it.frac }
    }
}
