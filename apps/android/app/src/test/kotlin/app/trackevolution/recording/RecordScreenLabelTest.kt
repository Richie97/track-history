package app.trackevolution.recording

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the record screen says about where the laps are going.
 *
 * This line was wrong for as long as it existed: `AppNavHost` passed
 * `eventLabel = null` unconditionally, so every recording — including one opened
 * from the dashboard's "Record laps at <track>" button, and from an event's own
 * page — was met with "Not attached to an event yet". The laps were filed
 * correctly the whole time; only the screen disagreed, which is the kind of
 * defect that costs trust rather than data.
 *
 * The middle case is the one worth having a name for. "Attached, but the track
 * name hasn't loaded" is a real state — the list is fetched, and a cold cache
 * offline never resolves it — and it must not collapse into "not attached",
 * because that is the lie all over again.
 */
class RecordScreenLabelTest {

    @Test
    fun `names the event when it is known`() {
        assertEquals(
            "Laps will be saved to Summit Point (Shenandoah).",
            attachmentText(isAttached = true, eventLabel = "Summit Point (Shenandoah)"),
        )
    }

    @Test
    fun `attached but unnamed still says there is an event`() {
        assertEquals(
            "Laps will be saved to this event.",
            attachmentText(isAttached = true, eventLabel = null),
        )
    }

    @Test
    fun `unattached says so, and says it is recoverable`() {
        assertEquals(
            "Not attached to an event yet — you can create one after.",
            attachmentText(isAttached = false, eventLabel = null),
        )
    }

    /**
     * A stale name with no attachment behind it must not resurrect the old bug
     * in the other direction — promising an event that isn't there.
     */
    @Test
    fun `a name without an attachment is ignored`() {
        assertEquals(
            "Not attached to an event yet — you can create one after.",
            attachmentText(isAttached = false, eventLabel = "Summit Point (Shenandoah)"),
        )
    }
}
