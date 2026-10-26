#if DEBUG
import SwiftUI
import TrackEvolutionKit

/// `-lapStage`: the session compare's stage on `LapChannelChart`'s synthetic
/// session, with no server — the `-channelGraphs` pattern. Both laps get a
/// clip cut from one generated H.264 file (`DebugImportFixture.syntheticVideo`,
/// the file `-syntheticClipVideo` cuts from), offset so the line is three
/// seconds in, so two videos run from one transport. `-syncMode time` opens it
/// in *Same time*.
struct LapStageDemo: View {
    @Environment(SyncModeStore.self) private var syncMode
    @State private var stage: LapStageModel?
    @State private var lit: [Int] = []

    private let channels = LapChannelChart.demoChannels
    private let laps = LapChannelChart.demoLaps.enumerated().map { index, lap in
        var lap = lap
        // Every lap a clip: three seconds of run-up, four of roll-out.
        lap.clip = LapClip(
            id: 900 + index, durationMs: lap.timeMs + 7_000, lapOffsetMs: 3_000, sizeBytes: nil, youtube: nil
        )
        return lap
    }

    var body: some View {
        NavigationStack {
            Group {
                if let stage {
                    LapStageView(model: stage, compare: true) {
                        Text("Synthetic session")
                            .teStyle(.h2)
                            .foregroundStyle(Color(.textStrong))
                    } content: {
                        LapChannelPanel(
                            channels: channels, laps: laps, preselect: [1, 0],
                            playhead: stage.playhead, onSeek: { stage.seek(toGridA: $0) },
                            onLitChange: { lit = $0 }
                        )
                    }
                    .task(id: lit) {
                        let matched = ChannelGraphs.matchLapsToChannels(laps, channels.laps)
                        stage.configure(
                            SessionCompareScreen.inputs(
                                session: Self.session(laps: laps, channels: channels), channels: channels,
                                matched: matched, lit: lit, opened: 1, playsVideo: true, pro: true
                            ),
                            trace: Self.trace,
                            corners: Corners.sessionCorners(channels)
                        )
                    }
                }
            }
            .background(Color(.bgPage))
            .navigationTitle("Lap stage")
            .navigationBarTitleDisplayMode(.inline)
            // As on the real routes, so `-tabletop <fraction>` shows the split.
            .publishingFoldGeometry()
        }
        .task {
            guard stage == nil else { return }
            let longest = Double(laps.compactMap(\.clip).map(\.durationMs).max() ?? 0) / 1000
            stage = LapStageModel(mode: syncMode.mode, store: syncMode) { _ in
                try await Self.video(durationS: longest)
            }
        }
    }

    /// One generated file for every clip, made once.
    @MainActor private static var cached: URL?

    @MainActor private static func video(durationS: Double) async throws -> URL {
        if let cached { return cached }
        let url = try await DebugImportFixture.syntheticVideo(durationS: durationS)
        cached = url
        return url
    }

    private static func session(laps: [Lap], channels: SessionChannels) -> Session {
        // Decoded, not built: the Kit's `Session` is decode-only from here.
        let json = """
        {"id": 1, "label": "Synthetic session", "notes": null, "sort": 1, "trace": null,
         "channels": null, "ambient_c": null, "elevation_m": null, "laps": []}
        """
        var session = try! JSONDecoder().decode(Session.self, from: Data(json.utf8))
        session.laps = laps
        return session
    }

    /// A 2.4 km loop, slower where the synthetic speed wave dips.
    private static let trace: [TracePoint] = (0..<120).map { k in
        let a = Double(k) / 120 * 2 * .pi
        return TracePoint(x: 380 * cos(a) + 60 * cos(3 * a), y: 260 * sin(a), v: 25 + 15 * sin(Double(k) / 9))
    }
}
#endif
