package app.trackevolution.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker

/**
 * How the device is folded (spec: NS-34 ticket 4).
 *
 * Posture is **not** width, and this is deliberately not part of [LayoutMetrics].
 * A half-open Fold lying on a dash is the same number of dp as one held flat;
 * what changed is that there is now a crease across the middle of it. Width says
 * how much room there is, posture says where the room *is not*.
 */
enum class FoldPosture {
    /** Flat, closed, or no fold at all — every device, most of the time. */
    Flat,

    /** Half-open with a horizontal hinge: the laptop-on-a-desk shape. */
    Tabletop,

    /** Half-open with a vertical hinge: the open-book shape. */
    Book,
}

/**
 * The posture, and where the crease falls.
 *
 * [hingeFraction] is the hinge's centre as a fraction of the window — down it for
 * [FoldPosture.Tabletop], across it for [FoldPosture.Book] — so a layout can put
 * the split where the hardware actually is instead of halving the window and
 * hoping. Null when there is nothing to avoid.
 */
data class FoldGeometry(
    val posture: FoldPosture,
    val hingeFraction: Float?,
)

/**
 * Turning a fold into a posture, with no Android types in sight.
 *
 * The `androidx.window` half of this is four lines at the edge ([ProvideFoldGeometry]);
 * everything decidable lives here, so it is testable on the JVM with no device,
 * no emulator profile and no `WindowLayoutInfoPublisherRule` — the same reason
 * `AutoRecording` holds Android Auto's strings.
 */
object Folds {
    val FLAT = FoldGeometry(FoldPosture.Flat, null)

    /** How far from a half of the window a hinge may sit and still be usable. */
    private const val HINGE_LIMIT = 0.35f

    /**
     * A posture from the two facts `FoldingFeature` carries, plus where the hinge
     * is.
     *
     * Only a **half-opened** fold is a posture worth laying out for: flat is an
     * ordinary screen and a closed book is the cover display, which is its own
     * window with its own width. A hinge nowhere near the middle is ignored too —
     * splitting a screen 5/95 gives one half nothing can be read in, and a
     * device like that is better served by the layout every other device gets.
     */
    fun geometry(halfOpened: Boolean, horizontal: Boolean, hingeFraction: Float?): FoldGeometry {
        if (!halfOpened) return FLAT
        val fraction = hingeFraction ?: 0.5f
        if (fraction < 0.5f - HINGE_LIMIT || fraction > 0.5f + HINGE_LIMIT) return FLAT
        return FoldGeometry(
            posture = if (horizontal) FoldPosture.Tabletop else FoldPosture.Book,
            hingeFraction = fraction,
        )
    }
}

/**
 * What the app is folded like right now.
 *
 * `static`, like [LocalLayoutMetrics]: a fold is rare and changes everything
 * below it, so invalidating the subtree is the point rather than a cost.
 */
val LocalFoldGeometry = staticCompositionLocalOf { Folds.FLAT }

/**
 * Publish the device's posture, watched while the app is running.
 *
 * Live rather than read once, for the same reason the layout class is: unfolding
 * a device does not relaunch the app, and a posture read at launch is wrong for
 * the rest of the session. Collected only while started — `WindowInfoTracker`
 * holds a system callback, and there is nothing to lay out for in the background.
 *
 * Outside a foldable this resolves to [Folds.FLAT] and costs one flow that never
 * emits a feature.
 */
@Composable
fun ProvideFoldGeometry(content: @Composable () -> Unit) {
    val activity = LocalContext.current.findActivity()
    val lifecycleOwner = LocalLifecycleOwner.current
    val geometry: State<FoldGeometry> = produceState(Folds.FLAT, activity, lifecycleOwner) {
        val host = activity ?: return@produceState
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            WindowInfoTracker.getOrCreate(host).windowLayoutInfo(host).collect { info ->
                val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
                value = fold?.let {
                    val bounds = it.bounds
                    val window = host.window?.decorView
                    // The hinge's centre against the window it crosses: down the
                    // window for a horizontal hinge, across it for a vertical one.
                    val fraction = when {
                        window == null -> null
                        it.orientation == FoldingFeature.Orientation.HORIZONTAL ->
                            window.height.takeIf { h -> h > 0 }
                                ?.let { h -> bounds.centerY().toFloat() / h }
                        else ->
                            window.width.takeIf { w -> w > 0 }
                                ?.let { w -> bounds.centerX().toFloat() / w }
                    }
                    Folds.geometry(
                        halfOpened = it.state == FoldingFeature.State.HALF_OPENED,
                        horizontal = it.orientation == FoldingFeature.Orientation.HORIZONTAL,
                        hingeFraction = fraction,
                    )
                } ?: Folds.FLAT
            }
        }
    }
    CompositionLocalProvider(LocalFoldGeometry provides geometry.value, content = content)
}

/** The `Activity` behind a composable's context, which `WindowInfoTracker` needs. */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
