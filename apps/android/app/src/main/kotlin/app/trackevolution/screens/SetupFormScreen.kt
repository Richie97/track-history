package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Garage
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * The setup form (NS-40), built from `Garage.SETUP_FIELDS`: each corner group a
 * row of four fields, each axle group a row of two, fuel on its own, then the
 * tire and pad pickers from the car's parts, then the notes. Values are typed in
 * the driver's units and stored in psi and gallons by the model.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SetupFormScreen(
    model: SetupFormModel,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    var confirmDelete by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.done) { if (model.done) onDone() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val values = model.values
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("setupForm"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Text("Day ${model.day} setup", style = TrackTheme.typography.h1, color = colors.textStrong)
                    model.source?.let {
                        Text(it, style = TrackTheme.typography.xs, color = colors.textMuted, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }

            model.error?.let { message -> item("error") { TEErrorBanner(message) } }

            Garage.SETUP_FIELDS.forEach { field ->
                item(field.key) {
                    val unit = Garage.setupUnit(field, units)
                    TEField(if (unit.isEmpty()) field.label else "${field.label} ($unit)") {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Garage.flatKeys(field).forEach { key ->
                                val sub = Garage.flatLabel(key).removePrefix(field.label).trim()
                                val labelSlot: (@Composable () -> Unit)? =
                                    if (sub.isEmpty()) null else { { Text(sub, style = TrackTheme.typography.xxs) } }
                                OutlinedTextField(
                                    value = values[key].orEmpty(),
                                    onValueChange = { model.setValue(key, it) },
                                    label = labelSlot,
                                    singleLine = true,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                    modifier = Modifier
                                        .weight(1f)
                                        .semantics { contentDescription = Garage.flatLabel(key) }
                                        .testTag("setupField-$key"),
                                )
                            }
                        }
                    }
                }
            }

            Garage.PART_REFS.forEach { ref ->
                val options = model.parts.filter { it.kind == ref.kind }
                if (options.isNotEmpty()) item(ref.key) {
                    TEField(ref.label) {
                        val chosen = values[ref.key]?.toIntOrNull()
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            PartChip("—", chosen == null) { model.setValue(ref.key, "") }
                            options.forEach { part ->
                                val suffix = when {
                                    part.retiredOn != null -> " (retired)"
                                    part.equipped == false -> " (spare)"
                                    else -> ""
                                }
                                PartChip(Garage.partTitle(part) + suffix, chosen == part.id) {
                                    model.setValue(ref.key, part.id.toString())
                                }
                            }
                        }
                    }
                }
            }

            item("notes") {
                TEField("Setup notes") {
                    OutlinedTextField(
                        value = model.notes,
                        onValueChange = { if (it.length <= 2000) model.notes = it },
                        placeholder = {
                            Text(
                                "What changed and why — pushing in T5, went two clicks stiffer front…",
                                style = TrackTheme.typography.sm,
                            )
                        },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth().testTag("setupNotes"),
                    )
                }
            }

            item("actions") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = model::save,
                        enabled = !model.saving,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                        modifier = Modifier.testTag("saveSetup"),
                    ) {
                        Text("Save day ${model.day} setup", style = TrackTheme.typography.bodyStrong)
                    }
                    if (model.existing) {
                        TextButton(onClick = { confirmDelete = true }, enabled = !model.saving) {
                            Text("Delete", style = TrackTheme.typography.sm, color = colors.danger)
                        }
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        TEConfirmDialog(
            text = "Delete the day ${model.day} setup sheet?",
            confirm = "Delete",
            onConfirm = { confirmDelete = false; model.delete() },
            onDismiss = { confirmDelete = false },
        )
    }
}

/** A part to pick — marked with a border *and* the selected state, never colour alone. */
@Composable
private fun PartChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(
        modifier = Modifier
            .clickable(onClick = onClick)
            .semantics {
                role = Role.RadioButton
                this.selected = selected
            },
        border = if (selected) colors.accent else colors.borderHairline,
        contentPadding = 8.dp,
    ) {
        Text(label, style = TrackTheme.typography.xs, color = if (selected) colors.accentInk else colors.textMuted)
    }
}
