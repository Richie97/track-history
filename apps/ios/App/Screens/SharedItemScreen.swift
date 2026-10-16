import SwiftUI
import TrackEvolutionKit

/// One shared event or session, read-only (NS-48) — where a
/// `trackevolution.app/share/e/<token>` or `/share/s/<token>` link lands.
///
/// The event page, narrowed: the header, the tiles, the best-lap trace, the
/// day's lap times, and each shared session with its laps, its channel panel
/// and its best-lap video. Built from the event page's own pieces rather than
/// by running `EventScreen` under another owner, because nothing about this
/// page is the viewer's: the read is public (`GET /api/share/(e|s)/:token`, no
/// token sent, nothing cached), the tier the panel opens to is the **owner's**
/// (`SharedItem.pro`), and no link out of it leads into anyone's logbook — so
/// laps are rows here, not doors onto the lap page.
///
/// The server has already narrowed the event: notes, the checklist, costs,
/// setup sheets and the garage link arrive null or empty, and a clip arrives
/// only while the owner has Pro. Nothing here hides a field the payload
/// carries; it simply has nothing to show for those.
struct SharedItemScreen: View {
    let kind: ItemShareKind
    let token: String

    @Environment(AuthController.self) private var auth
    @State private var state: LoadState = .loading
    @State private var item: SharedItem?
    /// The session whose channel panel is open as a sheet — this screen's one
    /// modal presentation.
    @State private var channelSession: Session?

    var body: some View {
        TELoadable(state: state, retry: load) {
            if let item {
                content(item)
            }
        }
        .navigationTitle(item?.event.event.trackName ?? (kind == .event ? "Shared track day" : "Shared session"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if item == nil { await load() }
        }
        .sheet(item: $channelSession) { session in
            NavigationStack {
                LapChannelChart(
                    channels: session.channels ?? SessionChannels(v: 1, dStepM: 20, laps: []),
                    laps: session.laps,
                    pro: item?.pro ?? false,
                    freeNote: ItemShareText.freeNote(name: item?.name)
                )
                .navigationTitle(session.label ?? "Channel graphs")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { channelSession = nil }
                    }
                }
            }
        }
    }

    private func content(_ item: SharedItem) -> some View {
        let detail = item.event
        let event = detail.event
        return TEPage {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(event.trackName) — \(EventDates.fmtDate(event.startDate))")
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                TEMeta([
                    [event.club, event.runGroup].compactMap { $0 }.joined(separator: " · "),
                    event.car,
                    EventScreen.conditionsText(event, units: auth.units)
                ])
                Text(ItemShareText.byline(item.kind, name: item.name))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }

            TEStatRow(tiles: Self.tiles(item))

            traceCard(detail)
            paceCard(detail)

            ForEach(detail.sessions) { session in
                sessionCard(item, session)
            }
            if detail.sessions.isEmpty {
                TEEmpty("No sessions recorded yet.")
            }
        }
        .refreshable { await load() }
    }

    /// The headline numbers. A session link's best, lap count and consistency are
    /// that session's — the server works them out from it alone — and a session
    /// has no days to count.
    static func tiles(_ item: SharedItem) -> [TEStatTile] {
        let event = item.event.event
        var tiles = [TEStatTile(label: "Best time", value: LapTime.fmtMs(event.bestMs), monospaced: true)]
        if item.kind == .event {
            tiles.append(TEStatTile(label: "Days", value: fmtDays(event.days)))
        }
        tiles.append(TEStatTile(label: "Laps recorded", value: "\(event.lapCount)"))
        tiles.append(TEStatTile(label: "Consistency", value: LapTime.fmtConsistency(event.consistency)))
        return tiles
    }

    // MARK: - The event page's pieces

    @ViewBuilder
    private func traceCard(_ detail: EventDetail) -> some View {
        if let session = EventScreen.tracedSession(detail.sessions), let best = session.bestLapMs {
            let markers = EventScreen.limitMarkers(session)
            TESectionHeader("Best lap trace")
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Brighter is faster")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                        Spacer()
                        TETime(ms: best, emphasized: true)
                    }
                    TrackMapView(trace: session.trace ?? [], markers: markers)
                        .frame(height: 220)
                    LimitLegend(markers: markers)
                }
            }
        }
    }

    @ViewBuilder
    private func paceCard(_ detail: EventDetail) -> some View {
        let laps = detail.sessions.flatMap(\.lapTimesMs)
        if laps.count >= 3 {
            TESectionHeader("Lap times")
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Down is faster")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    ProgressChart(
                        points: laps.enumerated().map { index, ms in
                            .init(x: Double(index + 1), label: "Lap \(index + 1)", ms: ms)
                        },
                        unit: "laps"
                    )
                }
            }
        }
    }

    private func sessionCard(_ item: SharedItem, _ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sessionHeader(session)
            if let stats = session.statsSummary(units: auth.units) {
                Text(stats)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            channelButton(session)
            TECard(padding: 14) {
                VStack(spacing: 8) {
                    ForEach(session.laps) { lap in
                        lapRow(session, lap)
                    }
                    if session.laps.isEmpty {
                        Text("No laps")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textFaint))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            // A best-lap video (NS-45), only ever present while the owner has
            // Pro — the server drops the clip otherwise, so a free owner's link
            // shows no locked player and no upsell.
            ForEach(session.laps.filter { $0.clip != nil }) { lap in
                if let clip = lap.clip {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Lap \(String(lap.lapNum)) · \(LapTime.fmtMs(lap.timeMs))")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                        LapVideoPlayer(clip: clip, readOnly: true, signedURL: {
                            try await auth.api.sharedClipURL(kind: kind, token: token, clipId: clip.id)
                        })
                    }
                }
            }
        }
        .padding(.top, 8)
    }

    private func sessionHeader(_ session: Session) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(session.label ?? "Session")
                .teStyle(.h2)
                .foregroundStyle(Color(.textStrong))
            if let best = session.bestLapMs {
                Text("best \(LapTime.fmtMs(best)) · \(fmtCount(session.laps.count, "lap"))")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            // The air this session was driven in (#191), as on the event page.
            if let ambientC = SessionConditions.sessionAmbientC(session) {
                let temp = SessionConditions.tempText(ambientC, SessionConditions.Units(auth.units))
                Text(temp)
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textMuted))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color(.heat).opacity(0.14), in: .capsule)
                    .accessibilityLabel("Ambient \(temp)")
            }
            Spacer()
        }
    }

    private func lapRow(_ session: Session, _ lap: Lap) -> some View {
        HStack {
            Text("Lap \(String(lap.lapNum))")
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
            Spacer()
            if lap.clip != nil {
                Text("▶")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.accentInk))
            }
            if lap.timeMs == session.bestLapMs {
                Text("★")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.accentInk))
            }
            TETime(ms: lap.timeMs, emphasized: lap.timeMs == session.bestLapMs)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "Lap \(String(lap.lapNum)) · \(LapTime.fmtMs(lap.timeMs))" + (lap.clip != nil ? ", has video" : "")
        )
    }

    /// The way into the session's channel panel, when it stored any — absent
    /// rather than empty otherwise, as on the event page.
    @ViewBuilder
    private func channelButton(_ session: Session) -> some View {
        let present = session.channels.map { ChannelGraphs.presentChannels($0) } ?? []
        if !present.isEmpty {
            Button {
                channelSession = session
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Compare laps")
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.textStrong))
                        Text("\(present.map(\.label).joined(separator: " · ")) vs distance")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.surfaceCard), in: .rect(cornerRadius: TERadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: TERadius.md)
                        .strokeBorder(Color(.borderHairline), lineWidth: 1)
                )
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("channelGraphs")
        }
    }

    private func load() async {
        do {
            item = try await auth.api.sharedItem(kind: kind, token: token)
            state = .ready
        } catch let error as APIError where error.status == 404 {
            state = .failed(ItemShareText.notFound, retryable: false, title: ItemShareText.notFoundTitle)
        } catch let error as APIError {
            if case .transport = error {
                state = .failed(ItemShareText.openNeedsConnection)
            } else {
                state = .failed(error.message)
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
