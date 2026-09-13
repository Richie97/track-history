package app.trackevolution.core

import app.trackevolution.core.model.SessionDraft

/**
 * The New Event form's "Add laps" section — the pure half, ported from
 * `public/js/event-form.js` under the same names and pinned to it by
 * `contracts/logic/event-form.json`.
 *
 * The form stages sessions until "Create event": clips the import review
 * handed back and, optionally, one session typed by hand. Nothing is posted
 * before the event exists — the event is created first, then each session is
 * `POST /events/:id/sessions` in the order [sessionsToCreate] returns, so the
 * logbook reads the way the form did. A hand entry with no parseable laps is
 * dropped rather than posted as an empty session.
 */
public object EventFormSessions {

    /**
     * Every session to create for a new event, in posting order: the staged
     * imports first, in the order they were staged, then the hand-typed one
     * when it holds at least one lap. The typed fields are passed as typed;
     * blank label and notes go out as null, as the event page's form sends them.
     */
    public fun sessionsToCreate(
        staged: List<SessionDraft>,
        label: String?,
        laps: String?,
        notes: String?,
    ): List<SessionDraft> {
        val parsed = LapTime.parseLapList(laps)
        if (parsed.isEmpty()) return staged
        return staged + SessionDraft(
            label = label?.trim()?.takeIf { it.isNotEmpty() },
            notes = notes?.trim()?.takeIf { it.isNotEmpty() },
            laps = parsed,
        )
    }

    /** "9 laps · best 2:01.24" — one staged session's line on the form. */
    public fun stagedSummary(laps: List<Int>): String {
        val n = laps.size
        val best = laps.minOrNull()
        return "$n lap${if (n == 1) "" else "s"}" + (best?.let { " · best ${LapTime.fmtMs(it)}" } ?: "")
    }
}
