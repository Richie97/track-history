import SwiftUI
import TrackEvolutionKit

/// The one place the app asks for notification permission on its own (NS-54):
/// under a comment thread, the first time a notification would mean something
/// — a driver reading what their coach said, a coach who has said something
/// and is now waiting for the answer. Never on launch, and never again once
/// answered either way; Settings' *Comment notifications* is the way back.
struct PushAskCard: View {
    /// The other person in the thread — who the notification would be about.
    let name: String?

    @Environment(PushController.self) private var push: PushController?

    var body: some View {
        if let push, push.shouldAsk {
            VStack(alignment: .leading, spacing: 8) {
                Text(Self.title(name))
                    .teStyle(.sm)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color(.textStrong))
                Text("A notification on this phone when a new comment arrives. Change it any time in Settings.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                HStack(spacing: 16) {
                    Button("Turn on") { Task { await push.ask() } }
                        .teStyle(.sm)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color(.accentInk))
                        .accessibilityIdentifier("pushAskTurnOn")
                    Button("Not now") { push.decline() }
                        .teStyle(.sm)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color(.textMuted))
                        .accessibilityIdentifier("pushAskNotNow")
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.bgSubtle), in: .rect(cornerRadius: TERadius.md))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("pushAsk")
        }
    }

    static func title(_ name: String?) -> String {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return "Get notified when \(name) replies"
        }
        return "Get notified of new comments"
    }
}

extension CommentsModel {
    /// Whether this thread is where the card belongs: the owner's once their
    /// coach has said something in it, a coach's once they have.
    func asksForPush(_ thread: Comments.Thread) -> Bool {
        isOwner ? thread.comments.contains { !$0.mine } : thread.comments.contains(where: \.mine)
    }

    /// Who the card names — the other person in the thread.
    func pushAskName(_ thread: Comments.Thread) -> String? {
        if isOwner { return coach(thread.coachId)?.name }
        if case .student(_, let name, _) = owner { return name }
        return nil
    }
}
