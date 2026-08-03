package app.trackevolution.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

    /** Carries the server's own message — the API contract is `{ error }`. */
    data class Failed(val message: String) : LoadState
}

/**
 * Loading, failed-with-retry, or content.
 *
 * A failure shows the server's message and a Retry rather than an empty screen:
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
            Text(
                state.message,
                style = TrackTheme.typography.sm,
                color = TrackTheme.colors.textMuted,
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = onRetry) {
                Text("Retry", style = TrackTheme.typography.bodyStrong, color = TrackTheme.colors.accentInk)
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

/** What a list says when it has nothing in it — never a blank space. */
@Composable
fun TEEmpty(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = TrackTheme.typography.sm,
        color = TrackTheme.colors.textMuted,
        modifier = modifier.padding(vertical = 8.dp),
    )
}

/** One headline number with its label. */
@Composable
fun TEStatTile(label: String, value: String, modifier: Modifier = Modifier) {
    TrackCard(modifier = modifier, contentPadding = 12.dp) {
        Text(value, style = TrackTheme.typography.h2, color = TrackTheme.colors.textStrong)
        Text(label, style = TrackTheme.typography.xxs, color = TrackTheme.colors.textMuted)
    }
}

/** A row of tiles, sharing the width evenly. */
@Composable
fun TEStatRow(tiles: List<Pair<String, String>>, modifier: Modifier = Modifier) {
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        tiles.forEach { (label, value) ->
            TEStatTile(label = label, value = value, modifier = Modifier.weight(1f))
        }
    }
}

/** A tappable card that navigates. */
@Composable
fun TENavCard(onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    TrackCard(modifier = modifier.fillMaxWidth().clickable(onClick = onClick)) { content() }
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

/** Dot-separated metadata, skipping whatever is absent. */
@Composable
fun TEMeta(parts: List<String?>, modifier: Modifier = Modifier) {
    val text = parts.filter { !it.isNullOrBlank() }.joinToString(" · ")
    if (text.isEmpty()) return
    Text(text, style = TrackTheme.typography.xs, color = TrackTheme.colors.textMuted, modifier = modifier)
}
