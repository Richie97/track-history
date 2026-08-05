package app.trackevolution.auto

import androidx.car.app.OnDoneCallback
import androidx.car.app.serialization.Bundleable
import app.trackevolution.recording.RecorderBlocker
import app.trackevolution.recording.RecorderState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * What the head unit says.
 *
 * These are one-line assertions about strings, which looks trivial until you
 * remember this is the surface nobody can open on a desk: without the split
 * between [AutoRecording] and the `Screen`, the wording read while driving would
 * be the only wording in the app with no test behind it.
 *
 * The stall case is the one that earns its keep. A recording that has silently
 * stopped receiving fixes looks *identical* to a healthy one if the screen only
 * shows a count — the number simply stops moving, and nobody watching the road
 * notices a number that isn't changing.
 */
@RunWith(RobolectricTestRunner::class)
class AutoRecordingTest {

    private val idle = RecorderState()

    private fun recording(
        fixes: Int = 120,
        elapsedS: Double = 65.0,
        lastFixAtMs: Long = 10_000,
    ) = RecorderState(
        isRecording = true,
        fixCount = fixes,
        elapsedS = elapsedS,
        lastFixAtMs = lastFixAtMs,
    )

    @Test
    fun `idle offers to record and names the app`() {
        assertEquals("Track Evolution", AutoRecording.title(idle))
        assertEquals("Ready to record laps.", AutoRecording.status(idle))
        assertEquals("Start", AutoRecording.actionLabel(idle))
    }

    @Test
    fun `recording shows elapsed and fixes, and offers to stop`() {
        assertEquals("Recording", AutoRecording.title(recording()))
        assertEquals("1:05 · 120 fixes", AutoRecording.status(recording()))
        assertEquals("Stop", AutoRecording.actionLabel(recording()))
    }

    @Test
    fun `a blocker outranks everything, including an active recording`() {
        // If location was switched off mid-session the driver needs to know
        // that, not a timer that has quietly stopped meaning anything.
        val blocked = recording().copy(blocker = RecorderBlocker.LOCATION_SERVICES_OFF)
        assertEquals(RecorderBlocker.LOCATION_SERVICES_OFF.message, AutoRecording.status(blocked))
    }

    @Test
    fun `an auto-stopped recording says to go to the phone`() {
        // Saving needs the review flow, which does not exist in the car — so the
        // car's job is to say where it does exist rather than to imply it is lost.
        val stopped = RecorderState(autoStopped = true)
        assertTrue(AutoRecording.status(stopped).contains("phone"))
    }

    @Test
    fun `an unattached recording says so without sounding like a failure`() {
        assertEquals(AutoRecording.NO_EVENT, AutoRecording.eventLine(null))
        assertEquals(AutoRecording.NO_EVENT, AutoRecording.eventLine("   "))
        assertEquals("Virginia International Raceway (Full)", AutoRecording.eventLine("Virginia International Raceway (Full)"))
    }

    // ---- The GPS indicator --------------------------------------------------

    @Test
    fun `gps is idle when nothing is running`() {
        assertEquals("GPS idle", AutoRecording.gpsLine(idle, nowMs = 20_000))
    }

    @Test
    fun `a recording with no fixes yet is waiting, not locked`() {
        assertEquals("Waiting for GPS…", AutoRecording.gpsLine(recording(fixes = 0), nowMs = 20_000))
    }

    @Test
    fun `a healthy stream reads as locked`() {
        val now = 10_000L + AutoRecording.STALL_AFTER_MS - 1
        assertEquals("GPS locked", AutoRecording.gpsLine(recording(), nowMs = now))
    }

    @Test
    fun `a stalled stream says so, with how long it has been silent`() {
        // Past the threshold: a gap under a bridge is not a failure, but silence
        // during a session is the worst possible outcome.
        val now = 10_000L + AutoRecording.STALL_AFTER_MS + 3_000
        assertEquals(
            "No GPS signal — 11s since the last fix",
            AutoRecording.gpsLine(recording(), nowMs = now),
        )
    }

    @Test
    fun `a recording that has never had a fix time is not called stalled`() {
        // lastFixAtMs is 0 before the first fix lands; treating that as "11,000
        // years since the last fix" would put a scary string on screen at the
        // exact moment everything is fine.
        assertEquals(
            "GPS locked",
            AutoRecording.gpsLine(recording(lastFixAtMs = 0), nowMs = 20_000),
        )
    }

    // ---- The template itself ------------------------------------------------

    @Test
    fun `the template builds within the library's distraction limits`() {
        // The Car App Library enforces its row and action caps by throwing at
        // build time, so this asserts by not exploding — which is the difference
        // between a failing test here and a crash on a head unit.
        var toggled = 0
        val template = AutoRecording.template(
            state = recording(),
            eventLabel = "VIR (Full)",
            nowMs = 12_000,
            onToggle = { toggled++ },
        )

        val rows = template.pane.rows
        assertEquals(2, rows.size)
        assertEquals("Recording", rows[0].title.toString())
        assertEquals("VIR (Full)", rows[1].title.toString())

        val actions = template.pane.actions
        assertEquals(1, actions.size)
        assertEquals("Stop", actions[0].title.toString())

        // The one control has to actually be wired to something.
        actions[0].onClickDelegate!!.sendClick(object : OnDoneCallback {
            override fun onSuccess(response: Bundleable?) = Unit
            override fun onFailure(response: Bundleable) = Unit
        })
        assertEquals(1, toggled)
    }

    @Test
    fun `the idle template offers Start and the unattached wording`() {
        val template = AutoRecording.template(idle, eventLabel = null, nowMs = 0, onToggle = {})
        assertEquals("Start", template.pane.actions[0].title.toString())
        assertEquals(AutoRecording.NO_EVENT, template.pane.rows[1].title.toString())
    }
}
