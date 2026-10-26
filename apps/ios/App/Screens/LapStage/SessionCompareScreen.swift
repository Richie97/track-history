import SwiftUI
import TrackEvolutionKit

/// A session's laps against each other, on the two-sided lap stage (NS-51).
///
/// A pushed destination (`Route.sessionCompare`), Android's `SessionCompareScreen`:
/// the lap page's *Compare laps*, and the event page's below expanded width,
/// where it used to be a sheet — one fewer `.sheet` on a page that already
/// presents one. The stage's sides follow the panel's lit laps through
/// `VideoSync.stageSides`: A is the lap the view was opened for while it is
/// lit, else the most recently lit, and B the fastest other lit lap. With fewer
/// than two lit, the stage is one-sided.
struct SessionCompareScreen: View {
    let eventId: Int
    let sessionId: Int
    /// The lap the view was opened for, or nil for the session's own default.
    let lapId: Int?

    @Environment(AuthController.self) private var auth
    @Environment(\.logbookOwner) private var owner
    @Environment(SyncModeStore.self) private var syncMode
    @State private var model: EventModel?
    @State private var stage: LapStageModel?
    @State private var lit: [Int] = []

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let detail = model.detail {
                if let session = detail.sessions.first(where: { $0.id == sessionId }),
                   let channels = session.channels, !channels.laps.isEmpty, let stage {
                    content(session, channels, stage)
                } else {
                    TEPage {
                        TEEmpty("This session has no laps with telemetry to compare.")
                    }
                }
            }
        }
        .background(Color(.bgPage))
        .navigationTitle("Compare laps")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let api = auth.api.scoped(to: owner)
                let model = EventModel(api: api, eventId: eventId)
                self.model = model
                stage = LapStageModel(mode: syncMode.mode, store: syncMode) { clip in
                    try await api.clipURL(id: clip.id).url
                }
                await model.load()
            }
        }
    }

    private var pro: Bool { owner.canViewChannels(viewer: auth.entitlement) }

    private var playsVideo: Bool {
        Entitlement.canSaveLapVideo(owner.channelEntitlement(viewer: auth.entitlement))
    }

    private func content(_ session: Session, _ channels: SessionChannels, _ stage: LapStageModel) -> some View {
        let matched = ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)
        let opened = lapId.flatMap { id in matched.first { $0.lap.id == id && $0.hasChannels }?.chIdx }
        return LapStageView(model: stage, compare: true) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.label ?? "Session")
                    .teStyle(.h2)
                    .foregroundStyle(Color(.textStrong))
                Text("Light laps to compare — the fastest lit lap is B. Tap a chart to move the videos there.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
        } content: {
            LapChannelPanel(
                channels: channels,
                laps: session.laps,
                preselect: Self.preselect(matched, opened: opened),
                pro: pro,
                playhead: stage.playhead,
                onSeek: { stage.seek(toGridA: $0) },
                onLitChange: { lit = $0 }
            )
        }
        .task(id: StageKey(lit: lit, clips: session.laps.map(\.clip), playsVideo: playsVideo, pro: pro)) {
            stage.configure(
                Self.inputs(
                    session: session, channels: channels, matched: matched, lit: lit, opened: opened,
                    playsVideo: playsVideo, pro: pro
                ),
                trace: session.trace.flatMap { $0.count >= 10 ? $0 : nil },
                corners: Corners.sessionCorners(channels)
            )
        }
    }

    private struct StageKey: Hashable {
        var lit: [Int]
        var clips: [LapClip?]
        var playsVideo: Bool
        var pro: Bool
    }

    /// What the panel lights first: the opened lap and the session's best
    /// beside it, or the panel's own default (the fastest) with no lap named.
    static func preselect(_ matched: [ChannelGraphs.LapMatch], opened: Int?) -> [Int]? {
        guard let opened else { return nil }
        guard let best = matched.filter(\.hasChannels).min(by: { $0.lap.timeMs < $1.lap.timeMs }),
              best.chIdx != opened
        else { return [opened] }
        return [opened, best.chIdx]
    }

    /// The stage's sides from the lit laps. A free account's stage is one-sided:
    /// the delta and B are Pro.
    static func inputs(
        session: Session, channels: SessionChannels, matched: [ChannelGraphs.LapMatch],
        lit: [Int], opened: Int?, playsVideo: Bool, pro: Bool
    ) -> [StageSideInput] {
        guard let picks = VideoSync.stageSides(lit, channels.laps, opened) else { return [] }
        let best = session.laps.map(\.timeMs).min()
        let side = { (key: VideoSync.SideKey, chIdx: Int) -> StageSideInput? in
            guard channels.laps.indices.contains(chIdx), let match = matched.first(where: { $0.chIdx == chIdx })
            else { return nil }
            return StageSideInput(
                key: key, entry: channels.laps[chIdx], dStepM: channels.dStepM,
                clip: playsVideo ? match.lap.clip : nil, chIdx: chIdx,
                lapNum: match.lap.lapNum, timeMs: match.lap.timeMs, isBest: match.lap.timeMs == best
            )
        }
        var out = [side(.A, picks.a)].compactMap(\.self)
        if pro, let b = picks.b, let input = side(.B, b) { out.append(input) }
        return out
    }
}
