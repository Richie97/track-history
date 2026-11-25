package app.trackevolution.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.screens.SessionStat
import app.trackevolution.ui.theme.TrackTheme

/** Two points are a line, not a shape (the web's `SPARK_MIN_LAPS`). */
const val SPARK_MIN_LAPS = 3

/**
 * A session's stats as a wrapping row of small labelled figures, led by a
 * sparkline of its lap times — the web's `sessionStatsHtml`. It used to be one
 * " · "-joined sentence, which read as a paragraph of numbers.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SessionStatsStrip(items: List<SessionStat>, laps: List<Int>, modifier: Modifier = Modifier) {
    val spark = laps.size >= SPARK_MIN_LAPS
    if (!spark && items.isEmpty()) return
    val colors = TrackTheme.colors
    val figures = items.filter { !it.text }
    // Sentences go on their own lines under the strip: one long sentence must
    // not make a cell taller than its neighbours.
    val notes = items.filter { it.text }
    Column(
        modifier = modifier.fillMaxWidth().semantics { testTag = "sessionStats" },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (spark || figures.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (spark) {
                    StatCell("Lap times", sparkSpoken(laps)) { LapSparkline(laps, Modifier.size(width = 96.dp, height = CELL_CONTENT_HEIGHT)) }
                }
                figures.forEach { item ->
                    StatCell(item.label, item.spoken) {
                        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(
                                item.value,
                                style = TrackTheme.typography.bodyStrong,
                                color = colors.textStrong,
                                maxLines = 1,
                                modifier = Modifier.alignByBaseline(),
                            )
                            item.note?.let {
                                Text(
                                    it,
                                    style = TrackTheme.typography.xs,
                                    color = when (item.tone) {
                                        SessionStat.Tone.Warn -> colors.dangerInk
                                        SessionStat.Tone.Good -> colors.accentInk
                                        null -> colors.textMuted
                                    },
                                    maxLines = 1,
                                    modifier = Modifier.alignByBaseline(),
                                )
                            }
                        }
                    }
                }
            }
        }
        notes.forEach { item ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.clearAndSetSemantics { contentDescription = item.spoken },
            ) {
                Text(
                    item.label.uppercase(),
                    style = TrackTheme.typography.eyebrow,
                    color = colors.textMuted,
                    modifier = Modifier.width(64.dp).alignByBaseline(),
                )
                Text(item.value, style = TrackTheme.typography.sm, color = colors.textBody, modifier = Modifier.alignByBaseline())
            }
        }
    }
}

/** Every cell's content is this tall, so the strip's boxes line up whatever they hold. */
private val CELL_CONTENT_HEIGHT = 22.dp

internal fun sparkSpoken(laps: List<Int>): String {
    val best = laps.indexOf(laps.minOrNull() ?: 0) + 1
    return "Lap times across the session, ${laps.size} laps; best was lap $best"
}

/** One cell, a single accessibility element saying [spoken]. */
@Composable
private fun StatCell(label: String, spoken: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = TrackTheme.colors
    val shape = RoundedCornerShape(TrackTheme.radii.sm)
    Column(
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = modifier
            .clip(shape)
            .background(colors.surfaceRaised)
            .border(1.dp, colors.borderHairline, shape)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .clearAndSetSemantics { contentDescription = spoken },
    ) {
        Text(label.uppercase(), style = TrackTheme.typography.eyebrow, color = colors.textMuted)
        Box(Modifier.height(CELL_CONTENT_HEIGHT), contentAlignment = Alignment.CenterStart) { content() }
    }
}

/**
 * Lap times across a session: one point per lap, **slower plotted higher** (the
 * progress chart's rule — down is faster), the best lap dotted.
 */
@Composable
fun LapSparkline(laps: List<Int>, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    Canvas(modifier) {
        if (laps.size < 2) return@Canvas
        val lo = laps.min()
        val hi = laps.max()
        val pad = 3.dp.toPx()
        val span = (hi - lo).coerceAtLeast(1).toFloat()
        val stepX = (size.width - pad * 2) / (laps.size - 1)
        val points = laps.mapIndexed { i, ms ->
            Offset(pad + i * stepX, pad + (1 - (ms - lo) / span) * (size.height - pad * 2))
        }
        val path = Path().apply {
            moveTo(points[0].x, points[0].y)
            points.drop(1).forEach { lineTo(it.x, it.y) }
        }
        drawPath(path, colors.chartDim, style = Stroke(1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        drawCircle(colors.chartLine, radius = 3.dp.toPx(), center = points[laps.indexOf(lo)])
    }
}
