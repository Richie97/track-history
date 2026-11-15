package app.trackevolution.screens

import app.trackevolution.core.model.CommentFeed
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What is waiting to be read in coach comments (NS-52), process-wide — the
 * `GarageBadge` arrangement: every surface that shows it reads this one value.
 * That covers the dashboard's unread card, Settings' Coaching count and the
 * Coaching page. Without it, the dashboard in the expanded-width list pane went
 * on saying "3 new" beside a thread that had just been read.
 *
 * [feed] is the last `GET /coaching/comments` any screen read. A `/seen` that
 * succeeds updates it on the spot ([noteSeen]: that event's rows marked read,
 * the count lowered by what the server says it marked). The model that posted
 * it then re-reads the feed, so the count settles on the server's figure.
 * [version] moves on every such change, for a page that holds counts of its
 * own (Coaching's per-row unread) and re-reads on it.
 */
public object CommentsBadge {
    private val _feed = MutableStateFlow<CommentFeed?>(null)
    public val feed: StateFlow<CommentFeed?> = _feed.asStateFlow()

    private val _version = MutableStateFlow(0)
    public val version: StateFlow<Int> = _version.asStateFlow()

    /** A fresh read of the feed. */
    public fun note(feed: CommentFeed) {
        _feed.value = feed
    }

    /**
     * [seen] comments on [eventId] were just marked read — in the caller's own
     * logbook when [studentId] is null, else in that student's.
     */
    public fun noteSeen(eventId: Int, studentId: Int?, seen: Int) {
        _feed.value = _feed.value?.let { f ->
            f.copy(
                unread = maxOf(0, f.unread - seen),
                comments = f.comments.map {
                    if (it.eventId == eventId && it.student?.id == studentId && !it.seen) it.copy(seen = true) else it
                },
            )
        }
        _version.value += 1
    }

    /** Sign-out: the next account must not inherit this one's count. */
    public fun clear() {
        _feed.value = null
        _version.value = 0
    }
}
