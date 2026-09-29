package app.trackevolution.core.api

import app.trackevolution.core.model.Entitlement

/**
 * Whose logbook a screen is showing (NS-38): the signed-in account's own, or a
 * student's, read by their coach through `/api/students/:id/…`.
 *
 * The counterpart of the web's `viewing` / `L()` / `ent()` seams and iOS's
 * `LogbookOwner`. It decides three things, and the reused screens go through
 * it rather than knowing about coaching:
 *
 *  - **where reads go** — [ApiClient.forOwner] prefixes every `/api` path with
 *    [pathPrefix], which also keeps the offline cache's keys apart from the
 *    coach's own;
 *  - **that nothing is written** — a [Student] client refuses a write before
 *    sending it ([ApiException.ReadOnly]), and the screens hide the controls;
 *  - **which tier the channel panel opens by** — [entitlement]: the
 *    **student's**, because the student is the one who paid for it and the
 *    server has already stripped `channels` by it. A free coach of a Pro
 *    student sees the full panel.
 */
public sealed interface LogbookOwner {

    /** The signed-in account. */
    public data object Me : LogbookOwner

    /**
     * A driver who invited this account to coach them. [name] and [pro] come
     * from their `/me/profile` under the coach mount — the one place the server
     * says their tier to someone else.
     */
    public data class Student(val id: Int, val name: String?, val pro: Boolean) : LogbookOwner

    /** No write control is offered, and none is sent. */
    public val readOnly: Boolean get() = this is Student

    /** What goes in front of every `/api` path. Empty for [Me]. */
    public val pathPrefix: String
        get() = when (this) {
            Me -> ""
            is Student -> studentPrefix(id)
        }

    /**
     * The entitlement the tier gates read in this logbook: the viewer's own for
     * [Me], the student's for a [Student] — never the viewer's there, or a free
     * coach would see the channels the server sent and the client lock them.
     */
    public fun entitlement(viewer: Entitlement?): Entitlement? = when (this) {
        Me -> viewer
        is Student -> Entitlement(tier = if (pro) Entitlement.Tier.PRO else Entitlement.Tier.FREE)
    }

    public companion object {
        /** `/students/5` — the coach mount's prefix, and the cache prefix a revoke purges. */
        public fun studentPrefix(id: Int): String = "/students/$id"
    }
}
