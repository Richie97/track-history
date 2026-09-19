package app.trackevolution.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.trackevolution.core.Garage
import app.trackevolution.core.model.CatalogCar
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * The car-catalog picker (#222): one searchable list over `GET /api/car-catalog`,
 * opened from the two vehicle forms. One field rather than year → make → model
 * dropdowns, because a driver can type "c7" in two keystrokes and a dealer-site
 * cascade is four taps to the same row.
 *
 * Ranking is `:core`'s [Garage.matchCatalogCars], pinned against the web by
 * `contracts/logic/car-catalog-match.json`, so "c7" finds the same row here as
 * it does in the browser. The catalog is a cached GET, so the search works
 * offline; it is the *save* that needs a connection, as every garage write does.
 *
 * [rows] is null while the caller is still fetching, and [error] carries the
 * server's own message when it could not.
 */
@Composable
fun CatalogCarPicker(
    rows: List<CatalogCar>?,
    error: String?,
    onPick: (CatalogCar) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    var query by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        TrackCard(Modifier.fillMaxWidth().padding(16.dp).testTag("catalogPicker")) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Find your car", style = type.h3, color = colors.textStrong)
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Corvette C7, MX-5 ND, 718 Cayman…", style = type.sm) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("catalogSearch"),
                )
                Text(
                    "Picking a car fills in the wheelbase and steering ratio the balance read-out " +
                        "uses — nothing else changes.",
                    style = type.xxs,
                    color = colors.textFaint,
                )
                when {
                    error != null -> TEErrorBanner(error)
                    rows == null -> Text("Loading the catalog…", style = type.sm, color = colors.textMuted)
                    else -> {
                        val matches = Garage.matchCatalogCars(query, rows)
                        if (matches.isEmpty()) {
                            TEEmpty("No car in the catalog matches that — close this and type the numbers in yourself.")
                        } else {
                            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
                                items(matches, key = { it.id }) { car ->
                                    Column(
                                        Modifier
                                            .fillMaxWidth()
                                            .clickable { onPick(car) }
                                            .padding(vertical = 8.dp)
                                            .testTag("catalogRow"),
                                    ) {
                                        Text(Garage.catalogCarLabel(car), style = type.body, color = colors.textStrong)
                                        Text(geometryLine(car), style = type.xs, color = colors.textMuted)
                                    }
                                }
                            }
                        }
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text("Cancel", style = type.sm, color = colors.textMuted)
                }
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

/**
 * "2710 mm · 16.25:1", or "2475 mm · no single steering ratio" for a
 * variable-ratio rack — what a pick would fill in, so the driver sees the
 * numbers before trusting them.
 */
internal fun geometryLine(car: CatalogCar): String {
    val ratio = car.steeringRatio?.let { "${fmtRatio(it)}:1" } ?: "no single steering ratio"
    return "${car.wheelbaseMm} mm · $ratio"
}

/** 16.0 reads as "16"; 16.25 stays "16.25" — what a driver would have typed. */
internal fun fmtRatio(value: Double): String =
    if (value % 1.0 == 0.0) value.toInt().toString() else value.toString()
