package app.trackevolution.videoimport

import android.content.ContentResolver
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Pick a video on the phone and get lap times out of it.
 *
 * The web app's **Import video / telemetry…** does this on a laptop; this does
 * it on the device that already has the footage — a GoPro clip lands in the
 * camera roll over Wi-Fi, a Corvette PDR clip comes off the USB stick into
 * Files, and both are usually there before the laptop is opened. iOS got this
 * first (NS-30); the parsers are the same port, checked against the same
 * fixture, and the review that follows is the *same* screen a stopped
 * recording goes through, because the laps, the line picker and the save are
 * the same job.
 *
 * Only the choosing lives here. Once the clips are parsed [onParsed] hands them
 * to the review overlay and this destination is popped.
 */
@Composable
fun ImportScreen(
    model: ImportModel,
    /** Clips handed straight to the app by a share sheet, parsed on arrival. */
    incoming: List<Uri>?,
    onConsumedIncoming: () -> Unit,
    onParsed: (List<ImportedClip>) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography

    // The system document picker: Files, Downloads, the USB stick, and every
    // photo app that publishes a documents provider — Google Photos included.
    // `content://` URIs from here open as seekable descriptors, so nothing is
    // copied. Multiple selection from the start: a session is often several
    // clips, and the batch is what lets a beacon-timed PDR recording re-anchor
    // a beacon-less one beside it.
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) model.parse(uris)
    }
    // The photo picker, for the camera roll on phones where the document picker
    // doesn't surface it. Same URIs, same no-copy read.
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isNotEmpty()) model.parse(uris)
    }

    LaunchedEffect(incoming) {
        val uris = incoming ?: return@LaunchedEffect
        onConsumedIncoming()
        if (uris.isNotEmpty()) model.parse(uris)
    }

    val clips = model.clips
    LaunchedEffect(clips) {
        if (clips != null) {
            model.consumeClips()
            onParsed(clips)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Import video", style = type.h1, color = colors.textStrong)

        TrackCard(Modifier.fillMaxWidth()) {
            Text("Lap times from video", style = type.h3, color = colors.textStrong)
            Text(
                "Corvette PDR and GoPro clips carry telemetry alongside the picture. Pick one and the " +
                    "laps come out of it here — the video never leaves this phone and is never copied; " +
                    "only its telemetry track is read.",
                style = type.sm,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 6.dp, bottom = 12.dp),
            )

            if (model.isParsing) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp), color = colors.accent)
                    Text(
                        model.progress,
                        style = type.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
                TextButton(onClick = model::cancel) {
                    Text("Cancel", style = type.sm, color = colors.textMuted)
                }
            } else {
                Button(
                    onClick = { documents.launch(arrayOf("video/mp4", "video/quicktime", "video/*")) },
                    modifier = Modifier.fillMaxWidth().testTag("importChooseVideos"),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.accent,
                        contentColor = colors.accentContrast,
                    ),
                ) {
                    Text("Choose videos", style = type.bodyStrong)
                }
                OutlinedButton(
                    onClick = {
                        photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly))
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp).testTag("importChoosePhotos"),
                ) {
                    Text("Choose from Photos", style = type.bodyStrong, color = colors.textStrong)
                }
            }

            model.failure?.let { TEErrorBanner(it, modifier = Modifier.padding(top = 10.dp)) }
        }

        TrackCard(Modifier.fillMaxWidth()) {
            Text("WHAT WORKS", style = type.eyebrow, color = colors.textFaint)
            Text(
                "A PDR clip recorded with the track's beacon arrives with exact lap times and needs " +
                    "nothing from you. A GoPro clip, or a PDR one without beacons, has GPS but no lap " +
                    "markers — tap where the start/finish line is and every pass across it is timed.",
                style = type.xs,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 6.dp),
            )
            Text(
                ".vbo and other logger files stay on the web app, where the screen is bigger and the " +
                    "SD card is already in the laptop.",
                style = type.xs,
                color = colors.textFaint,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

/**
 * Picking and parsing, and the states in between.
 *
 * The parse runs on the IO dispatcher in one job and checks for cancellation
 * between reads — a driver who picked the wrong 4 GB clip must be able to back
 * out. Held by `rememberScreenModel`, so a rotation mid-parse neither restarts
 * nor loses it.
 */
class ImportModel(
    private val scope: CoroutineScope,
    private val resolver: ContentResolver,
) {
    /** Non-null once a selection has been parsed; the review takes it from here. */
    var clips by mutableStateOf<List<ImportedClip>?>(null)
        private set

    var isParsing by mutableStateOf(false)
        private set

    var progress by mutableStateOf("")
        private set

    var failure by mutableStateOf<String?>(null)
        private set

    private var job: Job? = null

    fun parse(uris: List<Uri>) {
        if (uris.isEmpty()) return
        job?.cancel()
        failure = null
        isParsing = true
        progress = "Reading telemetry from ${uris.size} file${if (uris.size == 1) "" else "s"}…"
        job = scope.launch {
            try {
                clips = TelemetryImporter.parse(resolver, uris)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message ?: "Couldn't read the selected videos."
            } finally {
                isParsing = false
            }
        }
    }

    fun cancel() {
        job?.cancel()
        job = null
        isParsing = false
    }

    /** The review has taken the clips; a re-composition must not hand them over twice. */
    fun consumeClips() {
        clips = null
    }
}
