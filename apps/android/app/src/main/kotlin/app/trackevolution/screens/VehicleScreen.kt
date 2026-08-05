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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.defaultUnit
import app.trackevolution.core.label
import app.trackevolution.core.model.MeasurementDraft
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartDraft
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.Patch
import app.trackevolution.core.wearLimitHint
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.TEWearBar
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * One car: what's fitted, how much life is left in it, and what wore it out
 * (NS-31).
 *
 * `viewVehicle` in `public/app.js` is the reference, including its wording. The
 * setup notebook and the setup-vs-lap-times diff stay deferred on native and are
 * absent rather than stubbed.
 */
@Composable
fun VehicleScreen(
    model: VehicleModel,
    onOpenEvent: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    var confirmRetire by remember { mutableStateOf<Part?>(null) }
    var confirmRefresh by remember { mutableStateOf<Part?>(null) }
    var confirmDelete by remember { mutableStateOf<Part?>(null) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val vehicle = model.vehicle ?: return@TELoadable

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(vehicle.name, style = TrackTheme.typography.h1, color = colors.textStrong)
                        if (vehicle.isDefault) {
                            Text(
                                "Default",
                                style = TrackTheme.typography.xxs,
                                color = colors.accentInk,
                                modifier = Modifier.padding(start = 8.dp),
                            )
                        }
                    }
                    vehicle.notes?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                }
            }

            // Expanded, not collapsed: on the dashboard maintenance is one
            // section among many, but on this page it is the point of the view.
            if (model.alerts.isNotEmpty()) {
                item("alerts") { MaintenancePanel(model.alerts) }
            }

            item("tiles") {
                TEStatRow(
                    listOf(
                        "Track hours" to Garage.fmtHours(vehicle.hours),
                        "Track days" to vehicle.eventDays.toString(),
                        "Events" to vehicle.eventCount.toString(),
                        "Parts spend" to (Garage.fmtCost(model.spendCents.takeIf { it > 0 }) ?: "—"),
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

            item("parts-header") { TESectionHeader("Consumables in service") }
            item("parts-hint") {
                Text(
                    "Wear accrues automatically from this car's logged events (2h per track day " +
                        "unless an event says otherwise). Log a quick pad or tread measurement " +
                        "between events and the projection switches from estimated to measured.",
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }

            if (model.activeParts.isEmpty()) {
                item("parts-empty") {
                    TEEmpty(
                        "Nothing tracked yet — add pads, tires or fluid below and Track Evolution " +
                            "will tell you when they're due.",
                    )
                }
            } else {
                model.activeParts.forEach { part ->
                    item("part-${part.id}") {
                        PartCard(
                            part = part,
                            model = model,
                            onRetire = { confirmRetire = part },
                            onRefresh = { confirmRefresh = part },
                            onDelete = { confirmDelete = part },
                        )
                    }
                }
            }

            item("add-part") { AddPartCard(model) }

            if (model.retiredParts.isNotEmpty()) {
                item("retired-header") {
                    TESectionHeader("Retired parts", detail = "cost per hour")
                }
                model.retiredParts.forEach { part ->
                    item("retired-${part.id}") { RetiredCard(part) }
                }
            }

            if (model.events.isNotEmpty()) {
                item("ledger-header") { TESectionHeader("Track-hours ledger") }
                item("ledger-hint") {
                    Text(
                        "Hours marked est. use the 2h-per-day default — set exact hours on an " +
                            "event's edit form if a day ran long or short.",
                        style = TrackTheme.typography.xs,
                        color = colors.textMuted,
                    )
                }
                model.events.forEach { event ->
                    item("ledger-${event.id}") {
                        TrackCard(Modifier.fillMaxWidth().clickable { onOpenEvent(event.id) }) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        event.trackName,
                                        style = TrackTheme.typography.bodyStrong,
                                        color = colors.textStrong,
                                    )
                                    TEMeta(
                                        listOf(
                                            EventDates.fmtDate(event.startDate),
                                            EventDates.fmtDays(event.days),
                                        ),
                                    )
                                }
                                Text(
                                    Garage.fmtHours(event.hours) +
                                        if (event.trackHours == null) " est." else "",
                                    style = TrackTheme.typography.sm,
                                    color = colors.textStrong,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    confirmRetire?.let { part ->
        TEConfirmDialog(
            text = "Retire ${part.kind.label}? It stops accruing wear as of today and moves to " +
                "the retired list.",
            confirm = "Retire",
            onConfirm = { confirmRetire = null; model.retirePart(part.id) },
            onDismiss = { confirmRetire = null },
        )
    }

    confirmRefresh?.let { part ->
        TEConfirmDialog(
            text = "Replace ${part.kind.label} with the same spec? The old one is retired as of " +
                "today and a new one goes on in its place.",
            confirm = "Replace",
            onConfirm = { confirmRefresh = null; model.refreshPart(part.id) },
            onDismiss = { confirmRefresh = null },
        )
    }

    confirmDelete?.let { part ->
        TEConfirmDialog(
            text = "Delete ${part.kind.label}? Its measurements and wear history go with it. " +
                "Retire it instead if it was actually fitted.",
            confirm = "Delete",
            onConfirm = { confirmDelete = null; model.deletePart(part.id) },
            onDismiss = { confirmDelete = null },
        )
    }
}

/** The maintenance chips, in the web app's words. */
@Composable
private fun MaintenancePanel(alerts: List<Garage.Alert>) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth(), border = colors.danger) {
        Text("Maintenance due", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
        alerts.forEach { alert ->
            Text(
                "${alert.part.kind.label} — " +
                    if (alert.status == Garage.PartStatus.DUE) {
                        "replace now"
                    } else {
                        Garage.fmtRemaining(alert.part.wear).orEmpty()
                    },
                style = TrackTheme.typography.sm,
                color = if (alert.status == Garage.PartStatus.DUE) colors.danger else colors.textBody,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

@Composable
private fun PartCard(
    part: Part,
    model: VehicleModel,
    onRetire: () -> Unit,
    onRefresh: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = TrackTheme.colors
    var measuring by rememberSaveable(part.id) { mutableStateOf(false) }
    var editing by rememberSaveable(part.id) { mutableStateOf(false) }

    TrackCard(Modifier.fillMaxWidth()) {
        Text(part.kind.label, style = TrackTheme.typography.eyebrow, color = colors.accentInk)
        Text(
            part.name ?: part.kind.label,
            style = TrackTheme.typography.bodyStrong,
            color = colors.textStrong,
        )
        TEMeta(
            listOf(
                "Installed ${EventDates.fmtDate(part.installedOn)}",
                part.retiredOn?.let { "retired ${EventDates.fmtDate(it)}" },
                Garage.fmtCost(part.costCents),
                part.notes,
            ),
        )

        TEWearBar(part.wear, modifier = Modifier.padding(vertical = 8.dp))
        WearStory(part)

        if (part.measurements.isNotEmpty()) {
            Column(Modifier.padding(top = 8.dp)) {
                part.measurements.forEach { measurement ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "${EventDates.fmtDate(measurement.measuredOn)} · " +
                                "${measurement.value} ${measurement.unit}",
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            onClick = { model.deleteMeasurement(part.id, measurement.id) },
                        ) {
                            Text("✕", style = TrackTheme.typography.xs, color = colors.textFaint)
                        }
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { measuring = !measuring }) {
                Text("Measure", style = TrackTheme.typography.xs, color = colors.accentInk)
            }
            if (part.retiredOn == null) {
                TextButton(onClick = onRefresh) {
                    Text("Replace", style = TrackTheme.typography.xs, color = colors.accentInk)
                }
                TextButton(onClick = onRetire) {
                    Text("Retire", style = TrackTheme.typography.xs, color = colors.textMuted)
                }
            }
            TextButton(onClick = { editing = !editing }) {
                Text("Edit", style = TrackTheme.typography.xs, color = colors.textMuted)
            }
        }

        if (measuring) {
            MeasurementForm(part) { draft ->
                model.addMeasurement(part.id, draft)
                measuring = false
            }
        }

        if (editing) {
            PartForm(
                existing = part,
                submitLabel = "Save changes",
                onCancel = { editing = false },
                onDelete = onDelete,
                onSubmit = { patch ->
                    model.updatePart(part.id, patch)
                    editing = false
                },
            )
        }
    }
}

/**
 * The one-line wear story — `wearStatusHtml` in `public/app.js`.
 *
 * A part with no projection says so in words. It must not fall through to an
 * empty bar and a blank line, which reads as "new".
 */
@Composable
private fun WearStory(part: Part) {
    val colors = TrackTheme.colors
    val wear = part.wear
    val status = Garage.partStatus(wear)
    val remaining = Garage.fmtRemaining(wear)

    val usage = buildList {
        add("${Garage.fmtHours(wear.hours)} on part")
        if (part.kind == PartKind.TIRES) {
            add(fmtCount(wear.cycles, "heat cycle"))
        } else if (wear.events > 0) {
            add(fmtCount(wear.events, "event"))
        }
    }.joinToString(" · ")

    Text(usage, style = TrackTheme.typography.xs, color = colors.textMuted)

    if (remaining != null) {
        Text(
            remaining,
            style = TrackTheme.typography.sm,
            color = if (status == Garage.PartStatus.OK) colors.positive else colors.danger,
        )
        Text(
            if (wear.source?.rawValue == "measured") {
                "measured ${wear.wearPerHour?.let { kotlin.math.round(it * 100) / 100 }} " +
                    "${wear.unit.orEmpty()}/h"
            } else {
                "vs. ${Garage.fmtHours(wear.expectedHours)} expected"
            },
            style = TrackTheme.typography.xxs,
            color = colors.textFaint,
        )
    } else if (part.retiredOn == null) {
        Text(
            "No life estimate — set expected hours or log two measurements.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
        )
    }
}

@Composable
private fun MeasurementForm(part: Part, onSubmit: (MeasurementDraft) -> Unit) {
    val colors = TrackTheme.colors
    var value by rememberSaveable(part.id) { mutableStateOf("") }
    var unit by rememberSaveable(part.id) {
        mutableStateOf(part.measurements.lastOrNull()?.unit ?: part.kind.defaultUnit)
    }
    var measuredOn by rememberSaveable(part.id) { mutableStateOf(EventDates.todayIso()) }

    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TEField("Value", modifier = Modifier.weight(1f)) {
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            TEField("Unit", modifier = Modifier.weight(1f)) {
                OutlinedTextField(
                    value = unit,
                    onValueChange = { unit = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        TEField("Measured on") {
            OutlinedTextField(
                value = measuredOn,
                onValueChange = { measuredOn = it },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(
            "Two or more measurements unlock the wear projection.",
            style = TrackTheme.typography.xxs,
            color = colors.textFaint,
        )
        Button(
            onClick = {
                val parsed = value.trim().toDoubleOrNull() ?: return@Button
                onSubmit(
                    MeasurementDraft(
                        measuredOn = measuredOn.trim(),
                        value = parsed,
                        unit = unit.trim().ifEmpty { part.kind.defaultUnit },
                    ),
                )
            },
            enabled = value.trim().toDoubleOrNull() != null,
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.accent,
                contentColor = colors.accentContrast,
            ),
        ) {
            Text("Log measurement", style = TrackTheme.typography.bodyStrong)
        }
    }
}

@Composable
private fun AddPartCard(model: VehicleModel) {
    var open by rememberSaveable { mutableStateOf(false) }
    val colors = TrackTheme.colors

    TrackCard(Modifier.fillMaxWidth()) {
        if (!open) {
            TextButton(onClick = { open = true }) {
                Text("+ Add part", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
            }
        } else {
            Text("Add part", style = TrackTheme.typography.h3, color = colors.textStrong)
            PartForm(
                existing = null,
                submitLabel = "Add part",
                onCancel = { open = false },
                onDelete = null,
                onSubmit = { patch ->
                    model.addPart(patch.toDraft())
                    open = false
                },
            )
        }
    }
}

/**
 * The add/edit form.
 *
 * Both shapes are one composable producing a [PartPatch], because the fields are
 * identical and two copies would drift — the create path converts it to a
 * [PartDraft] on the way out. Every field is sent on save, so clearing one
 * clears it server-side, which is what the web form does.
 */
@Composable
private fun PartForm(
    existing: Part?,
    submitLabel: String,
    onCancel: () -> Unit,
    onDelete: (() -> Unit)?,
    onSubmit: (PartPatch) -> Unit,
) {
    val colors = TrackTheme.colors
    val key = existing?.id ?: 0
    var kind by rememberSaveable(key) { mutableStateOf(existing?.kind?.rawValue ?: PartKind.PADS_FRONT.rawValue) }
    var name by rememberSaveable(key) { mutableStateOf(existing?.name.orEmpty()) }
    var installedOn by rememberSaveable(key) {
        mutableStateOf(existing?.installedOn ?: EventDates.todayIso())
    }
    var cost by rememberSaveable(key) {
        mutableStateOf(existing?.costCents?.let { (it / 100.0).toString() }.orEmpty())
    }
    var expectedHours by rememberSaveable(key) {
        mutableStateOf(existing?.expectedHours?.toString().orEmpty())
    }
    var wearLimit by rememberSaveable(key) { mutableStateOf(existing?.wearLimit?.toString().orEmpty()) }
    var notes by rememberSaveable(key) { mutableStateOf(existing?.notes.orEmpty()) }

    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TEField("Type") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                // Chips rather than a dropdown: eight kinds is few enough to show
                // outright, and a picker hides the vocabulary from a first-time
                // user who doesn't yet know what the app tracks.
                PartKind.all.take(4).forEach { option ->
                    KindChip(option, kind == option.rawValue) { kind = option.rawValue }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PartKind.all.drop(4).forEach { option ->
                KindChip(option, kind == option.rawValue) { kind = option.rawValue }
            }
        }

        TEField("Part / compound") {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                placeholder = {
                    Text("Hawk DTC-60, RE-71RS 255/40…", style = TrackTheme.typography.sm)
                },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        TEField("Installed") {
            OutlinedTextField(
                value = installedOn,
                onValueChange = { installedOn = it },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TEField("Cost ($)", modifier = Modifier.weight(1f)) {
                NumberField(cost, "389") { cost = it }
            }
            TEField(
                "Expected life (h)",
                hint = "Blank uses your history",
                modifier = Modifier.weight(1f),
            ) {
                NumberField(expectedHours, "auto") { expectedHours = it }
            }
        }
        TEField("Replace at", hint = "The measured value this part is used up at") {
            NumberField(wearLimit, PartKind(kind).wearLimitHint.orEmpty()) { wearLimit = it }
        }
        TEField("Notes") {
            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it },
                placeholder = {
                    Text("Sizes, torque specs, where bought…", style = TrackTheme.typography.sm)
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    onSubmit(
                        PartPatch(
                            kind = Patch.Set(PartKind(kind)),
                            name = Patch.Set(name.trim().ifEmpty { null }),
                            installedOn = Patch.Set(installedOn.trim()),
                            costCents = Patch.Set(
                                cost.trim().toDoubleOrNull()?.let { kotlin.math.round(it * 100).toInt() },
                            ),
                            expectedHours = Patch.Set(expectedHours.trim().toDoubleOrNull()),
                            wearLimit = Patch.Set(wearLimit.trim().toDoubleOrNull()),
                            notes = Patch.Set(notes.trim().ifEmpty { null }),
                        ),
                    )
                },
                enabled = name.isNotBlank(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.accent,
                    contentColor = colors.accentContrast,
                ),
            ) {
                Text(submitLabel, style = TrackTheme.typography.bodyStrong)
            }
            TextButton(onClick = onCancel) {
                Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
            if (onDelete != null) {
                TextButton(onClick = onDelete) {
                    Text("Delete", style = TrackTheme.typography.sm, color = colors.danger)
                }
            }
        }
    }
}

@Composable
private fun KindChip(kind: PartKind, selected: Boolean, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(
        modifier = Modifier.clickable(onClick = onClick),
        border = if (selected) colors.accent else colors.borderHairline,
        contentPadding = 8.dp,
    ) {
        Text(
            kind.label,
            style = TrackTheme.typography.xxs,
            color = if (selected) colors.accentInk else colors.textMuted,
        )
    }
}

@Composable
private fun NumberField(value: String, placeholder: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, style = TrackTheme.typography.sm) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth(),
    )
}

/** A retired part, and what it cost per hour of use. */
@Composable
private fun RetiredCard(part: Part) {
    val colors = TrackTheme.colors
    val perHour = part.costCents
        ?.takeIf { part.wear.hours > 0 }
        ?.let { "$" + kotlin.math.round(it / 100.0 / part.wear.hours).toInt() + "/h" }

    TrackCard(Modifier.fillMaxWidth(), contentPadding = 12.dp) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(
                    "${part.kind.label} · ${part.name.orEmpty()}",
                    style = TrackTheme.typography.sm,
                    color = colors.textStrong,
                )
                TEMeta(
                    listOf(
                        "${EventDates.fmtDate(part.installedOn)} – ${EventDates.fmtDate(part.retiredOn)}",
                        Garage.fmtHours(part.wear.hours),
                        Garage.fmtCost(part.costCents),
                    ),
                )
            }
            Text(
                perHour ?: "—",
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
            )
        }
    }
}

/**
 * The create path's view of the form. `POST /parts` takes a draft, not a patch,
 * and the server defaults `expected_hours` from retired lifecycles when it is
 * absent — so an unset field must be omitted rather than sent as null.
 */
private fun PartPatch.toDraft(): PartDraft = PartDraft(
    kind = (kind as? Patch.Set)?.value ?: PartKind.OTHER,
    name = (name as? Patch.Set)?.value,
    installedOn = (installedOn as? Patch.Set)?.value ?: EventDates.todayIso(),
    costCents = (costCents as? Patch.Set)?.value,
    expectedHours = (expectedHours as? Patch.Set)?.value,
    wearLimit = (wearLimit as? Patch.Set)?.value,
    notes = (notes as? Patch.Set)?.value,
)
