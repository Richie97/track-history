package app.trackevolution.recording

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * A bench for the recorder, in the **debug source set** so it is not compiled
 * into a release build.
 *
 * NS-18 owns the real recording screen. This exists because NS-16 is a service,
 * a permission ladder and a durability guarantee — none of which can be checked
 * by reading, and all of which would otherwise have to wait for a UI ticket to
 * be exercised at all. It requests the permissions in the order Android demands,
 * starts and stops the service, and shows what the recorder is publishing.
 *
 *   adb shell am start -n app.trackevolution/app.trackevolution.recording.RecorderHarnessActivity
 *
 * Drive it on an emulator with `adb emu geo fix <lon> <lat>`, or from extended
 * controls → Location with a GPX of a real lap.
 */
class RecorderHarnessActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { TrackTheme(ThemeChoice.Dark) { HarnessScreen() } }
    }
}

@Composable
private fun HarnessScreen() {
    val context = LocalContext.current
    val state by Recorder.state.collectAsState()
    val finished by Recorder.finished.collectAsState()
    val colors = TrackTheme.colors
    val type = TrackTheme.typography

    // Recomputed whenever a permission request returns, so the readout below
    // reflects the grant rather than a stale snapshot.
    var permissionEpoch by remember { mutableIntStateOf(0) }

    // Fine location and notifications can be asked for together; background
    // location cannot ride along — Android rejects a combined request outright.
    val foreground = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { permissionEpoch++ }
    val background = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { permissionEpoch++ }

    LaunchedEffect(Unit) { Recorder.recoverPending(context) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .systemBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Recorder harness", style = type.h1, color = colors.textStrong)
        Text("Debug only. NS-18 builds the real screen.", style = type.sm, color = colors.textMuted)

        key(permissionEpoch) {
            TrackCard {
                Text("Permissions", style = type.h3, color = colors.textStrong)
                Row2("Location services", RecorderPermissions.locationServicesEnabled(context))
                Row2("Fine location", RecorderPermissions.hasFineLocation(context))
                Row2("Background location", RecorderPermissions.hasBackgroundLocation(context))
                Row2("Notifications", RecorderPermissions.hasNotifications(context))
                Row2("Unrestricted battery", RecorderPermissions.ignoringBatteryOptimizations(context))
                val blocker = RecorderPermissions.blocker(context)
                Text(
                    blocker?.message ?: "Ready to record.",
                    style = type.sm,
                    color = if (blocker == null) colors.accentInk else colors.dangerInk,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }

        Button(
            onClick = {
                foreground.launch(
                    buildList {
                        add(Manifest.permission.ACCESS_FINE_LOCATION)
                        add(Manifest.permission.ACCESS_COARSE_LOCATION)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            add(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    }.toTypedArray(),
                )
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.accent,
                contentColor = colors.accentContrast,
            ),
        ) { Text("1. Grant location + notifications", style = type.bodyStrong) }

        Button(
            onClick = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    background.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                }
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.surfaceRaised,
                contentColor = colors.textStrong,
            ),
        ) { Text("2. Grant background location (separate ask)", style = type.bodyStrong) }

        Button(
            onClick = {
                // The system dialog; refused twice and it stops appearing, at
                // which point Settings is the only way.
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ),
                )
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.surfaceRaised,
                contentColor = colors.textStrong,
            ),
        ) { Text("App settings", style = type.bodyStrong) }

        TrackCard {
            Text("Recorder", style = type.h3, color = colors.textStrong)
            Text(
                if (state.isRecording) "Recording" else "Idle",
                style = type.lapTimeHero,
                color = if (state.isRecording) colors.accentInk else colors.textMuted,
            )
            Text("${state.fixCount} fixes", style = type.body, color = colors.textBody)
            Text(
                "elapsed ${RecordingNotification.formatElapsed(state.elapsedS)}",
                style = type.lapTime,
                color = colors.textBody,
            )
            if (state.autoStopped) {
                Text("auto-stopped", style = type.sm, color = colors.dangerInk)
            }
            state.blocker?.let { Text(it.message, style = type.sm, color = colors.dangerInk) }
        }

        Button(
            onClick = {
                if (state.isRecording) Recorder.stop(context) else Recorder.start(context, null)
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (state.isRecording) colors.danger else colors.accent,
                contentColor = colors.accentContrast,
            ),
        ) { Text(if (state.isRecording) "Stop" else "Start recording", style = type.bodyStrong) }

        finished?.let { recording ->
            TrackCard(color = colors.accentTint, border = colors.accent) {
                Text("Recording to review", style = type.h3, color = colors.textStrong)
                Text(
                    "${recording.fixes.size} fixes · event ${recording.eventId ?: "none"}",
                    style = type.sm,
                    color = colors.textBody,
                )
                Text(
                    "Recovered from disk if this survived a force-stop.",
                    style = type.xs,
                    color = colors.textMuted,
                )
                Button(
                    onClick = { Recorder.consumeFinished(context) },
                    modifier = Modifier.padding(top = 8.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.surfaceRaised,
                        contentColor = colors.textStrong,
                    ),
                ) { Text("Discard", style = type.sm) }
            }
        }
    }
}

@Composable
private fun Row2(label: String, ok: Boolean) {
    Text(
        "${if (ok) "✓" else "✗"}  $label",
        style = TrackTheme.typography.sm,
        color = if (ok) TrackTheme.colors.textBody else TrackTheme.colors.textFaint,
    )
}
