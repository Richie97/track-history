package app.trackevolution.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import app.trackevolution.core.api.ApiClient
import app.trackevolution.screens.GarageModel
import app.trackevolution.screens.GarageScreen

/**
 * The Garage tab's list, wherever it is being shown (NS-37) — [DashboardPane]'s
 * counterpart, for the same reason: below expanded width it is the Garage
 * graph's start destination, and at expanded width it is the list pane beside
 * the detail, with one set of callbacks for both.
 *
 * From the list pane, opening a car **replaces** the detail (`popUpTo` the
 * Garage root) rather than deepening it, and the selected tile is marked.
 */
@Composable
fun GaragePane(
    nav: NavHostController,
    api: ApiClient,
    selection: Route?,
    inListPane: Boolean,
    onRequirePro: () -> Unit,
) {
    // Keyed for the same reason the dashboard pane is: the list pane's owner is
    // the activity, and an unkeyed model would be shared with the destination's.
    val model = rememberScreenModel(key = if (inListPane) "listPaneGarage" else null) { scope, _ ->
        GarageModel(scope, api)
    }
    // The list pane outlives every destination beside it, so it refreshes when
    // the detail moves on — a car deleted or renamed there shows here.
    if (inListPane) LaunchedEffect(selection) { model.load() }
    val open: (Int) -> Unit = { id ->
        if (inListPane) {
            nav.navigate(Route.Vehicle(id)) { popUpTo(Route.Garage) { inclusive = false } }
        } else {
            nav.navigate(Route.Vehicle(id))
        }
    }
    GarageScreen(
        model = model,
        onOpenVehicle = open,
        onCreated = open,
        onSubscribe = onRequirePro,
        selection = if (inListPane) selection else null,
    )
}
