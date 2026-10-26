package app.trackevolution.ui.stage

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import app.trackevolution.core.LapTime
import app.trackevolution.core.VideoSync
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.LapClip

/**
 * How the stage makes a player. Null is Media3 ([ExoStagePlayer]); a
 * Robolectric test provides a fake, since Media3 has no decoder to run there.
 */
val LocalStagePlayerFactory = staticCompositionLocalOf<(() -> StagePlayer)?> { null }

/**
 * The stage's holder for this destination, on its back-stack entry (or, in a
 * test, the activity): one per [key], so a two-pane replacement that lands the
 * same screen type on a different lap builds a new one.
 */
@Composable
fun rememberLapStageHolder(key: String): LapStageHolder {
    val app = LocalContext.current.applicationContext
    val factory = LocalStagePlayerFactory.current
    return viewModel(key = "lap-stage-$key") { LapStageHolder(factory ?: { ExoStagePlayer(app) }) }
}

/** "Lap 5 · 2:19.812" — the chip's words, and the stepper's. */
fun stageLapLabel(lapNum: Int, timeMs: Int): String = "Lap $lapNum · ${LapTime.fmtMs(timeMs)}"

/**
 * One side, or null when [entry] has no speed trace to time it by. [clip] is
 * the clip the viewer may **play** — the caller has already applied the tier
 * (`canSaveLapVideo`) and the coach and share rules.
 */
fun stageSide(
    key: VideoSync.SideKey,
    entry: LapChannels,
    dStepM: Double,
    lapNum: Int,
    clip: LapClip?,
    best: Boolean,
    chIdx: Int?,
    lockedNote: String? = null,
): LapStageHolder.SideInfo? {
    val side = VideoSync.makeSide(key, entry, dStepM, VideoSync.SideClip.of(clip)) ?: return null
    return LapStageHolder.SideInfo(
        side = side,
        clip = clip,
        label = stageLapLabel(lapNum, entry.timeMs),
        best = best,
        chIdx = chIdx,
        lockedNote = lockedNote,
    )
}

/**
 * Where a stepped-to lap's stage opens: side A's grid index on the lap it was
 * stepped from, so *Lap 6 ›* keeps the place on track. A step replaces the
 * destination (and with it the holder), so the place crosses here, once.
 */
object StageHandoff {
    private val places = mutableMapOf<Int, Double>()

    fun put(lapId: Int, k: Double) {
        places[lapId] = k
    }

    fun take(lapId: Int): Double? = places.remove(lapId)
}
