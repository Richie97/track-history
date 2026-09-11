package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Event
import app.trackevolution.ui.theme.BrandMark
import app.trackevolution.ui.theme.TrackTheme

/**
 * What the detail pane says when nothing is selected (spec: NS-34).
 *
 * It names the **next upcoming event** and offers it, rather than sitting there as
 * an empty half of the screen or — the thing the spec rules out by name — showing
 * the dashboard a second time. On a track-day morning the one thing wanted from
 * this pane is already known, so it may as well be one tap away.
 *
 * With nothing upcoming it says "Pick an event" and stops. That is deliberately
 * not a call to action: the dashboard beside it already offers *+ Add event*, and
 * a second button competing with it would be two answers to one question.
 */
@Composable
fun DetailPlaceholder(
    api: ApiClient,
    onOpenEvent: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    var next by remember { mutableStateOf<Event?>(null) }

    // The dashboard beside this has already fetched — and warmed — the same list,
    // so through the offline layer this is normally a cache read rather than a
    // request. A failure is swallowed on purpose: a pane saying "Pick an event" is
    // a fine outcome, and an error here would be about the one thing on screen
    // nobody asked for.
    LaunchedEffect(Unit) {
        next = runCatching {
            api.events().filter { EventDates.isUpcoming(it.startDate) }.minByOrNull { it.startDate }
        }.getOrNull()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .padding(24.dp)
            .semantics { testTag = "detailPlaceholder" },
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandMark(size = 40.dp)
        val upcoming = next
        if (upcoming == null) {
            Text("Pick an event", style = TrackTheme.typography.h2, color = colors.textStrong)
            Text(
                "Choose a track day from the list.",
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 320.dp),
            )
        } else {
            Text("Next up", style = TrackTheme.typography.xs, color = colors.textFaint)
            Text(
                upcoming.trackName,
                style = TrackTheme.typography.h2,
                color = colors.textStrong,
                textAlign = TextAlign.Center,
            )
            EventDates.fmtCountdown(upcoming.startDate)?.let {
                Text(it, style = TrackTheme.typography.sm, color = colors.accentInk)
            }
            OutlinedButton(
                onClick = { onOpenEvent(upcoming.id) },
                modifier = Modifier.semantics {
                    contentDescription = "Open ${upcoming.trackName}"
                },
            ) {
                Text("Open this event", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
            }
        }
    }
}
