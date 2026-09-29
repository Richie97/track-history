import SwiftUI
import TrackEvolutionKit

/// Where a coaching invite lands (NS-38): `https://<host>/coach/<token>`, opened
/// as a Universal Link — held across a sign-in if it arrived signed out, the way
/// any link is (`AppRouter.open(_:signedIn:)`). `viewAcceptInvite` in
/// `public/app.js` is the reference for behaviour and copy.
///
/// Opening the link accepts nothing: the screen previews whose logbook it is
/// and what accepting shares, and handles every way a link can be dead — used,
/// expired, your own, already accepted — in words rather than as an error.
struct CoachInviteScreen: View {
    let token: String

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var phase: Phase = .loading
    @State private var isAccepting = false
    @State private var acceptError: String?

    enum Phase: Equatable {
        case loading
        /// No answer at all: the link is kept — this screen is still on the
        /// stack — so it can be tried again once there is signal.
        case offline
        /// The server's own reason: used, expired or unknown.
        case gone(String)
        case preview(InvitePreview)
    }

    var body: some View {
        content
            .navigationTitle("Coaching invite")
            .navigationBarTitleDisplayMode(.inline)
            .task { if phase == .loading { await load() } }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ZStack {
                Color(.bgPage).ignoresSafeArea()
                ProgressView()
            }
        case .offline:
            card {
                Text("Can't reach the server to check this invite. Try again once you're back online.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                Button("Try again") { Task { phase = .loading; await load() } }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                Button("Not now") { router.show(.coaching) }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            }
        case .gone(let message):
            card {
                Text(Self.sentence(message))
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                    .accessibilityIdentifier("inviteGone")
                Button("Back to your logbook") { router.popToRoot() }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            }
        case .preview(let preview):
            previewCard(preview)
        }
    }

    @ViewBuilder
    private func previewCard(_ preview: InvitePreview) -> some View {
        let name = preview.student.name ?? "A driver"
        if preview.own {
            card {
                Text("This is your own invite link. Send it to your coach — whoever opens it gets read-only access to your logbook.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                    .accessibilityIdentifier("inviteOwn")
                Button("Back to Coaching") { router.show(.coaching) }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            }
        } else if preview.alreadyCoach {
            card {
                Text("You already coach \(name).")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                    .accessibilityIdentifier("inviteAlreadyCoach")
                Button("Open \(name)'s logbook") {
                    router.show(.student(id: preview.student.id, page: .home))
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
            }
        } else {
            card {
                Text("**\(name)** wants to share their Track Evolution logbook with you, read-only.")
                    .teStyle(.body)
                    .foregroundStyle(Color(.textStrong))
                Text("""
                    You'll see their events, sessions and laps with the channel graphs, their racing lines, their cars \
                    and modifications, and their driver profile — not their notes, costs, setup sheets or email. \
                    Either of you can end it at any time from the Coaching page.
                    """)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Accepting shows \(name) your name and profile picture, and when you last looked at their logbook.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
                if let acceptError {
                    TEErrorBanner(message: Self.sentence(acceptError))
                }
                Button(isAccepting ? "Accepting…" : "Accept") { Task { await accept() } }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                    .disabled(isAccepting)
                    .accessibilityIdentifier("acceptInvite")
                Button("Not now") { router.popToRoot() }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            }
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        TEPage {
            TECard {
                VStack(alignment: .leading, spacing: 12) {
                    content()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The server's messages are lower-case fragments ("this invite link has
    /// expired…"), which the web shows as they are; a screen of their own reads
    /// better as a sentence.
    static func sentence(_ message: String) -> String {
        guard let first = message.first else { return message }
        return first.uppercased() + message.dropFirst()
    }

    private func load() async {
        do {
            phase = .preview(try await auth.api.coachInvitePreview(token: token))
        } catch let error as APIError {
            switch error {
            case .transport:
                phase = .offline
            case .unauthorized:
                auth.handleUnauthorized()
            default:
                phase = .gone(error.status == 404
                    ? error.message
                    : "This invite link doesn't work any more.")
            }
        } catch {
            phase = .offline
        }
    }

    private func accept() async {
        acceptError = nil
        isAccepting = true
        defer { isAccepting = false }
        do {
            let accepted = try await auth.api.acceptCoachInvite(token: token)
            Haptics.confirm()
            router.show(.student(id: accepted.student.id, page: .home))
        } catch let error as APIError {
            acceptError = error.message
            Haptics.warn()
        } catch {
            acceptError = error.localizedDescription
        }
    }
}
