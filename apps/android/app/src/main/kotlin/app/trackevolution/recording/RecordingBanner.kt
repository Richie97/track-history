package app.trackevolution.recording

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Recording
import app.trackevolution.ui.theme.TrackTheme

/**
 * The strip that says a recording is happening — or that one is waiting to be
 * saved — wherever you are in the app.
 *
 * Required by NS-17/NS-18 for a real reason: the recording is app-global and
 * survives navigation, so without this it is possible to have a session running
 * (or, worse, an unsaved one sitting on disk) with nothing on screen saying so.
 * An unattached recording is the sharpest case — it belongs to no event, so
 * there is no event page to stumble across it on.
 */
@Composable
fun RecordingBanner(
    state: RecorderState,
    pending: Recording?,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography

    when {
        state.isRecording -> Banner(
            modifier = modifier,
            background = colors.accentTint,
            border = colors.accent,
            onClick = onOpen,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LiveDot(colors.accent)
                Column(modifier = Modifier.padding(start = 10.dp)) {
                    Text("Recording laps", style = type.bodyStrong, color = colors.textStrong)
                    Text(
                        "${RecordingNotification.formatElapsed(state.elapsedS)} · " +
                            "${state.fixCount} fixes",
                        style = type.xs,
                        color = colors.textMuted,
                    )
                }
            }
        }

        pending != null -> Banner(
            modifier = modifier,
            background = colors.surfaceRaised,
            border = colors.borderStrong,
            onClick = onOpen,
        ) {
            Column {
                Text("Unsaved recording", style = type.bodyStrong, color = colors.textStrong)
                Text(
                    "${pending.fixes.size} fixes waiting to be reviewed and saved.",
                    style = type.xs,
                    color = colors.textMuted,
                )
            }
        }
    }
}

@Composable
private fun Banner(
    modifier: Modifier,
    background: androidx.compose.ui.graphics.Color,
    border: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(TrackTheme.radii.md)
    Row(
        modifier = modifier
            .fillMaxWidth()
            // Hairline plus one surface step, like every other card in the
            // system — no shadow.
            .background(background, shape)
            .border(1.dp, border, shape)
            .clickable(onClick = onClick)
            .padding(12.dp),
        horizontalArrangement = Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        content()
    }
}

/** The live dot. Small, and the only thing on the banner that is pure signal. */
@Composable
private fun LiveDot(color: androidx.compose.ui.graphics.Color) {
    Box(modifier = Modifier.size(9.dp).background(color, CircleShape))
}
