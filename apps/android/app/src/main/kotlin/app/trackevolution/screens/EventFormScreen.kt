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
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.trackevolution.core.model.Conditions
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * Create or edit an event (NS-26).
 *
 * The Car and Track fields are **free text with suggestions**, never pickers: a
 * car that isn't in the garage has to keep working, and a track nobody has been
 * to yet has to be typeable. See [EventFormModel] for why the track name is only
 * ever trimmed.
 */
@Composable
fun EventFormScreen(
    model: EventFormModel,
    onSaved: (Int) -> Unit,
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
                TEField("Temp °F") {
                    NumberField(model.tempF, placeholder = "72") { model.tempF = it }
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

            item("actions") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = model::save,
                        enabled = !model.saving && model.trackName.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentInk,
                        ),
                    ) {
                        Text(
                            if (model.editId == null) "Add event" else "Save changes",
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
