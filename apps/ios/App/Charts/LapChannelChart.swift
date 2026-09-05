import Charts
import SwiftUI
import TrackEvolutionKit

/// The lap overlay: every lap of an imported session drawn on one driven-distance
/// axis, so the laps line up corner-for-corner and you can see *where* the fast lap
/// was fast.
///
/// `public/js/channel-graphs.js` is the reference for behavior — up to three laps
/// highlighted at once in the `--chart-line` / `-b` / `-c` slots with the rest a dim
/// envelope, best lap pre-selected, the chips doubling as the legend so a lap is
/// never identified by color alone. The maths is in the Kit's `ChannelGraphs`; this
/// file is drawing and gesture.
///
/// **A screen of its own, presented as a sheet, rather than the web version's
/// collapsible panel.** Two reasons, one of them load-bearing: three stacked charts
/// want the whole width and most of the height of a phone, and — the load-bearing one
/// — a chart of this many marks inside the event page's `List` row never settles.
/// The row is measured over and over, the app stops idling, and the page goes with
/// it. In a sheet's own `ScrollView` it lays out once and draws instantly.
///
/// The data only ever comes from the *web* telemetry importer (`sessions.channels`)
/// — file import is deliberately not ported — so a natively-recorded session has
/// nothing to show here and the event page offers no way in.
struct LapChannelChart: View {
    let channels: SessionChannels
    let laps: [Lap]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Laps on a shared distance axis — tap laps to compare (up to 3), tap a chart to read values. With 2+ laps selected, the Time tab's delta chart shows where time is gained or lost vs the fastest; the other tabs show why.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
                LapChannelPanel(channels: channels, laps: laps)
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.bgPage))
    }
}

/// The chips, the delta chart and the stacked channel charts, embeddable in any
/// scroller — `LapChannelChart` above wraps it as the event page's sheet, and
/// `CompareLapsScreen` embeds it under the head-to-head table with both laps of
/// the pair pre-highlighted.
struct LapChannelPanel: View {
    let channels: SessionChannels
    let laps: [Lap]
    /// Channel-lap indexes to start highlighted, in slot order. nil means the
    /// fastest lap, which is what the event page's overlay wants.
    var preselect: [Int]? = nil

    /// Channel-lap indexes in slot order — oldest first, so the eviction in
    /// `ChannelGraphs.toggle` drops the one you selected longest ago.
    @State private var lit: [Int] = []
    /// The grid point the read-out is parked on. Shared across the stacked charts
    /// because they share the distance axis: tapping the speed trace at the braking
    /// zone also shows you the RPM and the lateral G there.
    @State private var readout: Int?

    /// The slot colors, in the order laps take them.
    private static let slots: [Color] = [Color(.chartLine), Color(.chartLineB), Color(.chartLineC)]

    private var matches: [ChannelGraphs.LapMatch] {
        ChannelGraphs.matchLapsToChannels(laps, channels.laps)
    }

    private var present: [ChannelGraphs.Channel] {
        ChannelGraphs.presentChannels(channels)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            chips
            // One question per tab (epic #193). Only populated tabs are offered,
            // and a single one renders flat — a tab bar with one tab in it is a
            // control that does nothing.
            let tabs = populatedTabs
            if tabs.count > 1 {
                tabBar(tabs)
            }
            ForEach(tabs, id: \.self) { tabKey in
                if tabs.count == 1 || tabKey == selectedTab {
                    tabContent(tabKey)
                }
            }
        }
        .onAppear {
            if lit.isEmpty { lit = preselect ?? ChannelGraphs.initialSelection(matches) }
        }
    }

    // MARK: - Tabs

    /// The panel's tabs, in order — `TABS` in `public/js/channel-graphs.js`.
    /// Car is reserved for the per-lap scalars (#190) and so draws nothing yet;
    /// it is listed here so the two implementations stay diffable.
    enum Tab: String, CaseIterable, Hashable {
        case time, inputs, grip, car

        var label: String {
            switch self {
            case .time: "Time"
            case .inputs: "Inputs"
            case .grip: "Grip"
            case .car: "Car"
            }
        }
    }

    /// Which tab a channel's chart lands on — `TAB_OF` in the JS.
    private static func tab(of channel: ChannelGraphs.Channel) -> Tab {
        switch channel {
        case .speed: .time
        case .throttle, .brake, .steering, .rpm: .inputs
        case .latG: .grip
        }
    }

    @State private var tab: Tab?

    /// The tab actually shown: the selection when it still has content, else the
    /// first populated one — a lap selection that empties a tab must not leave
    /// the panel blank.
    private var selectedTab: Tab? {
        let tabs = populatedTabs
        if let tab, tabs.contains(tab) { return tab }
        return tabs.first
    }

    private var populatedTabs: [Tab] {
        Tab.allCases.filter { hasContent($0) }
    }

    private func hasContent(_ tabKey: Tab) -> Bool {
        switch tabKey {
        case .time:
            return true // the sector table and the speed chart both live here
        case .inputs, .grip:
            return present.contains { Self.tab(of: $0) == tabKey }
        case .car:
            return false // reserved for the per-lap scalars (#190)
        }
    }

    private func tabBar(_ tabs: [Tab]) -> some View {
        HStack(spacing: 2) {
            ForEach(tabs, id: \.self) { tabKey in
                let on = tabKey == selectedTab
                Button {
                    tab = tabKey
                    Haptics.select()
                } label: {
                    Text(tabKey.label)
                        .teStyle(.sm)
                        .foregroundStyle(on ? Color(.accentContrast) : Color(.textMuted))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(on ? Color(.accent) : .clear, in: .capsule)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tabKey.label)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(Color(.surfaceRaised), in: .capsule)
        .overlay(Capsule().strokeBorder(Color(.borderHairline), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("channelTabs")
    }

    @ViewBuilder
    private func tabContent(_ tabKey: Tab) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            switch tabKey {
            case .time:
                // Sector splits + theoretical best for the highlighted laps (#146).
                SectorTable(channels: channels, lit: lit, slots: Self.slots, lapNumber: lapNumber(forLapIndex:))
                deltaChart
            case .inputs:
                // The session's shift points (#187) above the traces they explain.
                ShiftTable(channels: channels)
            case .grip, .car:
                EmptyView()
            }
            ForEach(present.filter { Self.tab(of: $0) == tabKey }, id: \.self) { channel in
                channelChart(channel)
                // The gear ribbon rides under the RPM trace, where each shift is
                // the drop in the sawtooth above it (#187).
                if channel == .rpm {
                    GearRibbon(
                        channels: channels, lit: lit, slots: Self.slots,
                        lapNumber: lapNumber(forLapIndex:)
                    )
                }
            }
        }
    }

    // MARK: - Lap chips

    /// The legend and the selector in one control, as on the web: a lap's color is
    /// only ever readable next to its number.
    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(matches.filter(\.hasChannels), id: \.chIdx) { match in
                    chip(match)
                }
            }
            .padding(.vertical, 2)
        }
        .contentShape(.rect)
    }

    private func chip(_ match: ChannelGraphs.LapMatch) -> some View {
        let color = color(forLapIndex: match.chIdx)
        let isBest = match.lap.timeMs == laps.map(\.timeMs).min()
        return Button {
            lit = ChannelGraphs.toggle(match.chIdx, in: lit)
            Haptics.select()
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(color ?? Color(.chartDim))
                    .frame(width: 8, height: 8)
                Text("Lap \(String(match.lap.lapNum))\(isBest ? " ★" : "")")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                Text(LapTime.fmtMs(match.lap.timeMs))
                    .teStyle(.lapTime)
                    .foregroundStyle(Color(.textStrong))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: TERadius.sm)
                    .strokeBorder(color ?? Color(.borderHairline), lineWidth: color == nil ? 1 : 1.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Lap \(String(match.lap.lapNum)), \(LapTime.fmtMs(match.lap.timeMs))")
        .accessibilityAddTraits(color == nil ? [] : .isSelected)
    }

    /// A lap's highlight color, or nil when it's part of the dim envelope.
    private func color(forLapIndex chIdx: Int) -> Color? {
        guard let slot = lit.firstIndex(of: chIdx), slot < Self.slots.count else { return nil }
        return Self.slots[slot]
    }

    // MARK: - One channel's overlay

    @ViewBuilder
    private func channelChart(_ channel: ChannelGraphs.Channel) -> some View {
        if let domain = ChannelGraphs.valueDomain(channel, in: channels) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(channel.label) (\(channel.unit))")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textMuted))
                    Spacer()
                    if let readout {
                        Text(readoutText(channel, at: readout))
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textStrong))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                // One flat array of points through a single `ForEach`, and nothing
                // else in the builder — not a `RuleMark` for the read-out, not an
                // `if`. Mixing mark kinds here makes the builder's content type a
                // nested tuple over a few hundred marks per lap, and the app wedges
                // in layout before it ever draws (it did; the read-out's rule is a
                // two-point line in this same array instead, see `samples`).
                Chart {
                    ForEach(samples(channel, domain), id: \.id) { sample in
                        LineMark(
                            x: .value("Distance", sample.distance),
                            y: .value(channel.label, sample.value),
                            series: .value("Lap", sample.lapIndex)
                        )
                        .foregroundStyle(sample.color)
                        .lineStyle(.init(lineWidth: sample.lineWidth, lineCap: .round, lineJoin: .round))
                        // A trace is a sampled path, not a curve fit through it.
                        .interpolationMethod(.linear)
                        // Suppressed *per mark*, which is the only level that works:
                        // Swift Charts publishes an accessibility element for every
                        // mark, and hiding the chart as a whole doesn't prune them.
                        // A few hundred per lap makes the hierarchy so large that
                        // asking for a snapshot of it — which VoiceOver and every UI
                        // test do — never returns. The chart's summary is on the
                        // container below; point-by-point is not what a chart says.
                        .accessibilityHidden(true)
                    }
                }
                .chartYScale(domain: domain.low...domain.high)
                .chartXScale(domain: 0...max(1, ChannelGraphs.distanceSpan(channel, in: channels)))
                // Limit bands (#188) go in the *background* rather than as marks:
                // a `RectangleMark` beside the lines would break the one
                // homogeneous `ForEach` rule above, and these shade the plot
                // rather than plotting anything.
                .chartBackground { proxy in
                    limitBands(channel, proxy: proxy)
                }
                .chartYAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) { value in
                        AxisGridLine().foregroundStyle(Color(.chartGrid))
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text(fmtValue(v, channel)).teStyle(.xxs)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { value in
                        AxisGridLine().foregroundStyle(Color(.chartGrid))
                        AxisValueLabel {
                            if let d = value.as(Double.self) {
                                Text(ChannelGraphs.fmtDist(d)).teStyle(.xxs)
                            }
                        }
                    }
                }
                .foregroundStyle(Color(.textMuted))
                .frame(height: 150)
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(.rect)
                            .onTapGesture { location in
                                readOut(at: location, channel, proxy: proxy, geometry: geometry)
                            }
                    }
                }
                // Belt and braces with the per-mark suppression above: this alone does
                // *not* prune the marks — that is what the per-mark modifier is for —
                // but it does keep the plot's own furniture out of the hierarchy.
                .accessibilityHidden(true)
            }
            // So the chart reads as one element with the summary below, which is what
            // a chart should say.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(channel.label) by driven distance, per lap")
            .accessibilityValue(summary(channel))
        }
    }

    // MARK: - Limit bands

    /// Where the car was at its limit, shaded behind the trace that explains it
    /// (#188): ABS and lockup on the brake chart, traction control and
    /// wheelspin on the throttle, stability control on steering. One band per
    /// highlighted lap, so the map, the panel and the session line tell one
    /// story. Colour is by *kind*, not severity — a corner where traction
    /// control cuts is a throttle problem and one where ABS cuts is a braking
    /// problem, and the driver needs to know which.
    @ViewBuilder
    private func limitBands(_ channel: ChannelGraphs.Channel, proxy: ChartProxy) -> some View {
        let kinds = Limits.LIMIT_KINDS.filter { $0.channel == channel }
        if !kinds.isEmpty {
            GeometryReader { geometry in
                if let plotFrame = proxy.plotFrame {
                    let plot = geometry[plotFrame]
                    ForEach(bands(kinds), id: \.id) { band in
                        if let x0 = proxy.position(forX: band.from), let x1 = proxy.position(forX: band.to) {
                            Rectangle()
                                .fill(Self.color(band.side).opacity(band.filled ? 0.22 : 0.12))
                                .frame(width: max(1, x1 - x0), height: plot.height)
                                .position(x: plot.minX + (x0 + x1) / 2, y: plot.midY)
                        }
                    }
                }
            }
            .allowsHitTesting(false)
        }
    }

    /// One shaded stretch of the distance axis.
    private struct Band {
        let id: String
        let from: Double
        let to: Double
        let side: Limits.Side
        let filled: Bool
    }

    private func bands(_ kinds: [Limits.Kind]) -> [Band] {
        var out: [Band] = []
        for chIdx in lit where channels.laps.indices.contains(chIdx) {
            let entry = channels.laps[chIdx]
            for run in Limits.limitRuns(entry) {
                guard let kind = kinds.first(where: { $0.key == run.kind }) else { continue }
                out.append(
                    Band(
                        id: "\(chIdx)-\(run.kind)-\(run.k0)",
                        from: max(0, Double(run.k0) - 0.5) * channels.dStepM,
                        to: (Double(run.k1) + 0.5) * channels.dStepM,
                        side: kind.side,
                        filled: kind.filled
                    )
                )
            }
        }
        return out
    }

    /// A side's colour. Generated tokens, never a hex literal, and the map draws
    /// from the same two so a mark and its band cannot disagree.
    static func color(_ side: Limits.Side) -> Color {
        switch side {
        case .brake: Color(.limitBrake)
        case .power: Color(.limitPower)
        case .stability: Color(.textStrong)
        }
    }

    // MARK: - Lap delta

    /// The delta chart: highlighted laps vs the fastest of the selection, on
    /// the same distance axis as the channels below it. Positive is slower, so
    /// a climbing trace is time slipping away. The reference lap draws no
    /// trace — it *is* the zero line. The maths is `ChannelGraphs.deltaSeries`,
    /// pinned to the web implementation by `contracts/logic/lap-delta.json`.
    @ViewBuilder
    private var deltaChart: some View {
        if let refIdx = ChannelGraphs.deltaReference(lit, in: channels) {
            let deltas: [(chIdx: Int, series: [Double])] = lit
                .filter { $0 != refIdx && channels.laps.indices.contains($0) }
                .compactMap { chIdx in
                    ChannelGraphs.deltaSeries(channels.laps[chIdx], channels.laps[refIdx], channels.dStepM)
                        .map { (chIdx, $0) }
                }
            if !deltas.isEmpty, let domain = ChannelGraphs.deltaDomain(deltas.map(\.series)) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Delta (s) vs lap \(String(lapNumber(forLapIndex: refIdx))) — above the line is slower")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textMuted))
                        Spacer()
                        if let readout {
                            Text(deltaReadoutText(deltas, refIdx: refIdx, at: readout))
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textStrong))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                    // Same one-homogeneous-ForEach rule as the channel charts
                    // (see the comment there): the zero line and the read-out
                    // rule are two-point series inside the same sample array.
                    Chart {
                        ForEach(deltaSamples(deltas, domain), id: \.id) { sample in
                            LineMark(
                                x: .value("Distance", sample.distance),
                                y: .value("Delta", sample.value),
                                series: .value("Lap", sample.lapIndex)
                            )
                            .foregroundStyle(sample.color)
                            .lineStyle(.init(lineWidth: sample.lineWidth, lineCap: .round, lineJoin: .round))
                            .interpolationMethod(.linear)
                            .accessibilityHidden(true)
                        }
                    }
                    .chartYScale(domain: domain.low...domain.high)
                    .chartXScale(domain: 0...max(1, ChannelGraphs.distanceSpan(.speed, in: channels)))
                    .chartYAxis {
                        AxisMarks(values: .automatic(desiredCount: 3)) { value in
                            AxisGridLine().foregroundStyle(Color(.chartGrid))
                            AxisValueLabel {
                                if let v = value.as(Double.self) {
                                    Text(Self.fmtDelta(v, decimals: 1)).teStyle(.xxs)
                                }
                            }
                        }
                    }
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4)) { value in
                            AxisGridLine().foregroundStyle(Color(.chartGrid))
                            AxisValueLabel {
                                if let d = value.as(Double.self) {
                                    Text(ChannelGraphs.fmtDist(d)).teStyle(.xxs)
                                }
                            }
                        }
                    }
                    .foregroundStyle(Color(.textMuted))
                    .frame(height: 150)
                    .chartOverlay { proxy in
                        GeometryReader { geometry in
                            Rectangle().fill(.clear).contentShape(.rect)
                                .onTapGesture { location in
                                    readOut(at: location, .speed, proxy: proxy, geometry: geometry)
                                }
                        }
                    }
                    .accessibilityHidden(true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Time delta to lap \(String(lapNumber(forLapIndex: refIdx))) by driven distance — above the zero line is slower")
                .accessibilityValue(deltaSummary(deltas, refIdx: refIdx))
            }
        }
    }

    /// Delta traces in painter's order plus the zero line (the reference lap)
    /// and, last, the read-out's vertical rule — all in one homogeneous array.
    private func deltaSamples(
        _ deltas: [(chIdx: Int, series: [Double])], _ domain: (low: Double, high: Double)
    ) -> [Sample] {
        var out: [Sample] = []
        let span = max(1, ChannelGraphs.distanceSpan(.speed, in: channels))
        for (k, x) in [0.0, span].enumerated() {
            out.append(Sample(id: -10 - k, lapIndex: -2, distance: x, value: 0, color: Color(.textFaint), lineWidth: 1))
        }
        for (chIdx, series) in deltas {
            let color = color(forLapIndex: chIdx) ?? Color(.chartDim)
            for (k, v) in series.enumerated() {
                out.append(
                    Sample(
                        id: chIdx * 100_000 + k,
                        lapIndex: chIdx,
                        distance: Double(k) * channels.dStepM,
                        value: v,
                        color: color,
                        lineWidth: 2
                    )
                )
            }
        }
        if let readout {
            let x = Double(readout) * channels.dStepM
            for (k, y) in [domain.low, domain.high].enumerated() {
                out.append(Sample(id: -1 - k, lapIndex: -1, distance: x, value: y, color: Color(.textFaint), lineWidth: 1))
            }
        }
        return out
    }

    /// "1.2 km · L3 +0.42 s" — the distance once, then each lap's delta to the
    /// reference at that point.
    private func deltaReadoutText(_ deltas: [(chIdx: Int, series: [Double])], refIdx: Int, at index: Int) -> String {
        let values = deltas.compactMap { (chIdx, series) -> String? in
            guard series.indices.contains(index) else { return nil }
            return "L\(String(lapNumber(forLapIndex: chIdx))) \(Self.fmtDelta(series[index], decimals: 2)) s"
        }
        let distance = ChannelGraphs.fmtDist(Double(index) * channels.dStepM)
        return values.isEmpty ? distance : "\(distance) · \(values.joined(separator: " · "))"
    }

    /// What VoiceOver gets: where each lap ends up against the reference.
    private func deltaSummary(_ deltas: [(chIdx: Int, series: [Double])], refIdx: Int) -> String {
        let parts = deltas.compactMap { (chIdx, series) -> String? in
            guard let last = series.last else { return nil }
            return "Lap \(String(lapNumber(forLapIndex: chIdx))), \(Self.fmtDelta(last, decimals: 2)) seconds vs lap \(String(lapNumber(forLapIndex: refIdx)))"
        }
        return parts.isEmpty ? "No comparable laps" : parts.joined(separator: ". ")
    }

    /// "+0.4" / "−0.4" — the sign is the message, so it is always shown.
    private static func fmtDelta(_ value: Double, decimals: Int) -> String {
        let rounded = (value * pow(10, Double(decimals))).rounded() / pow(10, Double(decimals))
        let magnitude = String(format: "%.\(decimals)f", abs(rounded))
        return rounded < 0 ? "−\(magnitude)" : "+\(magnitude)"
    }

    /// One point of one lap's trace, ready to plot.
    private struct Sample: Identifiable {
        let id: Int
        let lapIndex: Int
        let distance: Double
        let value: Double
        let color: Color
        let lineWidth: CGFloat
    }

    /// Every lap's points for a channel, flattened in painter's order: the dim
    /// envelope first, then the highlighted laps in slot order, so the lap you
    /// selected first is never buried under the ones you didn't — plus, last, the
    /// read-out's vertical rule as a two-point series of its own.
    private func samples(_ channel: ChannelGraphs.Channel, _ domain: (low: Double, high: Double)) -> [Sample] {
        let dim = channels.laps.indices.filter { !lit.contains($0) }
        var out: [Sample] = []
        for chIdx in dim + lit {
            guard let series = channel.series(of: channels.laps[chIdx]) else { continue }
            let color = color(forLapIndex: chIdx)
            for (k, raw) in series.enumerated() {
                out.append(
                    Sample(
                        // Unique across laps: `Chart` identifies marks by this, and a
                        // shared id would collapse the laps into one line.
                        id: chIdx * 100_000 + k,
                        lapIndex: chIdx,
                        distance: Double(k) * channels.dStepM,
                        value: channel.convert(raw),
                        color: color ?? Color(.chartDim),
                        lineWidth: color == nil ? 1 : 2
                    )
                )
            }
        }
        if let readout {
            let x = Double(readout) * channels.dStepM
            for (k, y) in [domain.low, domain.high].enumerated() {
                out.append(
                    Sample(
                        id: -1 - k,
                        // Negative so it can't collide with a lap's series.
                        lapIndex: -1,
                        distance: x,
                        value: y,
                        color: Color(.textFaint),
                        lineWidth: 1
                    )
                )
            }
        }
        return out
    }

    // MARK: - Read-out

    /// Tap to park the read-out on a grid point; tap the same point to clear it.
    ///
    /// A tap rather than a drag, for the reason spelled out in `ProgressChart`: the
    /// charts sit in a scroller, and a `DragGesture` over the plot takes the touch
    /// that would have scrolled it.
    private func readOut(
        at location: CGPoint, _ channel: ChannelGraphs.Channel, proxy: ChartProxy, geometry: GeometryProxy
    ) {
        guard let plotFrame = proxy.plotFrame else { return }
        let x = location.x - geometry[plotFrame].origin.x
        guard let metres: Double = proxy.value(atX: x) else { return }
        let index = ChannelGraphs.gridIndex(atDistance: metres, channel, in: channels)
        if readout == index {
            readout = nil
        } else {
            readout = index
            Haptics.select()
        }
    }

    /// "1.2 km · Lap 3 92 · Lap 5 88" — the distance once, then a value per
    /// highlighted lap in its slot order.
    private func readoutText(_ channel: ChannelGraphs.Channel, at index: Int) -> String {
        let values = lit.compactMap { chIdx -> String? in
            guard let v = ChannelGraphs.value(channel, lapIndex: chIdx, gridIndex: index, in: channels) else {
                return nil
            }
            // What was active there, if anything (#188) — the read-out says "ABS"
            // where the band is shaded, so the two never have to be matched by eye.
            let active = Limits.activeLimitLabels(channels.laps[chIdx], index)
            let suffix = active.isEmpty ? "" : " (\(active.joined(separator: ", ")))"
            return "L\(String(lapNumber(forLapIndex: chIdx))) \(fmtValue(v, channel))\(suffix)"
        }
        let distance = ChannelGraphs.fmtDist(Double(index) * channels.dStepM)
        return values.isEmpty ? distance : "\(distance) · \(values.joined(separator: " · "))"
    }

    /// What VoiceOver gets: the range each highlighted lap covered, not the pixels.
    private func summary(_ channel: ChannelGraphs.Channel) -> String {
        let parts = lit.compactMap { chIdx -> String? in
            guard let series = channel.series(of: channels.laps[chIdx]),
                  let low = series.map(channel.convert).min(),
                  let high = series.map(channel.convert).max()
            else { return nil }
            return """
                Lap \(String(lapNumber(forLapIndex: chIdx))), \
                \(fmtValue(low, channel)) to \(fmtValue(high, channel)) \(channel.unit)
                """
        }
        guard !parts.isEmpty else { return "No lap highlighted" }
        return parts.joined(separator: ". ")
    }

    /// The session's own lap number for a channel entry, so the chips, the read-out
    /// and the lap list above all call the same lap the same thing.
    private func lapNumber(forLapIndex chIdx: Int) -> Int {
        matches.first { $0.chIdx == chIdx }?.lap.lapNum ?? channels.laps[chIdx].n
    }

    private func fmtValue(_ value: Double, _ channel: ChannelGraphs.Channel) -> String {
        String(format: "%.\(channel.decimals)f", value)
    }
}

#if DEBUG
extension LapChannelChart {
    /// The panel on synthetic data, for `-channelGraphs` (see `RootView`) and for
    /// previews. Shaped like a real import: three laps of a 2.4 km circuit on the
    /// importer's 20 m grid, all six charted channels plus the three a PDR import
    /// adds — `gear`, `wheelSlip` and the ABS/TC/VSC `flags` bitfield (#187,
    /// #188) — so the gear ribbon, the shift table and the limit bands all have
    /// something to draw.
    static var demoScreen: some View {
        let times = [118_400, 116_900, 117_600]
        let channels = SessionChannels(
            v: 1,
            dStepM: 20,
            laps: times.enumerated().map { index, ms -> LapChannels in
                let phase = Double(index) * 0.15
                let wave: [Double] = (0..<120).map { k in sin(Double(k) / 9 + phase) }
                let speed: [Double] = wave.map { v in 90 + 60 * v }
                let rpm: [Double] = wave.map { v in 3000 + 3500 * (1 + v) / 2 }
                let latG: [Double] = (0..<120).map { k in abs(cos(Double(k) / 9 + phase)) * 1.2 }
                // Pedals alternate: throttle on the wave's positive half, brake
                // on the negative; steering swings signed degrees.
                let throttle: [Double] = wave.map { v in max(0, v) * 100 }
                let brake: [Double] = wave.map { v in max(0, -v) * 100 }
                let steering: [Double] = (0..<120).map { k in cos(Double(k) / 9 + phase) * 120 }
                // Gear steps with the speed wave, dropping to 0 through one
                // shift — the clutch-in gap the ribbon has to draw as a gap.
                let gear: [Double] = wave.enumerated().map { k, v in
                    k % 37 == 18 ? 0 : Double(2 + Int((v + 1) / 2 * 3))
                }
                // Wheelspin on the exits, lockup into the braking zones; ABS
                // under heavy braking and traction control on the hardest exits.
                let wheelSlip: [Double] = wave.map { v in v * 5 }
                let flags: [Double] = wave.map { v in
                    v < -0.85 ? Double(Limits.FLAG_ABS) : v > 0.9 ? Double(Limits.FLAG_TC) : 0
                }
                return LapChannels(
                    n: index + 1, timeMs: ms, speed: speed, rpm: rpm, latG: latG,
                    throttle: throttle, brake: brake, steering: steering,
                    gear: gear, wheelSlip: wheelSlip, flags: flags
                )
            }
        )
        return LapChannelChart(
            channels: channels,
            laps: times.enumerated().map { index, ms in
                Lap(id: index + 1, sessionId: 1, lapNum: index + 1, timeMs: ms)
            }
        )
    }
}

#Preview {
    LapChannelChart.demoScreen
}
#endif
