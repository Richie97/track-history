package app.trackevolution.auto

import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import app.trackevolution.core.RemoteRecording
import app.trackevolution.data.AppServices
import app.trackevolution.recording.RecorderBlocker
import app.trackevolution.recording.RecorderPermissions
import app.trackevolution.recording.Recorder
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The head unit's one screen: what the recorder is doing, and a button (NS-20).
 *
 * **One screen, one control**, per the spec and per Android Auto's distraction
 * rules. Every extra template is another thing to read while driving and another
 * review risk; there is deliberately no way to browse the logbook from here.
 *
 * **This is a view onto the recorder, not an owner of it.** The recording lives
 * in the foreground service (NS-16), so connecting or disconnecting the car
 * cannot interrupt one — this screen appears, reads the same [Recorder] state
 * the phone reads, and disappears again. That is also what makes the mirroring
 * requirement free: both surfaces observe one object, so they cannot disagree.
 */
class RecordingScreen(carContext: CarContext) : Screen(carContext) {

    /**
     * The attached event's name, resolved once at start. Held here rather than
     * in [Recorder] because it is presentation — the recorder only needs the id.
     */
    private var eventLabel: String? = null

    private var starting = false

    init {
        // Mirror the phone: any state change redraws the car screen. A recording
        // started from the phone shows "Stop" here without anyone touching the
        // head unit, which is the requirement.
        lifecycleScope.launch {
            Recorder.state.collect {
                if (!it.isRecording) eventLabel = null
                invalidate()
            }
        }
        // The elapsed clock has to tick on its own: between fixes nothing
        // publishes, and a timer that only moves when a fix lands reads as a
        // stall.
        lifecycleScope.launch {
            while (true) {
                delay(1_000)
                if (Recorder.state.value.isRecording) invalidate()
            }
        }
    }

    override fun onGetTemplate(): Template = AutoRecording.template(
        state = Recorder.state.value,
        eventLabel = eventLabel,
        nowMs = System.currentTimeMillis(),
        onToggle = ::toggle,
    )

    private fun toggle() {
        val state = Recorder.state.value
        if (state.isRecording) {
            Recorder.stop(carContext)
            return
        }
        if (starting) return

        // Permissions cannot be requested from the car — there is no way to show
        // a system dialog on a head unit. Saying which one is missing, in the
        // blocker's own words, is the most useful thing available; the phone is
        // where it gets fixed.
        //
        // A missing *notification* permission is deliberately not a blocker
        // here, matching `RecordingService`: the recording works, the driver
        // just cannot see the notification. Refusing to record over that would
        // trade the irreplaceable thing for the recoverable one.
        RecorderPermissions.blocker(carContext)
            ?.takeIf { it != RecorderBlocker.NOTIFICATIONS_DENIED }
            ?.let { blocker ->
                CarToast.makeText(carContext, blocker.message, CarToast.LENGTH_LONG).show()
                return@toggle
            }

        starting = true
        lifecycleScope.launch {
            // Best effort, and the order matters: the event lookup must never be
            // able to stop a recording. Signed out, offline, or no event today
            // all still record — the GPS trace is the irreplaceable part and the
            // event is not.
            val event = runCatching {
                RemoteRecording.pickRecordingEvent(
                    AppServices.get(carContext).api.events(),
                    RemoteRecording.localTodayIso(),
                )
            }.getOrNull()

            eventLabel = event?.trackName
            Recorder.start(carContext, eventId = event?.id?.toString())
            starting = false
            invalidate()
        }
    }
}
