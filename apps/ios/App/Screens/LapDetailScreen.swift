import SwiftUI
import TrackEvolutionKit

/// One lap of one session: its time, its racing line when it is the lap the
/// session's trace was drawn from, its channel traces, and a door to the
/// multi-lap compare (#267).
///
/// **Video-first since NS-51.** A lap with a channel entry opens on the lap
/// stage — its video (or a replay on the map), the transport and the
/// now-strip, pinned — with the panel inline under it carrying the playhead,
/// and the facts at the end. The stage is one-sided: the delta is measured
/// against a quiet **reference lap** (`VideoSync.referenceLap` — the session
/// best, or the next-best when this lap is the best), whose speed trace sits
/// dim in the panel under this lap's own.
///
/// Reached from a lap row on the event page. Reads the event detail through
/// `EventModel` — the same offline-cached read the page made — and finds its
/// session and lap in it, so a lap opened in a paddock costs no request.
/// Everything below the time is optional: a hand-entered lap is a time and a
/// sentence, and the screen says which of the rest it has rather than drawing
/// empty frames.
///
/// **The map is the best lap's.** `sessions.trace` is one polyline, stored for
/// the session's best lap (migration 0005), so only that lap gets the racing
/// line; any other lap would be drawn on a line it never took. The channel
/// traces are per lap and every lap that has an entry gets its own.
///
/// *Compare laps* is a push now (`Route.sessionCompare`), not the sheet it was:
/// the page presents one thing — the stage's full-bleed cover — and nothing
/// else, which is the one-modal-per-view rule AGENTS.md lists.
struct LapDetailScreen: View {
    let eventId: Int
    let sessionId: Int
    let lapId: Int

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.layout) private var layout
    /// Whose logbook: the student's in a coach's view (NS-38), which decides both
    /// where the reads go and whose tier the channel panel opens by.
    @Environment(\.logbookOwner) private var owner
    @Environment(SyncModeStore.self) private var syncMode
    @State private var model: EventModel?
    @State private var stage: LapStageModel?

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let detail = model.detail {
                if let view = Self.build(detail, sessionId: sessionId, lapId: lapId) {
                    content(view)
                } else {
                    // The lap was deleted under us — from another device, or by
                    // the swipe on the page underneath after this was pushed.
                    TEPage {
                        TEEmpty("This lap is no longer in the logbook.")
                    }
                }
            }
        }
        .background(Color(.bgPage))
        .navigationTitle("Lap")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                // Held on the router, keyed by this page's route, so a resize
                // that rebuilds the page — an iPhone Duo opening sideways, a
                // rotation across 840 pt — finds the same models and the video
                // carries on (NS-51; `AppRouter.held`).
                let api = auth.api.scoped(to: owner)
                let route = owner.link(.lap(eventId: eventId, sessionId: sessionId, lapId: lapId))
                let model = router.held(route, "event") { EventModel(api: api, eventId: eventId) }
                self.model = model
                stage = router.held(route, "stage") {
                    LapStageModel(mode: syncMode.mode, store: syncMode) { clip in
                        try await api.clipURL(id: clip.id).url
                    }
                }
                if model.detail == nil { await model.load() }
            }
        }
    }

    // MARK: - What the screen draws

    /// Everything on the screen, computed once from the event detail. Pure and
    /// static so the rules — which lap gets the map, what the gap is, what the
    /// compare lights first — are tested without a view (`LapDetailTests`).
    struct Detail {
        var session: Session
        var lap: Lap
        /// The lap's channel entry alone in a blob of its own, so the panel draws
        /// exactly this lap — the same shape the leaderboard lap uses. Nil when the
        /// lap stored none (hand-entered, or added by hand to an imported session).
        var channels: SessionChannels?
        /// Where the entry sits in the session's own blob, for the compare.
        var chIdx: Int?
        var isBest: Bool
        /// Milliseconds behind the session's best; 0 for the best itself.
        var gapMs: Int
        /// The racing line — only when this is the lap it was drawn from.
        var trace: [TracePoint]?
        var markers: [Limits.Marker]
        /// The stage's reference (NS-51): the session best, or the next-best
        /// when this lap is the best — nil alone, or for a lap with no entry.
        var reference: ChannelGraphs.LapMatch?
    }

    static func build(_ detail: EventDetail, sessionId: Int, lapId: Int) -> Detail? {
        guard let session = detail.sessions.first(where: { $0.id == sessionId }),
              let lap = session.laps.first(where: { $0.id == lapId })
        else { return nil }
        let best = session.bestLapMs ?? lap.timeMs
        let isBest = lap.timeMs == best
        var chIdx: Int?
        var channels: SessionChannels?
        var reference: ChannelGraphs.LapMatch?
        if let stored = session.channels, !stored.laps.isEmpty {
            let matched = ChannelGraphs.matchLapsToChannels(session.laps, stored.laps)
            if let match = matched.first(where: { $0.lap.id == lap.id }), match.hasChannels {
                chIdx = match.chIdx
                channels = SessionChannels(v: 1, dStepM: stored.dStepM, laps: [stored.laps[match.chIdx]])
                reference = VideoSync.referenceLap(matched, match.chIdx)
            }
        }
        // Ten points is `TrackMapView`'s floor, as on the event page.
        let traced = isBest && (session.trace?.count ?? 0) >= 10
        return Detail(
            session: session,
            lap: lap,
            channels: channels,
            chIdx: chIdx,
            isBest: isBest,
            gapMs: lap.timeMs - best,
            trace: traced ? session.trace : nil,
            markers: traced ? EventScreen.limitMarkers(session) : [],
            reference: reference
        )
    }

    /// "Lap 3 of 12 · Session 2 · +0.412 vs best", or "★ best of the session".
    static func subtitle(_ view: Detail) -> String {
        [
            "Lap \(String(view.lap.lapNum)) of \(view.session.laps.count)",
            view.session.label ?? "Session",
            view.isBest ? "★ best of the session" : "\(LapTime.fmtDelta(view.gapMs)) vs best",
        ].joined(separator: " · ")
    }

    /// What the compare lights first: this lap, then the session's best beside it
    /// when that is a different lap — the comparison anyone opening a lap wants.
    /// Nil (the panel's own default, the fastest) when this lap has no entry.
    static func comparePreselect(_ view: Detail) -> [Int]? {
        guard let stored = view.session.channels, let chIdx = view.chIdx else { return nil }
        let matched = ChannelGraphs.matchLapsToChannels(view.session.laps, stored.laps).filter(\.hasChannels)
        guard let best = matched.min(by: { $0.lap.timeMs < $1.lap.timeMs }), best.chIdx != chIdx else {
            return [chIdx]
        }
        return [chIdx, best.chIdx]
    }

    /// Whether the session has an overlay to open at all.
    static func canCompare(_ view: Detail) -> Bool {
        !(view.session.channels?.laps.isEmpty ?? true)
    }

    /// The panel's channels on the stage: this lap's entry, then the
    /// reference's — lit is this lap alone, so the reference draws dim under it.
    /// `pro == false` leaves the reference out: the delta and B are Pro.
    static func stageChannels(_ view: Detail, pro: Bool) -> (channels: SessionChannels, laps: [Lap])? {
        guard let own = view.channels, let entry = own.laps.first else { return nil }
        if pro, let reference = view.reference, let stored = view.session.channels,
           stored.laps.indices.contains(reference.chIdx) {
            return (
                SessionChannels(v: 1, dStepM: own.dStepM, laps: [entry, stored.laps[reference.chIdx]]),
                [view.lap, reference.lap]
            )
        }
        return (own, [view.lap])
    }

    /// The neighbouring laps of the session that have a clip, for the stage's
    /// lap stepper (NS-50 every-lap sessions): the previous and the next by lap
    /// number, nil at either end.
    static func clipNeighbours(_ view: Detail) -> (previous: Lap?, next: Lap?) {
        let withClips = view.session.laps.filter { $0.clip != nil }.sorted { $0.lapNum < $1.lapNum }
        return (
            withClips.last { $0.lapNum < view.lap.lapNum },
            withClips.first { $0.lapNum > view.lap.lapNum }
        )
    }

    // MARK: - Content

    /// Whether this viewer plays the lap's clip on the stage: the owner's tier,
    /// or in a coach's view the student's (NS-45's rule).
    private var playsVideo: Bool {
        Entitlement.canSaveLapVideo(owner.channelEntitlement(viewer: auth.entitlement))
    }

    private var pro: Bool { owner.canViewChannels(viewer: auth.entitlement) }

    @ViewBuilder
    private func content(_ view: Detail) -> some View {
        if let stage, let staged = Self.stageChannels(view, pro: pro) {
            LapStageView(model: stage, compare: false) {
                VStack(alignment: .leading, spacing: 10) {
                    header(view)
                    lapStepper(view)
                    // Everything about the clip the stage doesn't play: locked,
                    // on its way, failed — today's card, which says nothing when
                    // there is nothing to say.
                    if !(view.lap.clip != nil && playsVideo) {
                        LapVideoSection(session: view.session, lap: view.lap, reload: { await model?.reload() })
                    } else if let clip = view.lap.clip, !owner.isReadOnly {
                        HStack {
                            Spacer()
                            LapClipMenu(clip: clip, onDeleted: { await model?.reload() }) {
                                stage.pause(announce: false)
                            }
                        }
                    }
                }
            } content: {
                VStack(alignment: .leading, spacing: 14) {
                    if Self.canCompare(view) {
                        compareButton(view)
                    }
                    Text("Tap a chart to move the video there.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    LapChannelPanel(
                        channels: staged.channels,
                        laps: staged.laps,
                        preselect: [0],
                        pro: pro,
                        playhead: stage.playhead,
                        onSeek: { stage.seek(toGridA: $0) },
                        memory: stage.panelMemory
                    )
                    if let entry = view.channels?.laps.first {
                        facts(CompareLaps.lapMetrics(entry))
                    }
                }
            }
            .task(id: StageKey(view, playsVideo: playsVideo, pro: pro)) {
                stage.configure(
                    stageInputs(view, staged: staged),
                    trace: view.session.trace.flatMap { $0.count >= 10 ? $0 : nil },
                    corners: Corners.sessionCorners(view.session.channels)
                )
            }
        } else {
            plainContent(view)
        }
    }

    /// What the stage is built from — the `.task`'s key, so a reload that
    /// changes the clip or the tier rebuilds it and nothing else does.
    private struct StageKey: Hashable {
        var lapId: Int
        var clip: LapClip?
        var referenceId: Int?
        var playsVideo: Bool
        var pro: Bool

        init(_ view: Detail, playsVideo: Bool, pro: Bool) {
            lapId = view.lap.id
            clip = view.lap.clip
            referenceId = view.reference?.lap.id
            self.playsVideo = playsVideo
            self.pro = pro
        }
    }

    private func stageInputs(_ view: Detail, staged: (channels: SessionChannels, laps: [Lap])) -> [StageSideInput] {
        let best = view.session.laps.map(\.timeMs).min()
        var inputs = [
            StageSideInput(
                key: .A, entry: staged.channels.laps[0], dStepM: staged.channels.dStepM,
                clip: playsVideo ? view.lap.clip : nil, chIdx: 0,
                lapNum: view.lap.lapNum, timeMs: view.lap.timeMs, isBest: view.isBest
            ),
        ]
        if staged.channels.laps.count > 1, staged.laps.count > 1 {
            let ref = staged.laps[1]
            // The reference has no slot, so no player: it is the delta's zero.
            inputs.append(
                StageSideInput(
                    key: .B, entry: staged.channels.laps[1], dStepM: staged.channels.dStepM, clip: nil, chIdx: 1,
                    lapNum: ref.lapNum, timeMs: ref.timeMs, isBest: ref.timeMs == best
                )
            )
        }
        return inputs
    }

    /// "‹ Lap 4" and "Lap 6 ›": the neighbouring laps with a clip. A step
    /// **replaces** this page rather than pushing, so Back still returns to the
    /// event.
    @ViewBuilder
    private func lapStepper(_ view: Detail) -> some View {
        let near = Self.clipNeighbours(view)
        if near.previous != nil || near.next != nil {
            HStack {
                if let previous = near.previous {
                    Button("‹ Lap \(String(previous.lapNum))") { replace(with: previous) }
                        .accessibilityLabel("Previous lap with video, lap \(String(previous.lapNum))")
                }
                Spacer()
                if let next = near.next {
                    Button("Lap \(String(next.lapNum)) ›") { replace(with: next) }
                        .accessibilityLabel("Next lap with video, lap \(String(next.lapNum))")
                }
            }
            .teStyle(.sm)
            .tint(Color(.accentInk))
        }
    }

    private func replace(with lap: Lap) {
        let route = owner.link(.lap(eventId: eventId, sessionId: sessionId, lapId: lap.id))
        if router.path.isEmpty {
            router.push(route)
        } else {
            router.path[router.path.count - 1] = route
        }
    }

    /// *Compare laps*: this lap against its reference, on the two-sided stage.
    private func compareButton(_ view: Detail) -> some View {
        Button {
            router.push(owner.link(.sessionCompare(eventId: eventId, sessionId: sessionId, lapId: lapId)))
        } label: {
            Label("Compare laps", systemImage: "chart.xyaxis.line")
        }
        .buttonStyle(TEButtonStyle(kind: .quiet))
        .accessibilityIdentifier("compareLaps")
    }

    /// A lap with no channel entry: its time and a sentence, today's player for
    /// a clip, and the best lap's line when this is the best.
    private func plainContent(_ view: Detail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(view)

                // The best-lap video (NS-45), above the trace: the lap as it
                // was driven, then the lap as it was measured.
                LapVideoSection(session: view.session, lap: view.lap, reload: { await model?.reload() })

                if Self.canCompare(view) {
                    compareButton(view)
                }

                if let trace = view.trace {
                    TECard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Racing line — brighter is faster")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textFaint))
                            TrackMapView(trace: trace, markers: view.markers)
                                .frame(height: 220)
                            LimitLegend(markers: view.markers)
                        }
                    }
                } else {
                    TEEmpty(
                        "No telemetry for this lap. Import a session, or record laps with the app, and its racing line and traces land here.",
                        // The importer for this lap's own event (#342) — the
                        // step that puts telemetry here. Not for a coach.
                        action: owner.isReadOnly ? nil : TEEmpty.Action("Import a session") {
                            router.push(.importVideo(eventId: eventId, incoming: nil), at: layout.layoutClass)
                        }
                    )
                }
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func header(_ view: Detail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(LapTime.fmtMs(view.lap.timeMs))
                .teStyle(.h1)
                .foregroundStyle(Color(.textStrong))
            Text(Self.subtitle(view))
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("lapDetail")
    }

    /// The lap's numbers, from the same reduction the two-lap compare's head-to-head
    /// uses. A figure the lap didn't store is a row that isn't there.
    private func facts(_ m: CompareLaps.Metrics) -> some View {
        let rows: [(String, String)] = ([
            m.topSpeedKph.map { ("Top speed", mph($0)) },
            m.minSpeedKph.map { ("Min speed", mph($0)) },
            m.avgSpeedKph.map { ("Avg speed", mph($0)) },
            m.maxRpm.map { ("Max RPM", "\(Gears.fmtRpm($0)) rpm") },
            m.maxLatG.map { ("Max lateral G", String(format: "%.2f G", $0)) },
            m.fullThrottlePct.map { ("Full throttle", "\(Int($0.rounded()))% of lap") },
            m.brakingPct.map { ("On the brakes", "\(Int($0.rounded()))% of lap") },
        ] as [(String, String)?]).compactMap { $0 }
        return TECard {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Divider().overlay(Color(.borderHairline))
                    }
                    HStack(spacing: 8) {
                        Text(row.0)
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                        Spacer(minLength: 8)
                        Text(row.1)
                            .teStyle(.lapTime)
                            .foregroundStyle(Color(.textStrong))
                    }
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    /// Speed in the account's unit system, as the rest of the app shows it.
    private func mph(_ kph: Double) -> String {
        Units.fmtSpeedKph(kph, auth.units)
    }
}
