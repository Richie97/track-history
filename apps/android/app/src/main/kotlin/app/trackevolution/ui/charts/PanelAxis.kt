package app.trackevolution.ui.charts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapAxis
import app.trackevolution.core.LapAxis.AxisMode
import app.trackevolution.core.Units
import app.trackevolution.core.VideoSync
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.max
import kotlin.math.min

/**
 * The channel panel's x-axis as the charts lay a session out on it — the
 * Android counterpart of `axisFrame` in `public/js/lap-axis.js` (the web-only
 * half the `:core` port leaves out). Every lap's series is worked out once per
 * session and mode: a chip toggle redraws every chart, and a time series is an
 * integration over the whole lap.
 */
class PanelAxis(
    val mode: AxisMode,
    /** The axis extent: the longest lap's last value. */
    val x1: Double,
    /** Where to label the axis, in axis units. */
    val ticks: List<Pair<Double, String>>,
    private val series: List<List<Double>?>,
) {
    /** A lap's axis value at each grid point, or null when it has none on this axis. */
    fun xsOf(chIdx: Int?): List<Double>? = chIdx?.let { series.getOrNull(it) }

    /** A lap's axis value at fractional grid index [k] — the distance grid when it has no series. */
    fun xAt(chIdx: Int?, k: Double, dStepM: Double): Double? =
        xsOf(chIdx)?.let { LapAxis.axisAtGrid(it, k) } ?: if (mode == AxisMode.DISTANCE) k * dStepM else null

    companion object {
        fun of(channels: SessionChannels, mode: AxisMode, units: UnitSystem): PanelAxis {
            val series = channels.laps.map { LapAxis.lapAxisSeries(it, channels.dStepM, mode) }
            val x1 = series.maxOfOrNull { it?.lastOrNull() ?: 0.0 } ?: 0.0
            val ticks = if (mode == AxisMode.TIME) {
                LapAxis.timeAxisTicks(x1).map { it.s to it.label }
            } else {
                Units.distAxisTicks(x1, units).map { it.m to it.label }
            }
            return PanelAxis(mode, x1, ticks, series)
        }

        /** A time axis needs a speed trace to integrate. */
        fun canTime(channels: SessionChannels): Boolean = channels.laps.any { (it.speed?.size ?: 0) >= 2 }
    }
}

/** One lit lap where the cursor is: [LapAxis.Place] plus the lap's slot colour. */
data class CursorPlace(val chIdx: Int, val k: Double, val frac: Double, val color: Color)

/**
 * The panel's cursor: an axis value and where each lit lap was there. What the
 * charts draw a line, a dot and a value for, and the map a dot per lap.
 */
data class CursorMark(val x: Double, val places: List<CursorPlace>)

/** A dot on the track map: how far round the lap, and whose colour. */
data class MapDot(val frac: Double, val color: Color)

/**
 * A plot's left and right edges in pixels, written while drawing and read by a
 * tap: the left inset is measured from the y labels at draw time, so the tap
 * handler can only know it afterwards. Not state — a tap reads the last frame.
 */
class PlotEdges {
    var left: Float = 0f
    var right: Float = 0f

    /** The axis value under pixel [px], clamped to the plot. */
    fun axisAt(px: Float, x1: Double): Double {
        val w = right - left
        if (w <= 0f) return 0.0
        return ((px - left) / w).toDouble().coerceIn(0.0, 1.0) * x1
    }
}

/** A series at fractional index [k], linearly interpolated with k clamped — `VideoSync.valueAt`. */
internal fun valueAt(series: List<Double>?, k: Double): Double? = VideoSync.valueAt(series, k)

/**
 * A tap on a lap-axis chart parks the cursor; a mouse over it borrows the
 * cursor (the [PanelPointer] rule: a pointer leaving hands the parked one back).
 * [toAxis] turns a pixel x into an axis value.
 */
fun Modifier.axisCursorInput(
    key: Any?,
    toAxis: (Float) -> Double,
    onPark: (Double) -> Unit,
    onHover: (Double?) -> Unit,
): Modifier =
    this
        .pointerInput(key) { detectTapGestures { onPark(toAxis(it.x)) } }
        .pointerHover(key) { offset -> onHover(offset?.let { toAxis(it.x) }) }

/**
 * The cursor's named actions — a chart card is one accessibility element, so a
 * tap inside it is unreachable with TalkBack unless it is offered here too
 * (AGENTS.md). Forward and back step the mark a twentieth of the axis.
 */
fun SemanticsPropertyReceiver.cursorActions(x1: Double, current: Double?, onPark: (Double?) -> Unit) {
    if (x1 <= 0.0) return
    val step = x1 / 20
    customActions = buildList {
        add(
            CustomAccessibilityAction("Mark further round the lap") {
                onPark(if (current == null) 0.0 else min(x1, current + step)); true
            },
        )
        add(
            CustomAccessibilityAction("Mark earlier in the lap") {
                onPark(if (current == null) x1 else max(0.0, current - step)); true
            },
        )
        if (current != null) add(CustomAccessibilityAction("Clear the mark") { onPark(null); true })
    }
}

/** "Marked at 0.68 mi · Clear" — the parked cursor, and the way to drop it. */
@Composable
internal fun CursorBar(text: String, onClear: () -> Unit) {
    val colors = TrackTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.semantics { testTag = "channelCursorBar" },
    ) {
        Text(text, style = TrackTheme.typography.xs, color = colors.textStrong)
        TextButton(onClick = onClear) {
            Text("Clear", style = TrackTheme.typography.xs, color = colors.accentInk)
        }
    }
}

/** The Distance / Time switch in the panel header. */
@Composable
internal fun AxisSwitch(current: AxisMode, onSelect: (AxisMode) -> Unit) {
    val colors = TrackTheme.colors
    Row(
        Modifier
            .background(colors.surfaceRaised, CircleShape)
            .border(1.dp, colors.borderHairline, CircleShape)
            .padding(3.dp)
            .semantics { testTag = "channelAxis" },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        LapAxis.AXIS_MODES.forEach { mode ->
            val on = mode == current
            val label = if (mode == AxisMode.TIME) "Time" else "Distance"
            Text(
                label,
                style = TrackTheme.typography.xs,
                color = if (on) colors.accentContrast else colors.textMuted,
                modifier = Modifier
                    .background(if (on) colors.accent else Color.Transparent, CircleShape)
                    .clickable(onClick = { onSelect(mode) })
                    .padding(horizontal = 12.dp, vertical = 5.dp)
                    .semantics {
                        selected = on
                        testTag = "axis:${mode.key}"
                        contentDescription = "Plot the laps against ${LapAxis.axisWord(mode)}"
                    },
            )
        }
    }
}
