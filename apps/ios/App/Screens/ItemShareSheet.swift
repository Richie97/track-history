import SwiftUI
import TrackEvolutionKit
import UIKit

/// The words of sharing one event or one session (NS-48) — and one lap, or two
/// laps compared (NS-56) — on both sides of the
/// link — the owner's sheet and the page the link opens. One place, so the
/// sentence that promises what a link shows and the page that shows it can't
/// drift apart.
enum ItemShareText {
    /// What the item is called in a sentence.
    static func noun(_ kind: ItemShareKind) -> String {
        switch kind {
        case .event: "this track day"
        case .session: "this session"
        case .lap: "this lap"
        case .compare: "these two laps compared"
        }
    }

    /// The sheet's promise: what a link shows, and what it never does. The lap's
    /// and the comparison's are NS-56's own sentences, the same on every client.
    static func explanation(_ kind: ItemShareKind) -> String {
        switch kind {
        case .event, .session:
            "Anyone with this link can see \(noun(kind)) — its laps, racing line, telemetry and video. "
                + "Notes, costs and setup sheets stay private."
        case .lap:
            "Anyone with this link can see this lap — its time, racing line, telemetry and video. "
                + "The rest of the session, notes, costs and setup sheets stay private."
        case .compare:
            "Anyone with this link can see these two laps compared — their times, telemetry and video. "
                + "Nothing else in your logbook is shared."
        }
    }

    static func sheetTitle(_ kind: ItemShareKind) -> String {
        switch kind {
        case .event: "Share track day"
        case .session: "Share session"
        case .lap: "Share lap"
        case .compare: "Share comparison"
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
        switch kind {
        case .event: return "A track day shared by \(who) — read-only."
        case .session: return "A session shared by \(who) — read-only."
        case .lap: return "A lap shared by \(who)."
        case .compare: return "Two laps compared, shared by \(who)."
        }
    }

    /// The page's title before (or without) its track's name.
    static func pageTitle(_ kind: ItemShareKind) -> String {
        switch kind {
        case .event: "Shared track day"
        case .session: "Shared session"
        case .lap: "Shared lap"
        case .compare: "Shared comparison"
        }
    }

    /// A free owner's comparison (NS-56): the compare is a Pro view, so the link
    /// shows the two lap times and this sentence — never an upsell to the viewer.
    static func compareFreeNote(name: String?) -> String {
        let who = name.flatMap { $0.isEmpty ? nil : $0 } ?? "The driver"
        return "\(who) is on the free plan, so this link shows the two lap times. "
            + "The comparison shows while they have Pro."
    }

    /// A Pro owner's comparison of laps that stored no telemetry — typed in by
    /// hand — has only the two times to show.
    static let compareNoTelemetry = "These laps have no telemetry to compare."

    /// Under a free owner's channel panel, in place of an upsell: the tier is the
    /// owner's, and the viewer — who may have no account — has nothing to buy.
    static func freeNote(name: String?) -> String {
        let who = name.flatMap { $0.isEmpty ? nil : $0 } ?? "The driver"
        return "\(who) is on the free plan, so this link shows the lap times, the racing line and the "
            + "speed, throttle and brake traces."
    }
}

/// *Share…* from an event's or a session's menu, the lap page, or either
/// compare (NS-56): mints the link (or answers the
/// existing one), and offers it — copied, through the system share sheet, or
/// stopped.
///
/// A live write and nothing else: offline it says so rather than queueing,
/// because a link minted later by a replay is a link nobody was shown.
struct ItemShareSheet: View {
    /// What is shared: an event, a session, a lap, or two laps compared.
    let target: ItemShareTarget

    private var kind: ItemShareKind { target.kind }

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
        guard !target.hasTempId else {
            phase = .failed(ItemShareText.notSyncedYet)
            return
        }
        phase = .loading
        do {
            phase = .ready(try await auth.api.createItemShare(target))
        } catch {
            phase = .failed(ItemShareText.words(for: error))
        }
    }

    private func stop() async {
        stopping = true
        stopError = nil
        defer { stopping = false }
        do {
            try await auth.api.deleteItemShare(target)
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
