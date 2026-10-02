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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.CoachInvite
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.ProfileResponse
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.QrCode
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import app.trackevolution.core.Coaching as CoachingText
import app.trackevolution.core.model.Coaching as CoachingData

/**
 * What a coach reads, as the Coaching page promises it before an invite is
 * made — `COACH_SHARES` in `public/app.js`, kept in step with `COACH_ROUTES` in
 * `src/lib/coaching.ts`.
 */
private const val COACH_SHARES =
    "your events, sessions and laps with the full channel panel (as far as your plan includes it), your " +
        "racing lines, the conditions, your cars and their modifications, and your driver profile. Never your " +
        "notes, prep checklists, costs, setup sheets, parts or email — and they can't change anything."

/**
 * Both halves of a grant (NS-38): the students whose logbooks this account
 * reads, and — for a Pro driver — the invite links and the coaches reading
 * theirs, with the driver profile they see. `viewCoaching` in `public/app.js`.
 *
 * **Every write here is live.** None is on the offline queue: an invite link
 * has to come from the server, and ending a grant is not something to replay
 * silently later. Offline, the lists read from the cache and the buttons fail
 * with the transport's message.
 */
class CoachingModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set
    var coaching by mutableStateOf<CoachingData?>(null)
        private set
    var profile by mutableStateOf<ProfileResponse?>(null)
        private set

    /**
     * The invite just made. Its link exists only in the create's answer — the
     * server keeps its hash — so it lives here, shown once, and a lost one is
     * replaced by making another.
     */
    var newInvite by mutableStateOf<CoachInvite?>(null)
        private set
    var creating by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** A create came back 402: the account lapsed since `/me` said Pro. */
    var proRequired by mutableStateOf(false)
        private set

    fun load() {
        scope.launch {
            try {
                val c = async { api.coaching() }
                val p = async { runCatching { api.profile() }.getOrNull() }
                coaching = c.await()
                profile = p.await()
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (coaching == null) state = LoadState.Failed(e.message)
            }
        }
    }

    fun createInvite() {
        if (creating) return
        scope.launch {
            creating = true
            error = null
            try {
                newInvite = api.createCoachInvite()
                load()
            } catch (e: ApiException) {
                if (e.isPaymentRequired) proRequired = true else error = e.message
            } finally {
                creating = false
            }
        }
    }

    fun withdrawInvite(id: Int) = write { api.withdrawCoachInvite(id) }

    fun removeCoach(id: Int) = write { api.removeCoach(id) }

    /**
     * Stop coaching a student — and forget what this device kept of their
     * logbook, as a 404 from their profile would.
     */
    fun leaveStudent(id: Int) = write {
        api.leaveStudent(id)
        api.forgetStudent(id)
    }

    fun dismissError() {
        error = null
    }

    fun acknowledgeProRequired() {
        proRequired = false
    }

    private fun write(block: suspend () -> Unit) {
        scope.launch {
            error = null
            try {
                block()
            } catch (e: ApiException) {
                error = e.message
            }
            load()
        }
    }
}

@Composable
fun CoachingScreen(
    model: CoachingModel,
    /** The viewer's own tier: inviting a coach is Pro, being one is free. */
    entitlement: Entitlement?,
    onOpenStudent: (Int) -> Unit,
    onEditProfile: () -> Unit,
    onShare: (String) -> Unit,
    onRequirePro: () -> Unit,
    modifier: Modifier = Modifier,
    now: () -> Long = System::currentTimeMillis,
) {
    val colors = TrackTheme.colors
    var confirmRemoveCoach by rememberSaveable { mutableStateOf<Int?>(null) }
    var confirmLeaveStudent by rememberSaveable { mutableStateOf<Int?>(null) }
    val canInvite = Entitlement.isPro(entitlement)

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.proRequired) {
        if (model.proRequired) {
            model.acknowledgeProRequired()
            onRequirePro()
        }
    }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val coaching = model.coaching ?: return@TELoadable
        val at = now()
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("coaching"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("title") { Text("Coaching", style = TrackTheme.typography.h1, color = colors.textStrong) }

            model.error?.let { message ->
                item("error") {
                    Column {
                        TEErrorBanner(message)
                        TextButton(onClick = model::dismissError) {
                            Text("Dismiss", style = TrackTheme.typography.xs, color = colors.textMuted)
                        }
                    }
                }
            }

            if (coaching.students.isNotEmpty()) {
                item("students-header") { TESectionHeader("Your students") }
                item("students") {
                    TrackCard(Modifier.fillMaxWidth()) {
                        coaching.students.forEachIndexed { index, student ->
                            if (index > 0) HorizontalDivider(color = colors.borderHairline)
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(
                                    Modifier
                                        .weight(1f)
                                        .clickable { onOpenStudent(student.id) }
                                        .padding(vertical = 6.dp)
                                        .testTag("student-${student.id}"),
                                ) {
                                    Text(
                                        student.name ?: "A driver",
                                        style = TrackTheme.typography.bodyStrong,
                                        color = colors.accentInk,
                                    )
                                    Text(
                                        CoachingText.studentLine(student, EventDates::fmtDate),
                                        style = TrackTheme.typography.xs,
                                        color = colors.textMuted,
                                    )
                                }
                                TextButton(onClick = { confirmLeaveStudent = student.id }) {
                                    Text("Stop coaching", style = TrackTheme.typography.xs, color = colors.textMuted)
                                }
                            }
                        }
                    }
                }
            }

            item("share-header") { TESectionHeader("Share your logbook with a coach") }
            item("share-hint") {
                Text(
                    "Give an instructor or coach read-only access to your whole logbook. They see $COACH_SHARES",
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
            item("invite") {
                if (canInvite) {
                    InviteCard(model, coaching, at, onShare)
                } else {
                    TEProLocked(
                        title = "Share with a coach",
                        blurb = "Send an instructor or coach a link that gives them read-only access to your " +
                            "logbook — every session, the channel graphs and your racing lines — so they can " +
                            "prepare before the next track day.",
                        onSubscribe = onRequirePro,
                    )
                }
            }

            item("coaches-header") { TESectionHeader("Coaches who can see your logbook") }
            item("coaches") {
                TrackCard(Modifier.fillMaxWidth()) {
                    if (coaching.coaches.isEmpty()) {
                        TEEmpty("Nobody can see your logbook yet.")
                    }
                    coaching.coaches.forEachIndexed { index, coach ->
                        if (index > 0) HorizontalDivider(color = colors.borderHairline)
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("coach-${coach.id}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(coach.name ?: "A coach", style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                                Text(
                                    "since ${fmtDay(coach.since)} · ${CoachingText.lastViewedText(coach.lastViewedAt, at)}",
                                    style = TrackTheme.typography.xs,
                                    color = colors.textMuted,
                                )
                            }
                            TextButton(onClick = { confirmRemoveCoach = coach.id }) {
                                Text("Remove", style = TrackTheme.typography.xs, color = colors.danger)
                            }
                        }
                    }
                }
            }

            item("profile-header") { TESectionHeader("Driver profile") }
            item("profile-hint") {
                Text(
                    "What your coaches see about you — your experience, your gear and what you want to work " +
                        "on. Only you and the coaches you've invited can see it.",
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
            item("profile") { ProfileCard(model.profile?.profile, empty = "Not filled in yet.") }
            item("profile-edit") {
                TextButton(onClick = onEditProfile, modifier = Modifier.testTag("editProfile")) {
                    Text(
                        if (model.profile?.profile != null) "Edit profile" else "Fill in your profile",
                        style = TrackTheme.typography.bodyStrong,
                        color = colors.accentInk,
                    )
                }
            }
        }
    }

    model.coaching?.coaches?.firstOrNull { it.id == confirmRemoveCoach }?.let { coach ->
        TEConfirmDialog(
            text = "Stop sharing your logbook with ${coach.name ?: "this coach"}? They lose access straight away.",
            confirm = "Remove",
            onConfirm = { confirmRemoveCoach = null; model.removeCoach(coach.id) },
            onDismiss = { confirmRemoveCoach = null },
        )
    }
    model.coaching?.students?.firstOrNull { it.id == confirmLeaveStudent }?.let { student ->
        TEConfirmDialog(
            text = "Stop coaching ${student.name ?: "this driver"}? You'll need a new invite to see their logbook again.",
            confirm = "Stop coaching",
            onConfirm = { confirmLeaveStudent = null; model.leaveStudent(student.id) },
            onDismiss = { confirmLeaveStudent = null },
        )
    }
}

/**
 * Create an invite, the one just made — its link with Copy, the share sheet
 * and a QR code, shown this once — and the open invites with Withdraw.
 */
@Composable
private fun InviteCard(model: CoachingModel, coaching: CoachingData, at: Long, onShare: (String) -> Unit) {
    val colors = TrackTheme.colors
    val clipboard = LocalClipboardManager.current
    var copied by rememberSaveable { mutableStateOf(false) }
    TrackCard(Modifier.fillMaxWidth()) {
        Button(
            onClick = { copied = false; model.createInvite() },
            enabled = !model.creating,
            modifier = Modifier.testTag("createInvite"),
            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
        ) {
            Text(if (model.creating) "Creating…" else "Create an invite link", style = TrackTheme.typography.bodyStrong)
        }
        model.newInvite?.let { invite ->
            Column(
                modifier = Modifier.padding(top = 10.dp).testTag("newInvite"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(invite.url, style = TrackTheme.typography.xs, color = colors.textStrong)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = {
                        clipboard.setText(AnnotatedString(invite.url))
                        copied = true
                    }) {
                        Text(if (copied) "Copied" else "Copy", style = TrackTheme.typography.sm, color = colors.accentInk)
                    }
                    TextButton(onClick = { onShare(invite.url) }) {
                        Text("Share…", style = TrackTheme.typography.sm, color = colors.accentInk)
                    }
                }
                // For handing it over in the paddock: the coach scans the screen.
                QrCode(invite.url)
                Text(
                    "Send this to your coach. It works once, ${CoachingText.inviteExpiryText(invite.expiresAt, at)}, " +
                        "and can't be shown again — make a new one if it gets lost.",
                    style = TrackTheme.typography.xs,
                    color = colors.textMuted,
                )
            }
        }
        if (coaching.invites.isNotEmpty()) {
            HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(vertical = 10.dp))
            coaching.invites.forEach { invite ->
                Row(
                    modifier = Modifier.fillMaxWidth().testTag("openInvite-${invite.id}"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Unused invite link", style = TrackTheme.typography.sm, color = colors.textBody)
                        Text(
                            CoachingText.inviteExpiryText(invite.expiresAt, at),
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                        )
                    }
                    TextButton(onClick = { model.withdrawInvite(invite.id) }) {
                        Text("Withdraw", style = TrackTheme.typography.xs, color = colors.textMuted)
                    }
                }
            }
        }
    }
}

private fun fmtDay(ms: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))
