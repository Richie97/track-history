package app.trackevolution.ui.stage

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.TraceSample
import app.trackevolution.core.Units
import app.trackevolution.core.VideoSync
import app.trackevolution.core.VideoSync.SideKey
import app.trackevolution.core.VideoSync.SyncMode
import app.trackevolution.ui.FoldPosture
import app.trackevolution.ui.LocalFoldGeometry
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.PaneWidth
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.charts.TrackMapDot
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/** *‹ Lap 4* / *Lap 6 ›* beside the chip (NS-50 every-lap sessions): a null label is no neighbour that way. */
data class LapStepper(
    val prevLabel: String?,
    val nextLabel: String?,
    val onPrev: () -> Unit,
    val onNext: () -> Unit,
)

/**
 * A page with the lap stage on it (NS-51): the stage in the shape
 * [StageLayout.choose] picks for this pane, with the page's own [header] and
 * [body] (the channel panel, the facts) around it.
 *
 * - **Compact / Medium** — one list: the header, the videos (and on Medium the
 *   map beside the now-strip), then the transport as a sticky header that pins
 *   once it reaches the top, so play and the scrubber stay in reach while the
 *   charts scroll — the web's as-built compact rule rather than the spec's
 *   sticky player with a mini bar (see the spec's *As built — ticket 3*).
 * - **Wide** — the stage pinned above the list, at most 45 % of the window's
 *   height; the map and the now-strip in a right column.
 * - **Tabletop** — the picture and the map above the crease, the transport and
 *   the list below it, split at the hinge.
 * - **Book** — the stage on the left page, the list on the right; the shell's
 *   gutter already sits on the hinge.
 * - **Full-bleed** — the page as Compact, under a full-window dialog showing the
 *   master video with its HUD; turning back, or the back chip, leaves it.
 *
 * Owns the clock while it is on screen: a `withFrameNanos` loop ticks the
 * holder while playing, and the app going to the background pauses it (but a
 * rotation, which recreates the activity, does not).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LapStagePage(
    holder: LapStageHolder,
    /** The map: the session's best lap trace (side A's session in a cross-event compare). */
    trace: List<TraceSample>?,
    modifier: Modifier = Modifier,
    stepper: LapStepper? = null,
    /** Above the stage: a locked clip's upsell or a coach's note, when a side has one. */
    notice: (@Composable () -> Unit)? = null,
    header: LazyListScope.() -> Unit = {},
    body: LazyListScope.() -> Unit,
) {
    val binding = holder.binding ?: return
    val metrics = LocalLayoutMetrics.current
    val fold = LocalFoldGeometry.current
    val config = LocalConfiguration.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val preference = remember(context) { SyncModePreference(context.applicationContext) }
    LaunchedEffect(preference) { preference.mode.collect { holder.adoptStoredMode(it) } }
    val onMode: (SyncMode) -> Unit = remember(holder, preference) {
        { m -> holder.changeMode(m); scope.launch { preference.set(m) } }
    }

    // The clock: one tick a display frame while playing.
    LaunchedEffect(holder, holder.playing) {
        while (holder.playing) withFrameNanos { holder.tick(it) }
    }
    // A signed URL lasts an hour; an expired one is fetched again in place.
    LaunchedEffect(holder) {
        while (true) {
            delay(1_000)
            holder.refreshExpired()
        }
    }
    // Backgrounded mid-play pauses (picture-in-picture is out of scope); a
    // rotation stops the activity too, and must not.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, holder) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP && context.findActivity()?.isChangingConfigurations != true) {
                holder.pause()
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    val sideColumn = metrics.sideColumnWidth(0.24f, 280.dp, 360.dp)
    val layout = StageLayout.choose(
        contentWidthDp = metrics.contentWidth.value,
        sideColumn = sideColumn != null,
        posture = fold.posture,
        landscape = config.orientation == Configuration.ORIENTATION_LANDSCAPE,
        screenHeightDp = config.screenHeightDp,
        hasVideo = holder.hasVideo,
    )
    LaunchedEffect(layout) { if (layout != StageLayout.FullBleed) holder.fullBleedDismissed = false }
    val fullBleed = holder.hasVideo &&
        ((layout == StageLayout.FullBleed && !holder.fullBleedDismissed) || holder.fullscreen)
    val compare = binding.shownB != null
    val ctx = StageCtx(holder, trace, stepper, compare, onMode)

    val listBody: LazyListScope.() -> Unit = body
    when (if (layout == StageLayout.FullBleed) StageLayout.Compact else layout) {
        StageLayout.Wide -> Column(modifier.fillMaxSize()) {
            val maxH = (config.screenHeightDp * 0.45f).dp
            Row(
                Modifier.fillMaxWidth().heightIn(max = maxH).padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    notice?.invoke()
                    StageVideos(ctx, Modifier.weight(1f, fill = false))
                    StageTransport(ctx, layout = StageLayout.Wide)
                }
                Column(Modifier.width(sideColumn ?: 300.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    StageMapCard(ctx, Modifier.fillMaxWidth(), height = 150.dp)
                    NowStrip(holder, row = false)
                }
            }
            LazyColumn(
                Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("lapStageList"),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                header()
                listBody()
            }
        }

        StageLayout.Tabletop -> {
            val top = (fold.hingeFraction ?: 0.5f).coerceIn(0.2f, 0.8f)
            Column(modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().weight(top).padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StageVideos(ctx, Modifier.weight(1f))
                    StageMapCard(ctx, Modifier.width(220.dp), height = 140.dp)
                }
                Column(Modifier.fillMaxWidth().weight(1f - top)) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        StageTransport(ctx, StageLayout.Tabletop, Modifier.weight(1f))
                        NowStrip(holder, row = true, modifier = Modifier.weight(1f))
                    }
                    LazyColumn(
                        Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("lapStageList"),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(vertical = 8.dp),
                    ) {
                        header()
                        listBody()
                    }
                }
            }
        }

        StageLayout.Book -> BoxWithConstraints(modifier.fillMaxSize()) {
            val left = maxWidth * (fold.hingeFraction ?: 0.5f)
            Row(Modifier.fillMaxSize()) {
                PaneWidth(Modifier.width(left)) {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        notice?.invoke()
                        StageVideos(ctx, Modifier.fillMaxWidth())
                        StageTransport(ctx, StageLayout.Medium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            StageMapCard(ctx, Modifier.weight(0.46f), height = 140.dp)
                            NowStrip(holder, row = false, modifier = Modifier.weight(0.54f))
                        }
                    }
                }
                PaneWidth(Modifier.weight(1f)) {
                    LazyColumn(
                        Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("lapStageList"),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(vertical = 12.dp),
                    ) {
                        header()
                        listBody()
                    }
                }
            }
        }

        else -> {
            val medium = layout == StageLayout.Medium
            LazyColumn(
                modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("lapStageList"),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                header()
                notice?.let { n -> item("stage-notice") { n() } }
                item("stage-videos") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        StageVideos(ctx, Modifier.fillMaxWidth())
                        if (medium) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                StageMapCard(ctx, Modifier.weight(0.46f), height = 150.dp)
                                NowStrip(holder, row = false, modifier = Modifier.weight(0.54f))
                            }
                        }
                    }
                }
                // Pins at the top once it reaches it: play, the scrubber and the
                // car's numbers stay in reach while the charts scroll under.
                stickyHeader("stage-transport") {
                    Column(
                        Modifier.fillMaxWidth().background(TrackTheme.colors.bgPage).padding(vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        StageTransport(ctx, if (medium) StageLayout.Medium else StageLayout.Compact)
                        if (!medium) {
                            NowStrip(holder, row = true)
                            if (compare) ModeControl(holder.mode, onMode)
                        }
                    }
                }
                listBody()
            }
        }
    }

    if (fullBleed) FullBleed(ctx)
}

/** What every piece of the stage reads, passed down once. */
private class StageCtx(
    val holder: LapStageHolder,
    val trace: List<TraceSample>?,
    val stepper: LapStepper?,
    val compare: Boolean,
    val onMode: (SyncMode) -> Unit,
)

// ---- the video slots ---------------------------------------------------------

/**
 * The stage's picture: on a phone the master large with the other side as an
 * inset (tap to swap); wider, the two side by side. Two replay sides become
 * one map with two dots rather than two identical maps.
 */
@Composable
private fun StageVideos(ctx: StageCtx, modifier: Modifier = Modifier) {
    val holder = ctx.holder
    val binding = holder.binding ?: return
    val metrics = LocalLayoutMetrics.current
    val b = binding.shownB
    val noVideo = binding.a.clip == null && (b == null || b.clip == null)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ctx.stepper?.let { StepperRow(it) }
        when {
            b == null || noVideo -> VideoSlot(ctx, SideKey.A, Modifier.fillMaxWidth(), bothDots = b != null)
            metrics.contentWidth < StageLayout.MEDIUM_MIN_DP.dp -> {
                val master = holder.masterKey
                val other = if (master == SideKey.A) SideKey.B else SideKey.A
                Box(Modifier.fillMaxWidth()) {
                    VideoSlot(ctx, master, Modifier.fillMaxWidth())
                    VideoSlot(
                        ctx,
                        other,
                        Modifier
                            .align(Alignment.BottomEnd)
                            .padding(8.dp)
                            .width(if (metrics.contentWidth >= 440.dp) 160.dp else 132.dp)
                            .border(1.dp, TrackTheme.colors.surfaceCard, RoundedCornerShape(TrackTheme.radii.sm))
                            .clickable(onClickLabel = "Swap videos") { holder.swap() }
                            .testTag("stageInset"),
                        inset = true,
                    )
                }
            }
            else -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VideoSlot(ctx, SideKey.A, Modifier.weight(1f))
                VideoSlot(ctx, SideKey.B, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StepperRow(stepper: LapStepper) {
    val colors = TrackTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (stepper.prevLabel != null) {
            TextButton(onClick = stepper.onPrev, modifier = Modifier.testTag("stagePrevLap")) {
                Text("‹ ${stepper.prevLabel}", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
        }
        Box(Modifier.weight(1f))
        if (stepper.nextLabel != null) {
            TextButton(onClick = stepper.onNext, modifier = Modifier.testTag("stageNextLap")) {
                Text("${stepper.nextLabel} ›", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
        }
    }
}

/**
 * One side's 16:9 slot: its video with no player chrome (the stage's transport
 * drives it), or — replay — the map with the playhead's dot and a line saying
 * why there is no picture. The chip at the top-left names the lap; colour is
 * never the only way to tell the sides apart.
 */
@OptIn(UnstableApi::class)
@Composable
private fun VideoSlot(
    ctx: StageCtx,
    key: SideKey,
    modifier: Modifier,
    inset: Boolean = false,
    /** A single map standing in for two replay slots: both sides' dots. */
    bothDots: Boolean = false,
    inDialog: Boolean = false,
) {
    val holder = ctx.holder
    val binding = holder.binding ?: return
    val info = (if (key == SideKey.A) binding.a else binding.shownB) ?: return
    val colors = TrackTheme.colors
    val sideColor = if (key == SideKey.A) colors.chartLine else colors.chartLineB
    val player = holder.playerFor(key)
    val shape = RoundedCornerShape(TrackTheme.radii.sm)
    Box(
        modifier
            .aspectRatio(16f / 9f)
            .background(if (player != null) Color.Black else colors.bgSubtle, shape)
            .testTag("stageSlot:${key.name}"),
    ) {
        if (player != null) {
            val showing = holder.fullBleedShowing && !inDialog
            AndroidView(
                factory = {
                    PlayerView(it).apply {
                        useController = false
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                        setShutterBackgroundColor(android.graphics.Color.BLACK)
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    }
                },
                update = { view -> view.player = if (showing) null else player.player },
                onRelease = { it.player = null },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            val trace = ctx.trace
            if (trace != null && trace.size >= 10 && !inset) {
                TrackMap(
                    trace = trace,
                    modifier = Modifier.fillMaxSize(),
                    height = 400.dp,
                    dots = { stageDots(holder, colors.chartLine, colors.chartLineB, both = bothDots) },
                )
            } else if (trace != null && trace.size >= 10) {
                TrackMap(trace = trace, modifier = Modifier.fillMaxSize(), height = 120.dp, dots = {
                    stageDots(holder, colors.chartLine, colors.chartLineB, both = false, only = key)
                })
            }
            if (!inset) {
                val why = holder.noteFor(key) ?: info.lockedNote
                Text(
                    why ?: "${info.label.substringBefore(" ·")} · no video · replaying telemetry",
                    style = TrackTheme.typography.xxs,
                    color = colors.textMuted,
                    modifier = Modifier.align(Alignment.BottomStart).padding(8.dp),
                )
            }
        }
        // The chip: dot, lap and time, ★ for the session's best.
        if (!bothDots) {
            Row(
                Modifier
                    .align(Alignment.TopStart)
                    .padding(6.dp)
                    .background(colors.surfaceCard.copy(alpha = 0.9f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(Modifier.size(7.dp).background(sideColor, CircleShape))
                Text(
                    info.label + if (info.best) " ★" else "",
                    style = TrackTheme.typography.xxs,
                    color = colors.textStrong,
                    maxLines = 1,
                )
            }
        }
        if (!inset && !inDialog && player != null && ctx.holder.binding != null) {
            TextButton(
                onClick = { holder.fullscreen = true },
                modifier = Modifier.align(Alignment.TopEnd).testTag("stageFullscreen")
                    .semantics { contentDescription = "Full screen" },
            ) {
                Text("⛶", style = TrackTheme.typography.body, color = Color.White)
            }
        }
    }
}

/** Where the map's dots are this frame: side A's place, and B's when it is shown (both in a compare). */
private fun stageDots(
    holder: LapStageHolder,
    colorA: Color,
    colorB: Color,
    both: Boolean,
    only: SideKey? = null,
): List<TrackMapDot> {
    val binding = holder.binding ?: return emptyList()
    val st = holder.state.value ?: return emptyList()
    if (!st.inLap) return emptyList()
    fun frac(side: VideoSync.Side, k: Double) = k / max(1, side.t.size - 1)
    val dots = mutableListOf<TrackMapDot>()
    if (only == null || only == SideKey.A) dots += TrackMapDot(frac(binding.a.side, st.a.k), colorA)
    val b = binding.shownB
    if ((both || only == SideKey.B) && b != null && st.b != null) dots += TrackMapDot(frac(b.side, st.b!!.k), colorB)
    return dots
}

/** The map card beside the now-strip (Wide, Medium, Tabletop): the place, two dots in a compare. */
@Composable
private fun StageMapCard(ctx: StageCtx, modifier: Modifier, height: androidx.compose.ui.unit.Dp) {
    val trace = ctx.trace ?: return
    if (trace.size < 10) return
    val colors = TrackTheme.colors
    TrackCard(modifier.testTag("stageMap"), contentPadding = 8.dp) {
        Text("Where the car is", style = TrackTheme.typography.xxs, color = colors.textFaint)
        TrackMap(
            trace = trace,
            modifier = Modifier.fillMaxWidth(),
            height = height,
            dots = { stageDots(ctx.holder, colors.chartLine, colors.chartLineB, both = true) },
        )
    }
}

// ---- the transport ------------------------------------------------------------

/**
 * One row: play/pause, the scrubber (drawing the delta along the lap), the
 * master's time, and — wider than a phone — the mode control and the rate menu.
 */
@Composable
private fun StageTransport(ctx: StageCtx, layout: StageLayout, modifier: Modifier = Modifier) {
    val holder = ctx.holder
    val colors = TrackTheme.colors
    val playing = holder.playing
    Row(
        modifier.fillMaxWidth().testTag("stageTransport"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(38.dp)
                .background(colors.accent, CircleShape)
                .clickable(onClickLabel = if (playing) "Pause" else "Play") { holder.togglePlay() }
                .semantics { contentDescription = if (playing) "Pause" else "Play" }
                .testTag("stagePlay"),
            contentAlignment = Alignment.Center,
        ) {
            Text(if (playing) "❚❚" else "▶", style = TrackTheme.typography.sm, color = colors.accentContrast)
        }
        Scrubber(holder, Modifier.weight(1f))
        StageTimes(holder)
        if (ctx.compare && layout != StageLayout.Compact && layout != StageLayout.Tabletop) {
            ModeControl(holder.mode, ctx.onMode)
        }
        if (layout == StageLayout.Wide || layout == StageLayout.Medium) RateMenu(holder)
    }
}

/** "0:36.0 / 2:19.8" — the master's lap time, recomposed at most ten times a second. */
@Composable
private fun StageTimes(holder: LapStageHolder) {
    val text by remember(holder) {
        derivedStateOf {
            val r = holder.range
            val lap = r?.let { it.max - app.trackevolution.core.telemetry.LapClips.PLAYBACK_LEAD_S }
            "${VideoSync.fmtStageTime(holder.eMaster)} / ${VideoSync.fmtStageTime(lap)}"
        }
    }
    Text(text, style = TrackTheme.typography.lapTime.copy(fontSize = TrackTheme.typography.xs.fontSize), color = TrackTheme.colors.textMuted, maxLines = 1)
}

/**
 * The scrubber: one adjustable element (NS-51 *Accessibility*). Its track draws
 * the delta to the other side — or, with none, side A's speed — scaled to the
 * lap's largest, with a dashed tick at the line and ticks at each corner and
 * sector boundary; the thumb is read in the draw phase. A drag seeks to the
 * nearest keyframe as it goes and exactly on release; TalkBack hears the
 * playhead in words and gets *Next corner* / *Previous corner*.
 */
@Composable
private fun Scrubber(holder: LapStageHolder, modifier: Modifier) {
    val binding = holder.binding ?: return
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val density = LocalDensity.current
    val master = holder.masterKey
    val track = remember(binding, master) { scrubTrack(binding, master) }
    val spoken by remember(holder, units) {
        derivedStateOf {
            val st = holder.state.value
            if (st == null) "" else VideoSync.playheadText(st, holder.binding?.corners, units).value
        }
    }
    val range = holder.range ?: return
    fun eAt(x: Float, width: Int): Double =
        range.min + (x / width.coerceAtLeast(1)).coerceIn(0f, 1f) * (range.max - range.min)

    Canvas(
        modifier
            .height(36.dp)
            .testTag("stageScrubber")
            .pointerInput(binding.key, master) {
                detectTapGestures { holder.seekElapsed(eAt(it.x, size.width)) }
            }
            .pointerInput(binding.key, master) {
                detectHorizontalDragGestures(
                    onDragStart = { holder.scrubElapsed(eAt(it.x, size.width)) },
                    onDragEnd = { holder.endScrub() },
                    onDragCancel = { holder.endScrub() },
                ) { change, _ ->
                    change.consume()
                    holder.scrubElapsed(eAt(change.position.x, size.width))
                }
            }
            .semantics {
                contentDescription = "Lap position"
                stateDescription = spoken
                progressBarRangeInfo = ProgressBarRangeInfo(
                    holder.eMaster.toFloat().coerceIn(range.min.toFloat(), range.max.toFloat()),
                    range.min.toFloat()..range.max.toFloat(),
                )
                setProgress { v -> holder.seekElapsed(v.toDouble()); true }
                customActions = listOf(
                    CustomAccessibilityAction("Next corner") { holder.stepCorner(true); true },
                    CustomAccessibilityAction("Previous corner") { holder.stepCorner(false); true },
                    CustomAccessibilityAction(if (holder.playing) "Pause" else "Play") { holder.togglePlay(); true },
                )
            },
    ) {
        val w = size.width
        val h = size.height
        val mid = h / 2f
        fun x(e: Double) = ((e - range.min) / (range.max - range.min)).toFloat().coerceIn(0f, 1f) * w
        drawLine(colors.borderStrong, Offset(0f, mid), Offset(w, mid), strokeWidth = 2f * density.density)
        // The line itself (e = 0), dashed.
        val x0 = x(0.0)
        drawLine(
            colors.textFaint, Offset(x0, 4f), Offset(x0, h - 4f), strokeWidth = 1f * density.density,
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)),
        )
        for (e in track.ticks) drawLine(colors.textFaint, Offset(x(e), h - 7f * density.density), Offset(x(e), h), strokeWidth = 1f * density.density)
        if (track.points.size > 1) {
            val path = Path()
            track.points.forEachIndexed { i, (e, v) ->
                val px = x(e)
                val py = mid - v.toFloat() * (h / 2f - 4f * density.density)
                if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
            }
            drawPath(path, color = if (track.isDelta) colors.danger else colors.chartLine, style = Stroke(width = 1.5f * density.density))
        }
        val tx = x(holder.eMaster)
        drawCircle(colors.surfaceCard, radius = 8f * density.density, center = Offset(tx, mid))
        drawCircle(colors.accent, radius = 6f * density.density, center = Offset(tx, mid))
    }
}

/** The scrubber's track, in the master's lap time: points `(e, v)` with v in −1..1, and its ticks. */
internal data class ScrubTrack(val points: List<Pair<Double, Double>>, val ticks: List<Double>, val isDelta: Boolean)

/**
 * The delta (A − B, or A − the reference) along the master's lap, scaled to the
 * lap's largest absolute delta; with no other side, A's speed. Ticks at each
 * corner's start and the two sector boundaries. Pure, for `LapStageHolderTest`.
 */
internal fun scrubTrack(binding: LapStageHolder.Binding, master: SideKey): ScrubTrack {
    val a = binding.a.side
    val b = binding.b?.side
    val m = if (master == SideKey.B && b != null) b else a
    val n = a.t.size
    val raw = (0 until n).map { k ->
        val kd = k.toDouble()
        val v = if (b != null) {
            val st = VideoSync.playheadAt(VideoSync.Sides(a, b), SideKey.A, a.t[k], VideoSync.SyncMode.PLACE)
            st.deltaS ?: 0.0
        } else {
            VideoSync.valueAt(a.entry.speed, kd) ?: 0.0
        }
        // Where this place is on the master's clock.
        val e = if (m === a) a.t[k] else VideoSync.playheadAt(VideoSync.Sides(a, b), SideKey.A, a.t[k], VideoSync.SyncMode.PLACE).b!!.e
        e to v
    }
    val peak = raw.maxOfOrNull { abs(it.second) }?.takeIf { it > 0 } ?: 1.0
    val points = if (b != null) {
        raw.map { (e, v) -> e to v / peak }
    } else {
        val lo = raw.minOfOrNull { it.second } ?: 0.0
        val hi = raw.maxOfOrNull { it.second } ?: 1.0
        raw.map { (e, v) -> e to if (hi > lo) (v - lo) / (hi - lo) * 2 - 1 else 0.0 }
    }
    val ticks = buildList {
        binding.corners.forEach { c -> VideoSync.valueAt(m.t, c.k0.toDouble())?.let { add(it) } }
        val last = (m.t.size - 1).toDouble()
        VideoSync.valueAt(m.t, last / 3)?.let { add(it) }
        VideoSync.valueAt(m.t, last * 2 / 3)?.let { add(it) }
    }
    return ScrubTrack(points, ticks, isDelta = b != null)
}

/** *Same place | Same time*. */
@Composable
private fun ModeControl(mode: SyncMode, onMode: (SyncMode) -> Unit) {
    val colors = TrackTheme.colors
    Row(
        Modifier
            .background(colors.surfaceRaised, CircleShape)
            .border(1.dp, colors.borderHairline, CircleShape)
            .padding(3.dp)
            .testTag("stageMode"),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (m in VideoSync.SYNC_MODES) {
            val on = m == mode
            val label = if (m == SyncMode.PLACE) "Same place" else "Same time"
            Text(
                label,
                style = TrackTheme.typography.xs,
                color = if (on) colors.accentContrast else colors.textMuted,
                maxLines = 1,
                modifier = Modifier
                    .background(if (on) colors.accent else Color.Transparent, CircleShape)
                    .clickable(onClickLabel = label) { onMode(m) }
                    .padding(horizontal = 10.dp, vertical = 5.dp)
                    .semantics {
                        selected = on
                        contentDescription = label
                    }
                    .testTag("stageMode:${m.key}"),
            )
        }
    }
}

@Composable
private fun RateMenu(holder: LapStageHolder) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "Playback rate" }) {
            Text(rateLabel(holder.rate), style = TrackTheme.typography.xs, color = TrackTheme.colors.textMuted)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (r in listOf(0.25, 0.5, 1.0)) {
                DropdownMenuItem(text = { Text(rateLabel(r)) }, onClick = { open = false; holder.changeRate(r) })
            }
        }
    }
}

private fun rateLabel(r: Double) = when (r) {
    0.25 -> "0.25×"
    0.5 -> "0.5×"
    else -> "1×"
}

// ---- the now-strip ----------------------------------------------------------------

/** What the now-strip shows, rounded to what it prints, so it recomposes only when the words change. */
private data class NowWords(
    val place: String,
    val speed: String?,
    val bSpeed: String?,
    val gear: String?,
    val throttle: Int?,
    val brake: Int?,
    val delta: String?,
    val slower: Boolean?,
)

/**
 * What the car is doing at the playhead, for side A (and B's speed in a
 * compare): the place, the speed and gear, throttle and brake as two bars, and
 * the delta — or in *Same time* the gap. A card with rows on a large screen, one
 * row on a phone and below a tabletop's crease.
 */
@Composable
private fun NowStrip(holder: LapStageHolder, row: Boolean, modifier: Modifier = Modifier) {
    val units = LocalUnitSystem.current
    val colors = TrackTheme.colors
    val words by remember(holder, units) {
        derivedStateOf {
            val st = holder.state.value ?: return@derivedStateOf null
            val text = VideoSync.playheadText(st, holder.binding?.corners, units)
            val other = holder.binding?.b
            val vsWho = if (holder.binding?.showB == true) "vs B" else "vs ${other?.label?.substringBefore(" ·") ?: "best"}"
            NowWords(
                place = text.place,
                speed = st.a.now.speedKph?.takeIf { st.inLap }?.let { Units.fmtSpeedKph(it, units) },
                bSpeed = st.b?.now?.speedKph?.takeIf { st.inLap && holder.binding?.showB == true }?.let { Units.fmtSpeedKph(it, units) },
                gear = st.a.now.gear?.takeIf { st.inLap && it > 0 }?.roundToInt()?.toString(),
                throttle = st.a.now.throttle?.takeIf { st.inLap }?.roundToInt(),
                brake = st.a.now.brake?.takeIf { st.inLap }?.roundToInt(),
                delta = text.delta?.let { if (st.mode == SyncMode.TIME) it else "$it $vsWho" },
                slower = st.deltaS?.takeIf { st.mode == SyncMode.PLACE }?.let { it > 0 },
            )
        }
    }
    val w = words ?: return
    val deltaColor = when (w.slower) {
        true -> colors.dangerInk
        false -> colors.positive
        null -> colors.textMuted
    }
    val bars = @Composable {
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.Bottom) {
            PedalBar(w.throttle, colors.limitPower, "Throttle")
            PedalBar(w.brake, colors.limitBrake, "Brake")
        }
    }
    if (row) {
        Row(
            modifier.fillMaxWidth().testTag("nowStrip"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(w.place, style = TrackTheme.typography.xs, color = colors.textMuted, maxLines = 1, modifier = Modifier.weight(1f))
            w.speed?.let { Text(it, style = TrackTheme.typography.lapTime, color = colors.textStrong, maxLines = 1) }
            w.gear?.let { Text(it, style = TrackTheme.typography.sm, color = colors.textMuted) }
            bars()
            w.delta?.let { Text(it, style = TrackTheme.typography.xs, color = deltaColor, maxLines = 1) }
        }
    } else {
        TrackCard(modifier.testTag("nowStrip"), contentPadding = 10.dp) {
            Text(w.place, style = TrackTheme.typography.xs, color = colors.textMuted)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(w.speed ?: "—", style = TrackTheme.typography.lapTimeHero, color = colors.textStrong, maxLines = 1)
                w.gear?.let { Text("$it gear", style = TrackTheme.typography.sm, color = colors.textMuted) }
                Box(Modifier.weight(1f))
                bars()
            }
            w.bSpeed?.let { Text("B $it", style = TrackTheme.typography.xs, color = colors.textMuted) }
            w.delta?.let { Text(it, style = TrackTheme.typography.bodyStrong, color = deltaColor) }
        }
    }
}

@Composable
private fun PedalBar(pct: Int?, color: Color, label: String) {
    val colors = TrackTheme.colors
    Box(
        Modifier
            .width(6.dp)
            .height(28.dp)
            .background(colors.chartGrid, RoundedCornerShape(2.dp))
            .semantics { contentDescription = "$label ${pct ?: 0} %" },
        contentAlignment = Alignment.BottomCenter,
    ) {
        Box(
            Modifier
                .width(6.dp)
                .fillMaxHeight(((pct ?: 0).coerceIn(0, 100)) / 100f)
                .background(color, RoundedCornerShape(2.dp)),
        )
    }
}

// ---- full-bleed ----------------------------------------------------------------------

/**
 * The phone turned sideways (or the fullscreen button): the master video fills
 * the window, the HUD over a gradient at the bottom, the scrubber along it, the
 * map top-right with the other side's inset under it, and a back chip
 * top-left. The **same** players — the page's views let go while this has them
 * — so the rotation's activity recreation doesn't restart anything.
 */
@Composable
private fun FullBleed(ctx: StageCtx) {
    val holder = ctx.holder
    val colors = TrackTheme.colors
    val leave = {
        if (holder.fullscreen) holder.fullscreen = false else holder.fullBleedDismissed = true
    }
    DisposableEffect(holder) {
        holder.fullBleedShowing = true
        onDispose { holder.fullBleedShowing = false }
    }
    Dialog(
        onDismissRequest = leave,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        DisposableEffect(window) {
            window?.let { w ->
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                WindowCompat.getInsetsController(w, w.decorView).apply {
                    systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    hide(WindowInsetsCompat.Type.systemBars())
                }
            }
            onDispose {}
        }
        val master = holder.masterKey
        val other = if (master == SideKey.A) SideKey.B else SideKey.A
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("stageFullBleed")) {
            VideoSlot(ctx, master, Modifier.fillMaxSize(), inDialog = true)
            TextButton(
                onClick = leave,
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp).testTag("stageBack")
                    .background(Color.Black.copy(alpha = 0.5f), CircleShape),
            ) { Text("‹ Back", style = TrackTheme.typography.sm, color = Color.White) }
            Column(
                Modifier.align(Alignment.TopEnd).padding(8.dp).width(150.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ctx.trace?.takeIf { it.size >= 10 }?.let { trace ->
                    TrackMap(
                        trace = trace,
                        modifier = Modifier.fillMaxWidth(),
                        height = 110.dp,
                        dots = { stageDots(holder, colors.chartLine, colors.chartLineB, both = true) },
                    )
                }
                if (holder.binding?.shownB != null) {
                    VideoSlot(
                        ctx,
                        other,
                        Modifier.fillMaxWidth().clickable(onClickLabel = "Swap videos") { holder.swap() },
                        inset = true,
                        inDialog = true,
                    )
                }
            }
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.75f))))
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                TrackTheme(app.trackevolution.ui.theme.ThemeChoice.Dark) { NowStrip(holder, row = true) }
                StageTransport(ctx, StageLayout.FullBleed)
            }
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
