package app.trackevolution.ui.charts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Gears
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * The shift-point read-out (#187) — the counterpart of `shiftTableHtml` in
 * `public/js/gears.js`.
 *
 * One row per gear, carrying how many times the session upshifted out of it and
 * the earliest / typical / latest rpm it did so at. Short-shifting and bouncing
 * off the limiter each become a number that way, and each is worth a sentence of
 * advice — which is what `Gears.shiftNotes` writes underneath.
 *
 * Two things about the figures are load-bearing and are said on screen rather
 * than only here. The rpm is read at the sample *before* the step, and on a 20 m
 * grid a shift takes about one grid point at speed — so every figure reads a
 * touch low and is labelled approximate. And the notes **report rather than
 * scold**: "upshifts from 4th come 800 rpm earlier than from 2nd" is a fact
 * about the session; "you are short-shifting" is a guess about why.
 *
 * The maths is `Gears` in `:core`, pinned to the web implementation by
 * `contracts/logic/gears.json`; this file lays it out.
 */
@Composable
fun ShiftTable(channels: SessionChannels, modifier: Modifier = Modifier) {
    val sp = Gears.shiftPoints(channels) ?: return
    val notes = Gears.shiftNotes(sp)
    val colors = TrackTheme.colors

    val summary = buildString {
        sp.gears.forEachIndexed { i, gear ->
            if (i > 0) append(". ")
            append("Upshifts from ${Gears.ordinal(gear.gear)}, ${gear.count} times, ")
            append("typically ${Gears.fmtRpm(gear.medianRpm.toDouble())} rpm")
        }
        notes.forEach { append(". $it") }
    }

    TrackCard(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                testTag = "shiftTable"
                contentDescription = summary
            },
        contentPadding = 12.dp,
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Upshifts", style = TrackTheme.typography.sm, color = colors.textMuted)
            Text(
                "≈${Gears.fmtRpm(sp.medianRpm.toDouble())} rpm",
                style = TrackTheme.typography.lapTime,
                color = colors.accentInk,
            )
        }
        Text(
            "Read at the last sample before each shift, so figures run a touch low.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 2.dp, bottom = 8.dp),
        )

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Upshift",
                style = TrackTheme.typography.eyebrow,
                color = colors.textFaint,
                modifier = Modifier.weight(LABEL_WEIGHT),
            )
            listOf("Count", "Earliest", "Typical", "Latest").forEach { heading ->
                Text(
                    heading,
                    style = TrackTheme.typography.eyebrow,
                    color = colors.textFaint,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        sp.gears.forEach { gear ->
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "From ${Gears.ordinal(gear.gear)}",
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                    maxLines = 1,
                    modifier = Modifier.weight(LABEL_WEIGHT),
                )
                Value(gear.count.toString(), colors.textMuted)
                Value(Gears.fmtRpm(gear.minRpm), colors.textMuted)
                Value(Gears.fmtRpm(gear.medianRpm.toDouble()), colors.textStrong)
                Value(Gears.fmtRpm(gear.maxRpm), colors.textMuted)
            }
        }

        if (notes.isNotEmpty()) {
            Column(
                Modifier.padding(top = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                notes.forEach { note ->
                    Text(note, style = TrackTheme.typography.xs, color = colors.textMuted)
                }
            }
        }
    }
}

/** The label column is wider than a figure column: "From 3rd" against "7,100". */
private const val LABEL_WEIGHT = 1.3f

@Composable
private fun androidx.compose.foundation.layout.RowScope.Value(
    text: String,
    color: androidx.compose.ui.graphics.Color,
) {
    Text(
        text,
        style = TrackTheme.typography.lapTime,
        color = color,
        textAlign = TextAlign.End,
        maxLines = 1,
        modifier = Modifier.weight(1f),
    )
}
