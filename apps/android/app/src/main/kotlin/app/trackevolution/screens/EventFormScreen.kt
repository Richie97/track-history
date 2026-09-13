package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.trackevolution.core.model.Conditions
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.EventFormSessions
import app.trackevolution.core.Units
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * Create or edit an event (NS-26).
 *
 * The Car and Track fields are **free text with suggestions**, never pickers: a
 * car that isn't in the garage has to keep working, and a track nobody has been
 * to yet has to be typeable. See [EventFormModel] for why the track name is only
 * ever trimmed.
 *
 * A **new** event ends with an "Add laps" section — the event page's "Add a
 * session" card, minus the recorder: [onImport] opens the same video import,
 * whose review hands its sessions back to the form (`Route.Import.forNewEvent`),
 * and lap times can be typed straight in. Both are saved with the event, so
 * logging a day is one screen rather than a form and then a page. Editing an
 * existing event has no such section: its page already has the card.
 */
@Composable
fun EventFormScreen(
    model: EventFormModel,
    onSaved: (Int) -> Unit,
    onImport: () -> Unit = {},
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.savedId) { model.savedId?.let(onSaved) }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("title") {
                Text(
                    if (model.editId == null) "Add event" else "Edit event",
                    style = TrackTheme.typography.h1,
                    color = colors.textStrong,
                )
            }

            item("error") { TEErrorBanner(model.error) }

            item("track") {
                SuggestingField(
                    label = "Track",
                    hint = "Pick from your tracks and known US tracks, or type a new name — " +
                        "layouts time differently, so name them separately to keep PBs honest",
                    value = model.trackName,
                    onValueChange = { model.trackName = it },
                    placeholder = "Virginia International Raceway (Full)",
                    options = model.trackOptions,
                )
            }

            item("date") {
                TEField("Start date") {
                    OutlinedTextField(
                        value = model.startDate,
                        onValueChange = { model.startDate = it },
                        placeholder = { Text("2026-05-01", style = TrackTheme.typography.sm) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            item("days") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TEField("Days", modifier = Modifier.weight(1f)) {
                        NumberField(model.days) { model.days = it }
                    }
                    TEField(
                        "On-track hours",
                        hint = "Blank uses the 2h-per-day estimate",
                        modifier = Modifier.weight(1f),
                    ) {
                        NumberField(model.trackHours, placeholder = "est. 2h per day") {
                            model.trackHours = it
                        }
                    }
                }
            }

            item("club") {
                TEField("Club / organizer") {
                    PlainField(model.club, "VIR Club") { model.club = it }
                }
            }

            item("group") {
                TEField("Run group") {
                    PlainField(model.runGroup, "High Speed") { model.runGroup = it }
                }
            }

            item("car") {
                SuggestingField(
                    label = "Car",
                    hint = "Pick from your garage or type anything",
                    value = model.car,
                    onValueChange = { model.car = it },
                    placeholder = "Corvette Z06, Miata, GT3…",
                    options = model.carOptions,
                )
            }

            item("conditions") {
                TEField("Conditions") {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ConditionChip("—", model.conditions == null) { model.conditions = null }
                        Conditions.all.forEach { option ->
                            ConditionChip(option.rawValue, model.conditions == option) {
                                model.conditions = option
                            }
                        }
                    }
                }
            }

            item("temp") {
                // Labelled and entered in the user's system; stored as whole °F
                // by the model.
                val units = LocalUnitSystem.current
                TEField("Temp ${Units.tempUnit(units)}") {
                    NumberField(model.temp, placeholder = Units.tempInputSpec(units).placeholder.toString()) {
                        model.temp = it
                    }
                }
            }

            item("best") {
                TEField(
                    "Best time",
                    hint = "Only needed when you don't log laps — logged laps compute this automatically",
                ) {
                    PlainField(model.bestTime, "2:01.24") { model.bestTime = it }
                }
            }

            item("notes") {
                TEField("Notes") {
                    OutlinedTextField(
                        value = model.notes,
                        onValueChange = { model.notes = it },
                        placeholder = {
                            Text("Weather, setup changes, incidents…", style = TrackTheme.typography.sm)
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            if (model.editId == null) {
                item("laps") {
                    AddLapsCard(
                        staged = model.stagedSessions,
                        onRemoveStaged = model::removeStaged,
                        onImport = onImport,
                        label = model.sessionLabel,
                        onLabelChange = { model.sessionLabel = it },
                        laps = model.sessionLaps,
                        onLapsChange = { model.sessionLaps = it },
                        notes = model.sessionNotes,
                        onNotesChange = { model.sessionNotes = it },
                    )
                }
            }

            item("actions") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = model::save,
                        enabled = !model.saving && model.trackName.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                        modifier = Modifier.testTag("eventFormSubmit"),
                    ) {
                        Text(
                            when {
                                model.editId != null -> "Save changes"
                                // The event exists and a session didn't make it:
                                // the same button now only retries the laps.
                                model.createdId != null -> "Add the laps"
                                else -> "Add event"
                            },
                            style = TrackTheme.typography.bodyStrong,
                        )
                    }
                    TextButton(onClick = onCancel) {
                        Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                }
            }
        }
    }
}

/**
 * The New Event form's "Add laps" section: sessions staged from the video
 * importer, each removable until the event is created, and a hand-typed one.
 * The copy is the event page card's, so the two read as the same thing.
 */
@Composable
private fun AddLapsCard(
    staged: List<SessionDraft>,
    onRemoveStaged: (Int) -> Unit,
    onImport: () -> Unit,
    label: String,
    onLabelChange: (String) -> Unit,
    laps: String,
    onLapsChange: (String) -> Unit,
    notes: String,
    onNotesChange: (String) -> Unit,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography

    TrackCard(Modifier.fillMaxWidth()) {
        TESectionHeader("Add laps")
        Text(
            "Optional — the sessions here are saved with the event. You can always add more from its page.",
            style = type.xs,
            color = colors.textMuted,
            modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
        )

        Text("Import a video", style = type.bodyStrong, color = colors.textStrong)
        Text(
            "Corvette PDR or GoPro clips already on this phone — laps, racing line and " +
                "channel graphs come out of the telemetry track. The video is read in " +
                "place, never copied or uploaded.",
            style = type.xs,
            color = colors.textMuted,
            modifier = Modifier.padding(vertical = 6.dp),
        )
        TextButton(onClick = onImport, modifier = Modifier.testTag("eventFormImportVideo")) {
            Text("Import video…", style = type.sm, color = colors.accentInk)
        }
        staged.forEachIndexed { index, draft ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp).testTag("stagedSession$index"),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(draft.label ?: "Imported session", style = type.sm, color = colors.textStrong)
                    Text(
                        EventFormSessions.stagedSummary(draft.laps.orEmpty()),
                        style = type.xs,
                        color = colors.textMuted,
                    )
                }
                TextButton(onClick = { onRemoveStaged(index) }) {
                    Text("Remove", style = type.sm, color = colors.textMuted)
                }
            }
        }

        HorizontalDivider(
            color = colors.borderHairline,
            modifier = Modifier.padding(vertical = 14.dp),
        )

        Text("Enter lap times by hand", style = type.bodyStrong, color = colors.textStrong)
        OutlinedTextField(
            value = label,
            onValueChange = onLabelChange,
            placeholder = { Text("Day 1 — Session 2", style = type.sm) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp).testTag("eventFormSessionLabel"),
        )
        OutlinedTextField(
            value = laps,
            onValueChange = onLapsChange,
            placeholder = { Text("2:01.24, 2:03.1 …", style = type.sm) },
            supportingText = {
                Text(
                    "Formats: 2:01.24 · 2:01 · 121.24 (seconds)",
                    style = type.xxs,
                    color = colors.textFaint,
                )
            },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp).testTag("eventFormSessionLaps"),
        )
        OutlinedTextField(
            value = notes,
            onValueChange = onNotesChange,
            placeholder = { Text("Traffic, tire pressures, line changes…", style = type.sm) },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
    }
}

/**
 * Free text with suggestions underneath — deliberately not a picker.
 *
 * A picker would make a track or car that isn't already in the logbook
 * unenterable, which is exactly the case a first visit is.
 */
@Composable
private fun SuggestingField(
    label: String,
    hint: String?,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    options: List<String>,
) {
    val colors = TrackTheme.colors
    var focused by remember { mutableStateOf(false) }
    val matches = remember(value, options, focused) {
        if (!focused || value.isBlank()) {
            emptyList()
        } else {
            options.filter { it.contains(value.trim(), ignoreCase = true) && !it.equals(value, true) }
                .take(5)
        }
    }

    TEField(label, hint) {
        Column {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = { Text(placeholder, style = TrackTheme.typography.sm) },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { focused = it.isFocused },
            )
            matches.forEach { option ->
                Text(
                    option,
                    style = TrackTheme.typography.sm,
                    color = colors.accentInk,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onValueChange(option); focused = false }
                        .padding(vertical = 6.dp, horizontal = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun PlainField(value: String, placeholder: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, style = TrackTheme.typography.sm) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun NumberField(
    value: String,
    placeholder: String = "",
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, style = TrackTheme.typography.sm) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ConditionChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(
        modifier = Modifier.clickable(onClick = onClick),
        border = if (selected) colors.accent else colors.borderHairline,
        contentPadding = 8.dp,
    ) {
        Text(
            label,
            style = TrackTheme.typography.xs,
            color = if (selected) colors.accentInk else colors.textMuted,
        )
    }
}
