import SwiftUI
import TrackEvolutionKit

/// Someone's public logbook, read-only — where a `trackevolution.app/share/<slug>`
/// Universal Link lands.
///
/// This screen exists because that link pattern is the only one the association file
/// advertises (`src/routes/wellKnown.ts`), so without it tapping a shared link opens
/// the app showing *your* logbook instead of theirs, which is worse than not handling
/// the link at all.
///
/// It reads `GET /api/share/:slug`, which is **unauthenticated** and already strips
/// notes, email, per-lap data and every garage/setup linkage server-side. `ShareData`
/// is a separate model from `Event`/`Track` for the same reason: a private field
/// leaking into the public payload is a decode failure here, not a silent nil.
struct SharedLogbookScreen: View {
    let slug: String

    @Environment(AuthController.self) private var auth
    @State private var state: LoadState = .loading
    @State private var data: ShareData?

    var body: some View {
        TELoadable(state: state, retry: load) {
            if let data {
                content(data)
            }
        }
        .navigationTitle(data?.name ?? slug)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if data == nil { await load() }
        }
    }

    private func content(_ data: ShareData) -> some View {
        TEPage {
            VStack(alignment: .leading, spacing: 4) {
                Text(data.name ?? "Shared logbook")
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                Text("A read-only track history — notes and per-lap data stay private.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }

            TEStatRow(tiles: [
                TEStatTile(label: "Events", value: "\(data.totals.events)"),
                TEStatTile(label: "Track days", value: "\(data.totals.trackDays)"),
                TEStatTile(label: "Tracks", value: "\(data.tracks.count)")
            ])

            TESectionHeader("Tracks")
            if data.tracks.isEmpty {
                TEEmpty("No tracks on this page yet.")
            } else {
                ForEach(data.tracks) { track in
                    TECard(padding: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(track.name)
                                    .teStyle(.h3)
                                    .foregroundStyle(Color(.textStrong))
                                Spacer()
                                TETime(ms: track.bestMs)
                            }
                            TEMeta([
                                fmtCount(track.eventCount, "event"),
                                fmtCount(track.trackDays, "day"),
                                EventDates.fmtDate(track.lastDate)
                            ])
                            if track.series.count >= 2 {
                                ProgressChart(
                                    points: track.series.enumerated().map { index, point in
                                        .init(
                                            x: Double(index),
                                            label: EventDates.fmtDate(point.date),
                                            ms: point.bestMs
                                        )
                                    },
                                    style: .sparkline
                                )
                                // Laid out full-width under the text rather than beside
                                // it, so nothing else fixes its height.
                                .frame(height: 44)
                            }
                        }
                    }
                }
            }

            TESectionHeader("Events")
            ForEach(data.events) { event in
                TECard(padding: 14) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.trackName)
                                .teStyle(.bodyStrong)
                                .foregroundStyle(Color(.textStrong))
                            TEMeta([
                                EventDates.fmtDate(event.startDate),
                                event.club,
                                event.runGroup,
                                event.conditions?.label
                            ])
                        }
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 2) {
                            TETime(ms: event.bestMs)
                            Text(LapTime.fmtConsistency(event.consistency))
                                .teStyle(.xxs)
                                .foregroundStyle(Color(.textFaint))
                        }
                    }
                }
            }
        }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            data = try await auth.api.sharedLogbook(slug: slug)
            state = .ready
        } catch let error as APIError where error.status == 404 {
            state = .failed("There's no shared logbook at /share/\(slug) — the link may have been disabled.")
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
