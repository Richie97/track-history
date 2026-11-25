import SwiftUI
import TrackEvolutionKit

/// One shared event or session, read-only (NS-48) — where a
/// `trackevolution.app/share/e/<token>` or `/share/s/<token>` link lands —
/// and one shared lap (NS-56, `/share/l/<token>`): the same page over the same
/// shape, cut down server-side to the one session with the one lap, so it says
/// *Lap N* where a session would say its best and count. Two laps compared
/// (`/share/c/<token>`) is `SharedCompareScreen`, below.
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
        .navigationTitle(item?.event.event.trackName ?? ItemShareText.pageTitle(kind))
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
                    freeNote: ItemShareText.freeNote(name: item?.name),
                    mapTrace: session.trace.flatMap { $0.count >= 10 ? $0 : nil }
                )
                .navigationTitle(kind == .lap ? "Telemetry" : (session.label ?? "Channel graphs"))
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
        // A lap link's header is the lap's own (NS-56): one time, and neither a
        // count of one nor a consistency of nothing is worth a tile.
        if item.kind == .lap {
            return [TEStatTile(label: "Lap time", value: LapTime.fmtMs(event.bestMs), monospaced: true)]
        }
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
            if kind == .lap, let lap = session.laps.first {
                // The one lap the link shares — "best of 1 lap" would be noise.
                Text("Lap \(String(lap.lapNum))")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            } else if let best = session.bestLapMs {
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
                        Text(kind == .lap ? "Telemetry" : "Compare laps")
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

/// Two laps compared, read-only (NS-56) — where a
/// `trackevolution.app/share/c/<token>` link lands.
///
/// The track's two-lap compare without its pickers: side A against side B on
/// the lap stage (both videos, when the owner's clips came with the link), the
/// head-to-head and the channel panel — `CompareLapsScreen`'s own pieces over
/// `CompareLaps.alignLapPair`, fed from the link's two sides rather than from
/// anyone's logbook. Each side is a lap link's payload: its event narrowed to
/// one session with one lap and that lap's own channel entry.
///
/// The read is public (`GET /api/share/c/:token`, no token sent, nothing
/// cached) and the tier is the **owner's**: a free owner's link shows the two
/// lap times and one sentence, never an upsell — the viewer has nothing to buy.
/// A Pro owner's laps that stored no telemetry show their times, a sentence
/// saying so, and each lap's video where there is one.
struct SharedCompareScreen: View {
    let token: String

    @Environment(AuthController.self) private var auth
    @Environment(SyncModeStore.self) private var syncMode
    @Environment(\.layout) private var layout
    @State private var state: LoadState = .loading
    @State private var shared: SharedCompare?
    @State private var stage: LapStageModel?

    var body: some View {
        TELoadable(state: state, retry: load) {
            if let shared {
                content(shared)
            }
        }
        .background(Color(.bgPage))
        .navigationTitle(shared?.a.event.event.trackName ?? ItemShareText.pageTitle(.compare))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if stage == nil {
                let api = auth.api
                let token = self.token
                // The clips play over the link's own signed URLs — the viewer's
                // account, if there is one, never enters into it.
                stage = LapStageModel(mode: syncMode.mode, store: syncMode) { clip in
                    try await api.sharedClipURL(kind: .compare, token: token, clipId: clip.id).url
                }
            }
            if shared == nil { await load() }
        }
        // The stage's tabletop shape (NS-51) on a half-open Duo.
        .publishingFoldGeometry()
    }

    // MARK: - What the screen draws

    /// The two sides as the compare's pair — nil for a free owner (the compare
    /// is a Pro view) and when either lap stored no telemetry.
    static func pair(_ shared: SharedCompare) -> CompareLapsModel.Pair? {
        guard shared.pro,
              let sessionA = shared.a.session, let sessionB = shared.b.session,
              let lapA = shared.a.lap, let lapB = shared.b.lap,
              let chanA = sessionA.channels, let chanB = sessionB.channels,
              let entryA = chanA.laps.first, let entryB = chanB.laps.first
        else { return nil }
        return CompareLapsModel.Pair(
            aligned: CompareLaps.alignLapPair(entryA, chanA.dStepM, entryB, chanB.dStepM),
            laps: [
                Lap(id: 0, sessionId: sessionA.id, lapNum: lapA.lapNum, timeMs: entryA.timeMs),
                Lap(id: 1, sessionId: sessionB.id, lapNum: lapB.lapNum, timeMs: entryB.timeMs),
            ],
            metricsA: CompareLaps.lapMetrics(entryA),
            metricsB: CompareLaps.lapMetrics(entryB),
            mismatch: CompareLaps.lengthMismatchRatio(entryA, chanA.dStepM, entryB, chanB.dStepM),
            clipA: lapA.clip,
            clipB: lapB.clip,
            // Side A's line, when A is the lap it was drawn from — the server
            // keeps it for no other.
            trace: sessionA.trace.flatMap { $0.count >= 10 ? $0 : nil }
        )
    }

    /// The pair on the stage, as `CompareLapsScreen` puts its picks there. A
    /// clip is present only while the owner has Pro, so there is no tier to ask.
    static func stageInputs(_ pair: CompareLapsModel.Pair) -> [StageSideInput] {
        let best = min(pair.laps[0].timeMs, pair.laps[1].timeMs)
        return pair.aligned.laps.indices.prefix(2).map { i in
            StageSideInput(
                key: i == 0 ? .A : .B, entry: pair.aligned.laps[i], dStepM: pair.aligned.dStepM,
                clip: i == 0 ? pair.clipA : pair.clipB, chIdx: i,
                lapNum: pair.laps[i].lapNum, timeMs: pair.laps[i].timeMs, isBest: pair.laps[i].timeMs == best
            )
        }
    }

    /// "Apr 10, 2026 · Session 2 · Lap 3", trimmed to what the side has.
    static func sideLabel(_ side: SharedLapSide) -> String {
        let parts: [String?] = [
            EventDates.fmtDate(side.event.event.startDate),
            side.session?.label,
            side.lap.map { "Lap \(String($0.lapNum))" },
        ]
        return parts.compactMap(\.self).joined(separator: " · ")
    }

    @ViewBuilder
    private func content(_ shared: SharedCompare) -> some View {
        if let pair = Self.pair(shared), let stage {
            let phone = layout.contentWidth < StageLayout.MEDIUM_MIN
            LapStageView(model: stage, compare: true) {
                heading(shared, mismatch: pair.mismatch)
            } content: {
                VStack(alignment: .leading, spacing: 14) {
                    if !phone { CompareHeadToHead(pair: pair) }
                    Text("Delta shows where time is gained or lost; the channels show why. Tap a chart to move the videos.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    LapChannelPanel(
                        channels: pair.aligned, laps: pair.laps, preselect: [0, 1],
                        playhead: stage.playhead, onSeek: { stage.seek(toGridA: $0) }
                    )
                    if phone { CompareHeadToHead(pair: pair) }
                }
            }
            .task(id: shared) {
                stage.configure(Self.stageInputs(pair), trace: pair.trace, corners: Corners.sessionCorners(pair.aligned))
            }
        } else {
            TEPage {
                heading(shared, mismatch: 0)
                Text(shared.pro ? ItemShareText.compareNoTelemetry : ItemShareText.compareFreeNote(name: shared.name))
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sharedCompareNote")
                // The laps' videos on their own, where the comparison can't
                // carry them. Present only while the owner has Pro.
                sideVideo("Lap A", shared.a)
                sideVideo("Lap B", shared.b)
            }
            .refreshable { await load() }
        }
    }

    /// The title, whose laps these are, and the two sides with their times.
    private func heading(_ shared: SharedCompare, mismatch: Double) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Two laps compared")
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                Text(shared.a.event.event.trackName)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                Text(ItemShareText.byline(.compare, name: shared.name))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            TECard(padding: 14) {
                VStack(spacing: 10) {
                    sideRow("Lap A", shared.a, color: Color(.chartLine), faster: Self.faster(shared) == .A)
                    Divider().overlay(Color(.borderHairline))
                    sideRow("Lap B", shared.b, color: Color(.chartLineB), faster: Self.faster(shared) == .B)
                }
            }
            if mismatch > CompareLaps.LENGTH_MISMATCH_WARN {
                Text("⚠️ These laps cover driven distances \(Int((mismatch * 100).rounded()))% apart — likely a different layout or start/finish line.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }

    /// Which side is the faster lap — nil on a tie, or without both times.
    static func faster(_ shared: SharedCompare) -> VideoSync.SideKey? {
        guard let a = shared.a.lap?.timeMs, let b = shared.b.lap?.timeMs, a != b else { return nil }
        return a < b ? .A : .B
    }

    private func sideRow(_ label: String, _ side: SharedLapSide, color: Color, faster: Bool) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                Text(Self.sideLabel(side))
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
            }
            Spacer(minLength: 8)
            TETime(ms: side.lap?.timeMs, emphasized: faster)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(Self.sideLabel(side)), \(LapTime.fmtMs(side.lap?.timeMs))")
    }

    @ViewBuilder
    private func sideVideo(_ label: String, _ side: SharedLapSide) -> some View {
        if let lap = side.lap, let clip = lap.clip {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(label) · Lap \(String(lap.lapNum)) · \(LapTime.fmtMs(lap.timeMs))")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                LapVideoPlayer(clip: clip, readOnly: true, signedURL: {
                    try await auth.api.sharedClipURL(kind: .compare, token: token, clipId: clip.id)
                })
            }
        }
    }

    private func load() async {
        do {
            shared = try await auth.api.sharedCompare(token: token)
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
