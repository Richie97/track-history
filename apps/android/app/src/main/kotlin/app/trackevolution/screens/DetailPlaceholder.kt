package app.trackevolution.screens

import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Event
import app.trackevolution.ui.TEPanePlaceholder
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
 * With an empty logbook it says so (#344) — "Pick an event" beside a list with
 * nothing in it is an instruction that can't be followed.
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
    // Whether the events list actually came back: "Nothing coming up" is a
    // claim about the logbook, so it is made only on an answer (#343) — iOS's
    // `answered`.
    var answered by remember { mutableStateOf(false) }
    // Whether the logbook holds any event at all — only meaningful once answered.
    var hasEvents by remember { mutableStateOf(true) }

    // The dashboard beside this has already fetched — and warmed — the same list,
    // so through the offline layer this is normally a cache read rather than a
    // request. A failure is swallowed on purpose: a pane saying "Pick an event" is
    // a fine outcome, and an error here would be about the one thing on screen
    // nobody asked for.
    LaunchedEffect(Unit) {
        runCatching { api.events() }.onSuccess { events ->
            hasEvents = events.isNotEmpty()
            next = events.filter { EventDates.isUpcoming(it.startDate) }.minByOrNull { it.startDate }
            answered = true
        }
    }

    val upcoming = next
    if (answered && !hasEvents) {
        TEPanePlaceholder(
            title = "No events yet",
            tag = "detailPlaceholder",
            mark = { BrandMark(size = 40.dp) },
            text = "Add your first event and it opens here.",
            modifier = modifier,
        )
    } else if (upcoming == null) {
        TEPanePlaceholder(
            title = "Pick an event",
            tag = "detailPlaceholder",
            mark = { BrandMark(size = 40.dp) },
            text = if (answered) "Nothing coming up — choose an event from the list." else "Choose an event from the list.",
            modifier = modifier,
        )
    } else {
        TEPanePlaceholder(
            title = upcoming.trackName,
            tag = "detailPlaceholder",
            mark = { BrandMark(size = 40.dp) },
            eyebrow = "Next up",
            modifier = modifier,
        ) {
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
