package app.trackevolution.ui.charts

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Limits
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TraceSample
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.recording.LinePicker
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.cos
import kotlin.math.sin

/**
 * A bench for the charts (NS-24), in the `debug` source set only.
 *
 * The charts are *drawn* rather than laid out, so nothing in a unit test can
 * tell you a trace came out mirrored, a ramp came out backwards, or a label
 * landed under the axis. This puts all four on one screen with a theme toggle,
 * because the tokens change hue between light and dark and a chart that reads
 * well in one can vanish in the other.
 *
 * It also carries the **20,000-fix line picker** NS-24 asks to be profiled. A
 * stored lap trace is capped at 300 points by `GeoTrace.lapTrace`, so nothing
 * else in the app can reach that size — a raw recording can, and the picker is
 * the one screen that draws it.
 */
class ChartGalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var theme by remember { mutableStateOf(ThemeChoice.Dark) }
            TrackTheme(theme) {
                Gallery(
                    theme = theme,
                    onToggleTheme = {
                        theme = if (theme == ThemeChoice.Dark) ThemeChoice.Light else ThemeChoice.Dark
                    },
                )
            }
        }
    }
}

@Composable
private fun Gallery(theme: ThemeChoice, onToggleTheme: () -> Unit) {
    val colors = TrackTheme.colors
    var picked by remember { mutableIntStateOf(0) }

    // 20,000 fixes: roughly 30 minutes at 10 Hz, which is a full session.
    val bigTrace = remember { syntheticTrace(20_000) }
    val lapTrace = remember { syntheticSamples(280) }

    Column(
        Modifier
            .fillMaxSize()
            // The window theme follows the *system* light/dark, but the toggle
            // here forces the token set — so without painting the page the
            // gallery can put near-white text on a light window.
            .background(colors.bgPage)
            // Without this the gallery draws under the status bar, which
            // both clips the first row and eats taps meant for it.
            .systemBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        TextButton(onClick = onToggleTheme) {
            Text("Theme: ${theme.name} — tap to switch", color = colors.accentInk)
        }

        Text("Progress — full, with an unbeaten goal", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        ProgressChart(
            points = listOf(
                ProgressPoint(1.0, "May 1", 128_400),
                ProgressPoint(2.0, "Jun 12", 125_100),
                ProgressPoint(3.0, "Jul 3", 123_800),
                ProgressPoint(4.0, "Aug 2", 121_450),
            ),
            goalMs = 119_000,
        )

        Text("Progress — sparkline", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        ProgressChart(
            points = (1..8).map { ProgressPoint(it.toDouble(), "", 128_000 - it * 700) },
            style = ProgressChartStyle.Sparkline,
        )

        Text("Progress — identical times (degenerate)", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        ProgressChart(points = (1..3).map { ProgressPoint(it.toDouble(), "E$it", 120_000) })

        Text("Trackmap — speed ramp", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        TrackMap(trace = lapTrace)

        Text(
            "Trackmap — limit marks (#188)",
            style = TrackTheme.typography.bodyStrong,
            color = colors.textStrong,
        )
        val markers = Limits.limitMarkers(gallerySession.laps[0], gallerySession.dStepM, lapTrace)
        TrackMap(trace = lapTrace, markers = markers)
        LimitLegend(markers, Modifier.padding(top = 6.dp))

        Text("Lap overlay", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        LapChannelChart(channels = gallerySession, laps = galleryLaps)

        Text(
            "Line picker — 20,000 fixes (drag/pinch to profile)",
            style = TrackTheme.typography.bodyStrong,
            color = colors.textStrong,
        )
        LinePicker(
            trace = bigTrace,
            gate = null,
            pickedIndex = picked.takeIf { it > 0 },
            onPick = { picked = it },
            modifier = Modifier.fillMaxWidth().height(300.dp),
        )
        Text(
            "picked index: $picked of ${bigTrace.size}",
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )
    }
}

/**
 * Five laps carrying every gridded channel the panel draws, including the three
 * that only a PDR import produces — `gear`, `wheelSlip` and the ABS/TC/VSC
 * `flags` bitfield (#187, #188), so the gear ribbon, the shift table, the limit
 * bands and the map's marks all have something to draw on the bench.
 */
private val gallerySession = SessionChannels(
    v = 1,
    dStepM = 20.0,
    laps = (1..5).map { n ->
        LapChannels(
            n = n,
            timeMs = 123_000 - n * 400,
            speed = (0 until 150).map { 60 + 90 * (0.5 + 0.5 * sin(it / 9.0 + n)) },
            rpm = (0 until 150).map { 3000 + 3500 * (0.5 + 0.5 * sin(it / 9.0 + n)) },
            latG = (0 until 150).map { 1.1 * sin(it / 4.5 + n) },
            // A quarter-turn out of phase with the cornering, so the samples
            // fill the friction circle rather than drawing its cross (#186).
            longG = (0 until 150).map { -1.2 * cos(it / 4.5 + n) },
            // Pedals trade off against each other (0–100%), the steering trace
            // is signed degrees around zero.
            throttle = (0 until 150).map { 100 * (0.5 + 0.5 * sin(it / 9.0 + n)) },
            brake = (0 until 150).map { 100 * (0.5 - 0.5 * sin(it / 9.0 + n)) },
            steering = (0 until 150).map { 180 * sin(it / 4.5 + n) },
            // Rotation that mostly follows the steering, but falls short through
            // the second half of the lap — so the balance scatter has a band to
            // draw and its table has a corner that pushes (#189).
            yaw = (0 until 150).map { k ->
                val speed = 60 + 90 * (0.5 + 0.5 * sin(k / 9.0 + n))
                val steer = 180 * sin(k / 4.5 + n)
                0.012 * (speed / 3.6) * steer * (if (k > 75) 0.7 else 1.0)
            },
            // Gear steps with the speed wave and drops to 0 through one shift,
            // which is the clutch-in gap the ribbon has to draw as a gap.
            gear = (0 until 150).map { k ->
                val wave = 0.5 + 0.5 * sin(k / 9.0 + n)
                if (k % 37 == 18) 0.0 else (2 + (wave * 3).toInt()).toDouble()
            },
            // The per-lap scalars the Car tab reads (#190): oil climbing past its
            // line by the last lap, fuel draining, and a tyre spread that is a
            // camber question rather than noise.
            oilC = 112 + n * 6.0,
            oilKpa = 330 - n * 30.0,
            coolantC = 98 + n * 5.0,
            transC = 92 + n * 7.0,
            fuelPct = 78 - n * 11.0,
            battV = 13.7 - n * 0.3,
            tyreKpaLF = 212 + n * 8.0,
            tyreKpaRF = 208 + n * 7.0,
            tyreKpaLR = 204 + n * 6.0,
            tyreKpaRR = 203 + n * 6.0,
            tyreCLF = 80 + n * 8.0,
            tyreCRF = 72 + n * 6.0,
            tyreCLR = 67 + n * 5.0,
            tyreCRR = 65 + n * 5.0,
            // Wheelspin on the exits, lockup into the braking zones.
            wheelSlip = (0 until 150).map { 5.0 * sin(it / 9.0 + n) },
            // ABS under braking, traction control on a couple of exits.
            flags = (0 until 150).map { k ->
                val wave = sin(k / 9.0 + n)
                when {
                    wave < -0.85 -> Limits.FLAG_ABS.toDouble()
                    wave > 0.9 -> Limits.FLAG_TC.toDouble()
                    else -> 0.0
                }
            },
        )
    },
)

private val galleryLaps = (1..5).map { Lap(id = it, sessionId = 1, lapNum = it, timeMs = 123_000 - it * 400) }

/** A closed circuit with a couple of corners, in projected metres. */
private fun syntheticTrace(n: Int): List<TracePoint> = (0 until n).map { i ->
    val a = i / n.toDouble() * 2 * Math.PI * 4 // four laps
    TracePoint(
        t = i * 0.1,
        x = cos(a) * 600 + cos(a * 3) * 90,
        y = sin(a) * 380 + sin(a * 2) * 60,
        v = 24.0 + 18.0 * (0.5 + 0.5 * sin(a * 3)),
    )
}

private fun syntheticSamples(n: Int): List<TraceSample> = syntheticTrace(n).map {
    TraceSample(x = it.x, y = it.y, v = it.v ?: 0.0)
}
