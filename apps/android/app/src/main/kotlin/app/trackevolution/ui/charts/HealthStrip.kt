package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Health
import app.trackevolution.core.Units
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.LayoutClass
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Every figure shows in the account's system — °F and psi for an imperial
 * account, °C and kPa for a metric one — while the maths stays in the stored
 * units. Read from `LocalUnitSystem`, so it is a composable getter: capture it
 * into a local before handing it to anything that isn't.
 */
private val UNITS: Health.Units
    @Composable get() = Units.healthUnits(LocalUnitSystem.current)

/**
 * The session health strip (#190) — the counterpart of `healthStripHtml` and
 * `sparklineSvg` in `public/js/health.js`.
 *
 * The panel's Car tab: one card per figure the import stored — peak oil,
 * coolant and transmission temperature, minimum oil pressure and battery, fuel
 * and the four tyre pressures at lap end, peak tyre temperature per corner, and
 * per-lap peak boost — carrying the session's number by that channel's own
 * rule, a sparkline across the laps with its threshold bands shaded, and the
 * cross-corner tyre spread and fuel outlook under them. The maths is `Health`
 * in `:core`, pinned to the web implementation by `contracts/logic/health.json`;
 * this file draws.
 *
 * Four things are load-bearing.
 *
 * **Thresholds shade, they never alarm.** A card past its watch line takes a
 * tinted border and one past its `over` line a tinted background, in the
 * garage's own wear colours — `danger` — rather than a second severity scale
 * invented here. Nothing blocks, nothing pops.
 *
 * **The number is the importer's reduction, and the card says which** ("peak",
 * "min", "at lap end"), because "oil 134 °C" means nothing without knowing it is
 * the lap's peak rather than its average.
 *
 * **The figures show in the account's system** ([UNITS]) while the maths stays
 * in the stored units — the conversion is the last step, exactly as on the web.
 *
 * **The web's per-lap table is deliberately absent.** Fifteen columns is a desk
 * layout; on a phone the sparkline carries the shape and the highlighted laps
 * are marked on it in their slot colours, which is the same question answered in
 * the space available.
 */
@Composable
fun HealthStrip(
    channels: SessionChannels,
    /** Channel-lap indexes in slot order, as [LapChannelChart] keeps them. */
    lit: List<Int>,
    slots: List<Color>,
    modifier: Modifier = Modifier,
    /** The session's own lap number for a channel entry, for the per-lap table. */
    lapNumber: (Int) -> Int = { it + 1 },
) {
    val sh = remember(channels) { Health.sessionHealth(channels) } ?: return
    val order = sh.laps.map { it.chIdx }
    val colors = TrackTheme.colors
    // Two on a phone; as many as the column holds above that. 150dp is the web's
    // own `.health-cards` minimum.
    val perRow = maxOf(2, LocalLayoutMetrics.current.columns(150.dp, gap = 8.dp))

    val summary = Health.healthSummary(channels, UNITS)
        ?: sh.columns.mapNotNull { column ->
            Health.defFor(column.key)?.let {
                "${it.label} ${Health.displayValue(it, column.extreme.v, UNITS).text}"
            }
        }.joinToString(", ")

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    TrackCard(
        Modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                testTag = "healthStrip"
                contentDescription = "Car: the session's health figures. $summary"
            },
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Car", style = TrackTheme.typography.xxs, color = colors.textMuted)
            Text(
                "What the car was doing while you drove it. One figure per lap, reduced the way " +
                    "the recorder stored it.",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
            )
            for ((groupKey, groupLabel) in Health.HEALTH_GROUPS) {
                val columns = sh.columns.filter { Health.defFor(it.key)?.group == groupKey }
                if (columns.isEmpty()) continue
                Text(groupLabel, style = TrackTheme.typography.xxs, color = colors.textFaint)
                // Two to a row on a phone, which is what fits legibly; more once
                // the column is wide enough for them (NS-34 ticket 3). Still not
                // a LazyVGrid — one inside an already-scrolling panel nests
                // scrolls, which is why this chunks by hand.
                columns.chunked(perRow).forEach { group ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        group.forEach { column ->
                            FigureCard(
                                column = column,
                                order = order,
                                lit = lit,
                                slots = slots,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        repeat(perRow - group.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            SpreadLines(channels)
            FuelLine(channels)
        }
    }

    // The per-lap table (NS-34 ticket 3), at expanded width only: the cards
    // above reduce each column to one number precisely because fifteen columns
    // do not fit a phone, and this is that reduction undone where there is room.
    //
    // Its **own card**, deliberately, rather than the last thing inside the one
    // above. That card declares itself a single accessibility element — a
    // fifteen-by-N grid of numbers is unbearable to swipe through one cell at a
    // time — and anything inside it inherits that, so a table placed there would
    // be invisible to TalkBack as well as to a test. As a sibling it carries a
    // summary of its own.
    if (LocalLayoutMetrics.current.layoutClass == LayoutClass.Expanded) {
        PerLapTable(sh = sh, lit = lit, slots = slots, lapNumber = lapNumber)
    }
    }
}

@Composable
private fun FigureCard(
    column: Health.Column,
    order: List<Int>,
    lit: List<Int>,
    slots: List<Color>,
    modifier: Modifier = Modifier,
) {
    val def = Health.defFor(column.key) ?: return
    val colors = TrackTheme.colors
    val display = Health.displayValue(def, column.extreme.v, UNITS)
    val border = when (column.status) {
        Health.Status.DUE -> colors.danger
        Health.Status.LOW -> colors.danger.copy(alpha = 0.45f)
        else -> colors.borderHairline
    }
    val background = if (column.status == Health.Status.DUE) colors.dangerTint else Color.Transparent
    val statusWord = when (column.status) {
        Health.Status.DUE -> "over the line"
        Health.Status.LOW -> "watch"
        else -> null
    }
    val line = colors.chartLine

    Column(
        modifier
            .background(background, RoundedCornerShape(10.dp))
            .border(1.dp, border, RoundedCornerShape(10.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            def.label,
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
            maxLines = 1,
        )
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                display.text,
                style = TrackTheme.typography.h3,
                color = colors.textStrong,
                maxLines = 1,
            )
            statusWord?.let {
                Text(it, style = TrackTheme.typography.xxs, color = colors.dangerInk, maxLines = 1)
            }
        }
        Text(ruleWord(def), style = TrackTheme.typography.xxs, color = colors.textFaint)
        val danger = colors.danger
        Canvas(Modifier.fillMaxWidth().height(34.dp)) {
            drawSparkline(def, column, order, lit, slots, line, danger)
        }
    }
}

/** The importer's rule, said out loud — `ruleWord` in the JS. */
private fun ruleWord(def: Health.Def): String = when (def.reduce) {
    Health.Reduce.MAX -> "peak"
    Health.Reduce.MIN -> "min"
    Health.Reduce.END -> "at lap end"
}

/**
 * One column across the session's health laps: x is the lap's position among
 * them (so every card lines up), the threshold bands shaded behind the line, and
 * the highlighted laps marked in their slot colours.
 */
private fun DrawScope.drawSparkline(
    def: Health.Def,
    column: Health.Column,
    order: List<Int>,
    lit: List<Int>,
    slots: List<Color>,
    lineColor: Color,
    danger: Color,
) {
    val series = column.series
    if (series.isEmpty() || size.width <= 0f || size.height <= 0f) return
    val pad = 4f * density
    val n = max(2, order.size)
    val index = order.withIndex().associate { (i, chIdx) -> chIdx to i }

    var y0 = series.minOf { it.v }
    var y1 = series.maxOf { it.v }
    // Bring the lines into view when the data sits near them, so the shading
    // says how close the session came rather than only whether it crossed.
    val watch = def.watch
    val over = def.over
    if (watch != null && over != null) {
        val near = if (def.low) watch * 1.05 else watch * 0.95
        if (if (def.low) y0 < near else y1 > near) {
            y0 = min(y0, over)
            y1 = max(y1, over)
        }
    }
    val ypad = max((y1 - y0) * 0.15, 1e-6)
    y0 -= ypad
    y1 += ypad

    fun x(i: Int) = pad + i.toFloat() / (n - 1) * (size.width - pad * 2)
    fun y(v: Double) = pad + ((y1 - v) / (y1 - y0)).toFloat() * (size.height - pad * 2)
    fun clampY(v: Double) = min(max(y(v), pad), size.height - pad)

    // The bands: past `over` in the danger tint, between the lines lighter.
    if (watch != null && over != null) {
        fun band(from: Double, to: Double, alpha: Float) {
            val ya = clampY(to)
            val yb = clampY(from)
            if (abs(yb - ya) <= 0.5f) return
            drawRect(
                color = danger.copy(alpha = alpha),
                topLeft = Offset(0f, min(ya, yb)),
                size = Size(size.width, abs(yb - ya)),
            )
        }
        band(if (def.low) y0 else over, if (def.low) over else y1, 0.18f)
        band(if (def.low) over else watch, if (def.low) watch else over, 0.09f)
    }

    val path = Path()
    series.forEachIndexed { i, s ->
        val px = x(index[s.chIdx] ?: i)
        val py = y(s.v)
        if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
    }
    drawPath(path, color = lineColor, style = Stroke(width = 1.5f * density))

    // The highlighted laps, in the slot colours the chips use.
    lit.forEachIndexed { slot, chIdx ->
        val s = series.firstOrNull { it.chIdx == chIdx } ?: return@forEachIndexed
        val i = index[chIdx] ?: return@forEachIndexed
        drawCircle(
            color = slots[slot % slots.size],
            radius = 2.5f * density,
            center = Offset(x(i), y(s.v)),
        )
    }
}

/**
 * Cross-corner spread is the figure a setup change is judged by, so it gets
 * words rather than a chart: left−right on each axle and front−rear, for the
 * last lap that carried all four corners.
 */
@Composable
private fun SpreadLines(channels: SessionChannels) {
    val temps = remember(channels) { Health.sessionSpread(channels, "tyreC").lastOrNull() }
    val pressures = remember(channels) { Health.sessionSpread(channels, "tyreKpa").lastOrNull() }
    if (temps == null && pressures == null) return
    val colors = TrackTheme.colors
    val units = UNITS

    fun text(def: Health.Def, spread: Health.LapSpread, label: String): String {
        val front = Health.displayDelta(def, spread.front, units).text
        val rear = Health.displayDelta(def, spread.rear, units).text
        val axle = Health.displayDelta(def, spread.axle, units).text
        return "$label — front L−R $front, rear L−R $rear, front−rear $axle"
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Cross-corner spread", style = TrackTheme.typography.xxs, color = colors.textFaint)
        temps?.let { spread ->
            Health.defFor("tyreCLF")?.let {
                Text(
                    text(it, spread, "Tyre temps"),
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
        }
        pressures?.let { spread ->
            Health.defFor("tyreKpaLF")?.let {
                Text(
                    text(it, spread, "Tyre pressures"),
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
        }
    }
}

@Composable
private fun FuelLine(channels: SessionChannels) {
    val fuel = remember(channels) { Health.fuelBurn(channels) } ?: return
    Text(
        "Fuel — ${fuel.perLapPct.roundToInt()}% a lap, ${fuel.lastPct.roundToInt()}% left: " +
            "≈${fuel.lapsRemaining} lap${if (fuel.lapsRemaining == 1) "" else "s"} at this rate",
        style = TrackTheme.typography.xs,
        color = TrackTheme.colors.textMuted,
    )
}

/**
 * Every figure, every lap — the port of `healthTableHtml` (NS-34 ticket 3).
 *
 * Columns are `sh.columns`: `HEALTH_DEFS` order, filtered to what the session
 * actually stored, so the table and the cards above can never disagree about
 * which figures exist. It scrolls horizontally rather than squeezing, because a
 * temperature narrowed to three digits is not a temperature any more.
 */
@Composable
private fun PerLapTable(
    sh: Health.SessionHealth,
    lit: List<Int>,
    slots: List<Color>,
    lapNumber: (Int) -> Int,
) {
    if (sh.laps.isEmpty() || sh.columns.isEmpty()) return
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text("Per lap", style = TrackTheme.typography.xxs, color = colors.textFaint)
    Column(
        Modifier.horizontalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "Lap",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
                modifier = Modifier.width(72.dp),
            )
            sh.columns.forEach { column ->
                val def = Health.defFor(column.key)
                Column(Modifier.width(64.dp), horizontalAlignment = Alignment.End) {
                    Text(
                        def?.label ?: column.key,
                        style = TrackTheme.typography.xxs,
                        color = colors.textFaint,
                        maxLines = 1,
                    )
                    if (def != null) {
                        Text(
                            Health.displayValue(def, 0.0, UNITS).unit,
                            style = TrackTheme.typography.xxs,
                            color = colors.textFaint,
                        )
                    }
                }
            }
        }
        sh.laps.forEach { row ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier.width(72.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // The slot colour when this lap is lit, so a row lines up
                    // with the traces above — never colour alone, since the lap
                    // number is right beside it.
                    val slot = lit.indexOf(row.chIdx)
                    if (slot >= 0 && slot < slots.size) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(slots[slot]))
                    }
                    Text(
                        "Lap ${lapNumber(row.chIdx)}",
                        style = TrackTheme.typography.xs,
                        color = colors.textStrong,
                        maxLines = 1,
                    )
                }
                sh.columns.forEach { column ->
                    val def = Health.defFor(column.key)
                    val value = row.values[column.key]
                    Text(
                        if (def != null && value != null) {
                            Health.displayValue(def, value, UNITS).text
                        } else {
                            "—"
                        },
                        style = TrackTheme.typography.xs,
                        color = if (value == null) colors.textFaint else colors.textStrong,
                        maxLines = 1,
                        modifier = Modifier.width(64.dp),
                        textAlign = TextAlign.End,
                    )
                }
            }
        }
    }
    }
    }
}
