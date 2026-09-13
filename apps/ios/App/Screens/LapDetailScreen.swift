import SwiftUI
import TrackEvolutionKit

/// One lap of one session: its time, its racing line when it is the lap the
/// session's trace was drawn from, its channel traces, and a door to the
/// multi-lap compare (#267).
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
/// The compare sheet hangs off its *button*, the way `ProUpsellCard`'s paywall
/// does: a second `.sheet` on a view that already presents one is the SwiftUI
/// hazard documented on `VehicleScreen`, and the panel below carries an upsell
/// of its own on a free account.
struct LapDetailScreen: View {
    let eventId: Int
    let sessionId: Int
    let lapId: Int

    @Environment(AuthController.self) private var auth
    @State private var model: EventModel?

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
                let model = EventModel(api: auth.api, eventId: eventId)
                self.model = model
                await model.load()
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
    }

    static func build(_ detail: EventDetail, sessionId: Int, lapId: Int) -> Detail? {
        guard let session = detail.sessions.first(where: { $0.id == sessionId }),
              let lap = session.laps.first(where: { $0.id == lapId })
        else { return nil }
        let best = session.bestLapMs ?? lap.timeMs
        let isBest = lap.timeMs == best
        var chIdx: Int?
        var channels: SessionChannels?
        if let stored = session.channels, !stored.laps.isEmpty,
           let match = ChannelGraphs.matchLapsToChannels(session.laps, stored.laps).first(where: { $0.lap.id == lap.id }),
           match.hasChannels {
            chIdx = match.chIdx
            channels = SessionChannels(v: 1, dStepM: stored.dStepM, laps: [stored.laps[match.chIdx]])
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
            markers: traced ? EventScreen.limitMarkers(session) : []
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

    // MARK: - Content

    @ViewBuilder
    private func content(_ view: Detail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(view)

                if Self.canCompare(view) {
                    CompareLapsButton(session: view.session, preselect: Self.comparePreselect(view))
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
                }

                if let channels = view.channels, let entry = channels.laps.first {
                    facts(CompareLaps.lapMetrics(entry))
                    Text("Tap a chart to read values.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    LapChannelPanel(
                        channels: channels,
                        laps: [view.lap],
                        preselect: [0],
                        pro: Entitlement.canViewChannels(auth.entitlement)
                    )
                } else if view.trace == nil {
                    TEEmpty("No telemetry for this lap. Record with the app or import a video, and its racing line and traces land here.")
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

/// The door to the session's multi-lap overlay — the same sheet the event page's
/// *Compare laps* control presents — with this lap lit first.
private struct CompareLapsButton: View {
    let session: Session
    let preselect: [Int]?

    @Environment(AuthController.self) private var auth
    @State private var comparing = false

    var body: some View {
        Button {
            comparing = true
        } label: {
            Label("Compare laps", systemImage: "chart.xyaxis.line")
        }
        .buttonStyle(TEButtonStyle(kind: .quiet))
        .accessibilityIdentifier("compareLaps")
        .sheet(isPresented: $comparing) {
            NavigationStack {
                LapChannelChart(
                    channels: session.channels ?? SessionChannels(v: 1, dStepM: 20, laps: []),
                    laps: session.laps,
                    preselect: preselect,
                    pro: Entitlement.canViewChannels(auth.entitlement)
                )
                .navigationTitle(session.label ?? "Compare laps")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { comparing = false }
                    }
                }
            }
        }
    }
}
