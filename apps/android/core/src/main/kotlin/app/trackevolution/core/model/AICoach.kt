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
