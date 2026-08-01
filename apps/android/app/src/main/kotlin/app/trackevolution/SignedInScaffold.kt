package app.trackevolution

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.activity.compose.BackHandler
import app.trackevolution.recording.RecordScreen
import app.trackevolution.recording.Recorder
import app.trackevolution.recording.RecordingBanner
import app.trackevolution.recording.RecordingFlow
import app.trackevolution.recording.ReviewScreen
import app.trackevolution.ui.theme.TrackTheme

/** Where the signed-in app is. NS-26 replaces this with the real logbook. */
enum class Destination { Home, Record, Review }

/**
 * The signed-in shell, and the navigation NS-18 needs to exist at all.
 *
 * Deliberately a three-way enum rather than a nav library: NS-26 owns the real
 * navigation, and inventing a graph here that it would immediately replace would
 * be work spent on the wrong thing. What it does own — and what NS-26 must keep
 * — is the two rules that make the recorder behave:
 *
 *  - **The banner is above the destination**, so an in-progress or unsaved
 *    recording is visible from everywhere.
 *  - **Back never stops a recording.** It navigates; the service carries on.
 */
@Composable
fun SignedInScaffold(
    flow: RecordingFlow,
    startOnRecord: Boolean,
    onConsumedStartOnRecord: () -> Unit,
    onStartRecording: () -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
    val recorder by Recorder.state.collectAsState()
    val pending by Recorder.finished.collectAsState()
    val review by flow.state.collectAsState()
    val saved by flow.saved.collectAsState()
    var destination by remember { mutableStateOf(Destination.Home) }

    // Tapping the recording notification must land on the recording, not the
    // dashboard — the whole point of it while driving.
    LaunchedEffect(startOnRecord) {
        if (startOnRecord) {
            destination = Destination.Record
            onConsumedStartOnRecord()
        }
    }

    // A recording that just stopped, or one recovered from a previous launch,
    // is what the review screen is for.
    LaunchedEffect(pending) {
        val recording = pending ?: return@LaunchedEffect
        flow.begin(recording)
        // Stopping goes straight to review — that is the flow. A recording
        // *recovered* at launch does not hijack the app the same way: the
        // banner offers it, and the user decides when.
        if (destination == Destination.Record) destination = Destination.Review
    }

    LaunchedEffect(saved) {
        if (saved) {
            destination = Destination.Home
            flow.acknowledgeSaved()
        }
    }

    // Back goes home; it does not stop anything. A recording is not something
    // you should be able to end by accident with a gesture.
    BackHandler(enabled = destination != Destination.Home) {
        destination = Destination.Home
    }

    Column(modifier = Modifier.fillMaxSize().background(TrackTheme.colors.bgPage)) {
        if (destination == Destination.Home) {
            RecordingBanner(
                state = recorder,
                pending = pending,
                onOpen = {
                    destination = if (pending != null && !recorder.isRecording) {
                        Destination.Review
                    } else {
                        Destination.Record
                    }
                },
                modifier = Modifier.systemBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }

        when (destination) {
            Destination.Home -> HomePlaceholder(
                onRecord = { destination = Destination.Record },
                onSignOut = onSignOut,
            )

            Destination.Record -> RecordScreen(
                state = recorder,
                eventLabel = null,
                onStart = onStartRecording,
                onStop = { Recorder.stop(context) },
            )

            Destination.Review -> ReviewScreen(
                state = review,
                onPick = flow::pick,
                onLabelChange = flow::setLabel,
                onNotesChange = flow::setNotes,
                onSelectEvent = flow::selectEvent,
                onSave = { flow.save(context) },
                onDiscard = { flow.discard(context) },
            )
        }
    }
}

@Composable
private fun HomePlaceholder(onRecord: () -> Unit, onSignOut: () -> Unit) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Signed in", style = type.h1, color = colors.textStrong, textAlign = TextAlign.Center)
        Text(
            "The logbook lands with NS-26.",
            style = type.sm,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
        TextButton(onClick = onRecord, modifier = Modifier.padding(top = 24.dp)) {
            Text("Record laps", style = type.bodyStrong, color = colors.accentInk)
        }
        TextButton(onClick = onSignOut) {
            Text("Sign out", style = type.sm, color = colors.textMuted)
        }
    }
}
