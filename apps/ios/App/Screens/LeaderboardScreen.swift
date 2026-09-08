import SwiftUI
import TrackEvolutionKit

/// One track's leaderboard, behind the track page's button. `viewLeaderboard`
/// in `public/app.js` is the reference.
///
/// It used to be a section of `TrackScreen`; it moved out because that page is
/// the driver's own history and a board they may not care about was costing it a
/// screen of space — and because a driver who *does* care wants to read it
/// before they are on it, when the section had nothing of theirs to sit beside.
/// The opt-in controls live here, where the driver is looking at exactly what
/// joining publishes.
///
/// A pushed screen rather than a sheet, matching Android's destination: it is a
/// place you go and come back from. The lap a row opens (NS-35) is this screen's
/// **one** sheet — a second `.sheet` on one view is the documented watchdog crash.
struct LeaderboardScreen: View {
    let trackId: Int

    @Environment(AuthController.self) private var auth
    @State private var model: LeaderboardModel?
    @State private var confirmingLeave = false
    /// The leaderboard lap being read (NS-35), by its id.
    @State private var openingLap: OpenedLap?

    /// An id that can drive `.sheet(item:)`.
    private struct OpenedLap: Identifiable {
        let id: Int
    }

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let leaderboard = model.leaderboard {
                content(model, leaderboard)
            }
        }
        .navigationTitle("Leaderboard")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = LeaderboardModel(api: auth.api, trackId: trackId)
                self.model = model
                await model.load()
            }
        }
        .sheet(item: $openingLap) { lap in
            LeaderboardLapScreen(trackId: trackId, lapId: lap.id)
        }
    }

    private func content(_ model: LeaderboardModel, _ leaderboard: TrackLeaderboard) -> some View {
        TEPage {
            VStack(alignment: .leading, spacing: 4) {
                Text("Leaderboard")
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                Text("\(model.trackName) · opt-in only")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }

            if leaderboard.catalogId == nil {
                TEEmpty("This track isn't in the catalog, so it has no leaderboard.")
            } else {
                board(model, leaderboard)
            }
        }
        .refreshable { await model.load() }
        .confirmationDialog(
            "Leave the leaderboards? Your name and times disappear from every track's leaderboard.",
            isPresented: $confirmingLeave,
            titleVisibility: .visible
        ) {
            Button("Leave leaderboards", role: .destructive) {
                Task { await model.setLeaderboardOptIn(false) }
            }
            Button("Stay on them", role: .cancel) {}
        }
    }

    // MARK: - The board

    /// Strictly opt-in: drivers who haven't opted in, the viewer included, simply
    /// aren't on it. Only device-timed laps rank (NS-33) — the server decides
    /// that — and `leaderboardNote` is what explains a row slower than the track
    /// page's own headline, or a missing one.
    private func board(_ model: LeaderboardModel, _ leaderboard: TrackLeaderboard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Best device-timed laps by Track Evolution drivers at this track. Laps recorded with the app or imported from telemetry count; hand-entered times don't.")
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
            if leaderboard.entries.isEmpty {
                TEEmpty("No opted-in drivers here yet\(leaderboard.optedIn ? "" : " — be the first").")
            } else {
                TECard {
                    VStack(spacing: 0) {
                        ForEach(Array(leaderboard.entries.enumerated()), id: \.offset) { index, entry in
                            leaderboardRow(index, entry, count: leaderboard.entries.count)
                        }
                    }
                }
            }
            if let note = leaderboardNote(model, leaderboard) {
                Text(note)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            if let error = model.leaderboardError {
                TEErrorBanner(message: error)
            }
            if leaderboard.entries.contains(where: { $0.lapId != nil }) {
                Text("Rows with a chevron open the lap — its racing line and telemetry, next to your own best here.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            if leaderboard.optedIn {
                HStack(spacing: 8) {
                    Text("You're on the leaderboards — your name and best device-timed lap per track are visible to other signed-in drivers.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    Spacer(minLength: 4)
                    Button("Leave") { confirmingLeave = true }
                        .teStyle(.xs)
                        .foregroundStyle(Color(.dangerInk))
                }
                // The second consent sits with the first, because this is the one
                // place a driver is looking at exactly what it would publish.
                if leaderboard.shareLaps == true {
                    HStack(spacing: 8) {
                        Text("Your ranked lap is open to other drivers here — its racing line and telemetry, and nothing else from your logbook.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                        Spacer(minLength: 4)
                        Button("Stop") { Task { await model.setLeaderboardOptIn(true, shareLaps: false) } }
                            .teStyle(.xs)
                            .foregroundStyle(Color(.dangerInk))
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your ranked lap is a time only. Sharing it lets other drivers ranked here open its racing line and telemetry — never your notes, your car, your setup or any other lap.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                        Button("Share my ranked laps") {
                            Task { await model.setLeaderboardOptIn(true, shareLaps: true) }
                        }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("You're not on the leaderboards. Joining shares exactly two things with other signed-in drivers, per track: your name and your best device-timed lap.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    Button("Join leaderboards") { Task { await model.setLeaderboardOptIn(true) } }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            }
        }
    }

    /// One leaderboard row. Openable when its owner published the lap itself
    /// (NS-35) — the server decides that and withholds `lapId` otherwise, so a
    /// row with no id is plain text rather than a tap that would 404.
    @ViewBuilder
    private func leaderboardRow(_ index: Int, _ entry: LeaderboardEntry, count: Int) -> some View {
        let openable = entry.lapId != nil
        let label = "Rank \(index + 1), \(entry.name ?? "Driver")\(entry.you ? ", you" : ""), "
            + "\(LapTime.fmtMs(entry.bestMs)), \(EventDates.fmtDate(entry.date))"
        Button {
            if let lapId = entry.lapId { openingLap = OpenedLap(id: lapId) }
        } label: {
            HStack(spacing: 10) {
                Text("\(String(index + 1))")
                    .teStyle(.lapTime)
                    .foregroundStyle(Color(.textFaint))
                    .frame(width: 24, alignment: .trailing)
                Text(entry.name ?? "Driver")
                    .teStyle(entry.you ? .bodyStrong : .body)
                    .foregroundStyle(Color(.textBody))
                    .lineLimit(1)
                if entry.you {
                    Text("you")
                        .teStyle(.xxs)
                        .foregroundStyle(Color(.accentInk))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color(.accentTint), in: .capsule)
                }
                Spacer(minLength: 8)
                TETime(ms: entry.bestMs)
                Text(EventDates.fmtDate(entry.date))
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
                // A chevron is the only thing distinguishing an openable row, so
                // it is drawn rather than left to colour: most rows are not.
                if openable {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color(.textFaint))
                }
            }
            .padding(.vertical, 8)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!openable)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(openable ? "\(label). Open this lap." : label)
        if index < count - 1 {
            Divider().overlay(Color(.borderHairline))
        }
    }

    /// Why the viewer's row differs from the track page's own headline, or is
    /// missing: only device-timed laps rank (NS-33), and the server decides
    /// that. Same wording as the web and Android.
    private func leaderboardNote(_ model: LeaderboardModel, _ leaderboard: TrackLeaderboard) -> String? {
        guard let logbookBest = model.logbookBest else { return nil }
        let you = leaderboard.entries.first { $0.you }
        if leaderboard.optedIn, you == nil {
            return "None of your laps here were timed by a device, so you aren't ranked yet. Record with the app or import telemetry to appear."
        }
        if let you, logbookBest < you.bestMs {
            return "Your best here (\(LapTime.fmtMs(logbookBest))) was entered by hand and isn't ranked."
        }
        return nil
    }
}

/// The board, the viewer's own best here, and the opt-in write.
@MainActor
@Observable
final class LeaderboardModel {
    private let api: APIClient
    let trackId: Int

    private(set) var state: LoadState = .loading
    private(set) var trackName = ""
    private(set) var leaderboard: TrackLeaderboard?
    var leaderboardError: String?

    /// The logbook's best at this track, manual bests included — what the note
    /// compares the viewer's row against. The dry-only filter has no say here,
    /// because the board ignores it too.
    private(set) var logbookBest: Int?

    init(api: APIClient, trackId: Int) {
        self.api = api
        self.trackId = trackId
    }

    func load() async {
        do {
            async let tracks = api.tracks()
            async let events = api.events(trackId: trackId)
            async let board = api.trackLeaderboard(id: trackId)
            let loaded = try await (tracks: tracks, events: events, board: board)
            guard let found = loaded.tracks.first(where: { $0.id == trackId }) else {
                state = .failed("That track isn't in your logbook any more.")
                return
            }
            trackName = found.name
            logbookBest = loaded.events.compactMap(\.bestMs).min()
            leaderboard = loaded.board
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Join or leave the leaderboards. A live write on purpose — never queued
    /// offline: publishing your name shouldn't replay silently later.
    func setLeaderboardOptIn(_ optIn: Bool, shareLaps: Bool? = nil) async {
        leaderboardError = nil
        do {
            try await api.setLeaderboardOptIn(optIn, shareLaps: shareLaps)
            leaderboard = try? await api.trackLeaderboard(id: trackId)
            Haptics.confirm()
        } catch let error as APIError {
            leaderboardError = error.message
            Haptics.warn()
        } catch {
            leaderboardError = error.localizedDescription
            Haptics.warn()
        }
    }
}
