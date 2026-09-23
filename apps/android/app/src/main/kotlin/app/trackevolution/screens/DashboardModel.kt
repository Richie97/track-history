package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.EventDates
import app.trackevolution.core.WrappedStory
import app.trackevolution.core.Garage
import app.trackevolution.core.RemoteRecording
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Totals
import app.trackevolution.core.model.Track
import app.trackevolution.core.label
import app.trackevolution.navigation.GarageBadge
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

            // The garage is fetched only for the hero's due-part line now that it
            // has its own tab (NS-37), and its failure is swallowed on purpose: a
            // 402 for a free account, or no network, must not cost the logbook.
            garage = runCatching { api.garage() }.getOrNull()?.also { GarageBadge.note(it) }.orEmpty()

            // Warm every event's detail so an event never opened still reads in
            // the paddock. A warm-up, not a load — failures are ignored.
            runCatching { api.warmCache(events) }
        }
    }

    /**
     * The next event's car, when something on it needs attention first (NS-37)
     * — the one thing the dashboard still says about the garage. Pro only by
     * construction: [garage] is empty for a free account. The web's
     * `heroGarageHtml`, over `Garage.garageAlerts` for that one car.
     */
    val heroGarage: HeroGarage?
        get() {
            val vehicleId = heroEvent?.vehicleId ?: return null
            val vehicle = garage.firstOrNull { it.id == vehicleId } ?: return null
            val alerts = Garage.garageAlerts(listOf(vehicle))
            val first = alerts.firstOrNull() ?: return null
            return HeroGarage(vehicleId = vehicle.id, line = heroGarageLine(first, alerts.size - 1))
        }

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

    /**
     * The event a recording started from the dashboard attaches to, or null to
     * record unattached (#108).
     *
     * Deliberately [RemoteRecording.pickRecordingEvent] — the *same* rule the
     * event page's door and Android Auto use, and the one iOS's `todaysEvent`
     * calls, so no two ways into the recorder can disagree about where the laps
     * belong. It reads the already-loaded [events], so the button costs no
     * request and works offline.
     *
     * Null is a normal outcome rather than a failure: the event often doesn't
     * exist until after the session is driven, and the scaffold's banner then
     * offers the recording to the first event whose record screen opens it.
     */
    val todaysEvent: Event?
        get() = RemoteRecording.pickRecordingEvent(events, RemoteRecording.localTodayIso())

    /**
     * The season the November banner promotes, when this driver drove in it —
     * [WrappedStory.wrappedSeason] (`:core`'s port of the web's reveal window)
     * over the local day, and null for a year with no past event.
     */
    val wrappedYear: Int?
        get() {
            val year = WrappedStory.wrappedSeason(java.time.LocalDate.now()) ?: return null
            return year.takeIf { y -> events.any { !EventDates.isUpcoming(it.startDate) && it.startDate.startsWith("$y-") } }
        }

    /**
     * Seasons whose banner was dismissed. A per-viewer convenience, like the
     * web's localStorage flag — kept for the process, which is the lifetime of
     * the question "did I already say no to this", and persisted through
     * [dismissStore] when there is one.
     */
    private var dismissed by mutableStateOf(emptySet<Int>())

    /** Where dismissals persist; the activity supplies SharedPreferences, tests leave it null. */
    var dismissStore: WrappedDismissStore? = null

    fun wrappedDismissed(year: Int): Boolean = year in dismissed || dismissStore?.isDismissed(year) == true

    fun dismissWrapped(year: Int) {
        dismissed = dismissed + year
        dismissStore?.dismiss(year)
    }
}

/** The hero card's due-part line and the car it opens. */
data class HeroGarage(val vehicleId: Int, val line: String)

/** "Front pads due on the C8 · +1 more" — `heroGarageHtml`'s words, minus the arrow. */
internal fun heroGarageLine(first: Garage.Alert, more: Int): String =
    "${first.part.kind.label} ${if (first.status == Garage.PartStatus.DUE) "due" else "due soon"} " +
        "on the ${first.vehicle.name}${if (more > 0) " · +$more more" else ""}"

/** Remembers which seasons' Wrapped banner the driver dismissed. */
interface WrappedDismissStore {
    fun isDismissed(year: Int): Boolean
    fun dismiss(year: Int)
}
