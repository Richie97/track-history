package app.trackevolution.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * The shared vocabulary the logbook screens are built from (NS-26).
 *
 * These exist so five screens agree on what a section heading, an empty state
 * and a failed load look like — the counterpart of iOS's `Components.swift`.
 * Everything here is layout over `TrackTheme` tokens; nothing fetches.
 */

/** Where a screen's data is. */
sealed interface LoadState {
    data object Loading : LoadState
    data object Ready : LoadState

    /**
     * Carries the server's own message — the API contract is `{ error }`.
     * [retryable] is false when the answer is final (the thing is gone, or
     * was never there), so the screen doesn't offer a Try again that can only
     * fail the same way.
     *
     * There is no paywall case: a 402 locks a *section* in place
     * ([TEProLocked]) rather than the whole screen, since NS-37 made every
     * page's free half readable by every account.
     *
     * [title] overrides the heading where a screen has its own words for the
     * failure ("Link not found" on a share page); null is iOS's rule —
     * "Couldn't load this", or "Not found" when the answer is final.
     */
    data class Failed(val message: String, val retryable: Boolean = true, val title: String? = null) : LoadState
}

/**
 * Loading, failed-with-retry, or content.
 *
 * A failure shows the server's message and a Try again rather than an empty screen:
 * offline is the expected case here, not the exceptional one.
 */
@Composable
fun TELoadable(
    state: LoadState,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    when (state) {
        LoadState.Loading -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = TrackTheme.colors.accent)
        }

        is LoadState.Failed -> Column(
            modifier = modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // iOS's TELoadable says the same: a final answer is "Not found",
            // anything worth retrying "Couldn't load this".
            Text(
                state.title ?: if (state.retryable) "Couldn't load this" else "Not found",
                style = TrackTheme.typography.h3,
                color = TrackTheme.colors.textStrong,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                state.message,
                style = TrackTheme.typography.sm,
                color = TrackTheme.colors.textMuted,
                textAlign = TextAlign.Center,
            )
            if (state.retryable) {
                Spacer(Modifier.height(12.dp))
                TERetryButton(onClick = onRetry)
            }
        }

        LoadState.Ready -> content()
    }
}

@Composable
fun TESectionHeader(title: String, detail: String? = null, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Bottom,
    ) {
        Text(title, style = TrackTheme.typography.h3, color = TrackTheme.colors.textStrong)
        if (detail != null) {
            Text(detail, style = TrackTheme.typography.xs, color = TrackTheme.colors.textMuted)
        }
    }
}

/** The next step an empty state offers: a label and what it does. */
data class TEEmptyAction(val label: String, val onClick: () -> Unit)

/**
 * What a list says when it has nothing in it — never a blank space — and,
 * where the next step isn't already on screen, the button that takes it
 * (#342). The web's `emptyHtml` and iOS's `TEEmpty` take the same three parts.
 */
@Composable
fun TEEmpty(
    text: String,
    modifier: Modifier = Modifier,
    title: String? = null,
    action: TEEmptyAction? = null,
) {
    Column(modifier = modifier.padding(vertical = 8.dp)) {
        if (title != null) {
            Text(title, style = TrackTheme.typography.bodyStrong, color = TrackTheme.colors.textStrong)
            Spacer(Modifier.height(4.dp))
        }
        Text(text, style = TrackTheme.typography.sm, color = TrackTheme.colors.textMuted)
        if (action != null) {
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = action.onClick,
                modifier = Modifier.semantics { testTag = "emptyAction" },
                colors = ButtonDefaults.buttonColors(
                    containerColor = TrackTheme.colors.accent,
                    contentColor = TrackTheme.colors.accentContrast,
                ),
            ) {
                Text(action.label, style = TrackTheme.typography.bodyStrong)
            }
        }
    }
}

/**
 * The one way a failed load is retried (#342): "Try again", outlined — the
 * dashboard's secondary style. A retry is never the loudest thing on the page;
 * the message above it is the news.
 */
@Composable
fun TERetryButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.semantics { testTag = "retry" },
        border = BorderStroke(1.dp, colors.borderHairline),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = colors.surfaceCard,
            contentColor = colors.textStrong,
        ),
    ) {
        Text("Try again", style = TrackTheme.typography.bodyStrong)
    }
}

/**
 * The detail pane with nothing selected, at expanded width — "Pick an event",
 * "Pick a car" (NS-34, #342). One layout for both tabs: a quiet mark, the
 * heading, a line under it, and whatever the pane offers beneath.
 */
@Composable
fun TEPanePlaceholder(
    title: String,
    tag: String,
    mark: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    eyebrow: String? = null,
    text: String? = null,
    extra: @Composable ColumnScope.() -> Unit = {},
) {
    val colors = TrackTheme.colors
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .padding(24.dp)
            .semantics { testTag = tag },
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        mark()
        if (eyebrow != null) {
            Text(eyebrow, style = TrackTheme.typography.xs, color = colors.textFaint)
        }
        Text(title, style = TrackTheme.typography.h2, color = colors.textStrong, textAlign = TextAlign.Center)
        if (text != null) {
            Text(
                text,
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 320.dp),
            )
        }
        extra()
    }
}

/** One headline number with its label. */
@Composable
fun TEStatTile(label: String, value: String, modifier: Modifier = Modifier) {
    TrackCard(modifier = modifier, contentPadding = 12.dp) {
        Text(
            value,
            style = TrackTheme.typography.h2,
            color = TrackTheme.colors.textStrong,
            // Never wrapped. A lap time broken across two lines — "0:45.18" then
            // "4" — reads as two numbers, and the second one is nonsense.
            maxLines = 1,
        )
        Text(label, style = TrackTheme.typography.xxs, color = TrackTheme.colors.textMuted)
    }
}

/**
 * Tiles sharing the width evenly, wrapping past three.
 *
 * **Four across does not fit a phone.** On a 393dp screen four tiles leave about
 * 60dp of content each, and `0:45.184` at h2 is wider than that — so the event
 * page's four-up row becomes two rows of two rather than a clipped best lap.
 */
@Composable
fun TEStatRow(tiles: List<Pair<String, String>>, modifier: Modifier = Modifier) {
    val perRow = if (tiles.size == 4) 2 else minOf(tiles.size, 3)
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        tiles.chunked(perRow.coerceAtLeast(1)).forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                row.forEach { (label, value) ->
                    TEStatTile(label = label, value = value, modifier = Modifier.weight(1f))
                }
                // Keeps a short final row's tiles the same width as the ones
                // above rather than stretching them across the screen.
                repeat(perRow - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/**
 * A tappable card that navigates.
 *
 * [selected] marks the row the detail pane is currently showing (NS-34), and is
 * only ever true beside a visible detail. The mark is a border *and* a tint,
 * never colour alone: the accent tint is a few percent of lime and disappears
 * entirely for anyone who cannot see it, so the border carries the same
 * information and `selected` semantics carry it to TalkBack.
 */
@Composable
fun TENavCard(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    content: @Composable () -> Unit,
) {
    TrackCard(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics { this.selected = selected },
        color = if (selected) TrackTheme.colors.accentTint else null,
        border = if (selected) TrackTheme.colors.accent else null,
    ) { content() }
}

/**
 * A write that failed, in the server's own words.
 *
 * Separate from [LoadState.Failed] on purpose: a failed *write* must not replace
 * the screen, because the content behind it is still valid and the user needs to
 * see what they were editing.
 */
@Composable
fun TEErrorBanner(message: String?, modifier: Modifier = Modifier) {
    if (message == null) return
    TrackCard(
        modifier = modifier.fillMaxWidth(),
        border = TrackTheme.colors.danger,
        contentPadding = 12.dp,
    ) {
        Text(message, style = TrackTheme.typography.sm, color = TrackTheme.colors.danger)
    }
}

/** A labelled form field with an optional hint underneath. */
@Composable
fun TEField(
    label: String,
    hint: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = TrackTheme.typography.xs, color = TrackTheme.colors.textMuted)
        content()
        if (hint != null) {
            Text(hint, style = TrackTheme.typography.xxs, color = TrackTheme.colors.textFaint)
        }
    }
}

/**
 * Confirm-or-cancel for a destructive action.
 *
 * One shape for all of them — deleting an event, disabling a share link, signing
 * out over unsynced writes — because the cost of getting one of those wrong is
 * the same everywhere, and a dialog that looks different each time is a dialog
 * people stop reading.
 */
@Composable
fun TEConfirmDialog(
    text: String,
    confirm: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = TrackTheme.colors.surfaceRaised,
        title = { Text(text, style = TrackTheme.typography.body, color = TrackTheme.colors.textStrong) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirm, color = TrackTheme.colors.danger)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = TrackTheme.colors.textMuted)
            }
        },
    )
}

/**
 * "1 event" / "3 events" — the noun agreeing with the number.
 *
 * Small, but it is on every track card in the app, and "1 events" is the kind of
 * thing that makes a logbook look unfinished.
 */
fun fmtCount(count: Int, noun: String): String = "$count $noun${if (count == 1) "" else "s"}"

/**
 * A Pro section, **locked in place** (NS-37) — the card a free account sees
 * where the section's content would be, never the section simply missing.
 * Since NS-37 every screen has a free half, so this is the only form a 402
 * takes — there is no whole-screen paywall state.
 */
@Composable
fun TEProLocked(
    title: String,
    blurb: String,
    onSubscribe: () -> Unit,
    modifier: Modifier = Modifier,
) {
    TrackCard(modifier = modifier.fillMaxWidth().semantics { testTag = "proLocked" }) {
        Text("PRO", style = TrackTheme.typography.eyebrow, color = TrackTheme.colors.accentInk)
        Text(title, style = TrackTheme.typography.bodyStrong, color = TrackTheme.colors.textStrong)
        Text(
            blurb,
            style = TrackTheme.typography.sm,
            color = TrackTheme.colors.textMuted,
            modifier = Modifier.padding(top = 4.dp),
        )
        TextButton(onClick = onSubscribe) {
            Text(
                "See Track Evolution Pro",
                style = TrackTheme.typography.bodyStrong,
                color = TrackTheme.colors.accentInk,
            )
        }
    }
}

/** Dot-separated metadata, skipping whatever is absent. */
@Composable
fun TEMeta(parts: List<String?>, modifier: Modifier = Modifier) {
    val text = parts.filter { !it.isNullOrBlank() }.joinToString(" · ")
    if (text.isEmpty()) return
    Text(text, style = TrackTheme.typography.xs, color = TrackTheme.colors.textMuted, modifier = modifier)
}
