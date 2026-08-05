package app.trackevolution.auto

import androidx.car.app.model.Action
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import app.trackevolution.recording.RecorderState
import app.trackevolution.recording.RecordingNotification

/**
 * What the head unit says, given what the recorder is doing (NS-20).
 *
 * Split out from the `Screen` because everything here is a pure mapping from
 * [RecorderState] to strings, and the alternative is that the one surface nobody
 * can open on a desk is also the one with no tests. The `Screen` assembles the
 * template; this decides the words.
 *
 * **Everything is short on purpose.** Android Auto's distraction guidelines cap
 * how much a template may carry, and the real constraint is stricter than the
 * API's: this is read at 70 mph, in one glance, by someone who should be looking
 * at the road. Nothing here says anything that could not be understood in half a
 * second.
 */
internal object AutoRecording {

    /**
     * A recording with no event yet, in the same words the phone uses. It is not
     * an error state — the dashboard offers the recording afterwards and the
     * first event's record screen adopts it, so recording unattached is a
     * perfectly good outcome and must not read as a failure.
     */
    const val NO_EVENT = "No event — will attach later"

    /**
     * How long without a fix before the screen says so, matching `RecordScreen`.
     * Generous next to the ~200 ms request interval, because a gap under a bridge
     * is not a failure — but silence during a session is the worst possible
     * outcome, so past this it says so rather than showing a frozen count that
     * looks like it is still working.
     */
    const val STALL_AFTER_MS = 8_000L

    fun title(state: RecorderState): String =
        if (state.isRecording) "Recording" else "Track Evolution"

    /**
     * The headline line: elapsed and fix count while running, the blocker's own
     * message when something stopped it, and an invitation otherwise.
     *
     * A blocker beats everything, including "recording" — if location was
     * switched off mid-session the driver needs to know that, not a timer.
     */
    fun status(state: RecorderState): String {
        state.blocker?.let { return it.message }
        if (!state.isRecording) {
            return if (state.autoStopped) {
                "Recording stopped. Open the phone to save it."
            } else {
                "Ready to record laps."
            }
        }
        return "${RecordingNotification.formatElapsed(state.elapsedS)} · ${state.fixCount} fixes"
    }

    /** The attached event's name, or the unattached wording. */
    fun eventLine(eventLabel: String?): String = eventLabel?.takeIf { it.isNotBlank() } ?: NO_EVENT

    /**
     * The GPS indicator.
     *
     * Three states, and the third is the one that matters: a recording that has
     * stopped receiving fixes looks identical to a healthy one if you only show a
     * count, because the count simply stops moving.
     */
    fun gpsLine(state: RecorderState, nowMs: Long): String {
        if (!state.isRecording) return "GPS idle"
        if (state.fixCount == 0) return "Waiting for GPS…"
        val since = nowMs - state.lastFixAtMs
        return if (state.lastFixAtMs > 0 && since > STALL_AFTER_MS) {
            "No GPS signal — ${since / 1000}s since the last fix"
        } else {
            "GPS locked"
        }
    }

    /** The single control's label. One button, two words, no ambiguity. */
    fun actionLabel(state: RecorderState): String = if (state.isRecording) "Stop" else "Start"

    /**
     * The whole screen, as a template.
     *
     * Built here rather than in the `Screen` because none of it needs a
     * `CarContext` — a `Pane` is a plain model object — and the Car App Library
     * enforces its distraction limits by *throwing* when a template is built
     * with too many rows or actions. Assembling it in a testable function is
     * what turns "rejected on a head unit" into a failing test.
     *
     * Two rows and one action, well inside the pane limits, because the limit is
     * not the constraint that matters: this is read at speed, in one glance.
     */
    fun template(
        state: RecorderState,
        eventLabel: String?,
        nowMs: Long,
        onToggle: () -> Unit,
    ): PaneTemplate {
        val pane = Pane.Builder()
            .addRow(
                Row.Builder()
                    .setTitle(title(state))
                    .addText(status(state))
                    .build(),
            )
            .addRow(
                Row.Builder()
                    .setTitle(eventLine(eventLabel))
                    .addText(gpsLine(state, nowMs))
                    .build(),
            )
            .addAction(
                Action.Builder()
                    .setTitle(actionLabel(state))
                    .setOnClickListener(onToggle)
                    .build(),
            )
            .build()

        return PaneTemplate.Builder(pane)
            .setTitle("Track Evolution")
            .setHeaderAction(Action.APP_ICON)
            .build()
    }
}
