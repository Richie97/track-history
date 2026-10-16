package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.ItemShareKind
import app.trackevolution.core.model.ItemShareLink
import app.trackevolution.core.offline.OfflineStore
import app.trackevolution.navigation.shareLink
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The words of sharing one event or one session (NS-48), on both sides of the
 * link — the owner's dialog and the page the link opens. One place, so the
 * sentence that promises what a link shows and the page that shows it can't
 * drift apart. iOS's `ItemShareText` under the same name, and the web's
 * `SHARE_ITEM_TEXT`, word for word.
 */
internal object ItemShareText {
    /** What the item is called in a sentence. */
    fun noun(kind: ItemShareKind): String = when (kind) {
        ItemShareKind.EVENT -> "this track day"
        ItemShareKind.SESSION -> "this session"
    }

    /** The dialog's promise: what a link shows, and what it never does. */
    fun explanation(kind: ItemShareKind): String =
        "Anyone with this link can see ${noun(kind)} — its laps, racing line, telemetry and video. " +
            "Notes, costs and setup sheets stay private."

    fun title(kind: ItemShareKind): String = when (kind) {
        ItemShareKind.EVENT -> "Share track day"
        ItemShareKind.SESSION -> "Share session"
    }

    const val NEEDS_CONNECTION = "Sharing needs a connection."

    /**
     * An event or session created offline has no id the server knows yet, so
     * there is nothing to mint a link for until its create flushes.
     */
    const val NOT_SYNCED_YET = "Sharing works once this has synced."

    const val COPIED = "Link copied."

    /** A failed share or stop, in words the driver can act on. */
    fun words(error: ApiException): String =
        if (error is ApiException.Transport) NEEDS_CONNECTION else error.message

    // ---- The page a link opens ----------------------------------------------

    const val NOT_FOUND = "This link doesn't exist or has been turned off."
    const val NOT_FOUND_TITLE = "Link not found"
    const val OPEN_NEEDS_CONNECTION = "Opening a shared link needs a connection."

    /** The quiet line under the page's heading. */
    fun byline(kind: ItemShareKind, name: String?): String {
        val who = name?.takeIf { it.isNotEmpty() } ?: "A driver"
        val what = if (kind == ItemShareKind.EVENT) "track day" else "session"
        return "A $what shared by $who — read-only."
    }

    /**
     * Under a free owner's channel panel, in place of an upsell: the tier is the
     * owner's, and the viewer — who may have no account — has nothing to buy.
     */
    fun freeNote(name: String?): String {
        val who = name?.takeIf { it.isNotEmpty() } ?: "The driver"
        return "$who is on the free plan, so this link shows the lap times, the racing line and the " +
            "speed, throttle and brake traces."
    }
}

/**
 * The share dialog's state (NS-48), held by the page's model so its requests run
 * in the model's scope rather than the dialog's composition — the same lifetime
 * every other write on the page has. [open] asks for the link: `POST` answers
 * the one already out there, so opening twice never mints a second. Live
 * writes, never queued.
 */
class ItemShareState(
    private val scope: CoroutineScope,
    private val create: suspend (ItemShareKind, Int) -> ItemShareLink,
    private val stop: suspend (ItemShareKind, Int) -> Unit,
) {
    /** What the dialog is about, or null when it is closed. */
    var target by mutableStateOf<Pair<ItemShareKind, Int>?>(null)
        private set
    var link by mutableStateOf<ItemShareLink?>(null)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    /** Opens the dialog for an item and asks for its link. A repeat for the same item is a no-op. */
    fun open(kind: ItemShareKind, id: Int) {
        if (target == kind to id) return
        target = kind to id
        link = null
        message = null
        if (OfflineStore.isTemp(id)) {
            message = ItemShareText.NOT_SYNCED_YET
            return
        }
        busy = true
        scope.launch {
            try {
                val answer = create(kind, id)
                if (target == kind to id) link = answer
            } catch (e: ApiException) {
                if (target == kind to id) message = ItemShareText.words(e)
            }
            busy = false
        }
    }

    fun copied() {
        message = ItemShareText.COPIED
    }

    /**
     * *Stop sharing*: deletes the link, then hands back to [onStopped] — the
     * caller's close, which clears its saveable choice; a failure stays open and
     * says why.
     */
    fun stopSharing(onStopped: () -> Unit) {
        val (kind, id) = target ?: return
        busy = true
        message = null
        scope.launch {
            try {
                stop(kind, id)
                if (target == kind to id) onStopped()
            } catch (e: ApiException) {
                message = ItemShareText.words(e)
            }
            busy = false
        }
    }

    fun close() {
        target = null
        link = null
        message = null
    }
}

/**
 * *Share…* from the event page or a session card: the link from [state],
 * offered copied, through the system share sheet (`ACTION_SEND`), or stopped.
 *
 * A live write and nothing else: offline it says so rather than queueing,
 * because a link minted later by a replay is a link nobody was shown. The URL
 * is text rather than a field — an `OutlinedTextField` in an `AlertDialog`
 * never lets Robolectric idle — selectable so it can still be copied by hand.
 *
 * The caller keeps *which* item is open in saveable state (an id) and calls
 * [ItemShareState.open] for it, so a recreate re-asks and gets the same link.
 */
@Composable
internal fun ItemShareDialog(state: ItemShareState, onDismiss: () -> Unit) {
    val (kind, _) = state.target ?: return
    val colors = TrackTheme.colors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val link = state.link

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surfaceRaised,
        modifier = Modifier.testTag("itemShareDialog"),
        title = { Text(ItemShareText.title(kind), style = TrackTheme.typography.h3, color = colors.textStrong) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(ItemShareText.explanation(kind), style = TrackTheme.typography.sm, color = colors.textMuted)
                if (link != null) {
                    SelectionContainer {
                        Text(
                            link.url,
                            style = TrackTheme.typography.sm,
                            color = colors.textStrong,
                            modifier = Modifier.testTag("itemShareUrl"),
                        )
                    }
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Button(
                            onClick = {
                                clipboard.setText(AnnotatedString(link.url))
                                state.copied()
                            },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.accent,
                                contentColor = colors.accentContrast,
                            ),
                            modifier = Modifier.testTag("itemShareCopy"),
                        ) {
                            Text("Copy", style = TrackTheme.typography.bodyStrong)
                        }
                        TextButton(
                            onClick = { shareLink(context, link.url) },
                            modifier = Modifier.testTag("itemShareSend"),
                        ) {
                            Text("Share…", style = TrackTheme.typography.sm, color = colors.accentInk)
                        }
                    }
                } else if (state.busy) {
                    Text("Getting the link…", style = TrackTheme.typography.sm, color = colors.textMuted)
                }
                state.message?.let {
                    Text(
                        it,
                        style = TrackTheme.typography.sm,
                        color = colors.textStrong,
                        modifier = Modifier
                            .padding(top = 2.dp)
                            .testTag("itemShareMessage")
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("itemShareDone")) {
                Text("Done", style = TrackTheme.typography.sm, color = colors.textStrong)
            }
        },
        dismissButton = {
            if (link != null) {
                TextButton(
                    enabled = !state.busy,
                    onClick = { state.stopSharing(onDismiss) },
                    modifier = Modifier.testTag("itemShareStop"),
                ) {
                    Text("Stop sharing", style = TrackTheme.typography.sm, color = colors.danger)
                }
            }
        },
    )
}
