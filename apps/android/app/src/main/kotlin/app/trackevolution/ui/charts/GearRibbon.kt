package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Gears
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.max
import kotlin.math.min

/**
 * The gear ribbon (#187) — the counterpart of `gearRibbonSvg` in
 * `public/js/gears.js`.
 *
 * One horizontal band per highlighted lap on the channel panel's shared
 * driven-distance axis, cut into blocks of one gear with the number written in
 * any block wide enough to hold it. **Not a line chart**: `gear` is an enum, and
 * a line between 3 and 4 implies a gear no car has — which is also why the
 * importer samples it by holding the last value. Gear 0 (clutch in / no gear)
 * renders as a *gap* rather than a block, because it is genuinely "no gear".
 *
 * With two or more laps lit, the runs where they sit in different gears are
 * outlined, and that is the whole feature: "you took T5 in 3rd on your best lap
 * and 4th on this one". The cutting and the comparison rule are `Gears` in
 * `:core`, pinned to the web implementation by `contracts/logic/gears.json`;
 * this file draws.
 */
@Composable
fun GearRibbon(
    channels: SessionChannels,
    /** Channel-lap indexes in slot order, as [LapChannelChart] keeps them. */
    lit: List<Int>,
    slots: List<Color>,
    /** The session's own lap number for a channel entry. */
    lapNumber: (Int) -> Int,
    modifier: Modifier = Modifier,
) {
    val rows = lit.mapIndexedNotNull { slot, chIdx ->
        val gear = channels.laps.getOrNull(chIdx)?.gear
        if (gear.isNullOrEmpty()) null else Triple(chIdx, slots[slot % slots.size], gear)
    }
    if (rows.isEmpty()) return

    val colors = TrackTheme.colors
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val blockStyle = TrackTheme.typography.xxs.copy(color = colors.surfaceCard)

    val disagreements = Gears.gearDisagreements(rows.map { it.third })
    // The same x-extent the channel charts use, so the ribbon lines up with the
    // RPM trace above it: the longest lap's speed series, falling back to gear.
    val span = max(
        1.0,
        (channels.laps.maxOfOrNull { (it.speed?.size ?: it.gear?.size ?: 0) }?.minus(1) ?: 0) * channels.dStepM,
    )

    val summary = buildString {
        rows.forEachIndexed { i, (chIdx, _, gear) ->
            if (i > 0) append(". ")
            val used = Gears.gearSegments(gear).filter { it.gear > 0 }.map { it.gear.toInt() }
            append("Lap ${lapNumber(chIdx)} used ")
            append(Gears.ordinal((used.minOrNull() ?: 0).toDouble()))
            append(" to ${Gears.ordinal((used.maxOrNull() ?: 0).toDouble())}")
        }
        if (rows.size >= 2) {
            append(
                if (disagreements.isEmpty()) {
                    ". The laps agree on gear throughout"
                } else {
                    ". The laps take different gears in ${disagreements.size} " +
                        "place${if (disagreements.size == 1) "" else "s"}"
                },
            )
        }
    }

    val rowHeight = 22.dp
    val rowGap = 6.dp
    val height = rowHeight * rows.size + rowGap * (rows.size - 1)

    Column(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                testTag = "gearRibbon"
                contentDescription = summary
            },
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Gear", style = TrackTheme.typography.xxs, color = colors.textMuted)
            if (rows.size >= 2) {
                Text(
                    if (disagreements.isEmpty()) "  same gears throughout" else "  dashed: laps disagree",
                    style = TrackTheme.typography.xxs,
                    color = colors.textFaint,
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(rowGap)) {
                rows.forEach { (chIdx, color, _) ->
                    Box(Modifier.height(rowHeight), contentAlignment = Alignment.CenterEnd) {
                        Text("L${lapNumber(chIdx)}", style = TrackTheme.typography.xxs, color = color)
                    }
                }
            }
            Canvas(Modifier.fillMaxWidth().height(height)) {
                val rowPx = with(density) { rowHeight.toPx() }
                val gapPx = with(density) { rowGap.toPx() }

                fun x(distance: Double) = (distance / span).toFloat() * size.width

                rows.forEachIndexed { index, (_, color, gear) ->
                    val y = index * (rowPx + gapPx)
                    val last = gear.size - 1
                    for (segment in Gears.gearSegments(gear)) {
                        if (segment.gear <= 0) continue // no gear: a gap, not a block
                        val xa = x(max(0.0, segment.k0 - 0.5) * channels.dStepM) + 1f
                        val xb = x(min(last.toDouble(), segment.k1 + 0.5) * channels.dStepM) - 1f
                        if (xb <= xa) continue
                        drawRoundRect(
                            color = color,
                            topLeft = Offset(xa, y),
                            size = Size(xb - xa, rowPx),
                            cornerRadius = CornerRadius(2f, 2f),
                        )
                        // Only where the block can hold the digit — a number
                        // clipped to a sliver reads as noise on the ribbon.
                        val text = measurer.measure(segment.gear.toInt().toString(), blockStyle)
                        if (xb - xa >= text.size.width + 6f) {
                            drawText(
                                text,
                                topLeft = Offset(
                                    (xa + xb) / 2f - text.size.width / 2f,
                                    y + rowPx / 2f - text.size.height / 2f,
                                ),
                            )
                        }
                    }
                }

                if (rows.size < 2) return@Canvas
                for (run in disagreements) {
                    val xa = x(max(0.0, run.k0 - 0.5) * channels.dStepM)
                    val xb = x((run.k1 + 0.5) * channels.dStepM)
                    drawRoundRect(
                        color = colors.danger,
                        topLeft = Offset(xa, -2f),
                        size = Size(xb - xa, size.height + 4f),
                        cornerRadius = CornerRadius(3f, 3f),
                        style = Stroke(
                            width = 1.5f * density.density,
                            pathEffect = PathEffect.dashPathEffect(
                                floatArrayOf(3f * density.density, 2f * density.density),
                            ),
                        ),
                    )
                }
            }
        }
    }
}
