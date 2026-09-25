package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Garage
import app.trackevolution.core.label
import app.trackevolution.core.model.Vehicle
import app.trackevolution.navigation.Route
import app.trackevolution.ui.CARD_GRID_MINIMUM
import app.trackevolution.ui.CatalogCarPicker
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TENavCard
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.cardGridItems
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * What a free account is shown in place of the garage's Pro half, here and on a
 * car's page — the web's `GARAGE_PRO_WHAT`, word for word.
 */
internal const val GARAGE_PRO_WHAT =
    "Pads, tires, rotors and fluid, each with the hours it has actually done — accrued from " +
        "your own track days — a wear projection from your measurements, reminders before the next " +
        "event, and what the car has cost you: its parts and its track days. Your cars and what " +
        "they've done stay free."

/** One cell of the garage grid: a car, or the **+ Add car** tile that ends it. */
private sealed interface GarageTile {
    data class Car(val vehicle: Vehicle) : GarageTile
    data object Add : GarageTile
}

/**
 * The Garage tab's root (NS-37): the maintenance strip for Pro, a tile per car,
 * and **+ Add car** — `viewGarage` in `public/app.js` is the reference, wording
 * included. Every account gets the tiles and the add tile; the Pro half renders
 * locked for a free one rather than being absent.
 */
@Composable
fun GarageScreen(
    model: GarageModel,
    onOpenVehicle: (Int) -> Unit,
    /** Where a new car goes next: its own page, as on the web. */
    onCreated: (Int) -> Unit,
    onSubscribe: () -> Unit,
    /** The car the detail pane is showing, when this is a list pane (NS-34). */
    selection: Route? = null,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val columns = LocalLayoutMetrics.current.columns(CARD_GRID_MINIMUM)
    val sync by model.syncStatus.collectAsState()
    // Saveable, so a rotation or a fold does not close the form under the driver.
    var addOpen by rememberSaveable { mutableStateOf(false) }

    // Every visit, not just the first: a car added, renamed or deleted from its
    // page must show here on the way back. The model keeps what it had while it
    // refreshes, so this never flashes a spinner over the tiles.
    LaunchedEffect(Unit) { model.load() }

    Column(modifier = modifier) {
        Text(
            "Garage",
            style = TrackTheme.typography.h1,
            color = colors.textStrong,
            modifier = Modifier
                .padding(start = 16.dp, end = 16.dp, top = 12.dp)
                .semantics { heading() },
        )
        TELoadable(state = model.state, onRetry = model::load, modifier = Modifier.weight(1f)) {
            val tiles = model.vehicles.map { GarageTile.Car(it) } + GarageTile.Add
            val listState = rememberLazyListState()
            // Opening the form brings it into view: it sits under the grid, which
            // on a phone with a few cars is below the fold.
            val formIndex = (if (model.alerts.isNotEmpty()) 1 else 0) + tiles.chunked(maxOf(1, columns)).size
            LaunchedEffect(addOpen) { if (addOpen) listState.animateScrollToItem(formIndex) }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                if (model.alerts.isNotEmpty()) {
                    item("maintenance") { MaintenanceStrip(model.alerts, onOpenVehicle) }
                }

                cardGridItems(
                    tiles,
                    columns,
                    key = { if (it is GarageTile.Car) "car-${it.vehicle.id}" else "add" },
                ) { tile ->
                    when (tile) {
                        is GarageTile.Car -> CarTile(
                            vehicle = tile.vehicle,
                            model = model,
                            selected = selection == Route.Vehicle(tile.vehicle.id),
                            onClick = { onOpenVehicle(tile.vehicle.id) },
                        )
                        GarageTile.Add -> AddCarTile(
                            offline = sync.offline,
                            firstCar = model.vehicles.isEmpty(),
                            onClick = { addOpen = true },
                        )
                    }
                }

                // The add form opens under the grid, as on the web (`#veh-add`),
                // rather than in a dialog: it is a form with a picker of its own,
                // and a dialog over a dialog is the wrong shape for that.
                if (addOpen) {
                    item("add-form") {
                        AddCarForm(
                            model = model,
                            firstCar = model.vehicles.isEmpty(),
                            onCancel = { addOpen = false; model.dismissAddError() },
                            onAdd = { name, notes, isDefault, catalogId ->
                                model.addVehicle(name, notes, isDefault, catalogId) { id ->
                                    addOpen = false
                                    onCreated(id)
                                }
                            },
                        )
                    }
                }

                if (model.proLocked) {
                    item("pro-header") { TESectionHeader("Maintenance and costs") }
                    item("pro-locked") {
                        TEProLocked(
                            title = "Maintenance and costs",
                            blurb = GARAGE_PRO_WHAT,
                            onSubscribe = onSubscribe,
                        )
                    }
                }
            }
        }
    }
}

/**
 * A car: its name, the Default marker, the catalog row it was picked from, the
 * logbook's one line — and for Pro its hours and how its consumables are doing.
 */
@Composable
private fun CarTile(vehicle: Vehicle, model: GarageModel, selected: Boolean, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    val pro = model.garageFor(vehicle.id)
    TENavCard(onClick = onClick, selected = selected, modifier = Modifier.testTag("carTile-${vehicle.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                vehicle.name,
                style = TrackTheme.typography.bodyStrong,
                color = colors.textStrong,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (vehicle.isDefault) {
                Text(
                    "Default",
                    style = TrackTheme.typography.xxs,
                    color = colors.accentInk,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        model.catalogRow(vehicle)?.let {
            Text(Garage.catalogCarLabel(it), style = TrackTheme.typography.xs, color = colors.textMuted)
        }
        Text(
            Garage.vehicleTileLine(model.logbook(vehicle.id)),
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )
        if (pro != null) {
            val alerts = Garage.garageAlerts(listOf(pro))
            val active = pro.parts.count(Garage::isOnCar)
            Text(
                "${Garage.fmtHours(pro.hours)} on track",
                style = TrackTheme.typography.xs,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 4.dp),
            )
            val worst = alerts.firstOrNull()?.status
            Text(
                when {
                    alerts.isNotEmpty() -> "● ${fmtCount(alerts.size, "item")} due soon"
                    active > 0 -> "● consumables OK"
                    else -> "no consumables tracked yet"
                },
                style = TrackTheme.typography.xs,
                color = when (worst) {
                    Garage.PartStatus.DUE -> colors.danger
                    Garage.PartStatus.LOW -> colors.heat
                    else -> if (active > 0) colors.positive else colors.textFaint
                },
            )
        }
    }
}

/**
 * The last tile. Vehicle writes need a live server, so offline it says so and
 * stands down rather than failing on submit.
 */
@Composable
private fun AddCarTile(offline: Boolean, firstCar: Boolean, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(
        Modifier
            .fillMaxWidth()
            .then(if (offline) Modifier else Modifier.clickable(onClick = onClick))
            .testTag("addCar")
            .semantics {
                contentDescription = if (offline) "Add car. Adding a car needs a connection" else "Add car"
                if (offline) disabled()
            },
        border = colors.borderStrong,
    ) {
        Text("+", style = TrackTheme.typography.h2, color = if (offline) colors.textFaint else colors.accentInk)
        Text(
            "Add car",
            style = TrackTheme.typography.bodyStrong,
            color = if (offline) colors.textMuted else colors.textStrong,
        )
        Text(
            when {
                offline -> "Adding a car needs a connection"
                firstCar -> "Add the car you drive — new events fill it in, and its page keeps what it has done"
                else -> "Pick it from the catalog or type it in"
            },
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )
    }
}

/**
 * The add form — moved here from Settings, with the catalog pick (#222) inline.
 * The pick names the car only when the driver hasn't: a car already called
 * "Betty" keeps its name.
 */
@Composable
private fun AddCarForm(
    model: GarageModel,
    firstCar: Boolean,
    onCancel: () -> Unit,
    onAdd: (name: String, notes: String, isDefault: Boolean, catalogId: Int?) -> Unit,
) {
    val colors = TrackTheme.colors
    var name by rememberSaveable { mutableStateOf("") }
    var notes by rememberSaveable { mutableStateOf("") }
    var isDefault by rememberSaveable { mutableStateOf(firstCar) }
    var pickId by rememberSaveable { mutableStateOf<Int?>(null) }
    var picking by rememberSaveable { mutableStateOf(false) }
    val pick = pickId?.let { id -> model.catalog?.firstOrNull { it.id == id } }

    if (picking) {
        LaunchedEffect(Unit) { model.loadCatalog() }
        CatalogCarPicker(
            rows = model.catalog,
            error = model.catalogError,
            onPick = { row ->
                pickId = row.id
                if (name.isBlank()) name = Garage.catalogCarName(row)
                picking = false
            },
            onDismiss = { picking = false },
        )
    }

    TrackCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Add car", style = TrackTheme.typography.h3, color = colors.textStrong)
                TEField("Car") {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        placeholder = { Text("2023 Corvette Z06", style = TrackTheme.typography.sm) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("addCarName"),
                    )
                }
                TEField(
                    "Find it in the catalog (optional)",
                    hint = "Fills in the wheelbase and steering ratio the balance read-out uses",
                ) {
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
                        TextButton(onClick = { pickId = null }, modifier = Modifier.testTag("clearCatalogCar")) {
                            Text("Clear", style = TrackTheme.typography.xs, color = colors.textMuted)
                        }
                    }
                }
                TEField("Modifications & notes") {
                    OutlinedTextField(
                        value = notes,
                        onValueChange = { notes = it },
                        placeholder = { Text("Coilovers, pads, tires, alignment…", style = TrackTheme.typography.sm) },
                        minLines = 2,
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
                TEErrorBanner(model.addError)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(
                        onClick = { onAdd(name, notes, isDefault, pickId) },
                        enabled = name.isNotBlank() && !model.adding,
                        modifier = Modifier.testTag("addCarSubmit"),
                    ) {
                        Text("Add car", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
                    }
                    TextButton(onClick = onCancel) {
                        Text("Cancel", style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                }
            }
    }
}

/**
 * The maintenance reminders, collapsed to a count until tapped — moved here from
 * the dashboard (NS-37), which no longer carries the garage.
 *
 * A `Column` that expands rather than a Material `ExposedDropdown` or an
 * `AlertDialog`: the web app's `<details>` behaves this way, and a reminder you
 * have to dismiss is one you learn to dismiss without reading.
 */
@Composable
private fun MaintenanceStrip(alerts: List<Garage.Alert>, onOpenVehicle: (Int) -> Unit) {
    val colors = TrackTheme.colors
    var expanded by rememberSaveable { mutableStateOf(false) }
    val due = alerts.count { it.status == Garage.PartStatus.DUE }

    TrackCard(
        modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
        border = if (due > 0) colors.danger else colors.borderHairline,
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                fmtCount(alerts.size, "maintenance reminder"),
                style = TrackTheme.typography.bodyStrong,
                color = if (due > 0) colors.danger else colors.textStrong,
                modifier = Modifier.weight(1f),
            )
            Text(if (expanded) "▾" else "▸", style = TrackTheme.typography.sm, color = colors.textFaint)
        }
        if (expanded) {
            alerts.forEach { alert ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenVehicle(alert.vehicle.id) }
                        .padding(top = 8.dp),
                ) {
                    Text(
                        "${alert.part.kind.label} — " +
                            if (alert.status == Garage.PartStatus.DUE) {
                                "replace now"
                            } else {
                                Garage.fmtRemaining(alert.part.wear).orEmpty()
                            },
                        style = TrackTheme.typography.sm,
                        color = if (alert.status == Garage.PartStatus.DUE) colors.danger else colors.textBody,
                    )
                    Text(alert.vehicle.name, style = TrackTheme.typography.xxs, color = colors.textMuted)
                }
            }
        }
    }
}

/**
 * The Garage tab's detail pane with nothing picked, at expanded width (NS-34):
 * the list is the pane beside it, so the detail must not show it twice.
 */
@Composable
fun GarageDetailPlaceholder(modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Pick a car", style = TrackTheme.typography.h3, color = colors.textStrong)
            Box(Modifier.height(6.dp))
            Text(
                "Its logbook, best laps and — for Pro — its consumables open here.",
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
            )
        }
    }
}
