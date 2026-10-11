package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.Health
import app.trackevolution.core.Units
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.Setup
import app.trackevolution.core.model.SetupSheet
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import java.time.LocalDate
import kotlin.math.ceil

/**
 * The per-day setup notebook on the event page (NS-40) — the port of the web's
 * `setupNotebookHtml`, brought to the phone because a sheet is filled in at the
 * car, between sessions, with a gauge in one hand.
 *
 * Each day of the event is a row: its sheet in the driver's units, the values
 * that changed since the previous day's sheet marked (`Garage.diffSetups`
 * against `Garage.previousSheet`, so in stored units), and a door to the form —
 * *Log day N setup*, which copies the day before forward, or *Edit*. Under the
 * days, when a session recorded tire pressures, the pressure loop.
 *
 * Pro: a free account sees the card locked in place, never missing.
 */
@Composable
internal fun SetupNotebookCard(
    event: Event,
    setups: List<Setup>,
    sessions: List<Session>,
    parts: List<Part>,
    targetHotPsi: Double?,
    units: UnitSystem,
    pro: Boolean,
    onSubscribe: () -> Unit,
    onOpenDay: (Int) -> Unit,
    onRecordHots: (Int, SetupSheet) -> Unit,
    onSetNextCold: (Int, SetupSheet) -> Unit,
) {
    if (!pro) {
        TEProLocked(
            title = "Setup notebook",
            blurb = "Log each day's pressures, alignment, dampers and fuel, see what changed since the " +
                "day before, and turn the hot pressures a session recorded into next session's colds.",
            onSubscribe = onSubscribe,
        )
        return
    }
    val colors = TrackTheme.colors
    val days = setupDays(event, setups)
    val byDay = setups.associate { it.day to it.data }
    TrackCard(Modifier.fillMaxWidth().testTag("setupNotebook")) {
        TESectionHeader("Setup notebook")
        days.forEachIndexed { index, day ->
            if (index > 0) HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(vertical = 10.dp))
            SetupDayRow(
                day = day,
                date = if (days.size > 1 || byDay[day] != null) dayDate(event.startDate, day) else null,
                sheet = byDay[day],
                previous = Garage.previousSheet(setups, day),
                parts = parts,
                units = units,
                onOpen = { onOpenDay(day) },
            )
        }

        loopSession(sessions)?.let { session ->
            HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(vertical = 12.dp))
            val day = defaultLoopDay(days, byDay)
            val sheet = byDay[day]
            val loop = Health.pressureLoop(session.channels, sheet, targetHotPsi) ?: return@let
            val nextDay = days.firstOrNull { it == day + 1 }
            PressureLoopSection(
                session = session,
                day = day,
                loop = loop,
                units = units,
                hasTarget = targetHotPsi != null,
                nextDay = nextDay,
                onRecord = { onRecordHots(day, Health.recordHotSheet(sheet, loop)) },
                onSetNext = nextDay?.let { next ->
                    { onSetNextCold(next, Health.nextDaySheet(byDay[next], sheet, loop)) }
                },
            )
        }
    }
}

@Composable
private fun SetupDayRow(
    day: Int,
    date: String?,
    sheet: SetupSheet?,
    previous: SetupSheet?,
    parts: List<Part>,
    units: UnitSystem,
    onOpen: () -> Unit,
) {
    val colors = TrackTheme.colors
    val changed = if (sheet == null) emptySet() else Garage.diffSetups(previous, sheet).map { it.key }.toSet()
    Column(Modifier.fillMaxWidth().testTag("setupDay-$day")) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Day $day", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
            date?.let {
                Text(it, style = TrackTheme.typography.xs, color = colors.textMuted, modifier = Modifier.padding(start = 8.dp))
            }
            Text("", Modifier.weight(1f))
            TextButton(onClick = onOpen, modifier = Modifier.testTag("setupOpen-$day")) {
                Text(
                    if (sheet == null) "Log day $day setup" else "Edit",
                    style = TrackTheme.typography.sm,
                    color = colors.accentInk,
                )
            }
        }
        if (sheet == null) {
            Text(
                if (previous != null) "Logging copies day ${day - 1}'s sheet forward." else "No sheet yet.",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
            return@Column
        }
        for (field in Garage.SETUP_FIELDS) {
            val keys = Garage.flatKeys(field).filter { Garage.sheetValue(sheet, it) != null }
            if (keys.isEmpty()) continue
            SetupValueLine(field.label, keys, sheet, previous, changed, units)
        }
        for (ref in Garage.PART_REFS) {
            val id = Garage.partRefValue(sheet, ref.key) ?: continue
            val name = parts.firstOrNull { it.id == id }?.let { Garage.partTitle(it) } ?: "Part #$id"
            val isChanged = ref.key in changed
            Text(
                "${ref.label}: $name",
                style = TrackTheme.typography.sm,
                color = if (isChanged) colors.accentInk else colors.textStrong,
                fontWeight = if (isChanged) FontWeight.SemiBold else null,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        sheet.notes?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = TrackTheme.typography.sm, color = colors.textMuted, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/**
 * One field of a sheet on one line — "Cold  FL 26 · FR 26 · RL 24 · RR 24" — with
 * a changed value set in the accent and said as "changed from …", so the mark is
 * never colour alone.
 */
@Composable
private fun SetupValueLine(
    label: String,
    keys: List<String>,
    sheet: SetupSheet,
    previous: SetupSheet?,
    changed: Set<String>,
    units: UnitSystem,
) {
    val colors = TrackTheme.colors
    val spoken = keys.joinToString(", ") { key ->
        val text = Garage.fmtSetupValue(key, Garage.sheetValue(sheet, key), units)
        val sub = Garage.flatLabel(key).removePrefix(label).trim()
        val was = if (key in changed) {
            " (changed from ${Garage.fmtSetupValue(key, Garage.sheetValue(previous, key), units)})"
        } else {
            ""
        }
        "$sub $text$was".trim()
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 2.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$label: $spoken" },
        verticalAlignment = Alignment.Top,
    ) {
        Text(label, style = TrackTheme.typography.xs, color = colors.textMuted, modifier = Modifier.width(120.dp))
        Text(
            buildString {
                keys.forEachIndexed { i, key ->
                    if (i > 0) append(" · ")
                    val sub = Garage.flatLabel(key).removePrefix(label).trim()
                    if (sub.isNotEmpty()) append("$sub ")
                    append(Garage.fmtSetupValue(key, Garage.sheetValue(sheet, key), units))
                    if (key in changed) append(" •")
                }
            },
            style = TrackTheme.typography.sm,
            color = if (keys.any { it in changed }) colors.accentInk else colors.textStrong,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * The tire-pressure loop (NS-40, the web's `pressureLoopHtml`): per corner the
 * sheet's cold, the session's hot, the target and the cold to start from next
 * time, with the two writes it offers — record the hots on the day's sheet, and
 * open the next day's form with the suggested colds. One accessibility element
 * whose two buttons are also named actions, the NS-34 rule for a card of
 * numbers.
 */
@Composable
private fun PressureLoopSection(
    session: Session,
    day: Int,
    loop: Health.PressureLoop,
    units: UnitSystem,
    hasTarget: Boolean,
    nextDay: Int?,
    onRecord: () -> Unit,
    onSetNext: (() -> Unit)?,
) {
    val colors = TrackTheme.colors
    val metric = Units.isMetric(units)
    val pressureField = Garage.SETUP_FIELDS.first { it.key == "tp_cold" }
    fun psi(v: Double?): String =
        if (v == null) "—" else Units.toFixed(Garage.setupToDisplay(pressureField, v, units) ?: v, if (metric) 2 else 1)
    val unit = Garage.setupUnit(pressureField, units)
    val actions = buildList {
        add(CustomAccessibilityAction("Record hot pressures on day $day") { onRecord(); true })
        if (onSetNext != null && nextDay != null) {
            add(CustomAccessibilityAction("Set day $nextDay cold pressures") { onSetNext(); true })
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("pressureLoop")
            .semantics { customActions = actions },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            "Tire pressures — ${session.label ?: "Session"} vs day $day",
            style = TrackTheme.typography.bodyStrong,
            color = colors.textStrong,
        )
        Text(
            "Cold from the sheet, hot from the session (the highest end-of-lap reading), and the cold to " +
                "start from next time to land on target. $unit.",
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )
        LoopRowLine("", "Cold", "Hot", "Target", "Next cold", header = true)
        loop.rows.forEach { row ->
            LoopRowLine(
                row.corner,
                psi(row.coldPsi),
                psi(row.hotPsi),
                psi(row.targetPsi),
                psi(row.suggestion?.suggestedPsi),
            )
        }
        if (!hasTarget) {
            Text(
                "Set a target hot pressure on the car's page to get a suggestion.",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = onRecord, modifier = Modifier.testTag("loopRecord")) {
                Text("Record hot pressures", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
            if (onSetNext != null && nextDay != null && loop.coldSheet != null) {
                TextButton(onClick = onSetNext, modifier = Modifier.testTag("loopNext")) {
                    Text("Set day $nextDay cold", style = TrackTheme.typography.sm, color = colors.accentInk)
                }
            }
        }
    }
}

@Composable
private fun LoopRowLine(corner: String, cold: String, hot: String, target: String, next: String, header: Boolean = false) {
    val colors = TrackTheme.colors
    val style = if (header) TrackTheme.typography.xxs else TrackTheme.typography.sm
    val color = if (header) colors.textMuted else colors.textStrong
    Row(Modifier.fillMaxWidth()) {
        Text(corner, style = style, color = colors.textMuted, modifier = Modifier.width(36.dp))
        listOf(cold, hot, target).forEach {
            Text(it, style = style, color = color, modifier = Modifier.weight(1f))
        }
        Text(next, style = style, color = if (header) color else colors.accentInk, modifier = Modifier.weight(1f))
    }
}

/**
 * The days a notebook has a row for: every day of the event (a fractional day
 * count rounds up, as `setupDays` does on the web), plus any day a sheet was
 * logged on beyond them.
 */
internal fun setupDays(event: Event, setups: List<Setup>): List<Int> {
    val span = maxOf(1, ceil(event.days).toInt())
    return ((1..span) + setups.map { it.day }).distinct().sorted()
}

/** A day's own date, "Sat 13 Jun". */
private fun dayDate(startDate: String, day: Int): String? =
    runCatching { EventDates.fmtDate(LocalDate.parse(startDate).plusDays((day - 1).toLong()).toString()) }.getOrNull()

/**
 * The session the loop reads: the latest one that recorded tire pressures. The
 * web lets the driver pick among sessions on the channel panel; on the phone the
 * loop sits with the notebook, and the last session out is the one the next
 * cold pressures are for.
 */
internal fun loopSession(sessions: List<Session>): Session? =
    sessions.lastOrNull { Health.hotPressures(it.channels) != null }

/**
 * The day the loop compares against: the latest day whose sheet has cold
 * pressures, else the latest day with a sheet, else day 1 — the web's
 * `defaultHealthDay`.
 */
internal fun defaultLoopDay(days: List<Int>, byDay: Map<Int, SetupSheet>): Int =
    days.lastOrNull { byDay[it]?.tpCold != null } ?: days.lastOrNull { byDay[it] != null } ?: 1
