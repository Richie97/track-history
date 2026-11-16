package app.trackevolution.push

import app.trackevolution.data.AppServices
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging's two callbacks (NS-54).
 *
 * A coach-comment message carries both a `notification` and `data`. In the
 * background FCM draws it itself and this is never called; in the foreground
 * FCM hands it here instead, and nothing would appear unless this posts it —
 * which it does, the same notification with the same tap.
 */
class CommentMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        AppServices.get(this).push.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["kind"] != "comment") return
        val n = message.notification ?: return
        CommentNotifications.show(this, n.title.orEmpty(), n.body.orEmpty(), data)
    }
}
