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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.LapTime
import app.trackevolution.core.Profile
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.model.DriverProfile
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.ProfileResponse
import app.trackevolution.core.model.Track
import app.trackevolution.core.model.Vehicle
import app.trackevolution.navigation.rememberScreenModel
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalLogbookOwner
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TENavCard
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.studentFreeNote
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

// ---- Who, and whether this account may still read them (NS-38) -------------

/**
 * Resolves a student for their coach: their `/me/profile` under the coach
 * mount, which is the one read that says their name and **tier**, and the first
 * that 404s once the grant is gone — revoked by the student, or left by the
 * coach on another device.
 *
 * A 404 is not an error to retry but an answer: everything this device kept of
 * the student's logbook is purged ([ApiClient.forgetStudent]) before the page
 * says so, because a coach who has lost access must not go on reading it out
 * of the cache when the network is gone. Offline, the read falls back to the
 * cached profile like any other, so a coach can prepare in the paddock.
 */
class StudentGateModel(
    private val scope: CoroutineScope,
    /** The coach's own client — the gate makes the student's view from it. */
    private val api: ApiClient,
    val studentId: Int,
) {
    sealed interface Status {
        data object Loading : Status
        data class Ready(val owner: LogbookOwner.Student, val profile: ProfileResponse) : Status

        /** The grant is gone, and so is what this device had kept. */
        data object Gone : Status
        data class Failed(val message: String) : Status
    }

    var status by mutableStateOf<Status>(Status.Loading)
        private set

    fun load() {
        scope.launch {
            try {
                val profile = api.forOwner(LogbookOwner.Student(studentId, null, false)).profile()
                status = Status.Ready(LogbookOwner.Student(studentId, profile.name, profile.pro), profile)
            } catch (e: ApiException) {
                when {
                    e.isNotFound -> {
                        api.forgetStudent(studentId)
                        status = Status.Gone
                    }
                    status !is Status.Ready -> status = Status.Failed(e.message)
                }
            }
        }
    }
}

/**
 * Whose logbook the [content] reads: the account's own when [studentId] is
 * null — straight through, no request — or a student's, resolved first by a
 * [StudentGateModel] and then handed down as the owner and a client scoped to
 * them (`api.forOwner`), under a banner that says whose logbook it is.
 *
 * This is the one seam every reused owner screen goes through: the event,
 * lap, session-compare, track, two-lap compare and car pages take the client,
 * the read-only flag and the tier from here rather than knowing about
 * coaching.
 */
@Composable
fun LogbookOwnerScope(
    api: ApiClient,
    studentId: Int?,
    onOpenStudentHome: (Int) -> Unit,
    onGone: () -> Unit,
    content: @Composable (owner: LogbookOwner, api: ApiClient) -> Unit,
) {
    if (studentId == null) {
        content(LogbookOwner.Me, api)
        return
    }
    // Keyed: the screen's own model lives in the same back stack entry, and
    // both erase to `ScreenModelHolder`.
    val gate = rememberScreenModel(key = "student-gate-$studentId") { scope, _ ->
        StudentGateModel(scope, api, studentId)
    }
    LaunchedEffect(studentId) { if (gate.status !is StudentGateModel.Status.Ready) gate.load() }

    when (val status = gate.status) {
        StudentGateModel.Status.Loading -> TELoadable(LoadState.Loading, onRetry = gate::load) {}
        is StudentGateModel.Status.Failed -> TELoadable(LoadState.Failed(status.message), onRetry = gate::load) {}
        StudentGateModel.Status.Gone -> NotSharedWithYou(onGone)
        is StudentGateModel.Status.Ready -> Column(Modifier.fillMaxSize()) {
            StudentBanner(status.owner, onClick = { onOpenStudentHome(studentId) })
            Box(Modifier.weight(1f)) {
                CompositionLocalProvider(LocalLogbookOwner provides status.owner) {
                    content(status.owner, remember(status.owner) { api.forOwner(status.owner) })
                }
            }
        }
    }
}

/** The student's `/me/profile` once the gate has it, for the student home. */
@Composable
fun rememberStudentProfile(api: ApiClient, studentId: Int): ProfileResponse? {
    val gate = rememberScreenModel(key = "student-gate-$studentId") { scope, _ ->
        StudentGateModel(scope, api, studentId)
    }
    return (gate.status as? StudentGateModel.Status.Ready)?.profile
}

/** "You're viewing Alex's logbook · read-only", on every page of it. */
@Composable
private fun StudentBanner(owner: LogbookOwner.Student, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    val who = owner.name ?: "a driver"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.accentTint)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag("studentBanner")
            .semantics { contentDescription = "Viewing $who's logbook, read-only. Opens their logbook." },
    ) {
        Text(
            "You're viewing $who's logbook · read-only",
            style = TrackTheme.typography.sm,
            color = colors.accentInk,
        )
    }
}

@Composable
private fun NotSharedWithYou(onGone: () -> Unit) {
    val colors = TrackTheme.colors
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp).testTag("studentGone"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Not shared with you", style = TrackTheme.typography.h2, color = colors.textStrong)
        Text(
            "This logbook isn't shared with you — the driver may have stopped sharing it, or you left. " +
                "Anything this device had kept of it has been cleared.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
        )
        Button(
            onClick = onGone,
            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
        ) { Text("Go to Coaching", style = TrackTheme.typography.bodyStrong) }
    }
}

// ---- The driver profile as a coach reads it --------------------------------

/**
 * The profile as labelled lines, grouped — `Profile.profileSections`, so a
 * half-filled profile reads as what it says. [empty] when nothing is filled in.
 */
@Composable
fun ProfileCard(profile: DriverProfile?, empty: String, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val sections = remember(profile) { Profile.profileSections(profile) }
    TrackCard(modifier.fillMaxWidth().testTag("profileCard")) {
        if (sections.isEmpty()) {
            Text(empty, style = TrackTheme.typography.sm, color = colors.textMuted)
            return@TrackCard
        }
        sections.forEachIndexed { index, section ->
            Text(
                section.title,
                style = TrackTheme.typography.bodyStrong,
                color = colors.textStrong,
                modifier = Modifier.padding(top = if (index == 0) 0.dp else 10.dp, bottom = 2.dp),
            )
            section.rows.forEach { row ->
                Column(Modifier.padding(vertical = 2.dp)) {
                    Text(row.label, style = TrackTheme.typography.xxs, color = colors.textFaint)
                    Text(row.value, style = TrackTheme.typography.sm, color = colors.textBody)
                }
            }
        }
    }
}

// ---- The student's dashboard ------------------------------------------------

/**
 * A student's logbook at a glance, for their coach (NS-38) — `viewStudentHome`
 * in `public/app.js`: their profile, the counts, what is coming up, the latest
 * days out (where a coach usually starts), their tracks and their cars. A small
 * dedicated screen rather than the owner's dashboard, whose every line carries
 * a garage, share or recorder control.
 */
class StudentHomeModel(
    private val scope: CoroutineScope,
    /** Already scoped to the student. */
    private val api: ApiClient,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set
    var tracks by mutableStateOf<List<Track>>(emptyList())
        private set
    var events by mutableStateOf<List<Event>>(emptyList())
        private set
    var vehicles by mutableStateOf<List<Vehicle>>(emptyList())
        private set

    fun load() {
        scope.launch {
            try {
                val t = async { api.tracks() }
                val e = async { api.events() }
                // A car list that fails costs the cars section, not the page.
                val v = async { runCatching { api.vehicles() }.getOrDefault(emptyList()) }
                tracks = t.await()
                events = e.await()
                vehicles = v.await()
                state = LoadState.Ready
            } catch (err: ApiException) {
                if (state != LoadState.Ready) state = LoadState.Failed(err.message)
            }
        }
    }

    val past: List<Event> get() = events.filter { !EventDates.isUpcoming(it.startDate) }
    val upcoming: List<Event>
        get() = events.filter { EventDates.isUpcoming(it.startDate) }.sortedBy { it.startDate }
    val tracksWithData: List<Track>
        get() = tracks.filter { it.eventCount > 0 }.sortedByDescending { it.lastDate.orEmpty() }
}

@Composable
fun StudentHomeScreen(
    model: StudentHomeModel,
    profile: ProfileResponse?,
    onOpenEvent: (Int) -> Unit,
    onOpenTrack: (Int) -> Unit,
    onOpenVehicle: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val who = profile?.name ?: "This driver"
    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val past = model.past
        val tracks = model.tracksWithData
        val today = EventDates.todayIso()
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("studentHome"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Text(who, style = TrackTheme.typography.h1, color = colors.textStrong)
                    if (profile != null && !profile.pro) {
                        Text(
                            studentFreeNote(profile.name),
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
            item("tiles") {
                TEStatRow(
                    listOf(
                        "Events" to past.size.toString(),
                        "Track days" to fmtTrackDays(past.sumOf { it.days }),
                        "Tracks" to tracks.size.toString(),
                    ),
                )
            }
            item("profile-header") { TESectionHeader("Driver profile") }
            item("profile") {
                ProfileCard(profile?.profile, empty = "$who hasn't filled in a driver profile yet.")
            }
            if (model.upcoming.isNotEmpty()) {
                item("upcoming-header") { TESectionHeader("Upcoming") }
                items(model.upcoming, key = { "up-${it.id}" }) { event ->
                    TENavCard(onClick = { onOpenEvent(event.id) }) {
                        Text(event.trackName, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                        Text(EventDates.fmtCountdown(event.startDate), style = TrackTheme.typography.sm, color = colors.accentInk)
                        TEMeta(listOf(EventDates.fmtDate(event.startDate), event.club, event.runGroup))
                    }
                }
            }
            item("latest-header") { TESectionHeader("Latest events") }
            if (past.isEmpty()) {
                item("latest-empty") { TEEmpty("No track days logged yet.") }
            } else {
                items(past.take(8), key = { "ev-${it.id}" }) { event ->
                    TENavCard(onClick = { onOpenEvent(event.id) }) {
                        Row(Modifier.fillMaxWidth()) {
                            Column(Modifier.weight(1f)) {
                                Text(event.trackName, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                                TEMeta(listOf(EventDates.fmtDate(event.startDate), event.runGroup, event.car))
                            }
                            Column {
                                Text(LapTime.fmtMs(event.bestMs), style = TrackTheme.typography.lapTime, color = colors.textStrong)
                                Text(fmtCount(event.lapCount, "lap"), style = TrackTheme.typography.xxs, color = colors.textFaint)
                            }
                        }
                    }
                }
            }
            item("tracks-header") { TESectionHeader("Tracks") }
            if (tracks.isEmpty()) {
                item("tracks-empty") { TEEmpty("No tracks yet.") }
            } else {
                items(tracks, key = { "tr-${it.id}" }) { track ->
                    TENavCard(onClick = { onOpenTrack(track.id) }) {
                        Text(track.name, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                        Text(LapTime.fmtMs(track.bestMs), style = TrackTheme.typography.lapTime, color = colors.textStrong)
                        TEMeta(
                            listOf(
                                fmtCount(track.eventCount, "event"),
                                fmtCount(track.trackDays, "day"),
                                EventDates.fmtDate(track.lastDate),
                            ),
                        )
                    }
                }
            }
            if (model.vehicles.isNotEmpty()) {
                item("cars-header") { TESectionHeader("Cars") }
                items(model.vehicles, key = { "car-${it.id}" }) { vehicle ->
                    TENavCard(onClick = { onOpenVehicle(vehicle.id) }, modifier = Modifier.testTag("studentCar-${vehicle.id}")) {
                        Text(vehicle.name, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                        Text(
                            Garage.vehicleTileLine(Garage.vehicleLogbook(vehicle.id, model.events, today)),
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                        )
                    }
                }
            }
        }
    }
}

/** "2", "1.5" — a track-day count the way the web prints it. */
private fun fmtTrackDays(days: Double): String =
    if (days == Math.rint(days)) days.toLong().toString() else days.toString()
