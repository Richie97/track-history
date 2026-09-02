package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.ChecklistItem
import app.trackevolution.core.model.Session
import app.trackevolution.core.TraceSample
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * One event: its sessions, laps, prep checklist and best-lap trace (NS-26).
 *
 * Deliberately absent, and not by omission: the per-day **setup notebook** and
 * `.vbo` import. Both stay web-only per the product split — a `.vbo` reaches a
 * laptop on an SD card, and the setup notebook is desk work. **Video** import is
 * here, though: a PDR or GoPro clip is already on the phone that shot or
 * received it, which is the argument NS-30 made for iOS and it was never
 * platform-specific. The card below opens the chooser; the review that follows
 * is the recorder's.
 */
@Composable
fun EventScreen(
    model: EventModel,
    checklistTemplate: List<String>,
    onEdit: (Int) -> Unit,
    onOpenTrack: (Int) -> Unit,
    onRecord: (Int) -> Unit,
    onImport: (Int) -> Unit,
    onDeleted: () -> Unit,
    recorderAvailable: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val listState = rememberLazyListState()
    var confirmDeleteEvent by remember { mutableStateOf(false) }
    var confirmDeleteSession by remember { mutableStateOf<Int?>(null) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.isDeleted) { if (model.isDeleted) onDeleted() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val detail = model.detail ?: return@TELoadable
        val event = detail.event

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Text(
                        event.trackName,
                        style = TrackTheme.typography.h1,
                        color = colors.textStrong,
                        modifier = Modifier.clickable { onOpenTrack(event.trackId) },
                    )
                    TEMeta(
                        listOf(
                            EventDates.fmtDate(event.startDate),
                            event.club,
                            event.runGroup,
                            event.car,
                            event.conditions?.rawValue,
                        ),
                    )
                    if (EventDates.isUpcoming(event.startDate)) {
                        Text(
                            "${EventDates.fmtCountdown(event.startDate)} — log sessions here once you're back from the track.",
                            style = TrackTheme.typography.sm,
                            color = colors.accentInk,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }

            item("tiles") {
                TEStatRow(
                    listOf(
                        "Best time" to LapTime.fmtMs(event.bestMs),
                        "Days" to EventDates.fmtDays(event.days),
                        "Laps" to event.lapCount.toString(),
                        "Consistency" to LapTime.fmtConsistency(event.consistency),
                    ),
                )
            }

            model.writeError?.let { message ->
                item("write-error") {
                    Column {
                        TEErrorBanner(message)
                        TextButton(onClick = model::dismissWriteError) {
                            Text("Dismiss", style = TrackTheme.typography.xs, color = colors.textMuted)
                        }
                    }
                }
            }

            event.notes?.takeIf { it.isNotBlank() }?.let { notes ->
                item("notes") {
                    TrackCard(Modifier.fillMaxWidth()) {
                        Text(notes, style = TrackTheme.typography.sm, color = colors.textStrong)
                    }
                }
            }

            item("actions") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onEdit(model.eventId) }) {
                        Text("Edit event", style = TrackTheme.typography.sm, color = colors.accentInk)
                    }
                    TextButton(onClick = { confirmDeleteEvent = true }) {
                        Text("Delete event", style = TrackTheme.typography.sm, color = colors.danger)
                    }
                }
            }

            // The checklist is for prep, so it appears while there is still prep
            // to do — or once one exists, however far past the event is.
            if (EventDates.isUpcoming(event.startDate) || !event.checklist.isNullOrEmpty()) {
                item("checklist") {
                    ChecklistCard(
                        items = event.checklist.orEmpty(),
                        template = checklistTemplate,
                        onChange = model::setChecklist,
                    )
                }
            }

            if (recorderAvailable) {
                item("recorder") {
                    TrackCard(Modifier.fillMaxWidth()) {
                        Text(
                            "Record laps with your phone",
                            style = TrackTheme.typography.bodyStrong,
                            color = colors.textStrong,
                        )
                        Text(
                            "Start before heading out, stow the phone, stop back in the paddock — laps are timed from GPS.",
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                            modifier = Modifier.padding(vertical = 6.dp),
                        )
                        Button(
                            onClick = { onRecord(model.eventId) },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.accent,
                                contentColor = colors.accentContrast,
                            ),
                        ) {
                            Text("Start recording", style = TrackTheme.typography.bodyStrong)
                        }
                    }
                }
            }

            item("import") {
                TrackCard(Modifier.fillMaxWidth()) {
                    Text(
                        "Import video",
                        style = TrackTheme.typography.bodyStrong,
                        color = colors.textStrong,
                    )
                    Text(
                        "Corvette PDR or GoPro clips already on this phone — laps, racing line and " +
                            "channel graphs come out of the telemetry track. The video is read in " +
                            "place, never copied or uploaded.",
                        style = TrackTheme.typography.xs,
                        color = colors.textMuted,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                    TextButton(onClick = { onImport(model.eventId) }, modifier = Modifier.testTag("eventImportVideo")) {
                        Text("Import video…", style = TrackTheme.typography.sm, color = colors.accentInk)
                    }
                }
            }

            bestLapTrace(detail.sessions)?.let { (trace, lapMs) ->
                item("trace") {
                    Column {
                        TESectionHeader("Best lap trace", detail = "brighter is faster")
                        Text(
                            LapTime.fmtMs(lapMs),
                            style = TrackTheme.typography.lapTime,
                            color = colors.textStrong,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                        TrackMap(trace = trace)
                    }
                }
            }

            item("sessions-header") { TESectionHeader("Sessions") }

            if (detail.sessions.isEmpty()) {
                item("sessions-empty") { TEEmpty("No sessions recorded yet.") }
            } else {
                detail.sessions.forEach { session ->
                    item("session-${session.id}") {
                        SessionCard(
                            session = session,
                            onDelete = { confirmDeleteSession = session.id },
                            onAddLaps = { model.appendLaps(session.id, it) },
                            onDeleteLap = model::deleteLap,
                        )
                    }
                }
            }

            item("add-session") {
                AddSessionCard { label, notes, laps -> model.addSession(label, notes, laps) }
            }
        }
    }

    if (confirmDeleteEvent) {
        TEConfirmDialog(
            text = "Delete this event and all its sessions/laps?",
            confirm = "Delete",
            onConfirm = { confirmDeleteEvent = false; model.deleteEvent() },
            onDismiss = { confirmDeleteEvent = false },
        )
    }

    confirmDeleteSession?.let { id ->
        TEConfirmDialog(
            text = "Delete this session and its laps?",
            confirm = "Delete",
            onConfirm = { confirmDeleteSession = null; model.deleteSession(id) },
            onDismiss = { confirmDeleteSession = null },
        )
    }
}

/**
 * The session holding the event's fastest lap, and its trace.
 *
 * Ten points is `TrackMap`'s floor — below that it is a GPS glitch rather than a
 * lap, and drawing it would claim more than we know.
 */
private fun bestLapTrace(sessions: List<Session>): Pair<List<TraceSample>, Int>? {
    val candidate = sessions
        .filter { (it.trace?.size ?: 0) >= 10 && it.laps.isNotEmpty() }
        .minByOrNull { it.bestLapMs ?: Int.MAX_VALUE }
        ?: return null
    val best = candidate.bestLapMs ?: return null
    val trace = candidate.trace.orEmpty().map { TraceSample(x = it.x, y = it.y, v = it.v) }
    return trace to best
}

@Composable
private fun ChecklistCard(
    items: List<ChecklistItem>,
    template: List<String>,
    onChange: (List<ChecklistItem>) -> Unit,
) {
    val colors = TrackTheme.colors
    var draft by rememberSaveable { mutableStateOf("") }

    TrackCard(Modifier.fillMaxWidth()) {
        TESectionHeader(
            "Prep checklist",
            detail = if (items.isEmpty()) null else "${items.count { it.done }}/${items.size}",
        )

        if (items.isEmpty()) {
            Text(
                "Nothing on the list yet.",
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
                modifier = Modifier.padding(vertical = 6.dp),
            )
            TextButton(onClick = { onChange(template.map { ChecklistItem(text = it, done = false) }) }) {
                Text(
                    // The wording follows whose list it is: a user who edited
                    // the template in Settings is starting from *theirs*.
                    if (template == app.trackevolution.core.EventDates.DEFAULT_CHECKLIST) {
                        "Use default list"
                    } else {
                        "Use my list"
                    },
                    style = TrackTheme.typography.sm,
                    color = colors.accentInk,
                )
            }
        } else {
            items.forEachIndexed { index, item ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = item.done,
                        onCheckedChange = { checked ->
                            onChange(items.toMutableList().also { it[index] = item.copy(done = checked) })
                        },
                        colors = CheckboxDefaults.colors(
                            checkedColor = colors.accent,
                            checkmarkColor = colors.accentInk,
                        ),
                    )
                    Text(
                        item.text,
                        style = TrackTheme.typography.sm,
                        color = if (item.done) colors.textMuted else colors.textStrong,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { onChange(items.filterIndexed { i, _ -> i != index }) }) {
                        Text("✕", style = TrackTheme.typography.sm, color = colors.textFaint)
                    }
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { if (it.length <= 200) draft = it },
                placeholder = { Text("Add item…", style = TrackTheme.typography.sm) },
                singleLine = true,
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            )
            TextButton(
                enabled = draft.isNotBlank(),
                onClick = {
                    onChange(items + ChecklistItem(text = draft.trim(), done = false))
                    draft = ""
                },
            ) {
                Text("Add", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
        }
    }
}

@Composable
private fun SessionCard(
    session: Session,
    onDelete: () -> Unit,
    onAddLaps: (List<Int>) -> Unit,
    onDeleteLap: (Int) -> Unit,
) {
    val colors = TrackTheme.colors
    var lapDraft by rememberSaveable(session.id) { mutableStateOf("") }
    val best = session.bestLapMs

    TrackCard(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    session.label ?: "Session",
                    style = TrackTheme.typography.bodyStrong,
                    color = colors.textStrong,
                )
                Text(
                    if (session.laps.isEmpty()) {
                        "no laps"
                    } else {
                        "best ${LapTime.fmtMs(best)} · ${session.laps.size} laps"
                    },
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
            TextButton(onClick = onDelete) {
                Text("Delete", style = TrackTheme.typography.xs, color = colors.danger)
            }
        }

        session.statsSummary?.let {
            Text(
                it,
                style = TrackTheme.typography.xs,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 4.dp),
            )
        }

        session.notes?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = TrackTheme.typography.sm,
                color = colors.textStrong,
                modifier = Modifier.padding(top = 6.dp),
            )
        }

        // An imported session's channels replace the plain lap chips: the chips
        // are the overlay's legend, so showing both would be two lap lists.
        val channels = session.channels
        if (channels != null) {
            LapChannelChart(
                channels = channels,
                laps = session.laps,
                modifier = Modifier.padding(top = 8.dp),
            )
        } else {
            session.laps.forEach { lap ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Lap ${lap.lapNum} · ${LapTime.fmtMs(lap.timeMs)}" +
                            if (best != null && lap.timeMs == best) " ★" else "",
                        style = TrackTheme.typography.sm,
                        color = colors.textStrong,
                    )
                    TextButton(onClick = { onDeleteLap(lap.id) }) {
                        Text("✕", style = TrackTheme.typography.xs, color = colors.textFaint)
                    }
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
            OutlinedTextField(
                value = lapDraft,
                onValueChange = { lapDraft = it },
                placeholder = { Text("Add laps: 2:01.24, 2:03.1 …", style = TrackTheme.typography.xs) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                enabled = LapTime.parseLapList(lapDraft).isNotEmpty(),
                onClick = {
                    onAddLaps(LapTime.parseLapList(lapDraft))
                    lapDraft = ""
                },
            ) {
                Text("Add", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
        }
    }
}

@Composable
private fun AddSessionCard(onAdd: (String?, String?, List<Int>) -> Unit) {
    val colors = TrackTheme.colors
    var label by rememberSaveable { mutableStateOf("") }
    var laps by rememberSaveable { mutableStateOf("") }
    var notes by rememberSaveable { mutableStateOf("") }
    val parsed = LapTime.parseLapList(laps)

    TrackCard(Modifier.fillMaxWidth()) {
        TESectionHeader("Add session")
        OutlinedTextField(
            value = label,
            onValueChange = { label = it },
            placeholder = { Text("Day 1 — Session 2", style = TrackTheme.typography.sm) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
        OutlinedTextField(
            value = laps,
            onValueChange = { laps = it },
            placeholder = { Text("2:01.24, 2:03.1 …", style = TrackTheme.typography.sm) },
            supportingText = {
                Text(
                    "Formats: 2:01.24 · 2:01 · 121.24 (seconds)",
                    style = TrackTheme.typography.xxs,
                    color = colors.textFaint,
                )
            },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
        OutlinedTextField(
            value = notes,
            onValueChange = { notes = it },
            placeholder = {
                Text("Traffic, tire pressures, line changes…", style = TrackTheme.typography.sm)
            },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
        Button(
            onClick = {
                onAdd(label.ifBlank { null }, notes.ifBlank { null }, parsed)
                label = ""; laps = ""; notes = ""
            },
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.accent,
                contentColor = colors.accentContrast,
            ),
            modifier = Modifier.padding(top = 8.dp),
        ) {
            Text("Add session", style = TrackTheme.typography.bodyStrong)
        }
    }
}
