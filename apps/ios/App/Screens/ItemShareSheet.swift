import SwiftUI
import TrackEvolutionKit
import UIKit

/// The words of sharing one event or one session (NS-48), on both sides of the
/// link — the owner's sheet and the page the link opens. One place, so the
/// sentence that promises what a link shows and the page that shows it can't
/// drift apart.
enum ItemShareText {
    /// What the item is called in a sentence.
    static func noun(_ kind: ItemShareKind) -> String {
        switch kind {
        case .event: "this track day"
        case .session: "this session"
        }
    }

    /// The sheet's promise: what a link shows, and what it never does.
    static func explanation(_ kind: ItemShareKind) -> String {
        "Anyone with this link can see \(noun(kind)) — its laps, racing line, telemetry and video. "
            + "Notes, costs and setup sheets stay private."
    }

    static func sheetTitle(_ kind: ItemShareKind) -> String {
        switch kind {
        case .event: "Share track day"
        case .session: "Share session"
        }
    }

    static let needsConnection = "Sharing needs a connection."

    /// An event or session created offline has no id the server knows yet, so
    /// there is nothing to mint a link for until its create flushes.
    static let notSyncedYet = "Sharing works once this has synced."

    /// A failed share or stop, in words the driver can act on.
    static func words(for error: any Error) -> String {
        if let error = error as? APIError {
            if case .transport = error { return needsConnection }
            return error.message
        }
        return error.localizedDescription
    }

    // MARK: - The page a link opens

    static let notFound = "This link doesn't exist or has been turned off."
    static let notFoundTitle = "Link not found"
    static let openNeedsConnection = "Opening a shared link needs a connection."

    /// The quiet line under the page's heading.
    static func byline(_ kind: ItemShareKind, name: String?) -> String {
        let who = name.flatMap { $0.isEmpty ? nil : $0 } ?? "A driver"
        let what = kind == .event ? "track day" : "session"
        return "A \(what) shared by \(who) — read-only."
    }

    /// Under a free owner's channel panel, in place of an upsell: the tier is the
    /// owner's, and the viewer — who may have no account — has nothing to buy.
    static func freeNote(name: String?) -> String {
        let who = name.flatMap { $0.isEmpty ? nil : $0 } ?? "The driver"
        return "\(who) is on the free plan, so this link shows the lap times, the racing line and the "
            + "speed, throttle and brake traces."
    }
}

/// *Share…* from an event's or a session's menu: mints the link (or answers the
/// existing one), and offers it — copied, through the system share sheet, or
/// stopped.
///
/// A live write and nothing else: offline it says so rather than queueing,
/// because a link minted later by a replay is a link nobody was shown.
struct ItemShareSheet: View {
    let kind: ItemShareKind
    let id: Int

    @Environment(AuthController.self) private var auth
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable {
        case loading
        case ready(ItemShareLink)
        case failed(String)
    }

    @State private var phase: Phase = .loading
    @State private var stopping = false
    @State private var stopError: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            TEPage {
                Text(ItemShareText.explanation(kind))
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                    .fixedSize(horizontal: false, vertical: true)

                switch phase {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                case .failed(let message):
                    TECard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(message)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textMuted))
                                .accessibilityIdentifier("itemShareError")
                            TERetryButton(retry: load)
                        }
                    }
                case .ready(let link):
                    linkCard(link)
                }
            }
            .navigationTitle(ItemShareText.sheetTitle(kind))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func linkCard(_ link: ItemShareLink) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            TECard(padding: 14) {
                Text(link.url.absoluteString)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textStrong))
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("itemShareURL")
            }

            Button(copied ? "Copied" : "Copy link") {
                UIPasteboard.general.url = link.url
                copied = true
                Haptics.confirm()
            }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .accessibilityIdentifier("itemShareCopy")

            ShareLink(item: link.url) {
                Label("Share…", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(TEButtonStyle(kind: .quiet))
            .accessibilityIdentifier("itemShareShareLink")

            Button(stopping ? "Stopping…" : "Stop sharing", role: .destructive) {
                Task { await stop() }
            }
            .buttonStyle(TEButtonStyle(kind: .danger))
            .disabled(stopping)
            .accessibilityIdentifier("itemShareStop")

            if let stopError {
                Text(stopError)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.dangerInk))
            }
        }
    }

    private func load() async {
        guard !OfflineStore.isTemp(id) else {
            phase = .failed(ItemShareText.notSyncedYet)
            return
        }
        phase = .loading
        do {
            phase = .ready(try await auth.api.createItemShare(kind, id: id))
        } catch {
            phase = .failed(ItemShareText.words(for: error))
        }
    }

    private func stop() async {
        stopping = true
        stopError = nil
        defer { stopping = false }
        do {
            try await auth.api.deleteItemShare(kind, id: id)
            Haptics.confirm()
            dismiss()
        } catch let error as APIError where error.status == 404 {
            // Already stopped — from the web, or another phone. Same outcome.
            dismiss()
        } catch {
            stopError = ItemShareText.words(for: error)
        }
    }
}
