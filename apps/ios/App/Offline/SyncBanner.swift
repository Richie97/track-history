import SwiftUI
import TrackEvolutionKit

/// What the offline layer is doing, when it's worth saying.
///
/// The web app's `#sync-banner` equivalent. Three states earn a banner and nothing
/// else does — a silent app that quietly holds unsent writes is the failure this
/// prevents:
///
/// - writes waiting to sync, so you know the paddock save isn't lost;
/// - offline with nothing pending, so a stale-looking screen is explained;
/// - a write the server **rejected**, surfaced once with a way to dismiss. It is
///   never retried forever.
struct SyncBanner: View {
    @Environment(AuthController.self) private var auth
    @State private var status: OfflineStore.SyncStatus?

    var body: some View {
        Group {
            if let status, let message = Self.message(for: status) {
                HStack(spacing: 10) {
                    Image(systemName: status.failed > 0 ? "exclamationmark.triangle.fill" : "arrow.triangle.2.circlepath")
                    Text(message)
                        .teStyle(.xs)
                    Spacer()
                    if status.failed > 0 {
                        Button("Dismiss") { Task { await clearFailed() } }
                            .teStyle(.xs)
                            .foregroundStyle(Color(.accentInk))
                    } else if status.pending > 0 {
                        Button("Retry") { Task { await flush() } }
                            .teStyle(.xs)
                            .foregroundStyle(Color(.accentInk))
                    }
                }
                .foregroundStyle(status.failed > 0 ? Color(.dangerInk) : Color(.textBody))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(status.failed > 0 ? Color(.dangerTint) : Color(.surfaceRaised))
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Color(.borderHairline)).frame(height: 1)
                }
            }
        }
        // Polled rather than observed: the store is an actor behind an async
        // boundary, and a few seconds of latency on a status line costs nothing.
        .task {
            while !Task.isCancelled {
                status = await auth.api.syncStatus()
                // A flush is worth attempting whenever we look and something's
                // waiting: reconnecting doesn't announce itself.
                if let status, status.pending > 0, !status.offline {
                    await flush()
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private static func message(for status: OfflineStore.SyncStatus) -> String? {
        if status.failed > 0 {
            let plural = status.failed == 1 ? "change" : "changes"
            return "\(status.failed) \(plural) couldn't be saved and were dropped."
        }
        if status.pending > 0 {
            let plural = status.pending == 1 ? "change" : "changes"
            return status.offline
                ? "Offline — \(status.pending) \(plural) will sync when you're back."
                : "Syncing \(status.pending) \(plural)…"
        }
        return status.offline ? "Offline — showing your last synced logbook." : nil
    }

    private func flush() async {
        if let flushed = await auth.api.flushQueue() {
            status = flushed
        } else {
            status = await auth.api.syncStatus()
        }
    }

    private func clearFailed() async {
        await auth.api.clearSyncFailures()
        status = await auth.api.syncStatus()
    }
}
