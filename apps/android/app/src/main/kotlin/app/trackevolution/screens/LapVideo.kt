package app.trackevolution.screens

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.trackevolution.clips.ClipNetwork
import app.trackevolution.clips.ClipUploadText
import app.trackevolution.clips.LocalClipStatus
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.clips.ClipUploadQueue
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.offline.OfflineStore
import app.trackevolution.core.telemetry.LapClips
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor

/**
 * What the lap page says about a lap's best-lap video (NS-45). Pure, so every
 * branch — whose tier, whose logbook, which job — is a unit test
 * (`LapVideoStateTest`) rather than a screen to open.
 */
internal sealed interface LapVideoState {
    /** No video, and none on its way. */
    data object None : LapVideoState

    /** The driver's own clip, on a free account: kept, and offered back (`TEProLocked`). */
    data object Locked : LapVideoState

    /** A coach reading a free student's clip: the upgrade is the student's (`studentFreeNote`'s rule). */
    data class StudentLocked(val name: String?) : LapVideoState {
        val text: String get() = "Lap videos play while ${name ?: "this driver"} has Pro."
    }

    /** Playable. [menu] is Download and Delete — the owner's, never a coach's. */
    data class Playable(val clip: LapClip, val menu: Boolean) : LapVideoState

    /** A clip being cut from the source video on this phone. */
    data object Preparing : LapVideoState

    /** The session was saved offline and hasn't reached the server yet. */
    data object WaitingForSession : LapVideoState

    /** No network at all. */
    data object WaitingForConnection : LapVideoState

    /** Held for an unmetered network by Settings' cellular switch. */
    data object WaitingForWifi : LapVideoState

    /** On its way: [fraction] of the clip's bytes the server holds or is receiving. */
    data class Uploading(val fraction: Double) : LapVideoState

    /** The last attempt failed; the next is at [atMs] (epoch). *Retry now* runs job [jobId] at once. */
    data class Retrying(val atMs: Long, val jobId: String) : LapVideoState

    /**
     * The cut failed ([reason] null) or the upload was given up on ([reason] a
     * `DropReason`'s raw value). Said once — the card acknowledges job [jobId]
     * as it says it — and the session is fine either way.
     */
    data class Failed(val reason: String?, val jobId: String) : LapVideoState

    companion object {
        /**
         * [jobs] are this phone's upload jobs; [resolve] maps a job's temp
         * session id to the real one where the queue has flushed it; [parts]
         * is the bytes sent of each job's part in flight. A coach has none —
         * jobs are the driver's own — so a student's logbook never shows a
         * pending state.
         *
         * The order is iOS's `ClipUploader.status`: a part in flight says how
         * far it has got unless the network has gone; otherwise a backoff says
         * when it tries again, then what the job is waiting for.
         */
        fun of(
            lap: Lap,
            sessionId: Int,
            sessionLaps: List<Lap>,
            owner: LogbookOwner,
            viewer: Entitlement?,
            jobs: List<ClipJob>,
            resolve: (Int) -> Int?,
            cellularAllowed: Boolean,
            network: ClipNetwork,
            parts: Map<String, Long> = emptyMap(),
            nowMs: Long = System.currentTimeMillis(),
        ): LapVideoState {
            val clip = lap.clip
            if (clip != null) {
                return when {
                    Entitlement.canSaveLapVideo(owner.entitlement(viewer)) -> Playable(clip, menu = !owner.readOnly)
                    owner is LogbookOwner.Student -> StudentLocked(owner.name)
                    else -> Locked
                }
            }
            if (owner.readOnly) return None
            // A job lands on the lap it names (NS-50: one job per lap when a
            // session saves every lap, each with its lap number); one from
            // before lap numbers lands on the lowest lap number with its time,
            // the server's old rule, so a second lap tied on time never shows
            // the first one's upload — iOS's `ClipUploadQueue.clipLap`, under
            // the same name here.
            val mine = jobs.filter { job ->
                ClipUploadQueue.isFor(
                    jobSessionId = job.sessionId,
                    jobTimeMs = job.timeMs,
                    sessionId = sessionId,
                    resolved = if (OfflineStore.isTemp(job.sessionId)) resolve(job.sessionId) else null,
                    timeMs = lap.timeMs,
                    jobLapNum = job.lapNum,
                    lapNum = lap.lapNum,
                ) && ClipUploadQueue.clipLap(sessionLaps, job.timeMs, job.lapNum)?.id == lap.id
            }
            // One on its way outranks an old failure for the same lap.
            val job = mine.lastOrNull { !it.failed } ?: mine.lastOrNull() ?: return None
            val waiting = when {
                !network.online -> WaitingForConnection
                network.metered && !cellularAllowed -> WaitingForWifi
                else -> null
            }
            return when (job.state) {
                ClipJob.State.CUT_FAILED -> Failed(null, job.id)
                ClipJob.State.DROPPED -> Failed(job.dropReason ?: ClipUploadQueue.DropReason.REFUSED.rawValue, job.id)
                ClipJob.State.CUTTING -> Preparing
                ClipJob.State.PENDING -> {
                    val sending = parts[job.id]
                    val notBefore = job.notBeforeMs
                    when {
                        sending != null -> waiting ?: Uploading(fraction(job, sending))
                        notBefore != null && job.failures > 0 && notBefore > nowMs -> Retrying(notBefore, job.id)
                        OfflineStore.isTemp(job.sessionId) && resolve(job.sessionId) == null -> WaitingForSession
                        else -> waiting ?: Uploading(fraction(job, 0))
                    }
                }
            }
        }

        /** The share of [job]'s bytes the server holds, plus [sending] of the part in flight. */
        fun fraction(job: ClipJob, sending: Long): Double = ClipUploadText.fraction(job, sending)
    }
}

/** The words, shared with the web and iOS where they have them. */
internal object LapVideoText {
    const val NEEDS_CONNECTION = "Playing a lap video needs a connection."
    const val DELETED = "This video has been deleted."
    const val CONFIRM_DELETE = "Delete this lap video? The lap and its telemetry stay."
    const val DELETE_NEEDS_CONNECTION = "Deleting a lap video needs a connection."
    const val PREPARING = "Preparing video"
    const val WAITING_FOR_SESSION = "Video waiting for this session to sync"
    const val WAITING_FOR_CONNECTION = "Video waiting for a connection"
    const val WAITING_FOR_WIFI = "Video waiting for Wi-Fi"
    const val UPLOADING = "Video uploading"
    const val RETRY_NOW = "Retry now"
    const val CUT_FAILED = "Couldn't save this lap's video."
    const val LOCKED_BLURB = "Your lap video is kept. Pro plays it, downloads it and saves new ones from a video import."

    /** A clip on its way, in iOS's `ClipPendingCard.text` words; null for any other state. */
    fun pending(state: LapVideoState, nowMs: Long): String? = when (state) {
        LapVideoState.Preparing -> PREPARING
        LapVideoState.WaitingForSession -> WAITING_FOR_SESSION
        LapVideoState.WaitingForConnection -> WAITING_FOR_CONNECTION
        LapVideoState.WaitingForWifi -> WAITING_FOR_WIFI
        is LapVideoState.Uploading -> {
            val percent = floor(state.fraction * 100).toInt()
            if (percent > 0) "$UPLOADING · $percent%" else UPLOADING
        }
        is LapVideoState.Retrying -> {
            val seconds = (state.atMs - nowMs) / 1000.0
            if (seconds <= 60) {
                "Video upload interrupted. Trying again shortly."
            } else {
                "Video upload interrupted. Trying again in ${ceil(seconds / 60).toInt()} min."
            }
        }
        else -> null
    }

    /** Why a lap has no video after all — iOS's `ClipUploader.failureText`. */
    fun failure(reason: String?): String = when (ClipUploadQueue.DropReason.entries.firstOrNull { it.rawValue == reason }) {
        ClipUploadQueue.DropReason.STORAGE_FULL -> "Couldn't upload this lap's video: your video storage is full."
        ClipUploadQueue.DropReason.PRO_REQUIRED -> "Couldn't upload this lap's video: saving lap videos needs Pro."
        null -> CUT_FAILED
        else -> "Couldn't upload this lap's video."
    }
}

/**
 * The lap's best-lap video, above its trace (NS-45): a Media3 ExoPlayer fed
 * from the signed URL and opened on the lap's first frame — `lap_offset_ms`,
 * measured from the cut, so the pre-roll is one scrub back — with Download and
 * Delete in a menu for the owner. A free owner sees the locked card; a coach
 * of a free student the student-tier sentence; a clip still on this phone its
 * upload state; and offline, the player says it needs a connection rather
 * than spinning.
 *
 * Tap to load: the URL is fetched when the driver asks to watch, not when the
 * page opens, so a lap page read in a paddock costs no request.
 */
@Composable
internal fun LapVideoCard(
    api: ApiClient,
    owner: LogbookOwner,
    viewer: Entitlement?,
    sessionId: Int,
    lap: Lap,
    sessionLaps: List<Lap>,
    onSubscribe: () -> Unit,
    onDeleted: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val clips = LocalClipStatus.current
    val jobs by clips.jobs.collectAsState()
    val parts by clips.parts.collectAsState()
    val network by clips.network.collectAsState()
    val cellular by clips.cellularAllowed.collectAsState(initial = false)
    // Temp session ids on this lap's jobs, resolved once each through the id map.
    val resolved by produceState(emptyMap<Int, Int>(), jobs) {
        value = jobs.map { it.sessionId }.filter { OfflineStore.isTemp(it) }.distinct()
            .mapNotNull { temp -> api.resolveTempId(temp)?.let { temp to it } }.toMap()
    }
    // Ticks while anything is on its way, so "Trying again in 2 min" counts down.
    val now by produceState(System.currentTimeMillis(), jobs.isNotEmpty()) {
        while (jobs.isNotEmpty()) {
            delay(TICK_MS)
            value = System.currentTimeMillis()
        }
    }
    val state = LapVideoState.of(
        lap = lap,
        sessionId = sessionId,
        sessionLaps = sessionLaps,
        owner = owner,
        viewer = viewer,
        jobs = jobs,
        resolve = { resolved[it] },
        cellularAllowed = cellular,
        network = network,
        parts = parts,
        nowMs = now,
    )
    // A failure is said once: kept here (through a rotation) once seen, and
    // forgotten by the manifest, so the next visit to the lap is quiet.
    var said by rememberSaveable(lap.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(state) {
        if (state is LapVideoState.Failed) {
            said = LapVideoText.failure(state.reason)
            clips.acknowledge(state.jobId)
        }
    }

    when (state) {
        LapVideoState.None, is LapVideoState.Failed ->
            said?.let { Note(it, modifier.testTag("lapVideoFailed")) }
        LapVideoState.Locked -> TEProLocked(
            title = "Lap video",
            blurb = LapVideoText.LOCKED_BLURB,
            onSubscribe = onSubscribe,
            modifier = modifier.testTag("lapVideoLocked"),
        )
        is LapVideoState.StudentLocked -> Note(state.text, modifier.testTag("lapVideoStudentLocked"))
        is LapVideoState.Retrying -> Pending(
            LapVideoText.pending(state, now).orEmpty(),
            onRetry = { clips.retryNow(state.jobId) },
            modifier = modifier,
        )
        LapVideoState.Preparing,
        LapVideoState.WaitingForSession,
        LapVideoState.WaitingForConnection,
        LapVideoState.WaitingForWifi,
        is LapVideoState.Uploading,
        -> Pending(LapVideoText.pending(state, now).orEmpty(), onRetry = null, modifier = modifier)
        is LapVideoState.Playable -> Playable(api, state, lap, onDeleted, modifier)
    }
}

/** A clip on its way, and — after a failed attempt — *Retry now*, also offered as the card's accessibility action. */
@Composable
private fun Pending(text: String, onRetry: (() -> Unit)?, modifier: Modifier) {
    TrackCard(
        modifier.fillMaxWidth().testTag("lapVideoPending").semantics {
            if (onRetry != null) {
                customActions = listOf(CustomAccessibilityAction(LapVideoText.RETRY_NOW) { onRetry(); true })
            }
        },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = TrackTheme.typography.sm, color = TrackTheme.colors.textMuted, modifier = Modifier.weight(1f))
            if (onRetry != null) {
                TextButton(onClick = onRetry, modifier = Modifier.testTag("lapVideoRetry")) {
                    Text(LapVideoText.RETRY_NOW, style = TrackTheme.typography.sm, color = TrackTheme.colors.accentInk)
                }
            }
        }
    }
}

@Composable
private fun Note(text: String, modifier: Modifier) {
    TrackCard(modifier.fillMaxWidth()) {
        Text(text, style = TrackTheme.typography.sm, color = TrackTheme.colors.textMuted)
    }
}

/**
 * A best-lap video on a shared event or session's page (NS-48): the player
 * alone — no menu, no upload state, no locked card. The server sends a `clip`
 * only while the owner has Pro, so a lap without one draws nothing; [signedUrl]
 * is the link's own `GET /api/share/(e|s)/:token/clips/:id/url`.
 */
@Composable
internal fun SharedLapVideoCard(
    api: ApiClient,
    lap: Lap,
    signedUrl: suspend (clipId: Int) -> String,
    modifier: Modifier = Modifier,
) {
    val clip = lap.clip ?: return
    Playable(api, LapVideoState.Playable(clip, menu = false), lap, onDeleted = {}, modifier, signedUrl)
}

@Composable
private fun Playable(
    api: ApiClient,
    state: LapVideoState.Playable,
    lap: Lap,
    onDeleted: () -> Unit,
    modifier: Modifier,
    /** Where the signed URL comes from: the owner's clip route, or a share link's (NS-48). */
    signedUrl: suspend (clipId: Int) -> String = { api.clipUrl(it).url },
) {
    val colors = TrackTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val appContext = context.applicationContext
    val holder = viewModel<ClipPlayerHolder>(key = "lap-clip-player-${state.clip.id}") { ClipPlayerHolder(appContext) }
    val open = holder.open
    var message by remember(state.clip.id) { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(open, state.clip.id) {
        if (!open || holder.url != null) return@LaunchedEffect
        message = null
        try {
            holder.url = signedUrl(state.clip.id)
        } catch (e: ApiException) {
            message = when {
                e is ApiException.Transport -> LapVideoText.NEEDS_CONNECTION
                e.isNotFound -> LapVideoText.DELETED
                else -> e.message
            }
        }
    }

    TrackCard(modifier.fillMaxWidth().testTag("lapVideo")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Lap ${lap.lapNum} video",
                style = TrackTheme.typography.bodyStrong,
                color = colors.textStrong,
                modifier = Modifier.weight(1f),
            )
            if (state.menu) {
                Box {
                    TextButton(onClick = { menu = true }, modifier = Modifier.testTag("lapVideoMenu")) {
                        Text("•••", style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text("Download video") },
                            onClick = {
                                menu = false
                                busy = "Downloading…"
                                scope.launch {
                                    message = download(context, api, state.clip.id)
                                    busy = null
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Delete video", color = colors.dangerInk) },
                            onClick = { menu = false; confirmDelete = true },
                        )
                    }
                }
            }
        }
        val playing = holder.url
        when {
            !open -> TextButton(onClick = { holder.open = true }, modifier = Modifier.testTag("lapVideoPlay")) {
                Text("▶ Play lap video", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
            playing != null -> ClipPlayer(holder, playing, state.clip.lapOffsetMs) { message = it }
            message == null -> Text("Loading…", style = TrackTheme.typography.sm, color = colors.textMuted)
        }
        (busy ?: message)?.let {
            Text(it, style = TrackTheme.typography.sm, color = colors.textMuted, modifier = Modifier.padding(top = 6.dp))
        }
    }

    if (confirmDelete) {
        TEConfirmDialog(
            text = LapVideoText.CONFIRM_DELETE,
            confirm = "Delete video",
            onConfirm = {
                confirmDelete = false
                scope.launch {
                    try {
                        api.deleteClip(state.clip.id)
                        onDeleted()
                    } catch (e: ApiException) {
                        message = if (e is ApiException.Transport) LapVideoText.DELETE_NEEDS_CONNECTION else e.message
                    }
                }
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

/**
 * The lap video's player, held on the lap page's back-stack entry rather than
 * `remember`ed in the card. Turning the phone sideways is how a driver watches a
 * lap full screen, and a rotation throws the card's composition away: a
 * `remember`ed player would be released and rebuilt from the signed URL, back at
 * the lap's first frame. This one keeps playing through it, and is released when
 * the lap page leaves the back stack.
 *
 * [url] is the signed URL, kept here for the same reason: a rotation must not
 * spend a request on a URL that is good for an hour.
 *
 * [open] lives here too rather than in a `rememberSaveable`: on a tablet or a
 * phone turned sideways, the rotation also crosses the two-pane breakpoint, and
 * the lap page's saveable state does not survive that move between panes. A card
 * that forgot it was open while this holder kept playing left the video's sound
 * running behind a *Play* button, with [fullscreen] stranded to reopen the dialog
 * on the next tap. One lifetime for all four is what keeps them agreeing.
 */
internal class ClipPlayerHolder(private val context: Context) : ViewModel() {
    var open by mutableStateOf(false)
    var url by mutableStateOf<String?>(null)
    var fullscreen by mutableStateOf(false)
    private var player: ExoPlayer? = null
    private var playerUrl: String? = null

    /** The player for [url], prepared at [offsetMs] the first time it is asked for. */
    fun player(url: String, offsetMs: Int): ExoPlayer {
        player?.let { if (playerUrl == url) return it else it.release() }
        return ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            // A couple of seconds of run-up, so the crossing is on screen.
            seekTo(LapClips.playbackStartMs(offsetMs).toLong())
            prepare()
            playWhenReady = true
        }.also {
            player = it
            playerUrl = url
        }
    }

    override fun onCleared() {
        player?.release()
        player = null
    }
}

/**
 * ExoPlayer over the signed URL, prepared at [offsetMs] so it opens on the
 * lap's first frame, with Media3's own fullscreen button.
 *
 * `PlayerView` draws that button only when the app says what fullscreen means,
 * which here is a dialog over the whole window, system bars hidden, showing the
 * **same** player: it moves from one view to the other without stopping. The
 * card's view lets go of the player while the dialog has it. Back, or the
 * button again, comes out.
 *
 * Scrolling the card off the lap page pauses the video; a rotation does not.
 */
@OptIn(UnstableApi::class) // PlayerView.setFullscreenButtonState
@Composable
private fun ClipPlayer(holder: ClipPlayerHolder, url: String, offsetMs: Int, onError: (String) -> Unit) {
    val context = LocalContext.current
    val player = remember(holder, url) { holder.player(url, offsetMs) }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                onError(
                    if (error.errorCode in NETWORK_ERRORS) LapVideoText.NEEDS_CONNECTION else "Couldn't play this video: ${error.errorCodeName}",
                )
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            if (context.findActivity()?.isChangingConfigurations != true) player.pause()
        }
    }
    val fullscreen = holder.fullscreen
    AndroidView(
        factory = {
            PlayerView(it).apply {
                // Only the way in: `setFullscreenButtonState` below calls this
                // listener too, and must not reopen what Back just closed.
                setFullscreenButtonClickListener { entering -> if (entering) holder.fullscreen = true }
            }
        },
        update = { view ->
            view.player = if (fullscreen) null else player
            view.setFullscreenButtonState(false)
        },
        onRelease = { it.player = null },
        modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).padding(top = 8.dp).testTag("lapVideoPlayer"),
    )
    if (fullscreen) {
        Dialog(
            onDismissRequest = { holder.fullscreen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            val window = (LocalView.current.parent as? DialogWindowProvider)?.window
            DisposableEffect(window) {
                window?.let { w ->
                    w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    WindowCompat.setDecorFitsSystemWindows(w, false)
                    WindowCompat.getInsetsController(w, w.decorView).apply {
                        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        hide(WindowInsetsCompat.Type.systemBars())
                    }
                }
                onDispose {}
            }
            AndroidView(
                factory = {
                    PlayerView(it).apply {
                        setFullscreenButtonState(true)
                        setFullscreenButtonClickListener { entering -> if (!entering) holder.fullscreen = false }
                    }
                },
                update = { view -> view.player = player },
                onRelease = { it.player = null },
                modifier = Modifier.fillMaxSize().background(Color.Black).testTag("lapVideoFullscreen"),
            )
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private val NETWORK_ERRORS = setOf(
    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
)

/**
 * Download through `GET /clips/:id/download` into the cache's
 * `clip-downloads/` (the FileProvider's one other directory) and hand it to the
 * share sheet — Save to Files, Drive or Photos, as iOS's `ShareLink` does.
 * Answers what to say, or null when the sheet opened.
 */
private suspend fun download(context: Context, api: ApiClient, clipId: Int): String? {
    val dir = File(context.cacheDir, "clip-downloads")
    val file = try {
        withContext(Dispatchers.IO) {
            dir.mkdirs()
            dir.listFiles()?.forEach { it.delete() }
            var out: File? = null
            api.downloadClip(clipId) { name ->
                File(dir, name.replace(Regex("[^A-Za-z0-9._-]"), "_")).also { out = it }.outputStream()
            }
            out!!
        }
    } catch (e: ApiException) {
        return if (e is ApiException.Transport) "Downloading a lap video needs a connection." else e.message
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.wrapped", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "video/mp4"
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri(null, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    return null
}

/** How often a pending card re-reads the clock, for its countdown. */
private const val TICK_MS = 5_000L
