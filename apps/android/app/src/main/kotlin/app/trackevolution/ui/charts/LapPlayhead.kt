package app.trackevolution.ui.charts

import androidx.compose.runtime.Immutable

/**
 * The lap stage's playhead as the channel panel reads it (NS-51): one driven
 * distance, a fractional grid index [k] on the panel's own 20 m grid.
 *
 * The panel's **inbound** value, beside the [ChannelHit] it reports outward.
 * In *Same place* one [k] serves every lit lap; in *Same time* each side has
 * its own, so [perLap] carries a lap's own index by channel-lap index and the
 * line stays at [k] (side A's) while B's dot sits at B's place — the gap is two
 * dots apart.
 *
 * Out of the lap there is no playhead at all: the panel is handed null, draws
 * nothing and blanks its read-outs.
 */
@Immutable
data class LapPlayhead(
    val k: Double,
    val perLap: Map<Int, Double> = emptyMap(),
    /**
     * Side A's channel-lap index — where the line goes on a time axis (A's
     * elapsed time at [k]), and whose time series a time-axis tap is turned
     * into a grid index with. Null when A carries no channels.
     */
    val aLap: Int? = null,
) {
    /** Where [chIdx]'s dot sits. */
    fun kFor(chIdx: Int): Double = perLap[chIdx] ?: k
}
