package app.trackevolution.recording

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import app.trackevolution.core.LocationFix
import app.trackevolution.core.RecorderCore
import app.trackevolution.core.Recording
import app.trackevolution.core.RecordingJournal
import java.io.File

/**
 * The lap recorder. **The service owns the recording, not the Activity** — which
 * is the whole point of NS-16.
 *
 * What this replaces, and why it is not a port: the Capacitor app records inside
 * a WebView through a plugin, and pays for it twice. Android stops delivering
 * background location to that bridge after five minutes, worked around by
 * `useLegacyBridge: true` in `mobile/capacitor.config.json` — a flag that must
 * not appear anywhere here. And its checkpoint runs every ~10 s *driven by fix
 * arrival*, because `setInterval` throttles with the screen off, so a WebView
 * death costs up to ten seconds of track time. A foreground service with a
 * location type has no five-minute limit, and this writes every accepted fix to
 * disk as it arrives, so the worst case is zero.
 *
 * Deliberately **not** `START_STICKY`. A service the system restarts with no
 * recording state is worse than none: it would post a notification claiming to
 * record while capturing nothing. Restart is handled explicitly instead — the
 * journal survives, and the next launch offers it back.
 */
class RecordingService : Service() {

    private lateinit var journal: RecordingJournal
    private var source: LocationSource? = null
    private var recording: Recording? = null
    private var autoStopped = false

    override fun onCreate() {
        super.onCreate()
        journal = RecordingJournal(journalFile(this))
        RecordingNotification.ensureChannel(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent.getStringExtra(EXTRA_EVENT_ID))
            ACTION_STOP -> stop(auto = false)
            else -> {
                // A restart with no action: the system brought us back without a
                // recording. Don't pretend — go away and let the recovery prompt
                // offer the journal on next launch.
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun start(eventId: String?) {
        if (recording != null) return

        // The five-second rule: from startForegroundService, the system kills
        // the process with ForegroundServiceDidNotStartInTimeException unless
        // startForeground has been called. So it happens first, before any
        // permission checks, journal I/O or provider setup.
        promoteToForeground(elapsedS = 0.0, fixCount = 0)

        val blocker = RecorderPermissions.blocker(this)
        // A missing notification permission is not a reason to refuse: the
        // recording still works, the user just cannot see it. Everything else is.
        if (blocker != null && blocker != RecorderBlocker.NOTIFICATIONS_DENIED) {
            Recorder.publish(RecorderState(blocker = blocker))
            stopForegroundAndSelf()
            return
        }

        val startedAtMs = System.currentTimeMillis().toDouble()
        val rec = RecorderCore.createRecording(eventId, startedAtMs)
        recording = rec
        autoStopped = false
        journal.begin(rec)

        Recorder.publish(
            RecorderState(
                isRecording = true,
                eventId = eventId,
                startedAtMs = startedAtMs,
                blocker = if (blocker == RecorderBlocker.NOTIFICATIONS_DENIED) blocker else null,
            ),
        )

        source = LocationSource(this).also { it.start(::onFix) }
    }

    /**
     * One fix: validate, persist, publish, and decide whether the recording
     * should end itself.
     *
     * Runs on the main looper, which is where the fused callback is registered.
     * That is deliberate — the work is a handful of arithmetic and one buffered
     * line write, and it keeps `Recording` confined to a single thread without a
     * lock, which is what its own documentation asks for.
     */
    private fun onFix(fix: LocationFix) {
        val rec = recording ?: return
        // addFix drops out-of-order, implausible and hopeless-accuracy fixes,
        // and only an accepted one is worth writing down.
        if (!rec.addFix(fix)) return
        journal.append(rec.fixes.last())

        val elapsed = RecorderCore.elapsedS(rec, fix.timeMs)
        Recorder.publish(
            Recorder.state.value.copy(fixCount = rec.fixes.size, elapsedS = elapsed),
        )
        updateNotification(elapsed, rec.fixes.size)

        // Evaluated per fix, not on a timer: a timer is exactly the thing that
        // stops firing with the screen off.
        if (RecorderCore.shouldAutoStop(rec, fix.timeMs)) stop(auto = true)
    }

    private fun stop(auto: Boolean) {
        val rec = recording
        source?.stop()
        source = null
        recording = null
        autoStopped = auto
        journal.close()

        if (rec != null) {
            // The journal stays on disk until NS-18's review flow saves or
            // discards it. Handing over an in-memory copy as well means the
            // common path never has to re-read it.
            Recorder.publishFinished(rec.snapshot())
        }
        Recorder.publish(
            RecorderState(
                isRecording = false,
                fixCount = rec?.fixes?.size ?: 0,
                autoStopped = auto,
            ),
        )
        stopForegroundAndSelf()
    }

    override fun onDestroy() {
        // Swipe-away from recents does not route through onStartCommand, and it
        // must not lose the recording: the provider is released, but the journal
        // keeps every fix already taken.
        source?.stop()
        source = null
        journal.close()
        super.onDestroy()
    }

    private fun promoteToForeground(elapsedS: Double, fixCount: Int) {
        val notification = RecordingNotification.build(this, elapsedS, fixCount)
        try {
            ServiceCompat.startForeground(
                this,
                RecordingNotification.ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                } else {
                    0
                },
            )
        } catch (e: Exception) {
            // Android 14+ throws if the app is not allowed to start a
            // location foreground service from where it did. Better to report
            // it than to die holding the GPS.
            Log.e(TAG, "could not start the recording service in the foreground", e)
            Recorder.publish(RecorderState(blocker = RecorderBlocker.LOCATION_DENIED))
            stopSelf()
        }
    }

    private fun updateNotification(elapsedS: Double, fixCount: Int) {
        // At ~5 fixes a second, rebuilding the notification every time is pure
        // waste — and a notification that changes 5x a second is unreadable
        // anyway. Once a second is what a stopwatch needs.
        val second = elapsedS.toLong()
        if (second == lastNotifiedSecond) return
        lastNotifiedSecond = second
        val manager = androidx.core.app.NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return
        runCatching {
            manager.notify(RecordingNotification.ID, RecordingNotification.build(this, elapsedS, fixCount))
        }
    }

    private var lastNotifiedSecond = -1L

    private fun stopForegroundAndSelf() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        const val ACTION_START = "app.trackevolution.recording.START"
        const val ACTION_STOP = "app.trackevolution.recording.STOP"
        const val EXTRA_EVENT_ID = "eventId"

        private const val TAG = "RecordingService"

        /**
         * Where the in-progress recording lives. In `filesDir`, not the cache:
         * the system may clear the cache under storage pressure, and this is the
         * one copy of a session that has not been saved yet.
         */
        fun journalFile(context: android.content.Context): File =
            File(File(context.filesDir, "recorder").apply { mkdirs() }, "in-progress.jsonl")
    }
}
