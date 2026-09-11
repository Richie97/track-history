import SwiftUI
import TrackEvolutionKit

/// The event page's right-hand column at expanded width (spec: NS-34 ticket 3).
///
/// The best-lap **track map above the channel panel**, for the session selected in
/// the page beside it, so that map and charts are in one eyeline. That ordering is
/// the point of the column rather than a preference: on a phone the panel is a
/// sheet *over* the map, which is why the web's hover behaviour — mark the
/// distance across the charts, ring the place on the map — has never been worth
/// porting. A window wide enough to show both at once is what makes it worth
/// having, and this is the container that provides it.
///
/// It has **its own `ScrollView`** and is a sibling of the page's `List`, never a
/// row inside it. `LapChannelChart` documents why: a chart of that many marks
/// inside a `List` row never settles.
struct AnalysisColumn: View {
    let detail: EventDetail
    @Binding var selectedSessionId: Int?

    /// Where the panel is pointing, if anywhere — the friction circle's tapped
    /// sample. Held here rather than in the panel because the *map* is what
    /// answers it, and the map is this column's, not the panel's.
    @State private var hit: ChannelHit?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TESpacing.gridGap) {
                if let session = selected {
                    traceCard(session)
                    panel(session)
                } else {
                    empty
                }
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.bgPage))
        .accessibilityIdentifier("analysisColumn")
    }

    /// The selected session, falling back to nothing rather than to an arbitrary
    /// one: a column showing a session the page has not highlighted would be
    /// answering a question nobody asked.
    private var selected: Session? {
        guard let id = selectedSessionId else { return nil }
        return detail.sessions.first { $0.id == id }
    }

    /// The racing line of the selected session — its own trace, not the event's
    /// best, because the charts under it are this session's.
    @ViewBuilder
    private func traceCard(_ session: Session) -> some View {
        if let trace = session.trace, !trace.isEmpty {
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Brighter is faster")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                        Spacer()
                        TETime(ms: session.bestLapMs, emphasized: true)
                    }
                    let markers = EventScreen.limitMarkers(session)
                    TrackMapView(
                        trace: trace,
                        markers: markers,
                        highlight: ringedIndex(session, trace: trace)
                    )
                    .frame(height: 240)
                    LimitLegend(markers: markers)
                }
            }
        }
    }

    @ViewBuilder
    private func panel(_ session: Session) -> some View {
        if let channels = session.channels, !ChannelGraphs.presentChannels(channels).isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(session.label ?? "Channel graphs")
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                LapChannelChart(channels: channels, laps: session.laps, onHit: { hit = $0 })
                    // Keyed by session: `lit` holds *channel-lap indexes*, which
                    // mean different laps in a different session, so carrying them
                    // across would light the wrong ones. Remembering tab and lit
                    // state per session id — which NS-34 asks for — needs the
                    // panel to hand that state back out, and is deferred rather
                    // than faked; see the note on #217.
                    .id(session.id)
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "chart.xyaxis.line")
                .teStyle(.h1)
                .foregroundStyle(Color(.textFaint))
            Text(hasAnyChannels ? "Pick a session" : "No channel data yet")
                .teStyle(.h3)
                .foregroundStyle(Color(.textStrong))
            Text(
                hasAnyChannels
                    ? "Choose a session's channel graphs to see them here."
                    : "Import a video or record laps on the phone, and the channels land here."
            )
            .teStyle(.sm)
            .foregroundStyle(Color(.textMuted))
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    /// Where to ring the map for the current hit, or nil for "don't".
    ///
    /// The stored trace is **one lap** — the session's best — so a sample from
    /// any other lap has no place on it, and ringing one anyway would put the
    /// mark where that lap never was. Same constraint the limit marks work under
    /// (`Limits.limitMarkers`), and the same rule the web states in `bindBalance`:
    /// a hit with no lap of its own (`chIdx` nil) is a place every lap shares, so
    /// it rings whichever lap the trace is.
    private func ringedIndex(_ session: Session, trace: [TracePoint]) -> Int? {
        guard let hit else { return nil }
        if let chIdx = hit.chIdx, chIdx != Self.tracedChannelIndex(session) { return nil }
        return TrackMap.traceIndexAtFraction(trace, hit.frac)
    }

    /// The channel-lap the stored trace was drawn from: the session's fastest lap
    /// that has channel data, matched the way the panel matches them.
    private static func tracedChannelIndex(_ session: Session) -> Int? {
        guard let channels = session.channels, !channels.laps.isEmpty else { return nil }
        return ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)
            .filter(\.hasChannels)
            .min { $0.lap.timeMs < $1.lap.timeMs }?
            .chIdx
    }

    private var hasAnyChannels: Bool {
        detail.sessions.contains { session in
            session.channels.map { !ChannelGraphs.presentChannels($0).isEmpty } ?? false
        }
    }
}
