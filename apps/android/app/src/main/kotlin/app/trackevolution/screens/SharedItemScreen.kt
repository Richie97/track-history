package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.TraceSample
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.SessionConditions
import app.trackevolution.core.Units
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.ItemShareKind
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SharedItem
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalChannelFreeNote
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.PaneWidth
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.charts.LimitLegend
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * One shared event or session's link, read (NS-48): `GET /api/share/(e|s)/:token`.
 *
 * Unauthenticated and past the cache (`ApiClient.sharedItem`): the token is the
 * whole permission, and a stale copy of something its owner has since stopped
 * sharing is exactly what a cache would keep.
 */
class SharedItemModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val kind: ItemShareKind,
    val token: String,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var item by mutableStateOf<SharedItem?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                item = api.sharedItem(kind, token)
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (item != null) return@launch
                state = when {
                    // Unknown, revoked, or its event or session deleted: the server
                    // says no more than that, and neither does this.
                    e.isNotFound -> LoadState.Failed(
                        ItemShareText.NOT_FOUND,
                        retryable = false,
                        title = ItemShareText.NOT_FOUND_TITLE,
                    )
                    e is ApiException.Transport -> LoadState.Failed(ItemShareText.OPEN_NEEDS_CONNECTION)
                    else -> LoadState.Failed(e.message)
                }
            }
        }
    }

    /** A best-lap video's signed URL, through the link rather than the owner's account. */
    suspend fun clipUrl(clipId: Int): String = api.sharedClipUrl(kind, token, clipId).url
}

/**
 * Where a `trackevolution.app/share/e/<token>` or `/share/s/<token>` App Link
 * lands (NS-48): the event page, narrowed — the header, the tiles, the best-lap
 * trace, each shared session with its laps and channel panel, and the best-lap
 * videos.
 *
 * Built from the event page's own pieces (`LapRow`, `bestLapTrace`,
 * `AnalysisColumn`, `LapChannelChart`, the video player) rather than by running
 * `EventScreen` under another owner, because nothing about this page is the
 * viewer's — iOS's `SharedItemScreen` made the same call:
 *
 *  - **No link out of it leads into anyone's logbook.** The ids in the payload
 *    are the owner's; a lap or track page opened with them would read the
 *    *viewer's* row of the same id. So laps are rows, not doors, and the track
 *    name is a heading, not a link.
 *  - **The panel opens to the owner's tier** ([SharedItem.pro]), and where it
 *    stops at the free half it says so in [ItemShareText.freeNote] — the
 *    viewer has nothing to buy.
 *  - **Nothing here hides a field the payload carries.** The server already
 *    sent notes, the checklist, costs and setups null or empty, and a clip only
 *    while the owner has Pro; this page simply has nothing to show for those.
 *
 * Below the analysis column's width a session's panel opens inline under its
 * card — this page has no destination of its own for it to go to.
 */
@Composable
fun SharedItemScreen(model: SharedItemModel, api: ApiClient, modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val item = model.item ?: return@TELoadable
        CompositionLocalProvider(
            LocalChannelFreeNote provides if (item.pro) null else ItemShareText.freeNote(item.name),
        ) {
            SharedItemContent(item, model.kind, api, model::clipUrl)
        }
    }
}

@Composable
private fun SharedItemContent(
    item: SharedItem,
    kind: ItemShareKind,
    api: ApiClient,
    clipUrl: suspend (Int) -> String,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val listState = rememberLazyListState()
    val detail = item.event
    val event = detail.event
    // The event page's split, by the same rule (NS-34 ticket 3).
    val analysisWidth = LocalLayoutMetrics.current.sideColumnWidth(0.46f, 380.dp, 620.dp)
    val twoColumn = analysisWidth != null
    // At expanded width the session the column shows; below it, the session
    // whose panel is open under its card. Saveable, so a rotation keeps it.
    var selectedSessionId by rememberSaveable { mutableStateOf<Int?>(null) }
    var openSessionId by rememberSaveable { mutableStateOf<Int?>(null) }

    LaunchedEffect(detail.sessions.map { it.id }) {
        if (selectedSessionId == null) selectedSessionId = defaultChannelSession(detail.sessions)?.id
    }

    val page = @Composable {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("sharedItem"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Text(event.trackName, style = TrackTheme.typography.h1, color = colors.textStrong)
                    TEMeta(
                        listOf(
                            EventDates.fmtDate(event.startDate),
                            event.club,
                            event.runGroup,
                            event.car,
                            event.conditions?.rawValue,
                            SessionConditions.ambientText(
                                SessionConditions.eventAmbient(event),
                                Units.usUnits(units),
                            ).ifEmpty { null },
                        ),
                    )
                    Text(
                        ItemShareText.byline(kind, item.name),
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 6.dp).testTag("sharedByline"),
                    )
                }
            }

            item("tiles") {
                // A session link's best, laps and consistency are that session's:
                // the server worked them out from it alone.
                TEStatRow(
                    listOfNotNull(
                        "Best time" to LapTime.fmtMs(event.bestMs),
                        ("Days" to EventDates.fmtDays(event.days)).takeIf { kind == ItemShareKind.EVENT },
                        "Laps" to event.lapCount.toString(),
                        "Consistency" to LapTime.fmtConsistency(event.consistency),
                    ),
                )
            }

            bestLapTrace(detail.sessions).takeIf { !twoColumn }?.let { traced ->
                item("trace") {
                    Column {
                        TESectionHeader("Best lap trace", detail = "brighter is faster")
                        Text(
                            LapTime.fmtMs(traced.lapMs),
                            style = TrackTheme.typography.lapTime,
                            color = colors.textStrong,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                        TrackMap(trace = traced.trace, markers = traced.markers)
                        LimitLegend(traced.markers, Modifier.padding(top = 6.dp))
                    }
                }
            }

            item("sessions-header") {
                TESectionHeader(if (kind == ItemShareKind.EVENT) "Sessions" else "Session")
            }

            if (detail.sessions.isEmpty()) {
                item("sessions-empty") { TEEmpty("No sessions recorded yet.") }
            }
            // Keys carry the position as well as the id, so two rows can never
            // collide whatever the payload's ids are.
            detail.sessions.forEachIndexed { index, session ->
                item("session-$index-${session.id}") {
                    val hasChannels = session.channels?.laps?.isNotEmpty() == true
                    SharedSessionCard(
                        session = session,
                        selected = twoColumn && selectedSessionId == session.id,
                        panelLabel = when {
                            !hasChannels -> null
                            twoColumn && selectedSessionId == session.id -> "Comparing laps →"
                            twoColumn -> "Compare laps →"
                            openSessionId == session.id -> "Hide lap comparison"
                            else -> "Compare laps →"
                        },
                        onPanel = {
                            if (twoColumn) {
                                selectedSessionId = session.id
                            } else {
                                openSessionId = if (openSessionId == session.id) null else session.id
                            }
                        },
                    )
                }
                val channels = session.channels?.takeIf { it.laps.isNotEmpty() }
                if (!twoColumn && channels != null && openSessionId == session.id) {
                    item("panel-$index-${session.id}") {
                        LapChannelChart(
                            channels = channels,
                            laps = session.laps,
                            modifier = Modifier.fillMaxWidth(),
                            trace = session.trace?.map { TraceSample(x = it.x, y = it.y, v = it.v) },
                            pro = item.pro,
                        )
                    }
                }
                // A best-lap video (NS-45), present only while the owner has Pro.
                session.laps.filter { it.clip != null }.forEach { lap ->
                    item("video-$index-${lap.id}-${lap.lapNum}") {
                        SharedLapVideoCard(api = api, lap = lap, signedUrl = clipUrl)
                    }
                }
            }
        }
    }

    if (analysisWidth != null) {
        Row(Modifier.fillMaxSize()) {
            PaneWidth(Modifier.weight(1f)) { page() }
            VerticalDivider(color = colors.borderHairline)
            PaneWidth(Modifier.width(analysisWidth)) {
                AnalysisColumn(
                    sessions = detail.sessions,
                    selectedSessionId = selectedSessionId,
                    pro = item.pro,
                )
            }
        }
    } else {
        page()
    }
}

/**
 * A shared session: its label, best and lap count, the air it was driven in,
 * the stats line and its laps as rows — none of the owner's controls, and no
 * notes (the server sends them null).
 */
@Composable
private fun SharedSessionCard(
    session: Session,
    selected: Boolean,
    /** The channel panel's control, or null when the session stored no channels. */
    panelLabel: String?,
    onPanel: () -> Unit,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val best = session.bestLapMs
    TrackCard(
        Modifier.fillMaxWidth().testTag("sharedSession-${session.id}"),
        color = if (selected) colors.accentTint else null,
        border = if (selected) colors.accent else null,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(session.label ?: "Session", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                Text(
                    if (session.laps.isEmpty()) "No laps" else "best ${LapTime.fmtMs(best)} · ${fmtCount(session.laps.size, "lap")}",
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
            SessionConditions.sessionAmbientC(session)?.let { ambientC ->
                val text = SessionConditions.tempText(ambientC, Units.usUnits(units))
                Text(
                    text,
                    style = TrackTheme.typography.xxs,
                    color = colors.textMuted,
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(colors.heat.copy(alpha = 0.14f))
                        .padding(horizontal = 8.dp, vertical = 2.dp)
                        .semantics { contentDescription = "Ambient $text" },
                )
            }
        }
        session.statsSummary(units)?.let {
            Text(it, style = TrackTheme.typography.xs, color = colors.textMuted, modifier = Modifier.padding(top = 4.dp))
        }
        session.laps.forEach { lap ->
            LapRow(lap = lap, isBest = best != null && lap.timeMs == best, onOpen = null, onDelete = null)
        }
        panelLabel?.let { label ->
            TextButton(onClick = onPanel, modifier = Modifier.padding(top = 4.dp).testTag("sharedCompare-${session.id}")) {
                Text(
                    label,
                    style = TrackTheme.typography.sm,
                    color = if (selected) colors.accentInk else colors.textMuted,
                )
            }
        }
    }
}
