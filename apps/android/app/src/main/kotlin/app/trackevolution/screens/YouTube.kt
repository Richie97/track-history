package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.trackevolution.core.YouTubeUpload
import app.trackevolution.core.YouTubeUpload.Offer
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.LapClipYouTube
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import app.trackevolution.youtube.LocalYouTube
import app.trackevolution.youtube.YouTubeHost
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import app.trackevolution.core.model.YouTubeUpload as Upload

/** The words that are this client's own; every shared sentence is `YouTubeUpload`'s. */
internal object YouTubeText {
    const val UPLOAD = "Upload to YouTube…"
    const val CONNECT = "Connect YouTube…"
    const val RECONNECT = "Reconnect YouTube…"
    const val TRY_AGAIN = "Try again"
    const val OPEN = "Open"
    const val DISCONNECT = "Disconnect YouTube"
    const val PERMISSIONS = "Google account permissions"
    const val SETTINGS_BLURB =
        "With Pro, upload a lap video to your YouTube channel from its lap."

    /** How often the status line is re-read while an upload is on its way (the web's `YOUTUBE_POLL_MS`). */
    const val POLL_MS = 5_000L
}

/**
 * The clip as the YouTube offer should read it: the event detail's
 * `clip.youtube`, unless this session has seen a newer row ([latest] — the
 * 202 that started the upload, or a poll), which the cached page predates.
 */
internal fun LapClip.withLatestUpload(latest: Upload?): LapClip =
    if (latest == null) {
        this
    } else {
        copy(
            youtube = LapClipYouTube(
                status = latest.status,
                videoId = youtube?.videoId,
                url = latest.url,
                privacy = latest.privacy,
            ),
        )
    }

/**
 * What a lap's video says and offers about YouTube (NS-46), by
 * `YouTubeUpload.youtubeOffer` — the web's `paintYouTube`:
 *
 *  - `upload`: *Upload to YouTube…*, which opens the form ([onUpload]).
 *  - `connect`: the consent explanation with Google's two links, and
 *    *Connect YouTube…*, which opens Google's consent in a Custom Tab.
 *  - `pending`: the status line, re-read every five seconds while this
 *    destination is resumed.
 *  - `done`: *On YouTube · Unlisted* and *Open*.
 *  - `failed`: the error and *Try again*, which reopens the form.
 *  - `locked`, `none`: nothing at all.
 *
 * Drawn inside the lap video's own card, so it carries no card of its own.
 * [readOnly] is a coach's view, where the offer is always `none`.
 */
@Composable
internal fun YouTubeLapPanel(
    api: ApiClient,
    clip: LapClip,
    viewer: Entitlement?,
    readOnly: Boolean,
    onUpload: (clipId: Int) -> Unit,
    /** The upload finished or failed: the page's event detail is stale. */
    onChanged: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = LocalYouTube.current
    val account by host.account.collectAsState()
    val uploads by host.uploads.collectAsState()
    val latest = uploads[clip.id]
    val effective = clip.withLatestUpload(latest)
    val offer = YouTubeUpload.youtubeOffer(effective, viewer, account, readOnly)
    if (offer == Offer.NONE || offer == Offer.LOCKED) return

    val colors = TrackTheme.colors
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var message by remember(clip.id) { mutableStateOf<String?>(null) }

    // The status route carries what the event detail doesn't — the progress,
    // and a failure's reason — so a pending or failed upload reads it at once,
    // and a pending one again every five seconds while the page is in front.
    val polling = offer == Offer.PENDING
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(clip.id, polling, offer == Offer.FAILED) {
        if (offer != Offer.PENDING && offer != Offer.FAILED) return@LaunchedEffect
        if (offer == Offer.FAILED && latest != null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                try {
                    val upload = api.youTubeUpload(clip.id)
                    message = null
                    host.note(clip.id, upload)
                    if (!YouTubeUpload.youtubeIsPending(upload)) {
                        // A failure may have been the grant going at Google's
                        // end: re-read /me so the line offers Connect rather
                        // than a Try again that can't work.
                        if (upload.status == "failed") host.refresh()
                        if (polling) onChanged()
                        break
                    }
                } catch (e: ApiException) {
                    if (e is ApiException.Transport) {
                        message = YouTubeUpload.YOUTUBE_OFFLINE
                    } else {
                        // A 404: the upload is gone (the cron deleted it, or
                        // the clip went). The page's own copy is what's left.
                        host.forget(clip.id)
                        if (polling) onChanged()
                        break
                    }
                }
                delay(YouTubeText.POLL_MS)
            }
        }
    }

    val line = latest?.let { YouTubeUpload.youtubeStatusLine(it) } ?: YouTubeUpload.youtubeStatusLine(effective.youtube)

    Column(modifier.fillMaxWidth().padding(top = 8.dp).testTag("youtubePanel")) {
        when (offer) {
            Offer.UPLOAD -> PanelButton(YouTubeText.UPLOAD, "youtubeUpload") { onUpload(clip.id) }
            Offer.CONNECT -> {
                YouTubeConsent()
                PanelButton(YouTubeText.CONNECT, "youtubeConnect") {
                    scope.launch { message = host.connect() }
                }
            }
            Offer.PENDING -> Text(
                message ?: line,
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
                modifier = Modifier.testTag("youtubeStatus").semantics { liveRegion = LiveRegionMode.Polite },
            )
            Offer.DONE -> {
                val url = effective.youtube?.url
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.semantics(mergeDescendants = true) {
                        if (url != null) {
                            customActions = listOf(
                                CustomAccessibilityAction("Open on YouTube") { uri.openUri(url); true },
                            )
                        }
                    },
                ) {
                    Text(
                        line,
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                        modifier = Modifier.weight(1f).testTag("youtubeStatus"),
                    )
                    if (url != null) {
                        TextButton(onClick = { uri.openUri(url) }, modifier = Modifier.testTag("youtubeOpen")) {
                            Text(YouTubeText.OPEN, style = TrackTheme.typography.sm, color = colors.accentInk)
                        }
                    }
                }
            }
            Offer.FAILED -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    line,
                    style = TrackTheme.typography.sm,
                    color = colors.dangerInk,
                    modifier = Modifier.weight(1f).testTag("youtubeStatus"),
                )
                TextButton(onClick = { onUpload(clip.id) }, modifier = Modifier.testTag("youtubeRetry")) {
                    Text(YouTubeText.TRY_AGAIN, style = TrackTheme.typography.sm, color = colors.accentInk)
                }
            }
            Offer.NONE, Offer.LOCKED -> Unit
        }
        if (offer != Offer.PENDING) {
            message?.let {
                Text(
                    it,
                    style = TrackTheme.typography.sm,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 4.dp).testTag("youtubeMessage"),
                )
            }
        }
    }
}

/**
 * The YouTube line for an owner whose lap video is locked (a lapsed
 * subscription) on a page that draws no video card: only a link already made,
 * or an upload still on its way — the two things `youtubeOffer` keeps for a free
 * account. Draws nothing otherwise.
 */
@Composable
internal fun YouTubeLapsedCard(
    api: ApiClient,
    clip: LapClip,
    viewer: Entitlement?,
    onChanged: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = LocalYouTube.current
    val account by host.account.collectAsState()
    val uploads by host.uploads.collectAsState()
    val offer = YouTubeUpload.youtubeOffer(clip.withLatestUpload(uploads[clip.id]), viewer, account, false)
    if (offer != Offer.DONE && offer != Offer.PENDING) return
    TrackCard(modifier.fillMaxWidth().testTag("youtubeLapsed")) {
        Text("Lap video", style = TrackTheme.typography.bodyStrong, color = TrackTheme.colors.textStrong)
        YouTubeLapPanel(api, clip, viewer, readOnly = false, onUpload = {}, onChanged = onChanged)
    }
}

@Composable
private fun PanelButton(label: String, tag: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.testTag(tag)) {
        Text(label, style = TrackTheme.typography.sm, color = TrackTheme.colors.accentInk)
    }
}

/**
 * The consent explanation, above *Connect* on every client and word for word
 * (`YOUTUBE_CONNECT_TEXT`), with the two documents Google's API terms require
 * as links under it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun YouTubeConsent(modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val uri = LocalUriHandler.current
    Column(modifier.testTag("youtubeConsent")) {
        Text(YouTubeUpload.YOUTUBE_CONNECT_TEXT, style = TrackTheme.typography.xs, color = colors.textMuted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            YouTubeUpload.YOUTUBE_LINKS.forEach { link ->
                TextButton(onClick = { uri.openUri(link.url) }, modifier = Modifier.semantics { role = Role.Button }) {
                    Text("${link.label} ↗", style = TrackTheme.typography.xs, color = colors.accentInk)
                }
            }
        }
    }
}

/**
 * The upload form (NS-46): the title with its count, the description, the
 * visibility — Private, Unlisted or Public, the driver's choice — and which
 * account it goes to. Pre-filled from the server's draft; pops once the upload
 * is queued, having told the lap page ([YouTubeHost.note]).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun YouTubeUploadScreen(
    model: YouTubeUploadModel,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val host = LocalYouTube.current

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.sent) {
        val sent = model.sent ?: return@LaunchedEffect
        host.remember(model.clipId, model.values)
        host.note(model.clipId, sent)
        onDone()
    }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("youtubeForm"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Text("Upload to YouTube", style = TrackTheme.typography.h1, color = colors.textStrong)
            }

            item("title") {
                TEField("Title", hint = "${model.titleCount} / ${YouTubeUploadModel.TITLE_MAX}") {
                    OutlinedTextField(
                        value = model.title,
                        onValueChange = model::setTitleText,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("youtubeTitle"),
                    )
                }
            }

            item("description") {
                TEField("Description") {
                    OutlinedTextField(
                        value = model.description,
                        onValueChange = { model.description = it },
                        minLines = 5,
                        modifier = Modifier.fillMaxWidth().testTag("youtubeDescription"),
                    )
                }
            }

            item("privacy") {
                TEField("Visibility") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        YouTubeUpload.YOUTUBE_PRIVACY.forEach { option ->
                            val selected = model.privacy == option.value
                            // Marked with a border *and* the selected state, never colour alone.
                            TrackCard(
                                modifier = Modifier
                                    .clickable { model.privacy = option.value }
                                    .semantics {
                                        role = Role.RadioButton
                                        this.selected = selected
                                    }
                                    .testTag("youtubePrivacy:${option.value}"),
                                border = if (selected) colors.accent else colors.borderHairline,
                                contentPadding = 10.dp,
                            ) {
                                Text(
                                    option.label,
                                    style = TrackTheme.typography.sm,
                                    color = if (selected) colors.accentInk else colors.textMuted,
                                )
                            }
                        }
                    }
                }
            }

            item("account") {
                val who = model.account?.let { "Uploading to $it · " }.orEmpty()
                Text(
                    who + YouTubeUpload.YOUTUBE_KIDS_TEXT,
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                    modifier = Modifier.testTag("youtubeAccount"),
                )
            }

            model.error?.let { message -> item("error") { TEErrorBanner(message, Modifier.testTag("youtubeError")) } }

            item("actions") {
                Button(
                    onClick = model::upload,
                    enabled = !model.sending && model.title.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.accent,
                        contentColor = colors.accentContrast,
                    ),
                    modifier = Modifier.testTag("youtubeSend"),
                ) {
                    Text(if (model.sending) "Uploading…" else "Upload", style = TrackTheme.typography.bodyStrong)
                }
            }
        }
    }
}

/**
 * Settings → YouTube (NS-46), drawn only while the feature is available to
 * this account: which Google account is connected, *Disconnect YouTube*
 * (confirmed — the videos stay) and Google's permissions page; or, with no live
 * grant, the consent explanation and *Connect YouTube…*. A connect's outcome
 * is said here once.
 *
 * Answers whether it drew anything, so Settings can leave the header off too.
 */
@Composable
internal fun YouTubeSettingsCard(onOpenLink: (String) -> Unit, modifier: Modifier = Modifier) {
    val host = LocalYouTube.current
    val account by host.account.collectAsState()
    val yt = account?.takeIf { it.available } ?: return
    val colors = TrackTheme.colors
    val scope = rememberCoroutineScope()
    // Taken, not read: the sentence is said once, and kept through a rotation.
    var said by rememberSaveable { mutableStateOf<String?>(null) }
    val pending by host.result.collectAsState()
    LaunchedEffect(pending) { host.takeResult()?.let { said = it } }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var confirmDisconnect by rememberSaveable { mutableStateOf(false) }

    TrackCard(modifier.fillMaxWidth().testTag("youtubeSettings")) {
        Text(YouTubeText.SETTINGS_BLURB, style = TrackTheme.typography.xs, color = colors.textFaint)
        said?.let {
            Text(
                it,
                style = TrackTheme.typography.sm,
                color = colors.textStrong,
                modifier = Modifier.padding(top = 8.dp).testTag("youtubeResult")
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        Text(
            YouTubeUpload.youtubeAccountLine(yt),
            style = TrackTheme.typography.body,
            color = colors.textBody,
            modifier = Modifier.padding(top = 8.dp).testTag("youtubeAccountLine"),
        )
        if (yt.connected) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = { confirmDisconnect = true },
                    enabled = !busy,
                    modifier = Modifier.testTag("youtubeDisconnect"),
                ) {
                    Text(YouTubeText.DISCONNECT, style = TrackTheme.typography.sm, color = colors.dangerInk)
                }
                TextButton(
                    onClick = { onOpenLink(YouTubeUpload.GOOGLE_PERMISSIONS_URL) },
                    modifier = Modifier.testTag("youtubePermissions"),
                ) {
                    Text("${YouTubeText.PERMISSIONS} ↗", style = TrackTheme.typography.sm, color = colors.accentInk)
                }
            }
            Text(
                YouTubeUpload.YOUTUBE_DISCONNECT_NOTE,
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
        } else {
            YouTubeConsent(Modifier.padding(top = 4.dp))
            TextButton(
                onClick = {
                    busy = true
                    scope.launch {
                        error = host.connect()
                        busy = false
                    }
                },
                enabled = !busy,
                modifier = Modifier.testTag("youtubeConnect"),
            ) {
                Text(
                    if (yt.account != null) YouTubeText.RECONNECT else YouTubeText.CONNECT,
                    style = TrackTheme.typography.sm,
                    color = colors.accentInk,
                )
            }
        }
        TEErrorBanner(error, Modifier.padding(top = 8.dp))
    }

    if (confirmDisconnect) {
        TEConfirmDialog(
            text = "Disconnect YouTube? ${YouTubeUpload.YOUTUBE_DISCONNECT_NOTE}",
            confirm = "Disconnect",
            onConfirm = {
                confirmDisconnect = false
                busy = true
                error = null
                scope.launch {
                    error = host.disconnect()
                    if (error == null) said = null
                    busy = false
                }
            },
            onDismiss = { confirmDisconnect = false },
        )
    }
}
