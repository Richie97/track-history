package app.trackevolution.recording

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import app.trackevolution.MainActivity
import app.trackevolution.R

/**
 * The ongoing notification a location foreground service is required to post —
 * and which, on the Capacitor app, nobody ever sees, because `POST_NOTIFICATIONS`
 * is declared in the manifest but never requested at runtime. On Android 13+
 * that means a recording runs with no indication at all.
 *
 * Low importance on purpose: it must be present and honest, not attention-
 * grabbing. Nobody wants a buzz every time a lap timer updates.
 */
object RecordingNotification {

    const val CHANNEL_ID = "recording"
    const val ID = 1001

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.recording_channel_name),
                // IMPORTANCE_LOW: visible and silent. The wording matches the
                // Capacitor app's channel so an upgrading user recognises it.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.recording_channel_description)
                setShowBadge(false)
            },
        )
    }

    /**
     * The notification for a running recording. [elapsedS] and [fixCount] are
     * what the driver actually wants to see from a glance at a phone on a mount.
     */
    fun build(context: Context, elapsedS: Double, fixCount: Int): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                // Tapping it must land on the live recording, not the dashboard
                // — while driving, that is the only screen worth reaching.
                putExtra(RecordingService.EXTRA_OPEN_RECORDER, true)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            context,
            1,
            Intent(context, RecordingService::class.java).apply {
                action = RecordingService.ACTION_STOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_recording)
            .setContentTitle(context.getString(R.string.recording_title))
            .setContentText(context.getString(R.string.recording_text, formatElapsed(elapsedS), fixCount))
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.recording_stop), stop)
            // Ongoing and not dismissible: swiping away the thing that says GPS
            // is live, while GPS is live, would be a lie.
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    /** `1:23:45` past an hour, `23:45` below it — a stopwatch, not a duration. */
    internal fun formatElapsed(seconds: Double): String {
        val total = seconds.toLong().coerceAtLeast(0)
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return if (h > 0) {
            "%d:%02d:%02d".format(h, m, s)
        } else {
            "%d:%02d".format(m, s)
        }
    }
}
