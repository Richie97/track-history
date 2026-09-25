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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.label
import app.trackevolution.core.Balance
import app.trackevolution.core.model.CatalogCar
import app.trackevolution.core.model.SteeringFit
import app.trackevolution.core.model.MeasurementDraft
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartDraft
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.Vehicle
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.Patch
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.PaneWidth
import app.trackevolution.ui.CatalogCarPicker
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.TEWearBar
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.fmtRatio
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * One car: what it has done, for every account — and for Pro what's fitted, how
 * much life is left in it, and what wore it out (NS-31, NS-37).
 *
 * `viewVehicle` in `public/app.js` is the reference, including its wording. A
 * free account gets the logbook tiles, the last-out / next-up line, the best in
 * this car and the *Edit car* form, with the Pro half **locked in place** rather
 * than the page being a paywall. The setup notebook and the setup-vs-lap-times
 * diff stay deferred on native and are absent rather than stubbed.
 */
@Composable
fun VehicleScreen(
    model: VehicleModel,
    modifier: Modifier = Modifier,
    onRequirePro: () -> Unit = {},
    onOpenEvent: (Int) -> Unit = {},
    onOpenTrack: (Int) -> Unit = {},
    /** The car is gone; leave its page. */
    onDeleted: () -> Unit = {},
) {
    val colors = TrackTheme.colors
    // Which part has a confirmation open, by **id** rather than by `Part`.
    //
    // Saveable, so an open dialog survives the configuration change a fold, a
    // rotation or a font-scale change causes (NS-34 ticket 4's audit). Held as an
    // id because `Part` is not `Parcelable` — and an id is the better handle
    // anyway: the part is re-read from the model, so a dialog cannot go on
    // describing a part whose measurements have moved on underneath it.
    var confirmRetireId by rememberSaveable { mutableStateOf<Int?>(null) }
    var confirmRefreshId by rememberSaveable { mutableStateOf<Int?>(null) }
    var confirmDeleteId by rememberSaveable { mutableStateOf<Int?>(null) }
    // The Equipped switch's confirm row (migration 0029) and a retired part's
    // "another set of those" — ids again, for the same reasons. Inline in the
    // card, as the web page's confirm row is, rather than a dialog: the row
    // carries a date field, and a text field is a form, not an alert.
    var confirmEquipId by rememberSaveable { mutableStateOf<Int?>(null) }
    var refreshRetiredId by rememberSaveable { mutableStateOf<Int?>(null) }
    // The car's own delete (NS-37, moved from Settings), the same pattern: the
    // vehicle id, saveably.
    var confirmDeleteCarId by rememberSaveable { mutableStateOf<Int?>(null) }

    // Two columns, and which consumable the right one is showing (NS-34 ticket 3).
    //
    // Narrower than the event page's analysis column and with a lower floor,
    // because what goes in it is a two-field form rather than a track map and a
    // stack of charts. Measured against this page's own column rather than the
    // window's class — see `LayoutMetrics.sideColumnWidth`. Pro only: a free
    // account has no consumables to put in it.
    val partWidth = LocalLayoutMetrics.current.sideColumnWidth(0.42f, 340.dp, 560.dp)
        .takeIf { model.garage != null }
    val twoColumn = partWidth != null
    var selectedPartId by rememberSaveable { mutableStateOf<Int?>(null) }
    // The car's own form, open or not. Saveable for the same reason the dialogs
    // are: a fold or a rotation must not close it under the driver.
    var editingCar by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.deleted) { if (model.deleted) onDeleted() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val vehicle = model.vehicle ?: return@TELoadable
        val pro = model.garage
        val logbook = model.logbook
        // Read here, not inside the LazyColumn's builder, which is not composable.
        val units = LocalUnitSystem.current

        val page = @Composable {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            vehicle.name,
                            style = TrackTheme.typography.h1,
                            color = colors.textStrong,
                            modifier = Modifier.weight(1f),
                        )
                        if (vehicle.isDefault) {
                            Text(
                                "Default",
                                style = TrackTheme.typography.xxs,
                                color = colors.accentInk,
                                modifier = Modifier.padding(horizontal = 8.dp),
                            )
                        }
                        // The car itself — name, mods, the pressure the health
                        // strip aims at, whether new events start on it.
                        TextButton(onClick = { editingCar = !editingCar }) {
                            Text("Edit car", style = TrackTheme.typography.sm, color = colors.accentInk)
                        }
                    }
                    vehicle.notes?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                }
            }

            if (editingCar) {
                item("edit-car") {
                    // The catalog is fetched when the form opens, not with the
                    // page: it is only needed here, and the picker reads it from
                    // the response cache offline. The measured ratio is Pro.
                    LaunchedEffect(Unit) {
                        model.loadCatalog()
                        if (model.garage != null) model.loadSteeringFits()
                    }
                    VehicleForm(
                        vehicle,
                        catalog = model.catalog,
                        catalogError = model.catalogError,
                        steeringFits = if (pro != null) model.steeringFits else null,
                        onCancel = { editingCar = false },
                    ) { edit ->
                        model.updateVehicle(
                            edit.name, edit.notes, edit.targetHotPsi, edit.isDefault,
                            edit.catalogId, edit.wheelbaseMm, edit.steeringRatio,
                        )
                        editingCar = false
                    }
                }
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

            // Expanded, not collapsed: on the garage list maintenance is one
            // line among the cars, but on this page it is the point of the view.
            if (model.alerts.isNotEmpty()) {
                item("alerts") { MaintenancePanel(model.alerts) }
            }

            item("tiles") {
                TEStatRow(
                    if (pro != null) {
                        listOf(
                            "Track hours" to Garage.fmtHours(pro.hours),
                            "Track days" to pro.eventDays.toString(),
                            "Events" to pro.eventCount.toString(),
                            "Parts spend" to (Garage.fmtCost(model.spendCents.takeIf { it > 0 }) ?: "—"),
                        )
                    } else {
                        listOf(
                            "Track days" to fmtDays(logbook.trackDays),
                            "Events" to logbook.events.toString(),
                        )
                    },
                )
            }

            // The car's own odometer (#192), from GET /garage and so Pro: ground
            // truth for distance beside the hours estimate, from video imports
            // only — so the line names the recorded session it came from rather
            // than claiming to be current.
            Garage.vehicleOdometerLine(pro?.odometer, units)?.let { line ->
                item("odometer") {
                    Text(line, style = TrackTheme.typography.xs, color = colors.textMuted)
                }
            }

            item("logbook-line") { LogbookLine(logbook, onOpenEvent) }

            if (logbook.bests.isNotEmpty()) {
                item("bests-header") { TESectionHeader("Best in this car") }
                item("bests") { BestsCard(logbook.bests, onOpenTrack = onOpenTrack, onOpenEvent = onOpenEvent) }
            }

            if (pro == null) {
                // Locked in place, never simply missing (NS-37).
                if (model.proLocked) {
                    item("pro-header") { TESectionHeader("Consumables, hours and costs") }
                    item("pro-locked") {
                        TEProLocked(
                            title = "Consumables, hours and costs",
                            blurb = GARAGE_PRO_WHAT,
                            onSubscribe = onRequirePro,
                        )
                    }
                }
            } else {
                item("parts-header") { TESectionHeader("On the car") }
                item("parts-hint") {
                    Text(
                        "Wear accrues automatically from this car's logged events (2h per track day " +
                            "unless an event says otherwise), but only while a part is equipped — flip " +
                            "the switch off to put a set on the shelf, and on again to swap it back. Log " +
                            "a quick pad or tread measurement between events and the projection switches " +
                            "from estimated to measured.",
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
                                onRetire = { confirmRetireId = part.id },
                                onRefresh = { confirmRefreshId = part.id },
                                onDelete = { confirmDeleteId = part.id },
                                onToggleEquipped = { confirmEquipId = if (confirmEquipId == part.id) null else part.id },
                                equipping = confirmEquipId == part.id,
                                onEquipDone = { confirmEquipId = null },
                                detailInColumn = twoColumn,
                                selected = twoColumn && selectedPart(model, selectedPartId)?.id == part.id,
                                onSelect = { selectedPartId = part.id },
                            )
                        }
                    }
                }

                // The shelf (migration 0029): off the car, not thrown away.
                if (model.spareParts.isNotEmpty()) {
                    item("spares-header") { TESectionHeader("Spares") }
                    item("spares-hint") {
                        Text(
                            "Off the car but not retired — a second set of wheels, the street pads. " +
                                "Their hours are frozen until you equip them, which takes off whatever " +
                                "is in their place.",
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                        )
                    }
                    model.spareParts.forEach { part ->
                        item("spare-${part.id}") {
                            PartCard(
                                part = part,
                                model = model,
                                onRetire = { confirmRetireId = part.id },
                                onRefresh = { confirmRefreshId = part.id },
                                onDelete = { confirmDeleteId = part.id },
                                onToggleEquipped = { confirmEquipId = if (confirmEquipId == part.id) null else part.id },
                                equipping = confirmEquipId == part.id,
                                onEquipDone = { confirmEquipId = null },
                                detailInColumn = twoColumn,
                                selected = twoColumn && selectedPart(model, selectedPartId)?.id == part.id,
                                onSelect = { selectedPartId = part.id },
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
                        item("retired-${part.id}") {
                            RetiredCard(
                                part,
                                refreshing = refreshRetiredId == part.id,
                                parts = model.allParts,
                                onRefresh = { refreshRetiredId = if (refreshRetiredId == part.id) null else part.id },
                                onConfirm = { on, equipped ->
                                    refreshRetiredId = null
                                    model.refreshRetiredPart(part.id, on, equipped)
                                },
                            )
                        }
                    }
                }
            }

            item("delete-car") {
                TextButton(
                    onClick = { confirmDeleteCarId = vehicle.id },
                    modifier = Modifier.testTag("deleteCar"),
                ) {
                    Text("Delete car", style = TrackTheme.typography.sm, color = colors.danger)
                }
            }
        }
        }

        if (partWidth != null) {
            Row(Modifier.fillMaxSize()) {
                PaneWidth(Modifier.weight(1f)) { page() }
                VerticalDivider(color = colors.borderHairline)
                PaneWidth(Modifier.width(partWidth)) {
                    PartColumn(part = selectedPart(model, selectedPartId), model = model)
                }
            }
        } else {
            page()
        }
    }

    partById(model, confirmRetireId)?.let { part ->
        TEConfirmDialog(
            text = "Retire ${part.kind.label}? It stops accruing wear as of today and moves to " +
                "the retired list.",
            confirm = "Retire",
            onConfirm = { confirmRetireId = null; model.retirePart(part.id) },
            onDismiss = { confirmRetireId = null },
        )
    }

    partById(model, confirmRefreshId)?.let { part ->
        TEConfirmDialog(
            text = "Replace ${part.kind.label} with the same spec? The old one is retired as of " +
                if (Garage.isSpare(part)) "today and a new one takes its place on the shelf."
                else "today and a new one goes on in its place.",
            confirm = "Replace",
            onConfirm = { confirmRefreshId = null; model.refreshPart(part.id) },
            onDismiss = { confirmRefreshId = null },
        )
    }

    partById(model, confirmDeleteId)?.let { part ->
        TEConfirmDialog(
            text = "Delete ${part.kind.label}? Its measurements and wear history go with it. " +
                "Retire it instead if it was actually fitted.",
            confirm = "Delete",
            onConfirm = { confirmDeleteId = null; model.deletePart(part.id) },
            onDismiss = { confirmDeleteId = null },
        )
    }

    model.vehicle?.takeIf { it.id == confirmDeleteCarId }?.let { vehicle ->
        TEConfirmDialog(
            text = "Delete ${vehicle.name}? Past events keep the car name they were logged with" +
                if (model.garage != null) "; its consumables, measurements and wear history go with it." else ".",
            confirm = "Delete car",
            onConfirm = { confirmDeleteCarId = null; model.deleteVehicle() },
            onDismiss = { confirmDeleteCarId = null },
        )
    }
}

/** "2", "1.5" — a track-day count the way the web prints it. */
private fun fmtDays(days: Double): String =
    if (days == Math.rint(days)) days.toLong().toString() else days.toString()

/**
 * Last out and next up (NS-37), each opening its event — the same two facts the
 * car's tile words, for both tiers.
 */
@Composable
private fun LogbookLine(logbook: Garage.VehicleLogbook, onOpenEvent: (Int) -> Unit) {
    val colors = TrackTheme.colors
    val last = logbook.lastEvent
    val next = logbook.nextEvent
    if (last == null && next == null) {
        Text(
            "No track days in this car yet — pick it on an event and they'll show up here.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
        )
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        last?.let {
            Text(
                "Last out at ${it.trackName} on ${EventDates.fmtDate(it.startDate)}",
                style = TrackTheme.typography.sm,
                color = colors.accentInk,
                modifier = Modifier.clickable { onOpenEvent(it.id) }.padding(vertical = 4.dp),
            )
        }
        next?.let {
            Text(
                "Next: ${it.trackName} on ${EventDates.fmtDate(it.startDate)}",
                style = TrackTheme.typography.sm,
                color = colors.accentInk,
                modifier = Modifier.clickable { onOpenEvent(it.id) }.padding(vertical = 4.dp),
            )
        }
    }
}

/**
 * Best in this car, per track (NS-37) — free, since it is the driver's own
 * logbook. A row opens the track; its date opens the day the time was set.
 */
@Composable
private fun BestsCard(
    bests: List<Garage.LogbookBest>,
    onOpenTrack: (Int) -> Unit,
    onOpenEvent: (Int) -> Unit,
) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth().testTag("bestsInCar")) {
        bests.forEachIndexed { index, best ->
            if (index > 0) HorizontalDivider(color = colors.borderHairline)
            Row(
                modifier = Modifier.fillMaxWidth().clickable { onOpenTrack(best.trackId) }.padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(best.trackName, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                    Text(
                        "Set on ${EventDates.fmtDate(best.startDate)}",
                        style = TrackTheme.typography.xs,
                        color = colors.accentInk,
                        modifier = Modifier.clickable { onOpenEvent(best.eventId) },
                    )
                }
                Text(LapTime.fmtMs(best.bestMs), style = TrackTheme.typography.lapTime, color = colors.textStrong)
            }
        }
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
                "${alert.part.kind.label}${alert.part.size?.let { " $it" }.orEmpty()} — " +
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

/** One row per logged measurement, with the way to remove it. */
@Composable
private fun MeasurementList(part: Part, model: VehicleModel) {
    val colors = TrackTheme.colors
    part.measurements.forEach { measurement ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${EventDates.fmtDate(measurement.measuredOn)} · " +
                    "${measurement.value} ${measurement.unit}",
                style = TrackTheme.typography.xs,
                color = colors.textMuted,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { model.deleteMeasurement(part.id, measurement.id) }) {
                Text("✕", style = TrackTheme.typography.xs, color = colors.textFaint)
            }
        }
    }
}

/**
 * The vehicle page's right-hand column at expanded width (NS-34 ticket 3): the
 * selected consumable's measurements. Logging one is a two-field form that on a
 * phone sits inside whichever card you happened to scroll to; the column gives
 * it a fixed place.
 */
@Composable
private fun PartColumn(part: Part?, model: VehicleModel) {
    val colors = TrackTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
            .semantics { testTag = "partColumn" },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (part == null) {
            TEEmpty("Add a consumable and its measurements will show here.")
        } else {
            Text(
                Garage.partTitle(part).ifEmpty { part.kind.label },
                style = TrackTheme.typography.h3,
                color = colors.textStrong,
            )
            WearStory(part)
            if (part.measurements.isNotEmpty()) {
                TESectionHeader("Measurements")
                MeasurementList(part, model)
            }
            MeasurementForm(part) { draft -> model.addMeasurement(part.id, draft) }
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
    /** The Equipped switch was flipped; the card confirms before it writes. */
    onToggleEquipped: () -> Unit,
    /** The confirm row is open. */
    equipping: Boolean = false,
    /** It closed, confirmed or cancelled. */
    onEquipDone: () -> Unit = {},
    /** Whether the measurements live in the column beside this instead. */
    detailInColumn: Boolean = false,
    selected: Boolean = false,
    onSelect: () -> Unit = {},
) {
    val colors = TrackTheme.colors
    var measuring by rememberSaveable(part.id) { mutableStateOf(false) }
    var editing by rememberSaveable(part.id) { mutableStateOf(false) }

    TrackCard(
        Modifier
            .fillMaxWidth()
            .then(if (detailInColumn) Modifier.clickable(onClick = onSelect) else Modifier)
            .semantics { this.selected = selected },
        // Marked the way every other selectable row in the app is: a tint *and*
        // a border, never colour alone.
        color = if (selected) colors.accentTint else null,
        border = if (selected) colors.accent else null,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(part.kind.label, style = TrackTheme.typography.eyebrow, color = colors.accentInk)
                Text(
                    part.name ?: part.kind.label,
                    style = TrackTheme.typography.bodyStrong,
                    color = colors.textStrong,
                )
                part.size?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = TrackTheme.typography.xs, color = colors.textMuted)
                }
            }
            if (part.retiredOn == null) EquipSwitch(part, onToggleEquipped)
        }
        val lastOff = Garage.lastOff(part)
        TEMeta(
            listOf(
                "Installed ${EventDates.fmtDate(part.installedOn)}",
                when {
                    !Garage.isSpare(part) -> null
                    lastOff != null -> "off the car since ${EventDates.fmtDate(lastOff)}"
                    else -> "not fitted yet"
                },
                part.retiredOn?.let { "retired ${EventDates.fmtDate(it)}" },
                Garage.fmtCost(part.costCents),
                part.notes,
            ),
        )

        if (equipping) {
            EquipConfirm(
                part = part,
                parts = model.allParts,
                onConfirm = { on ->
                    onEquipDone()
                    model.setEquipped(part, equipped = Garage.isSpare(part), on = on)
                },
                onCancel = onEquipDone,
            )
        }

        TEWearBar(part.wear, modifier = Modifier.padding(vertical = 8.dp))
        WearStory(part)

        // Both move to the column beside this at expanded width (NS-34 ticket 3).
        if (!detailInColumn && part.measurements.isNotEmpty()) {
            Column(Modifier.padding(top = 8.dp)) { MeasurementList(part, model) }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!detailInColumn) {
                TextButton(onClick = { measuring = !measuring }) {
                    Text("Measure", style = TrackTheme.typography.xs, color = colors.accentInk)
                }
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
                onSubmit = { patch, _ ->
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
        if (Garage.isTireKind(part.kind)) {
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
    } else if (Garage.isOnCar(part)) {
        Text(
            "No life estimate — set expected hours or log two measurements.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
        )
    }

    // The odometer's distance beside the hours above (#192) — reported, never
    // an input to the estimate.
    Garage.partOdometerLine(part.odometer, LocalUnitSystem.current)?.let { line ->
        Text(line, style = TrackTheme.typography.xs, color = colors.textMuted)
    }
}

/**
 * The part a confirmation is about, looked up fresh each time.
 *
 * Both lists, because a confirmation can outlive the state that opened it: retire
 * a part and the dialog's own action moves it from one list to the other. Null
 * when the id names nothing any more, which closes the dialog rather than
 * stranding it over a part that has been deleted.
 */
private fun partById(model: VehicleModel, id: Int?): Part? {
    if (id == null) return null
    return model.allParts.firstOrNull { it.id == id }
}

/**
 * The part the expanded page's right-hand column shows: the one picked, while
 * it is still on the car or the shelf, else the first on the car, else the
 * first spare.
 */
private fun selectedPart(model: VehicleModel, id: Int?): Part? {
    val candidates = model.activeParts + model.spareParts
    return candidates.firstOrNull { it.id == id } ?: candidates.firstOrNull()
}

@Composable
private fun MeasurementForm(part: Part, onSubmit: (MeasurementDraft) -> Unit) {
    val colors = TrackTheme.colors
    // The account's tread-depth idiom only sets the *default*: a measurement
    // stores its own unit string, and a part's later ones follow its first.
    val units = LocalUnitSystem.current
    var value by rememberSaveable(part.id) { mutableStateOf("") }
    var unit by rememberSaveable(part.id) {
        mutableStateOf(part.measurements.lastOrNull()?.unit ?: Garage.defaultMeasurementUnit(part.kind, units))
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
                        unit = unit.trim().ifEmpty { Garage.defaultMeasurementUnit(part.kind, units) },
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
                addingTo = model.allParts,
                onSubmit = { patch, equipped ->
                    // Equipped, it takes off what it replaces (`swap`), as the
                    // switch does; unticked, it goes straight to the shelf.
                    model.addPart(patch.toDraft().copy(equipped = equipped, swap = equipped))
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
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PartForm(
    existing: Part?,
    submitLabel: String,
    onCancel: () -> Unit,
    onDelete: (() -> Unit)?,
    /**
     * The car's parts when this form *adds* one: it then carries the Equipped
     * switch and says what an equipped part takes off. Null for an edit, where
     * the card's own switch does that.
     */
    addingTo: List<Part>? = null,
    /** The patch, and — adding — whether the part goes on the car. */
    onSubmit: (PartPatch, Boolean) -> Unit,
) {
    val colors = TrackTheme.colors
    val key = existing?.id ?: 0
    var kind by rememberSaveable(key) { mutableStateOf(existing?.kind?.rawValue ?: PartKind.PADS_FRONT.rawValue) }
    var name by rememberSaveable(key) { mutableStateOf(existing?.name.orEmpty()) }
    var size by rememberSaveable(key) { mutableStateOf(existing?.size.orEmpty()) }
    var equipped by rememberSaveable(key) { mutableStateOf(true) }
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
            // Chips rather than a dropdown: ten kinds is few enough to show
            // outright, and a picker hides the vocabulary from a first-time user
            // who doesn't yet know what the app tracks. Wrapping, since the tyre
            // pairs (migration 0029) made the list longer than two phone rows.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                PartKind.all.forEach { option ->
                    KindChip(option, kind == option.rawValue) { kind = option.rawValue }
                }
            }
        }

        TEField("Part / compound") {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                placeholder = {
                    Text("Hawk DTC-60, Hoosier A7…", style = TrackTheme.typography.sm)
                },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        TEField("Size (optional)") {
            OutlinedTextField(
                value = size,
                // The server's limit, enforced where it is typed rather than
                // refused on save.
                onValueChange = { size = it.take(40) },
                placeholder = {
                    if (Garage.isTireKind(PartKind(kind))) Text("285/30R18", style = TrackTheme.typography.sm)
                },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("partSize"),
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
            NumberField(wearLimit, Garage.wearLimitHint(PartKind(kind), LocalUnitSystem.current)) { wearLimit = it }
        }
        TEField("Notes") {
            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it },
                placeholder = {
                    Text("Torque specs, where bought…", style = TrackTheme.typography.sm)
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (addingTo != null) {
            EquippedToggle(
                checked = equipped,
                label = "Equipped — on the car now",
                onCheckedChange = { equipped = it },
            )
            if (equipped) {
                Garage.addSwapNote(PartKind(kind), addingTo)?.let {
                    Text(it, style = TrackTheme.typography.xs, color = colors.textMuted)
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    onSubmit(
                        PartPatch(
                            kind = Patch.Set(PartKind(kind)),
                            name = Patch.Set(name.trim().ifEmpty { null }),
                            size = Patch.Set(size.trim().ifEmpty { null }),
                            installedOn = Patch.Set(installedOn.trim()),
                            costCents = Patch.Set(
                                cost.trim().toDoubleOrNull()?.let { kotlin.math.round(it * 100).toInt() },
                            ),
                            expectedHours = Patch.Set(expectedHours.trim().toDoubleOrNull()),
                            wearLimit = Patch.Set(wearLimit.trim().toDoubleOrNull()),
                            notes = Patch.Set(notes.trim().ifEmpty { null }),
                        ),
                        equipped,
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

/**
 * The Equipped switch on a part card (migration 0029). It never writes on its
 * own: flipping it asks the page to confirm — the swap date, and what putting
 * it on takes off — so the switch shows the part's real state until then.
 */
@Composable
private fun EquipSwitch(part: Part, onToggle: () -> Unit) {
    EquippedToggle(
        checked = !Garage.isSpare(part),
        label = "Equipped",
        onCheckedChange = { onToggle() },
        modifier = Modifier.testTag("equip-${part.id}"),
    )
}

/**
 * A switch and its label as one control, so TalkBack reads "Equipped, switch,
 * on" and the whole row is the touch target — the `role="switch"` checkbox
 * the web page draws.
 */
@Composable
private fun EquippedToggle(
    checked: Boolean,
    label: String,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    Row(
        modifier = modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Switch(
            checked = checked,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(
                checkedThumbColor = colors.accentInk,
                checkedTrackColor = colors.accentTint,
            ),
        )
        Text(label, style = TrackTheme.typography.sm, color = colors.textBody)
    }
}

/**
 * A swap-date field bounded the way the server bounds it: a real date, not
 * before [earliest], and not after [latest] when there is one. Blank is not
 * allowed — the web's input is `required` — so the default is today.
 */
private fun validSwapDate(date: String, earliest: String, latest: String?): Boolean =
    EventDates.epochDay(date) != null && date.length == 10 && date >= earliest && (latest == null || date <= latest)

/**
 * The Equipped switch's confirm row (migration 0029): what the swap does, in
 * the web page's words, and the date it happened — today unless it was earlier,
 * never before the part's current stretch began or back inside one it was
 * already on.
 */
@Composable
private fun EquipConfirm(
    part: Part,
    parts: List<Part>,
    onConfirm: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val colors = TrackTheme.colors
    val today = EventDates.todayIso()
    val earliest = Garage.earliestSwapDate(part)
    var on by rememberSaveable(part.id) { mutableStateOf(today) }
    val valid = validSwapDate(on.trim(), earliest, today)
    TrackCard(Modifier.fillMaxWidth().padding(top = 8.dp), color = colors.surfaceRaised, contentPadding = 12.dp) {
        Text(Garage.equipNote(part, parts), style = TrackTheme.typography.sm, color = colors.textStrong)
        TEField(
            "Swap date",
            hint = if (valid) null else "Between ${EventDates.fmtDate(earliest)} and today",
            modifier = Modifier.padding(top = 8.dp),
        ) {
            OutlinedTextField(
                value = on,
                onValueChange = { on = it },
                singleLine = true,
                isError = !valid,
                modifier = Modifier.fillMaxWidth().testTag("equipDate"),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            Button(
                onClick = { onConfirm(on.trim()) },
                enabled = valid,
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
            ) {
                Text(if (Garage.isSpare(part)) "Equip" else "Take off", style = TrackTheme.typography.bodyStrong)
            }
            TextButton(onClick = onCancel) {
                Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
        }
    }
}

/**
 * "Buy another set of those" for a retired part: a fresh copy of its spec —
 * name, size, cost, replace-at — installed on the chosen date, on the car in
 * place of whatever is there by default, or on the shelf.
 */
@Composable
private fun RetiredRefreshForm(
    part: Part,
    parts: List<Part>,
    onConfirm: (String, Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    val colors = TrackTheme.colors
    var on by rememberSaveable(part.id) { mutableStateOf(EventDates.todayIso()) }
    var equipped by rememberSaveable(part.id) { mutableStateOf(true) }
    val valid = validSwapDate(on.trim(), part.installedOn, null)
    val note = (if (equipped) Garage.addSwapNote(part.kind, parts) else null)
        ?: if (equipped) "Goes on the car with hours at zero." else "Goes to Spares with hours at zero."
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("A new set of ${Garage.partTitle(part)}", style = TrackTheme.typography.sm, color = colors.textStrong)
        TEField("Installed", hint = if (valid) null else "On or after ${EventDates.fmtDate(part.installedOn)}") {
            OutlinedTextField(
                value = on,
                onValueChange = { on = it },
                singleLine = true,
                isError = !valid,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        EquippedToggle(checked = equipped, label = "Equipped", onCheckedChange = { equipped = it })
        Text(note, style = TrackTheme.typography.xs, color = colors.textMuted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onConfirm(on.trim(), equipped) },
                enabled = valid,
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
            ) {
                Text("Add new set", style = TrackTheme.typography.bodyStrong)
            }
            TextButton(onClick = onCancel) {
                Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
        }
    }
}

/** A retired part, and what it cost per hour of use. */
@Composable
private fun RetiredCard(
    part: Part,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onConfirm: (String, Boolean) -> Unit,
    parts: List<Part> = emptyList(),
) {
    val colors = TrackTheme.colors
    val perHour = part.costCents
        ?.takeIf { part.wear.hours > 0 }
        ?.let { "$" + kotlin.math.round(it / 100.0 / part.wear.hours).toInt() + "/h" }

    TrackCard(Modifier.fillMaxWidth(), contentPadding = 12.dp) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(
                    "${part.kind.label} · ${Garage.partTitle(part)}",
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
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    perHour ?: "—",
                    style = TrackTheme.typography.sm,
                    color = colors.textMuted,
                )
                // "Buy another set of those" (migration 0029).
                TextButton(
                    onClick = onRefresh,
                    modifier = Modifier.semantics {
                        contentDescription = "Refresh ${Garage.partTitle(part)} into a new set"
                    },
                ) {
                    Text("Refresh", style = TrackTheme.typography.xs, color = colors.accentInk)
                }
            }
        }
        if (refreshing) {
            RetiredRefreshForm(part, parts, onConfirm = onConfirm, onCancel = onRefresh)
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
    size = (size as? Patch.Set)?.value,
    installedOn = (installedOn as? Patch.Set)?.value ?: EventDates.todayIso(),
    costCents = (costCents as? Patch.Set)?.value,
    expectedHours = (expectedHours as? Patch.Set)?.value,
    wearLimit = (wearLimit as? Patch.Set)?.value,
    notes = (notes as? Patch.Set)?.value,
)

/** What the *Edit car* form hands back — every field it shows. */
internal data class VehicleEdit(
    val name: String,
    val notes: String,
    val targetHotPsi: Double?,
    val isDefault: Boolean,
    val catalogId: Int?,
    val wheelbaseMm: Int?,
    val steeringRatio: Double?,
)

/**
 * Edit the car: its name, its modifications and notes, the hot tyre pressure the
 * health strip's pressure loop aims at, whether new events start on it, and —
 * #208 / #222 — its two spec-sheet numbers, picked from the car catalog or typed.
 * `viewVehicle`'s `#veh-form` in `public/app.js`. Inline under the heading, as
 * the part cards' edit forms are.
 *
 * The catalog pick follows the web's rules exactly, through `:core`'s
 * [Garage.catalogPrefill]: **pre-fill, never overwrite** — a number the driver
 * typed is asked about, inline under its field, per field; a number the previous
 * pick filled in is replaced silently on a re-pick; clearing the pick keeps the
 * numbers, because they are the driver's now. `pickId` is the row the form's
 * numbers came from — the stored one to begin with — which is what tells those
 * two cases apart. Held as an id, saveably, for the same reason the page's
 * dialogs are: a fold must not lose the pick.
 */
@Composable
internal fun VehicleForm(
    vehicle: Vehicle,
    catalog: List<CatalogCar>?,
    catalogError: String?,
    steeringFits: List<SteeringFit>? = null,
    onCancel: () -> Unit,
    onSave: (VehicleEdit) -> Unit,
) {
    val colors = TrackTheme.colors
    var name by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.name) }
    var notes by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.notes.orEmpty()) }
    var psi by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.targetHotPsi?.let { if (it % 1.0 == 0.0) it.toInt().toString() else it.toString() }.orEmpty()) }
    var isDefault by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.isDefault) }
    var wheelbase by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.wheelbaseMm?.toString().orEmpty()) }
    var steering by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.steeringRatio?.let(::fmtRatio).orEmpty()) }
    var pickId by rememberSaveable(vehicle.id) { mutableStateOf(vehicle.catalogId) }
    var wheelbaseAsk by rememberSaveable(vehicle.id) { mutableStateOf<Int?>(null) }
    var steeringAsk by rememberSaveable(vehicle.id) { mutableStateOf<Double?>(null) }
    var picking by rememberSaveable(vehicle.id) { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val pick = pickId?.let { id -> catalog?.firstOrNull { it.id == id } }

    fun picked(row: CatalogCar) {
        val plan = Garage.catalogPrefill(
            row,
            Garage.VehicleGeometry(
                wheelbaseMm = wheelbase.trim().toIntOrNull(),
                steeringRatio = steering.trim().replace(',', '.').toDoubleOrNull(),
            ),
            pick,
        )
        when (plan.wheelbaseMm.action) {
            Garage.CatalogPrefillAction.FILL -> { wheelbase = plan.wheelbaseMm.value?.toString().orEmpty(); wheelbaseAsk = null }
            Garage.CatalogPrefillAction.ASK -> wheelbaseAsk = plan.wheelbaseMm.value
            Garage.CatalogPrefillAction.KEEP -> wheelbaseAsk = null
        }
        when (plan.steeringRatio.action) {
            Garage.CatalogPrefillAction.FILL -> { steering = plan.steeringRatio.value?.let(::fmtRatio).orEmpty(); steeringAsk = null }
            Garage.CatalogPrefillAction.ASK -> steeringAsk = plan.steeringRatio.value
            Garage.CatalogPrefillAction.KEEP -> steeringAsk = null
        }
        pickId = row.id
        // A car already called "Betty" keeps its name.
        if (name.isBlank()) name = Garage.catalogCarName(row)
        picking = false
    }

    if (picking) {
        CatalogCarPicker(rows = catalog, error = catalogError, onPick = ::picked, onDismiss = { picking = false })
    }

    TrackCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TEField(
                "Car",
                hint = "Past events match this car by name — renaming it away from what they " +
                    "say stops their hours accruing here",
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            TEField("Modifications & notes") {
                OutlinedTextField(
                    value = notes,
                    onValueChange = { notes = it },
                    placeholder = {
                        Text("Coilovers, pads, tires, alignment…", style = TrackTheme.typography.sm)
                    },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            TEField(
                "Target hot tire pressure (psi, optional)",
                hint = "What the pressure loop on an imported session's Car tab aims at",
            ) {
                OutlinedTextField(
                    value = psi,
                    onValueChange = { psi = it },
                    placeholder = { Text("e.g. 34", style = TrackTheme.typography.sm) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Switch(
                    checked = isDefault,
                    onCheckedChange = { isDefault = it },
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = colors.accentInk,
                        checkedTrackColor = colors.accentTint,
                    ),
                )
                Text("Default car for new events", style = TrackTheme.typography.sm, color = colors.textBody)
            }

            // The catalog field: what is picked, the door to the picker, and
            // Clear. The label says what a pick *does*, because that is the
            // only reason to pick rather than type.
            TEField(
                "Find your car in the catalog (optional)",
                hint = "Picking a car fills in the wheelbase and steering ratio the balance read-out " +
                    "uses — nothing else changes, and a car the catalog doesn't know is just typed in below.",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        pick?.let(Garage::catalogCarLabel) ?: "Search the catalog…",
                        style = TrackTheme.typography.body,
                        color = if (pick == null) colors.textMuted else colors.textStrong,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.surfaceInput)
                            .clickable { picking = true }
                            .padding(horizontal = 12.dp, vertical = 10.dp)
                            .testTag("pickCatalogCar"),
                    )
                    if (pickId != null) {
                        TextButton(
                            onClick = { pickId = null; wheelbaseAsk = null; steeringAsk = null },
                            modifier = Modifier.testTag("clearCatalogCar"),
                        ) {
                            Text("Clear the pick — keep the numbers", style = TrackTheme.typography.xs, color = colors.accentInk)
                        }
                    }
                }
            }
            TEField("Wheelbase (mm, optional)") {
                OutlinedTextField(
                    value = wheelbase,
                    onValueChange = { wheelbase = it },
                    placeholder = { Text("e.g. 2710", style = TrackTheme.typography.sm) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth().testTag("wheelbaseField"),
                )
            }
            wheelbaseAsk?.let { ask ->
                GeometryAsk(
                    "The catalog says $ask mm for the wheelbase; you have $wheelbase mm.",
                    onUse = { wheelbase = ask.toString(); wheelbaseAsk = null },
                    onKeep = { wheelbaseAsk = null },
                )
            }
            TEField("Steering ratio (optional)") {
                OutlinedTextField(
                    value = steering,
                    onValueChange = { steering = it },
                    placeholder = { Text("e.g. 16.25 for 16.25:1", style = TrackTheme.typography.sm) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth().testTag("steeringRatioField"),
                )
            }
            steeringAsk?.let { ask ->
                GeometryAsk(
                    "The catalog says ${fmtRatio(ask)}:1 for the steering ratio; you have $steering:1.",
                    onUse = { steering = fmtRatio(ask); steeringAsk = null },
                    onKeep = { steeringAsk = null },
                )
            }
            // The measured steering ratio (#223): the car's recent sessions' fits
            // pooled against the wheelbase *in the form*, so the line follows both
            // fields as they are typed. With the field empty it offers the number;
            // with a number in it, it is the typo check. "Use this" writes the
            // field, never the row — the driver still saves.
            val measured = Balance.estimateSteeringRatio(steeringFits?.map { it.fit }, wheelbase.trim().toIntOrNull())
            val typedRatio = steering.trim().replace(',', '.').toDoubleOrNull()
            if (measured != null) {
                Balance.measuredRatioLine(measured, typedRatio)?.let { line ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            line,
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                            modifier = Modifier.testTag("measuredRatio"),
                        )
                        if (!Balance.ratioAgrees(measured, typedRatio)) {
                            TextButton(
                                onClick = { steering = Balance.fmtSteeringRatio(Balance.measuredRatioValue(measured)) },
                                modifier = Modifier.testTag("useMeasuredRatio"),
                            ) {
                                Text("Use this", style = TrackTheme.typography.xs, color = colors.accentInk)
                            }
                        }
                    }
                }
            }
            // Where the numbers came from, so the driver knows what they are trusting.
            pick?.let {
                Text(
                    it.source,
                    style = TrackTheme.typography.xxs,
                    color = colors.textFaint,
                    modifier = Modifier.testTag("catalogSource"),
                )
            }
            Text(
                "Both are on the spec sheet or in the owner's manual. They let the balance read-out say " +
                    "how much understeer, rather than only which corner differs from the rest — leave " +
                    "them blank and it keeps the relative reading.",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
            )

            error?.let { TEErrorBanner(it) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(
                    onClick = {
                        val raw = psi.trim().replace(',', '.')
                        val value = if (raw.isEmpty()) null else raw.toDoubleOrNull()
                        // The same ranges `src/lib/validate.ts` enforces, so a
                        // slip is caught here with a sentence rather than there
                        // with a 400.
                        val rawWheelbase = wheelbase.trim()
                        val wheelbaseMm = rawWheelbase.toIntOrNull()
                        val rawSteering = steering.trim().replace(',', '.')
                        val steeringRatio = rawSteering.toDoubleOrNull()
                        if (raw.isNotEmpty() && (value == null || value < 5 || value > 100)) {
                            error = "Target pressure should be between 5 and 100 psi."
                        } else if (rawWheelbase.isNotEmpty() && (wheelbaseMm == null || wheelbaseMm < 1500 || wheelbaseMm > 4500)) {
                            error = "Wheelbase should be between 1500 and 4500 mm."
                        } else if (rawSteering.isNotEmpty() && (steeringRatio == null || steeringRatio < 5 || steeringRatio > 30)) {
                            error = "Steering ratio should be between 5 and 30 — 16.25 for 16.25:1."
                        } else {
                            error = null
                            onSave(VehicleEdit(name, notes, value, isDefault, pickId, wheelbaseMm, steeringRatio))
                        }
                    },
                    enabled = name.isNotBlank(),
                ) {
                    Text("Save", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
                }
                TextButton(onClick = onCancel) {
                    Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
                }
            }
        }
    }
}

/**
 * A per-field question under the number it is about — inline rather than in a
 * dialog, because the answer belongs next to the field, and it is one of two.
 */
@Composable
private fun GeometryAsk(text: String, onUse: () -> Unit, onKeep: () -> Unit) {
    val colors = TrackTheme.colors
    Column {
        Text(text, style = TrackTheme.typography.xs, color = colors.textMuted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onUse) {
                Text("Use the catalog's", style = TrackTheme.typography.xs, color = colors.accentInk)
            }
            TextButton(onClick = onKeep) {
                Text("Keep mine", style = TrackTheme.typography.xs, color = colors.textMuted)
            }
        }
    }
}
