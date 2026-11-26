package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The AI Coach (epic #314, docs/specs/native/NS-58-ai-coach.md). Always the
// "AI Coach" — a bare "coach" is a person in this app (NS-38). The
// conversation itself is an event stream, not JSON (its recorded fixture is
// contracts/streams/ai-coach.sse); these are the JSON shapes around it. The
// screens land with ticket 6 (#320) — this is the decoder its golden needs.

/** One model a driver may pick for a provider: its id and its name in words. */
@Serializable
public data class AICoachModel(
    val id: String,
    val label: String,
)

/**
 * `POST /api/ai/coach/verify` (Pro): a key the provider accepted. [provider]
 * is a string rather than an enum so one the server adds later still decodes.
 * A rejected key is a 424 `{ error }`, never this shape.
 */
@Serializable
public data class AICoachVerify(
    val ok: Boolean,
    val provider: String,
    @SerialName("default_model") val defaultModel: String,
    val models: List<AICoachModel>,
)

/** One turn of an AI Coach conversation, as the request carries it: `user` or `assistant`. */
@Serializable
public data class AICoachMessage(
    val role: String,
    val content: String,
)

/**
 * How an AI Coach request ended — `streamCoach`'s outcomes in
 * `public/js/ai-coach.js`. Never thrown: every refusal is an answer the sheet
 * draws in place (NS-58), never the sync banner.
 */
public sealed interface AICoachOutcome {
    /** The reply is complete. [message] is said under it when it stopped short (`tool_limit`, `max_tokens`, `refusal`). */
    public data class Done(val stop: String, val model: String?, val message: String?) : AICoachOutcome

    /** 402: draw the Pro offer in place. */
    public data object Paywall : AICoachOutcome

    /** 401: the app session is gone. A provider's rejected key is a 424, never this. */
    public data object Unauthorized : AICoachOutcome

    /** The server's `{ error }` before the stream opened, or the stream's `error` event, or a cut-off stream (502). */
    public data class Error(val status: Int, val error: String) : AICoachOutcome

    /** The request never reached the server. */
    public data object Offline : AICoachOutcome
}
