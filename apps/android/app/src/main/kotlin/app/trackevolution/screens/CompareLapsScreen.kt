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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.CompareLaps
import app.trackevolution.core.LapTime
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Compare any two laps with telemetry at one track — different sessions, events,
 * even years apart (#165). `viewLapCompare` in `public/app.js` is the reference:
 * the same "current me vs best me" default picks, head-to-head numbers and
 * length-mismatch warning; the charts are the same [LapChannelChart] the event
 * page uses, fed the pair `CompareLaps.alignLapPair` builds.
 */
@Composable
fun CompareLapsScreen(
    model: CompareLapsModel,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val pair = model.pair
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Text("Compare two laps", style = TrackTheme.typography.h1, color = colors.textStrong)
            }

            if (pair == null) {
                item("empty") {
                    TEEmpty(
                        "Comparing laps needs two laps with telemetry at this track — " +
                            "import a session (or record laps) first.",
                    )
                }
                return@LazyColumn
            }

            item("pickers") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    LapPicker("Lap A", colors.chartLine, model.selA, model, model::pickA)
                    LapPicker("Lap B", colors.chartLineB, model.selB, model, model::pickB)
                }
            }

            if (pair.mismatch > CompareLaps.LENGTH_MISMATCH_WARN) {
                item("mismatch") {
                    Text(
                        "⚠️ These laps cover driven distances ${(pair.mismatch * 100).roundToInt()}% apart — " +
                            "likely a different layout or start/finish line, so the distance alignment may be off.",
                        style = TrackTheme.typography.xs,
                        color = colors.textMuted,
                    )
                }
            }

            item("head-to-head") { HeadToHead(pair) }

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
                )
            }
        }
    }
}

@Composable
private fun LapPicker(
    label: String,
    color: Color,
    selected: Int,
    model: CompareLapsModel,
    onPick: (Int) -> Unit,
) {
    val colors = TrackTheme.colors
    var expanded by remember { mutableStateOf(false) }

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
                    .semantics { contentDescription = "$label: ${model.pickLabel(selected)}" },
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
                            onPick(index)
                        },
                    )
                }
            }
        }
    }
}

private const val KPH_TO_MPH = 0.621371

@Composable
private fun HeadToHead(pair: CompareLapsModel.LapPair) {
    val mph = { kph: Double -> "${(kph * KPH_TO_MPH).roundToInt()} mph" }
    val mphDelta = { kph: Double -> signed(kph, "${(abs(kph) * KPH_TO_MPH).roundToInt()} mph") }
    val ppDelta = { d: Double -> signed(d, "${(abs(d) * 10).roundToInt() / 10.0}pp") }

    TrackCard(Modifier.fillMaxWidth()) {
        StatRow(
            "Lap time",
            LapTime.fmtMs(pair.metricsA.timeMs),
            LapTime.fmtMs(pair.metricsB.timeMs),
            LapTime.fmtDelta(pair.metricsB.timeMs - pair.metricsA.timeMs),
        )
        MetricRow("Top speed", pair.metricsA.topSpeedKph, pair.metricsB.topSpeedKph, mph, mphDelta)
        MetricRow("Min speed", pair.metricsA.minSpeedKph, pair.metricsB.minSpeedKph, mph, mphDelta)
        MetricRow("Avg speed", pair.metricsA.avgSpeedKph, pair.metricsB.avgSpeedKph, mph, mphDelta)
        MetricRow(
            "Max RPM", pair.metricsA.maxRpm, pair.metricsB.maxRpm,
            { "${it.roundToInt()}" }, { signed(it, "${abs(it).roundToInt()}") },
        )
        MetricRow(
            "Max lateral G", pair.metricsA.maxLatG, pair.metricsB.maxLatG,
            { String.format("%.2f", it) }, { signed(it, String.format("%.2f", abs(it))) },
        )
        MetricRow(
            "Full throttle", pair.metricsA.fullThrottlePct, pair.metricsB.fullThrottlePct,
            { "${it.roundToInt()}% of lap" }, ppDelta,
        )
        MetricRow(
            "On the brakes", pair.metricsA.brakingPct, pair.metricsB.brakingPct,
            { "${it.roundToInt()}% of lap" }, ppDelta,
            last = true,
        )
    }
}

@Composable
private fun MetricRow(
    label: String,
    a: Double?,
    b: Double?,
    fmt: (Double) -> String,
    deltaFmt: (Double) -> String,
    last: Boolean = false,
) {
    StatRow(
        label = label,
        a = a?.let(fmt) ?: "—",
        b = b?.let(fmt) ?: "—",
        delta = if (a != null && b != null) deltaFmt(b - a) else "—",
        last = last,
    )
}

@Composable
private fun StatRow(label: String, a: String, b: String, delta: String, last: Boolean = false) {
    val colors = TrackTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .semantics { contentDescription = "$label: lap A $a, lap B $b, delta $delta" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(label, style = TrackTheme.typography.sm, color = colors.textMuted, modifier = Modifier.weight(1f))
        Text(a, style = TrackTheme.typography.lapTime, color = colors.textStrong)
        Text(b, style = TrackTheme.typography.lapTime, color = colors.textStrong)
        Text(delta, style = TrackTheme.typography.lapTime, color = colors.textMuted)
    }
    if (!last) HorizontalDivider(color = colors.borderHairline)
}

/** The sign is the message, so it is always shown. */
private fun signed(value: Double, magnitude: String): String =
    if (value < 0) "−$magnitude" else "+$magnitude"
