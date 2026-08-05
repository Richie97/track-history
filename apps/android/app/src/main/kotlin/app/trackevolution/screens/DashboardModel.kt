package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Totals
import app.trackevolution.core.model.Track
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * The dashboard's data (NS-26).
 *
 * One model per screen, owning its fetches and its derived lists, so the
 * composable stays layout. Everything goes through [ApiClient], which **is** the
 * offline layer (NS-22) — there is deliberately no second path to the server, so
 * there is no separate offline behaviour to forget to test.
 */
class DashboardModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var totals by mutableStateOf(Totals(events = 0, trackDays = 0))
        private set

    var tracks by mutableStateOf<List<Track>>(emptyList())
        private set

    var events by mutableStateOf<List<Event>>(emptyList())
        private set

    var garage by mutableStateOf<List<GarageVehicle>>(emptyList())
        private set

    fun load() {
        scope.launch {
            try {
                val me = async { api.me() }
                val trackList = async { api.tracks() }
                val eventList = async { api.events() }

                totals = me.await().totals
                tracks = trackList.await()
                events = eventList.await()
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "Couldn't load your logbook.")
                return@launch
            }

            // The garage is fetched separately and its failure is swallowed on
            // purpose (NS-31): it is a section, not the screen, and an empty or
            // failing garage must not cost the user their logbook.
            garage = runCatching { api.garage() }.getOrDefault(emptyList())

            // Warm every event's detail so an event never opened still reads in
            // the paddock. A warm-up, not a load — failures are ignored.
            runCatching { api.warmCache(events) }
        }
    }

    /**
     * The maintenance reminders across every car (NS-31). Derived, not fetched:
     * `Garage.garageAlerts` is the port of the web app's own rule, so the strip
     * on the dashboard and the panel on a vehicle page can never disagree.
     */
    val alerts: List<Garage.Alert>
        get() = Garage.garageAlerts(garage)

    /** Tracks worth listing: one with no events has nothing to show yet. */
    val tracksWithData: List<Track>
        get() = tracks.filter { it.eventCount > 0 }.sortedByDescending { it.lastDate ?: "" }

    val upcoming: List<Event>
        get() = events.filter { EventDates.isUpcoming(it.startDate) }.sortedBy { it.startDate }

    /** The nearest upcoming event, which the hero card is about. */
    val heroEvent: Event?
        get() = upcoming.firstOrNull()

    val alsoUpcoming: List<Event>
        get() = upcoming.drop(1)

    /** The server returns newest first; six is what fits before it stops being a summary. */
    val recent: List<Event>
        get() = events.filterNot { EventDates.isUpcoming(it.startDate) }.take(6)
}
