package app.trackevolution.push

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

private fun permissionGranted(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED

/**
 * *Turn on*, through the system prompt where Android 13+ needs one. Granted,
 * the phone registers; denied, the ask is answered and stays answered, and
 * Settings' toggle is the way back.
 */
@Composable
private fun rememberTurnOn(control: CommentPushControl): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) control.setEnabled(true) else control.markAsked()
    }
    return remember(control, launcher) {
        {
            if (CommentPushAsk.needsPermission(Build.VERSION.SDK_INT, permissionGranted(context))) {
                launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                control.setEnabled(true)
            }
        }
    }
}

/**
 * The in-context ask under a comment thread (NS-54): *Get notified when
 * <name> replies*. Shown by the caller only when [CommentPushAsk.shouldOffer]
 * says so.
 */
@Composable
fun CommentPushOffer(name: String?, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val control = LocalCommentPush.current
    val turnOn = rememberTurnOn(control)
    Column(modifier.fillMaxWidth().testTag("commentPushOffer")) {
        Text(
            "Get notified when ${name ?: "they"} ${if (name == null) "reply" else "replies"}",
            style = TrackTheme.typography.sm,
            color = colors.textBody,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = turnOn, modifier = Modifier.testTag("commentPushTurnOn")) {
                Text("Turn on", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
            TextButton(onClick = control::markAsked, modifier = Modifier.testTag("commentPushNotNow")) {
                Text("Not now", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
        }
    }
}

/**
 * Settings' *Comment notifications* switch (NS-54), per phone. On means this
 * phone is registered; when Android itself is blocking the app's
 * notifications the switch says so and offers the system page, since only
 * the driver can undo that.
 */
@Composable
fun CommentNotificationsCard() {
    val colors = TrackTheme.colors
    val context = LocalContext.current
    val control = LocalCommentPush.current
    val enabled by control.enabled.collectAsState()
    val turnOn = rememberTurnOn(control)
    // Re-read when the switch changes; the system page is a trip out and back,
    // which recomposes this on return.
    var blocked by remember { mutableStateOf(false) }
    blocked = enabled && !NotificationManagerCompat.from(context).areNotificationsEnabled()
    TrackCard(Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.testTag("commentNotifications").toggleable(
                value = enabled,
                role = Role.Switch,
                onValueChange = { on -> if (on) turnOn() else control.setEnabled(false) },
            ),
        ) {
            Switch(
                checked = enabled,
                onCheckedChange = null,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = colors.accentInk,
                    checkedTrackColor = colors.accentTint,
                ),
            )
            Text("Comment notifications", style = TrackTheme.typography.body, color = colors.textBody)
        }
        Text(
            "When a coach comments on your laps, or a student replies to you. Just this phone.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 6.dp),
        )
        if (blocked) {
            Text(
                "Notifications for Track Evolution are off in Android's settings.",
                style = TrackTheme.typography.xs,
                color = colors.danger,
                modifier = Modifier.padding(top = 6.dp),
            )
            TextButton(onClick = {
                context.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                )
            }) { Text("Open notification settings", style = TrackTheme.typography.sm, color = colors.accentInk) }
        }
    }
}
