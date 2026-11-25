package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.CompareLaps
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.TraceSample
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.ItemShareKind
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SharedCompare
import app.trackevolution.core.model.SharedLapSide
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.stage.LapStagePage
import app.trackevolution.ui.stage.rememberLapStageHolder
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * A shared comparison's link, read (NS-56): `GET /api/share/c/:token`.
 *
 * Unauthenticated and past the cache, as `SharedItemModel` is: the token is the
 * whole permission, and a stale copy of something its owner has since stopped
 * sharing is exactly what a cache would keep.
 */
class SharedCompareModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val token: String,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var compare by mutableStateOf<SharedCompare?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                compare = api.sharedCompare(token)
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (compare != null) return@launch
                state = when {
                    // Unknown, revoked, or either lap deleted: the server says no
                    // more than that, and neither does this.
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

    /** A lap video's signed URL, through the link rather than the owner's account. */
    suspend fun clipUrl(clipId: Int): String = api.sharedClipUrl(ItemShareKind.COMPARE, token, clipId).url
}

/** One side's session and lap, found in its payload — the one session with the one lap. */
internal data class SharedSide(val side: SharedLapSide) {
    val session: Session? = side.event.sessions.firstOrNull { it.id == side.sessionId } ?: side.event.sessions.firstOrNull()
    val lap: Lap? = session?.laps?.firstOrNull { it.id == side.lapId } ?: session?.laps?.firstOrNull()

    /** "Apr 10, 2026 · Session 1 · Lap 2", trimmed to what the payload has — the picker's words. */
    val line: String
        get() = listOfNotNull(
            EventDates.fmtDate(side.event.event.startDate),
            session?.label,
            lap?.let { "Lap ${it.lapNum}" },
        ).joinToString(" · ")
}

/**
 * The two sides as the two-lap compare's own pair (NS-56), so the head-to-head,
 * the stage and the channel panel are the owner's screen's and nothing is
 * worked out twice: `CompareLaps.alignLapPair` over each side's one channel
 * entry. Null when either lap stored no telemetry — then the times are all a
 * link has to show.
 */
internal fun sharedComparePair(compare: SharedCompare): CompareLapsModel.LapPair? {
    val a = SharedSide(compare.a)
    val b = SharedSide(compare.b)
    val lapA = a.lap ?: return null
    val lapB = b.lap ?: return null
    val chanA = a.session?.channels ?: return null
    val chanB = b.session?.channels ?: return null
    val entryA = chanA.laps.firstOrNull() ?: return null
    val entryB = chanB.laps.firstOrNull() ?: return null
    return CompareLapsModel.LapPair(
        aligned = CompareLaps.alignLapPair(entryA, chanA.dStepM, entryB, chanB.dStepM),
        // Synthetic chip rows, as the track compare builds them: ids 0 and 1,
        // the entries' own times so `matchLapsToChannels` pairs them.
        laps = listOf(
            Lap(id = 0, sessionId = compare.a.sessionId, lapNum = lapA.lapNum, timeMs = entryA.timeMs),
            Lap(id = 1, sessionId = compare.b.sessionId, lapNum = lapB.lapNum, timeMs = entryB.timeMs),
        ),
        metricsA = CompareLaps.lapMetrics(entryA),
        metricsB = CompareLaps.lapMetrics(entryB),
        mismatch = CompareLaps.lengthMismatchRatio(entryA, chanA.dStepM, entryB, chanB.dStepM),
        lapA = lapA,
        lapB = lapB,
        traceA = a.session?.trace,
    )
}

/**
 * Where a `trackevolution.app/share/c/<token>` App Link lands (NS-56): two of
 * one driver's laps compared, read-only.
 *
 * The track compare without its pickers. Both lap times always; then, while the
 * **owner** has Pro and both laps stored telemetry, the same head-to-head,
 * stage and channel panel `CompareLapsScreen` draws, over the same
 * `CompareLapsModel.LapPair` — each lap's video playing on the stage through
 * the link's own signed URL. A free owner's link is the two times and
 * [ItemShareText.freeCompareNote]: the compare is a Pro view, the tier is the
 * owner's, and the viewer — who may have no account — has nothing to buy.
 *
 * Like the shared-item page, nothing here is a door: the ids in the payload are
 * the owner's, so neither lap opens anything.
 */
@Composable
fun SharedCompareScreen(model: SharedCompareModel, modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val compare = model.compare ?: return@TELoadable
        val colors = TrackTheme.colors
        val a = remember(compare) { SharedSide(compare.a) }
        val b = remember(compare) { SharedSide(compare.b) }
        val pair = remember(compare) { if (compare.pro) sharedComparePair(compare) else null }

        val header: LazyListScope.() -> Unit = {
            item("head") {
                Column {
                    Text(compare.a.event.event.trackName, style = TrackTheme.typography.h1, color = colors.textStrong)
                    Text(
                        ItemShareText.byline(ItemShareKind.COMPARE, compare.name),
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 6.dp).testTag("sharedByline"),
                    )
                }
            }
            item("sides") {
                TrackCard(Modifier.fillMaxWidth().testTag("sharedCompareSides")) {
                    SideRow("Lap A", colors.chartLine, a)
                    HorizontalDivider(color = colors.borderHairline)
                    SideRow("Lap B", colors.chartLineB, b)
                }
            }
            if (!compare.pro) {
                item("free") {
                    Text(
                        ItemShareText.freeCompareNote(compare.name),
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                        modifier = Modifier.testTag("sharedCompareFreeNote"),
                    )
                }
            } else if (pair == null) {
                item("no-telemetry") {
                    Text(
                        ItemShareText.COMPARE_NO_TELEMETRY,
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                        modifier = Modifier.testTag("sharedCompareNoTelemetry"),
                    )
                }
            } else if (pair.mismatch > CompareLaps.LENGTH_MISMATCH_WARN) {
                item("mismatch") {
                    Text(
                        "⚠️ These laps cover driven distances ${(pair.mismatch * 100).roundToInt()}% apart — " +
                            "likely a different layout or start/finish line.",
                        style = TrackTheme.typography.xs,
                        color = colors.textMuted,
                    )
                }
            }
        }

        if (pair == null) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("sharedCompare"),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                header()
            }
            return@TELoadable
        }

        // The track compare's stage (NS-51) over the same pair. The server sent
        // a `clip` only while the owner has Pro, so one that is here plays.
        val binding = remember(pair) { compareBinding(pair, canPlay = true) }
        val holder = rememberLapStageHolder("shared-compare-${model.token}")
        LaunchedEffect(binding) {
            binding?.let { holder.bind(it, model::clipUrl) }
        }
        val trace = remember(pair.traceA) {
            pair.traceA?.takeIf { it.size >= 10 }?.map { TraceSample(x = it.x, y = it.y, v = it.v) }
        }
        val staged = binding != null && holder.binding != null
        val body: LazyListScope.() -> Unit = {
            item("head-to-head") { LapPairHeadToHead(pair) }
            item("charts-hint") {
                Text(
                    "The delta chart shows where time is gained or lost vs the faster lap; " +
                        "the channels below show why.",
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                )
            }
            item("charts") {
                LapChannelChart(
                    channels = pair.aligned,
                    laps = pair.laps,
                    initialSelection = listOf(0, 1),
                    playhead = if (staged) holder.playhead else null,
                    onSeek = if (staged) holder::seekGrid else null,
                    onScrub = if (staged) holder::scrubGrid else null,
                )
            }
        }
        if (!staged) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("sharedCompare"),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                header()
                body()
            }
            return@TELoadable
        }
        LapStagePage(holder = holder, trace = trace, header = header, body = body)
    }
}

/** One side: its colour, which lap it is and when, and its time. */
@Composable
private fun SideRow(label: String, color: Color, side: SharedSide) {
    val colors = TrackTheme.colors
    val time = LapTime.fmtMs(side.lap?.timeMs)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$label: ${side.line}, $time" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Column(Modifier.weight(1f)) {
            Text(label, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
            Text(side.line, style = TrackTheme.typography.xs, color = colors.textMuted)
        }
        Text(time, style = TrackTheme.typography.lapTime, color = colors.textStrong)
    }
}
