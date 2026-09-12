package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.CompareLaps
import app.trackevolution.core.LapTime
import app.trackevolution.core.SessionConditions
import app.trackevolution.core.Units
import app.trackevolution.core.TraceSample
import app.trackevolution.core.EventDates
import app.trackevolution.core.model.LeaderboardLap
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * One leaderboard row, opened (NS-35). `viewLeaderboardLap` in `public/app.js`
 * is the reference, and [CompareLapsScreen] is the sibling it borrows its charts
 * and head-to-head from.
 *
 * The server publishes the lap and nothing else — no session, no event, no car,
 * nothing user-entered — so this screen is deliberately thin above the charts: a
 * time, whose it is, the date, and what the recorder measured.
 *
 * A **destination**, not an overlay, matching how the two-lap compare is reached
 * here: it is a place you go and come back from with the system gesture, and
 * nothing about it is modal the way the recorder's review is.
 *
 * Max RPM is absent from the head-to-head that [CompareLapsScreen] shows: a
 * stranger's engine speed against yours is a fact about two different cars, not
 * about the lap.
 */
@Composable
fun LeaderboardLapScreen(
    model: LeaderboardLapModel,
    /**
     * Whether the viewer may see channel traces. The server has already decided
     * — it strips `channels` for a free account, exactly as it does on a session
     * — so this only chooses between "here is what Pro shows you" and "this lap
     * stored no telemetry", which are different sentences and must not be one.
     */
    canViewChannels: Boolean,
    modifier: Modifier = Modifier,
    onSubscribe: () -> Unit = {},
) {
    val colors = TrackTheme.colors

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, onSubscribe = onSubscribe, modifier = modifier) {
        val lap = model.lap ?: return@TELoadable
        val panel = model.panel
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(LapTime.fmtMs(lap.timeMs), style = TrackTheme.typography.h1, color = colors.textStrong)
                    Text(subtitle(lap, LocalUnitSystem.current), style = TrackTheme.typography.sm, color = colors.textMuted)
                }
            }

            // The racing line is free: `channels` is the one Pro field (NS-32
            // rule 4), so a free account still gets the shape of the lap and the
            // upsell sits under it rather than over the screen.
            val trace = lap.trace.orEmpty().map { TraceSample(x = it.x, y = it.y, v = it.v) }
            if (trace.size > 1) {
                item("map") {
                    TrackCard(Modifier.fillMaxWidth()) {
                        Text(
                            "Racing line — brighter is faster",
                            style = TrackTheme.typography.xs,
                            color = colors.textFaint,
                        )
                        TrackMap(trace = trace, modifier = Modifier.fillMaxWidth().height(220.dp))
                    }
                }
            }

            if (panel == null) {
                item("no-telemetry") {
                    if (canViewChannels) {
                        TEEmpty("This lap's telemetry isn't available.")
                    } else {
                        TrackCard(Modifier.fillMaxWidth()) {
                            Text("Telemetry", style = TrackTheme.typography.h3, color = colors.textStrong)
                            Text(
                                "See this lap's speed, throttle, brake and steering traces — and put your own " +
                                    "best lap at this track beside it, corner for corner.",
                                style = TrackTheme.typography.sm,
                                color = colors.textMuted,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                            TextButton(onClick = onSubscribe) {
                                Text(
                                    "See Track Evolution Pro",
                                    style = TrackTheme.typography.bodyStrong,
                                    color = colors.accentInk,
                                )
                            }
                        }
                    }
                }
                return@LazyColumn
            }

            if (panel.mine == null) {
                item("no-lap-of-mine") {
                    Text(
                        "You have no lap with telemetry at this track yet, so there's nothing to overlay. " +
                            "Record with the app or import a session and this screen will put the two side by side.",
                        style = TrackTheme.typography.xs,
                        color = colors.textMuted,
                    )
                }
            } else {
                // Only offered once there is a choice to make: with one lap of
                // your own it is already the one shown, and a menu with a single
                // item is a control that does nothing.
                if (model.rows.size > 1) {
                    item("mine-picker") {
                        MinePicker(colors.chartLineB, model)
                    }
                }
                if (panel.mismatch > CompareLaps.LENGTH_MISMATCH_WARN) {
                    item("mismatch") {
                        Text(
                            "⚠️ These laps cover driven distances ${(panel.mismatch * 100).roundToInt()}% apart — " +
                                "likely a different layout or start/finish line, so the distance alignment may be off.",
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                        )
                    }
                }
            }

            item("head-to-head") { HeadToHead(panel) }

            item("charts-hint") {
                Text(
                    if (panel.mine == null) {
                        "Tap a chart to read values."
                    } else {
                        "The delta chart shows where you gain or lose against this lap; " +
                            "the channels below show why."
                    },
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                )
            }

            item("charts") {
                LapChannelChart(
                    channels = panel.aligned,
                    laps = panel.laps,
                    initialSelection = if (panel.mine == null) listOf(0) else listOf(0, 1),
                )
            }
        }
    }
}

/**
 * Whose lap, when, and what the recorder measured around it. Nothing here is
 * user-entered — the typed `temp_f` deliberately has no counterpart.
 */
private fun subtitle(lap: LeaderboardLap, units: UnitSystem): String {
    val parts = mutableListOf(
        if (lap.you) "Your leaderboard lap" else "${lap.name ?: "Driver"}'s leaderboard lap",
        EventDates.fmtDate(lap.date),
    )
    lap.ambientC?.let { parts += SessionConditions.tempText(it, Units.usUnits(units)) }
    SessionConditions.elevationText(lap.elevationM, Units.usUnits(units))
        .takeIf { it.isNotEmpty() }
        ?.let { parts += it }
    return parts.joinToString(" · ")
}

@Composable
private fun MinePicker(color: Color, model: LeaderboardLapModel) {
    val colors = TrackTheme.colors
    var expanded by remember { mutableStateOf(false) }
    val selected = model.selectedMine ?: 0

    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Box {
            Text(
                model.pickLabel(selected),
                style = TrackTheme.typography.bodyStrong,
                color = colors.textStrong,
                maxLines = 1,
                modifier = Modifier
                    .background(colors.surfaceCard, RoundedCornerShape(TrackTheme.radii.sm))
                    .border(1.dp, colors.borderHairline, RoundedCornerShape(TrackTheme.radii.sm))
                    .clickable { expanded = true }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .semantics { contentDescription = "Your lap: ${model.pickLabel(selected)}" },
            )
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                model.rows.indices.forEach { index ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                (if (index == selected) "✓ " else "") + model.pickLabel(index),
                                style = TrackTheme.typography.sm,
                            )
                        },
                        onClick = {
                            expanded = false
                            model.pickMine(index)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun HeadToHead(panel: LeaderboardLapModel.Panel) {
    val units = LocalUnitSystem.current
    val mph = { kph: Double -> Units.fmtSpeedKph(kph, units) }
    val mphDelta = { kph: Double -> signed(kph, Units.fmtSpeedKph(abs(kph), units)) }
    val ppDelta = { d: Double -> signed(d, "${(abs(d) * 10).roundToInt() / 10.0}pp") }

    TrackCard(Modifier.fillMaxWidth()) {
        LapRow(
            "Lap time",
            LapTime.fmtMs(panel.theirMetrics.timeMs),
            panel.myMetrics?.let { LapTime.fmtMs(it.timeMs) },
            panel.myMetrics?.let { LapTime.fmtDelta(it.timeMs - panel.theirMetrics.timeMs) },
        )
        Metric("Top speed", panel, { it.topSpeedKph }, mph, mphDelta)
        Metric("Min speed", panel, { it.minSpeedKph }, mph, mphDelta)
        Metric("Avg speed", panel, { it.avgSpeedKph }, mph, mphDelta)
        Metric(
            "Max lateral G", panel, { it.maxLatG },
            { String.format("%.2f", it) }, { signed(it, String.format("%.2f", abs(it))) },
        )
        Metric("Full throttle", panel, { it.fullThrottlePct }, { "${it.roundToInt()}% of lap" }, ppDelta)
        Metric(
            "On the brakes", panel, { it.brakingPct }, { "${it.roundToInt()}% of lap" }, ppDelta,
            last = true,
        )
    }
}

@Composable
private fun Metric(
    label: String,
    panel: LeaderboardLapModel.Panel,
    pick: (CompareLaps.Metrics) -> Double?,
    fmt: (Double) -> String,
    deltaFmt: (Double) -> String,
    last: Boolean = false,
) {
    val theirs = pick(panel.theirMetrics)
    val mine = panel.myMetrics?.let(pick)
    LapRow(
        label = label,
        theirs = theirs?.let(fmt) ?: "—",
        mine = if (panel.myMetrics == null) null else mine?.let(fmt) ?: "—",
        delta = if (theirs != null && mine != null) deltaFmt(mine - theirs) else null,
        last = last,
    )
}

/** The Δ column disappears when there is only one lap to read. */
@Composable
private fun LapRow(label: String, theirs: String, mine: String?, delta: String?, last: Boolean = false) {
    val colors = TrackTheme.colors
    val spoken = if (mine == null) {
        "$label: $theirs"
    } else {
        "$label: theirs $theirs, yours $mine, difference ${delta ?: "unknown"}"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .semantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(label, style = TrackTheme.typography.sm, color = colors.textMuted, modifier = Modifier.weight(1f))
        Text(theirs, style = TrackTheme.typography.lapTime, color = colors.textStrong)
        if (mine != null) {
            Text(mine, style = TrackTheme.typography.lapTime, color = colors.textStrong)
            Text(delta ?: "—", style = TrackTheme.typography.lapTime, color = colors.textMuted)
        }
    }
    if (!last) HorizontalDivider(color = colors.borderHairline)
}

/** The sign is the message, so it is always shown. */
private fun signed(value: Double, magnitude: String): String =
    if (value < 0) "−$magnitude" else "+$magnitude"
