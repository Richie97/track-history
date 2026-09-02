package app.trackevolution.ui.charts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapTime
import app.trackevolution.core.Sectors
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * Sector splits and the theoretical best lap for the highlighted laps of a
 * channel session (#146) — the counterpart of `sectorTableHtml` in
 * `public/js/sectors.js`.
 *
 * One row per highlighted lap in its slot colour, a cell per sector — the
 * session's best in a sector in the accent, every other cell carrying its gap
 * to that best — and, once two or more laps could be split, a closing "best
 * sectors" row that *is* the theoretical best lap, with the gap to the actual
 * best above it. The maths is `Sectors` in `:core`, pinned to the web
 * implementation by `contracts/logic/sectors.json`; this file lays it out.
 *
 * Best sectors are taken across *every* lap of the session, not only the
 * highlighted ones, so the table answers "where does my time go" against the
 * session rather than against whichever laps happen to be lit.
 */
@Composable
fun SectorTable(
    channels: SessionChannels,
    /** Channel-lap indexes in slot order, as [LapChannelChart] keeps them. */
    lit: List<Int>,
    slots: List<Color>,
    /** The session's own lap number for a channel entry. */
    lapNumber: (Int) -> Int,
    modifier: Modifier = Modifier,
) {
    val sec = remember(channels) { Sectors.sessionSectors(channels) } ?: return
    val rows = lit.mapIndexedNotNull { slot, chIdx ->
        sec.laps.firstOrNull { it.chIdx == chIdx }?.let { slots[slot % slots.size] to it }
    }
    if (rows.isEmpty()) return
    val colors = TrackTheme.colors
    val hasTheoretical = sec.laps.size >= 2

    val summary = buildString {
        rows.forEachIndexed { i, (_, lap) ->
            if (i > 0) append(". ")
            append("Lap ${lapNumber(lap.chIdx)}: ")
            append(lap.sectors.mapIndexed { k, ms -> "S${k + 1} ${LapTime.fmtMs(ms)}" }.joinToString(", "))
            append(", lap ${LapTime.fmtMs(lap.timeMs)}")
        }
        if (hasTheoretical) {
            append(". Theoretical best ${LapTime.fmtMs(sec.theoreticalBestMs)}. ${gapSentence(sec)}")
        }
    }

    TrackCard(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                testTag = "sectorTable"
                contentDescription = summary
            },
        contentPadding = 12.dp,
    ) {
        if (hasTheoretical) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Theoretical best", style = TrackTheme.typography.sm, color = colors.textMuted)
                Text(
                    LapTime.fmtMs(sec.theoreticalBestMs),
                    style = TrackTheme.typography.lapTime,
                    color = colors.accentInk,
                )
            }
            Text(
                gapSentence(sec),
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
                modifier = Modifier.padding(top = 2.dp, bottom = 8.dp),
            )
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Sectors", style = TrackTheme.typography.eyebrow, color = colors.textFaint, modifier = Modifier.weight(LABEL_WEIGHT))
            for (k in 0 until sec.n) {
                Text(
                    "S${k + 1}",
                    style = TrackTheme.typography.eyebrow,
                    color = colors.textFaint,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                "Lap",
                style = TrackTheme.typography.eyebrow,
                color = colors.textFaint,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        }

        rows.forEach { (color, lap) ->
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Row(
                    Modifier.weight(LABEL_WEIGHT),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(Modifier.size(7.dp).background(color, CircleShape))
                    Text("Lap ${lapNumber(lap.chIdx)}", style = TrackTheme.typography.xs, color = colors.textMuted, maxLines = 1)
                }
                for (k in 0 until sec.n) {
                    SectorCell(ms = lap.sectors[k], gap = lap.sectors[k] - sec.bestSectors[k], modifier = Modifier.weight(1f))
                }
                Text(
                    LapTime.fmtMs(lap.timeMs),
                    style = TrackTheme.typography.lapTime,
                    color = colors.textStrong,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (hasTheoretical) {
            HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(top = 8.dp))
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Best sectors",
                    style = TrackTheme.typography.xs,
                    fontStyle = FontStyle.Italic,
                    color = colors.textMuted,
                    modifier = Modifier.weight(LABEL_WEIGHT),
                )
                for (k in 0 until sec.n) {
                    Text(
                        LapTime.fmtMs(sec.bestSectors[k]),
                        style = TrackTheme.typography.lapTime,
                        color = colors.textMuted,
                        textAlign = TextAlign.End,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                }
                Text(
                    LapTime.fmtMs(sec.theoreticalBestMs),
                    style = TrackTheme.typography.lapTime,
                    color = colors.textStrong,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** The label column is a little wider than a time column: "Lap 12" plus its dot. */
private const val LABEL_WEIGHT = 1.15f

/**
 * One sector: the split, in the accent when it is the session's best, with its
 * gap to that best underneath otherwise.
 */
@Composable
private fun SectorCell(ms: Int, gap: Int, modifier: Modifier) {
    val colors = TrackTheme.colors
    Column(modifier, horizontalAlignment = Alignment.End) {
        Text(
            LapTime.fmtMs(ms),
            style = TrackTheme.typography.lapTime,
            color = if (gap == 0) colors.accentInk else colors.textStrong,
            maxLines = 1,
        )
        if (gap != 0) {
            Text(LapTime.fmtDelta(gap), style = TrackTheme.typography.xxs, color = colors.textFaint, maxLines = 1)
        }
    }
}

/**
 * "The best sectors of 12 laps strung together — 0.85s quicker than the best
 * lap.", the same words the web uses.
 */
internal fun gapSentence(sec: Sectors.SessionSplits): String =
    if (sec.gapMs > 0) {
        val gap = LapTime.fmtDelta(sec.gapMs).removePrefix("+")
        "The best sectors of ${sec.laps.size} laps strung together — $gap quicker than the best lap."
    } else {
        "The best lap already strings together the session's best sectors."
    }
