package app.trackevolution.ai

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.AICoach
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.AICoachMessage
import app.trackevolution.core.model.AICoachOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * One AI Coach conversation (#320) — the drawer's state in `public/app.js`
 * (`openCoach` / `coachAsk` / `coachSaveRow`), held by the destination it was
 * opened from through `rememberScreenModel(key = "ai-coach")`, so a rotation or
 * a fold keeps the conversation and a reply mid-stream keeps streaming.
 *
 * Stateless on the server (NS-58): the conversation is [messages], sent whole
 * each time. A question that was refused or failed leaves it, so *Try again*
 * asks it afresh; a reply is kept only when something came back.
 */
class AICoachChat(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    private val keys: AICoachKeys,
) {
    /** Where it was opened from, and how a kept reply is written. */
    data class Opening(
        val entry: String,
        val context: AICoach.CoachContext,
        val subtitle: String,
        /** The ordinary notes write: session notes for a debrief, event notes otherwise. */
        val save: suspend (reply: String) -> Unit,
    )

    sealed interface TurnState {
        data object Streaming : TurnState
        /** [message] is said under the reply when it stopped short. */
        data class Answered(val message: String?) : TurnState
        data object Empty : TurnState
        /** [toSettings] offers the way to Settings (a 400 or a 424). */
        data class Failed(val message: String, val toSettings: Boolean) : TurnState
    }

    class Turn(val question: String) {
        var reply by mutableStateOf("")
            internal set
        var progress by mutableStateOf<String?>("Thinking…")
            internal set
        var state by mutableStateOf<TurnState>(TurnState.Streaming)
            internal set
        var saved by mutableStateOf<String?>(null)
            internal set
        var saving by mutableStateOf(false)
            internal set
        var saveError by mutableStateOf<String?>(null)
            internal set
    }

    var opening by mutableStateOf<Opening?>(null)
        private set

    val turns = mutableStateListOf<Turn>()

    /** 402 (or a free account): the Pro offer is drawn in place of the conversation. */
    var paywall by mutableStateOf(false)
        private set

    /** 401 mid-conversation: the app session is gone; the host signs out. */
    var signedOut by mutableStateOf(false)
        private set

    var draft by mutableStateOf("")

    val busy: Boolean get() = turns.lastOrNull()?.state == TurnState.Streaming

    private val messages = mutableListOf<AICoachMessage>()
    private var job: Job? = null

    /** The provider the conversation runs on, for the footer. */
    val providerName: String get() = AICoach.providerName(keys.credential()?.provider)

    /**
     * Opens a fresh conversation and asks the entry point's question — or, for
     * a free account, draws the paywall in place.
     */
    fun open(opening: Opening, pro: Boolean) {
        close()
        this.opening = opening
        if (!pro) {
            paywall = true
            return
        }
        ask(AICoach.COACH_ENTRIES.getValue(opening.entry).question)
    }

    fun close() {
        job?.cancel()
        job = null
        opening = null
        turns.clear()
        messages.clear()
        paywall = false
        draft = ""
    }

    /** A follow-up from the text box. */
    fun send() {
        val text = draft.trim()
        if (text.isEmpty() || busy) return
        draft = ""
        ask(text)
    }

    /** *Try again*: the failed turn goes, and its question is asked afresh. */
    fun retry(turn: Turn) {
        if (busy) return
        turns.remove(turn)
        ask(turn.question)
    }

    private fun ask(text: String) {
        val open = opening ?: return
        val cred = keys.credential() ?: run { close(); return }
        val turn = Turn(text)
        turns += turn
        messages += AICoachMessage("user", text)
        job = scope.launch {
            val outcome = try {
                api.aiCoach(
                    provider = cred.provider,
                    key = cred.key,
                    context = open.context,
                    messages = messages.toList(),
                    model = cred.model,
                    onText = { turn.reply += it },
                    onTool = { _, label -> turn.progress = label?.takeIf { it.isNotEmpty() } ?: "Reading your logbook…" },
                )
            } catch (e: ApiException) {
                AICoachOutcome.Error(e.status ?: 0, e.message)
            }
            turn.progress = null
            when (outcome) {
                is AICoachOutcome.Done -> {
                    if (turn.reply.isNotBlank()) {
                        messages += AICoachMessage("assistant", turn.reply)
                        turn.state = TurnState.Answered(outcome.message)
                    } else {
                        // Nothing came back, so the question leaves the conversation too.
                        messages.removeLastOrNull()
                        turn.state = if (outcome.message != null) TurnState.Answered(outcome.message) else TurnState.Empty
                    }
                }
                AICoachOutcome.Paywall -> {
                    messages.removeLastOrNull()
                    turns.remove(turn)
                    paywall = true
                }
                AICoachOutcome.Unauthorized -> {
                    messages.removeLastOrNull()
                    signedOut = true
                }
                AICoachOutcome.Offline -> {
                    messages.removeLastOrNull()
                    turn.state = TurnState.Failed("The ${AICoach.COACH_NAME} ${AICoach.COACH_OFFLINE}.", toSettings = false)
                }
                is AICoachOutcome.Error -> {
                    messages.removeLastOrNull()
                    turn.state = TurnState.Failed(
                        AICoach.coachErrorText(outcome.status, outcome.error, cred.provider),
                        toSettings = outcome.status == 424 || outcome.status == 400,
                    )
                }
            }
        }
    }

    /** Keeps a reply in the notes it belongs to, through the ordinary (queueable, free) write. */
    fun save(turn: Turn) {
        val open = opening ?: return
        if (turn.saving || turn.saved != null) return
        turn.saving = true
        turn.saveError = null
        scope.launch {
            try {
                open.save(turn.reply)
                turn.saved = "Saved to notes."
            } catch (e: ApiException) {
                turn.saved = null
                turn.saveError = e.message
            } finally {
                turn.saving = false
            }
        }
    }
}
