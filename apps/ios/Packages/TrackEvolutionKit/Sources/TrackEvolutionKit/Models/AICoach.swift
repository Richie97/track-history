import Foundation

// The AI Coach (epic #314, docs/specs/native/NS-58-ai-coach.md). Always the
// "AI Coach" — a bare "coach" is a person in this app (NS-38). The
// conversation itself is an event stream, not JSON (its recorded fixture is
// contracts/streams/ai-coach.sse); these are the JSON shapes around it. The
// screens land with ticket 6 (#320) — this is the decoder its golden needs.

/// One model a driver may pick for a provider: its id and its name in words.
public struct AICoachModel: Codable, Hashable, Sendable {
    public var id: String
    public var label: String
}

/// `POST /api/ai/coach/verify` (Pro): a key the provider accepted. `provider`
/// is a string rather than an enum so one the server adds later still decodes.
/// A rejected key is a 424 `{ error }`, never this shape.
public struct AICoachVerify: Codable, Hashable, Sendable {
    public var ok: Bool
    public var provider: String
    public var defaultModel: String
    public var models: [AICoachModel]

    public enum CodingKeys: String, CodingKey {
        case ok, provider
        case defaultModel = "default_model"
        case models
    }
}
