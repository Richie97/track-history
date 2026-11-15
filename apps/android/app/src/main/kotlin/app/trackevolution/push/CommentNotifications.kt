package app.trackevolution.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.trackevolution.MainActivity
import app.trackevolution.R
import app.trackevolution.core.DeepLink

/**
 * The coach-comment notification (NS-54) and its channel.
 *
 * FCM draws the notification itself while the app is in the background, on
 * the channel and with the icon the manifest names, and a tap opens
 * [MainActivity] with the message's `data` as plain string extras. This posts
 * the same notification while the app is in the foreground — when FCM hands
 * the message to [CommentMessagingService] instead — with the same extras, so
 * [fromIntent] reads either tap the same way.
 */
object CommentNotifications {

    /** `ANDROID_CHANNEL` in `src/lib/push.ts`: the server names it in every message. */
    const val CHANNEL_ID = "coach_comments"

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Coach comments", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When your coach comments on a lap, or a student replies to you."
            },
        )
    }

    /** The intent a tap opens: the push's `data`, as string extras. */
    fun openIntent(context: Context, data: Map<String, String>): Intent =
        Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            for ((k, v) in data) putExtra(k, v)
        }

    /** The notification for one comment, grouped on the device by event (`tag`). */
    fun build(context: Context, title: String, body: String, data: Map<String, String>): Notification {
        val open = PendingIntent.getActivity(
            context,
            // One request code per comment, so two notifications never share
            // (and overwrite) one PendingIntent's extras.
            requestCode(data),
            openIntent(context, data),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_comment)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(tag(data))
            .build()
    }

    /** Posts it, unless the OS won't show it anyway. */
    fun show(context: Context, title: String, body: String, data: Map<String, String>) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(context)
        try {
            manager.notify(tag(data), requestCode(data), build(context, title, body, data))
        } catch (_: SecurityException) {
            // The permission was revoked between the check and the post.
        }
    }

    /** `event-<id>`, the server's `tag` / `thread-id`: one group per event. */
    fun tag(data: Map<String, String>): String = "event-${data["event_id"] ?: "0"}"

    private fun requestCode(data: Map<String, String>): Int = data["comment_id"]?.toIntOrNull() ?: 0

    /**
     * Where a tapped notification goes, from the intent that opened the app —
     * the foreground notification's or FCM's own, whose extras are the same.
     * Null for any other launch.
     */
    fun fromIntent(intent: Intent?): DeepLink.CommentPush? {
        val extras: Bundle = intent?.extras ?: return null
        if (extras.getString("kind") != "comment") return null
        val data = buildMap {
            for (key in DATA_KEYS) extras.getString(key)?.let { put(key, it) }
        }
        return DeepLink.commentPush(data)
    }

    /** `commentPushMessage`'s `data` keys in `src/lib/push.ts`. */
    private val DATA_KEYS = listOf("kind", "comment_id", "event_id", "session_id", "lap_id", "student_id")
}
