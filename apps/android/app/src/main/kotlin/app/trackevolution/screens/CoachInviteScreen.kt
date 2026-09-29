package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.InvitePreview
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The screen an invite link lands on (NS-38) — `viewAcceptInvite` in
 * `public/app.js`: whose logbook, what accepting shares both ways, and Accept.
 *
 * Every outcome that isn't an acceptance is said in words rather than as an
 * error: a link that is expired or already used (the server's 404, in its own
 * message), your own link, and a driver you already coach. Offline is its own
 * case — the link is still good, so the screen offers to try again rather than
 * declaring it dead.
 */
class CoachInviteModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val token: String,
) {
    sealed interface Status {
        data object Loading : Status
        data class Preview(val preview: InvitePreview) : Status

        /** Unknown, used or expired — the server's own words. */
        data class Invalid(val message: String) : Status

        /** No answer at all: the link may be fine. */
        data class Offline(val message: String) : Status
    }

    var status by mutableStateOf<Status>(Status.Loading)
        private set
    var accepting by mutableStateOf(false)
        private set
    var acceptError by mutableStateOf<String?>(null)
        private set

    /** The student whose logbook this account can now read. */
    var acceptedStudentId by mutableStateOf<Int?>(null)
        private set

    fun load() {
        status = Status.Loading
        scope.launch {
            status = try {
                Status.Preview(api.coachInvite(token))
            } catch (e: ApiException.Transport) {
                Status.Offline(e.message)
            } catch (e: ApiException) {
                Status.Invalid(e.message)
            }
        }
    }

    fun accept() {
        if (accepting) return
        scope.launch {
            accepting = true
            acceptError = null
            try {
                acceptedStudentId = api.acceptCoachInvite(token).student.id
            } catch (e: ApiException) {
                // 400 own / 409 already a coach or no room: the server's reason.
                acceptError = e.message
            } finally {
                accepting = false
            }
        }
    }
}

@Composable
fun CoachInviteScreen(
    model: CoachInviteModel,
    onAccepted: (Int) -> Unit,
    onOpenStudent: (Int) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    LaunchedEffect(Unit) { if (model.status == CoachInviteModel.Status.Loading) model.load() }
    LaunchedEffect(model.acceptedStudentId) { model.acceptedStudentId?.let(onAccepted) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
            .testTag("coachInvite"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Coaching invite", style = TrackTheme.typography.h1, color = colors.textStrong)
        TrackCard(Modifier.fillMaxWidth()) {
            when (val status = model.status) {
                CoachInviteModel.Status.Loading -> CircularProgressIndicator(color = colors.accent)

                is CoachInviteModel.Status.Offline -> {
                    Body("Can't reach the server to check this invite. Try again once you're back online.")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Primary("Try again", onClick = model::load)
                        TextButton(onClick = onDone) { Text("Not now", color = colors.textMuted) }
                    }
                }

                is CoachInviteModel.Status.Invalid -> {
                    Body(status.message.ifBlank { "This invite link doesn't work any more." })
                    TextButton(onClick = onDone) { Text("Back to your logbook", color = colors.accentInk) }
                }

                is CoachInviteModel.Status.Preview -> {
                    val preview = status.preview
                    val name = preview.student.name ?: "A driver"
                    when {
                        preview.own -> {
                            Body(
                                "This is your own invite link. Send it to your coach — whoever opens it gets " +
                                    "read-only access to your logbook.",
                            )
                            TextButton(onClick = onDone) { Text("Back", color = colors.accentInk) }
                        }
                        preview.alreadyCoach -> {
                            Body("You already coach $name.")
                            Primary("Open $name's logbook") { onOpenStudent(preview.student.id) }
                        }
                        else -> {
                            Text(
                                "$name wants to share their Track Evolution logbook with you, read-only.",
                                style = TrackTheme.typography.bodyStrong,
                                color = colors.textStrong,
                            )
                            Body(
                                "You'll see their events, sessions and laps with the channel graphs, their racing " +
                                    "lines, their cars and modifications, and their driver profile — not their " +
                                    "notes, costs, setup sheets or email. Either of you can end it at any time from " +
                                    "the Coaching page.",
                            )
                            Body(
                                "Accepting shows $name your name and profile picture, and when you last looked at " +
                                    "their logbook.",
                            )
                            TEErrorBanner(model.acceptError)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Primary(if (model.accepting) "Accepting…" else "Accept", enabled = !model.accepting, tag = "acceptInvite") {
                                    model.accept()
                                }
                                TextButton(onClick = onDone) { Text("Not now", color = colors.textMuted) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Body(text: String) {
    Text(
        text,
        style = TrackTheme.typography.sm,
        color = TrackTheme.colors.textMuted,
        modifier = Modifier.padding(vertical = 4.dp),
    )
}

@Composable
private fun Primary(label: String, enabled: Boolean = true, tag: String? = null, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = if (tag != null) Modifier.testTag(tag) else Modifier,
        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
    ) { Text(label, style = TrackTheme.typography.bodyStrong) }
}
