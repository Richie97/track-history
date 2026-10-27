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
/// A place on a lap, pointed at from one chart and answered on the others.
///
/// The port of the `hit` the web's `bindGripCircle` / `bindBalance` hand to
/// `onHover` (`{ chIdx, k, d, frac }`), under the same field names. It exists so
/// tapping a sample on the friction circle can mark that distance across every
/// chart *and* ring the place on the track map — the behaviour NS-34 ticket 3
/// takes back from the web now that the panel sits beside the map rather than
/// over it.
///
/// `chIdx` is nil for a place every lap shares — a corner row rather than a
/// sample — which is what tells the map it may ring it whichever lap the trace
/// happens to be.
struct ChannelHit: Equatable {
    var chIdx: Int?
    /// The grid sample index. The panel's read-out is parked here.
    var k: Int
    /// How far round the lap, 0…1. What the map is placed by.
    var frac: Double
}

struct LapChannelChart: View {
    let channels: SessionChannels
    let laps: [Lap]
    /// Channel-lap indexes to light first — see `LapChannelPanel.preselect`. The
    /// lap detail opens the sheet on its own lap beside the session's best (#267).
    var preselect: [Int]? = nil
    /// Whether the account gets the Pro half of the panel — see `LapChannelPanel.pro`.
    var pro = true
    /// Said in place of the upsell under a free panel — see `LapChannelPanel.freeNote`.
    var freeNote: String? = nil
    /// Where the panel is currently pointing, for whatever is drawn beside it.
    var onHit: (ChannelHit?) -> Void = { _ in }
    /// The session's best-lap racing line, for the small map the Traces tab
    /// draws the cursor on — see `LapChannelPanel.mapTrace`. nil where a map is
    /// drawn beside the panel instead (`onCursor`).
    var mapTrace: [TracePoint]? = nil
    /// The cursor's dots, one per lit lap, for a map drawn beside the panel —
    /// see `LapChannelPanel.onCursor`.
    var onCursor: (([TrackMapView.Dot]) -> Void)? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(
                    "Laps on a shared axis, by distance or by time — tap laps to compare (up to 3), tap a chart to mark that place on every chart"
                        + (mapTrace != nil || onCursor != nil ? " and the track map." : ".")
                        + (pro ? " With 2+ laps selected, the delta chart on Traces shows where time is gained or lost vs the fastest; the other tabs show why." : "")
                )
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
                LapChannelPanel(
                    channels: channels, laps: laps, preselect: preselect, pro: pro, freeNote: freeNote, onHit: onHit,
                    mapTrace: mapTrace, onCursor: onCursor
                )
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
    /// Whether the account gets the Pro half of the panel (#264). A free
    /// account's `channels` already arrive with only speed, throttle and brake —
    /// the server strips the rest — but the delta chart, the sector table, the
    /// shift points, the friction circle, the balance read-out and the Car tab
    /// all derive from what is left, so they are the panel's own gate: with
    /// `pro == false` none of them draw, and an upsell card under the charts
    /// says what the rest of the recording would show.
    var pro = true
    /// What a free panel says under its charts **instead of the upsell**, when
    /// the tier being read is not the viewer's to change — a shared event or
    /// session (NS-48) opens to its *owner's* tier, and a viewer with no account
    /// is offered nothing. Nil for the panel's own rules (the upsell, or a
    /// coach's `studentFreeNote`).
    var freeNote: String? = nil
    /// Where the panel is currently pointing (NS-34 ticket 3). Defaulted to a
    /// no-op, because everywhere the panel is a *sheet* there is nothing beside
    /// it to answer.
    var onHit: (ChannelHit?) -> Void = { _ in }
    /// The lap stage's playhead (NS-51), drawn as a line across every
    /// distance-axis chart with a dot on each lit lap's trace. Read **only by the
    /// overlays** — see `LapPlayhead` — so the traces never re-render because it
    /// moved. nil off a stage, and the panel is exactly what it was.
    var playhead: LapPlayhead? = nil
    /// With a stage, a tap on a chart (or a sector heading, a friction-circle
    /// sample, a balance corner) seeks the video to that grid index instead of
    /// parking the read-out — the playhead then *is* the mark. nil: today's tap.
    var onSeek: ((Double) -> Void)? = nil
    /// Which laps are lit, in slot order, whenever that changes — the session
    /// compare picks its stage's sides from it (`VideoSync.stageSides`).
    var onLitChange: (([Int]) -> Void)? = nil
    /// Where the panel's tab and lit laps outlive the panel (NS-51) — the web's
    /// `bindChannelGraphs` `memory` option. A resize that rebuilds the page (a
    /// Duo unfolding sideways, a rotation across 840 pt) would otherwise put a
    /// driver reading the Grip tab back on Time with the default laps lit. nil:
    /// the panel's own `@State`, as before.
    var memory: PanelMemory? = nil
    /// The session's best-lap racing line (≥ 10 points), for a small track map at
    /// the top of the Traces tab carrying the cursor — one dot per lit lap, in
    /// its slot colour, at its fraction of the lap. Pass it where nothing is
    /// drawn beside the panel; nil draws no map (the expanded-width analysis
    /// column has its own and takes `onCursor` instead).
    var mapTrace: [TracePoint]? = nil
    /// The cursor's dots, whenever they change, for a map drawn beside the panel
    /// (the analysis column's). Empty when nothing is marked.
    var onCursor: (([TrackMapView.Dot]) -> Void)? = nil

    /// The account's unit system — the speed axis and the distance ticks follow it.
    @Environment(\.unitSystem) private var units
    /// Whose session this is — a coach reading a student's says so in place of
    /// the upsell (NS-38).
    @Environment(\.logbookOwner) private var owner

    /// Channel-lap indexes in slot order — oldest first, so the eviction in
    /// `ChannelGraphs.toggle` drops the one you selected longest ago.
    @State private var lit: [Int] = []
    /// What a **tap** has parked the panel on, and what a **pointer** is
    /// borrowing (NS-34 ticket 5).
    ///
    /// Two states rather than one because hover is *additive to tap, never a
    /// replacement* — the same iPad is used by touch a moment later. A pointer
    /// crossing the plot marks as it goes and hands the tapped mark back the
    /// moment it leaves, so a mark you committed survives a pointer passing over
    /// it. Without the pair, moving the trackpad would silently throw away the
    /// place you had chosen.
    @State private var parked: Mark?
    @State private var hovered: Mark?
    /// Whether the friction circle draws the laps that aren't highlighted (⌘F).
    @State private var showEnvelope = true
    /// What the laps are plotted against: driven distance (the default — laps
    /// line up corner for corner) or each lap's own elapsed time (they drift
    /// apart, and the drift is the gap). `LapAxis`, the port of
    /// `public/js/lap-axis.js`.
    @State private var axis: LapAxis.Mode = LapAxis.DEFAULT_AXIS
    /// Each lap's axis series, worked out once per lap set and mode rather than
    /// on every redraw — a time series is an integration over the whole lap and
    /// a pointer crossing a plot redraws the panel per move.
    @State private var seriesCache = AxisSeriesCache()

    /// Where the panel is pointing: the pointer's mark if there is one, else the
    /// tapped one.
    private var mark: Mark? { hovered ?? parked }

    /// Whether the cursor is the panel's own. Off while the lap stage owns the
    /// playhead (NS-51): there a tap seeks the video instead, and the playhead
    /// *is* the mark.
    private var cursorEnabled: Bool { onSeek == nil }

    /// A place the panel is pointing at — the **cursor**.
    ///
    /// `x` is a value on the panel's axis (metres, or seconds on a time axis),
    /// which every lit lap is then found at (`LapAxis.axisPlaces`): a dot and a
    /// value on each lap's trace, and a dot per lap on the track map at its own
    /// fraction of the lap. `hit` is the sample a friction-circle point, a
    /// balance corner or a sector heading named, when the mark came from one —
    /// what the analysis column rings beside the dots.
    private struct Mark: Equatable {
        var x: Double
        var hit: ChannelHit?
    }

    /// A tap from a sample-naming source: commits a mark there — or, on a
    /// stage, seeks there.
    private func park(_ hit: ChannelHit?) {
        if let onSeek, let hit {
            onSeek(Double(hit.k))
            return
        }
        parked = hit.flatMap(mark(for:))
        emit()
    }

    /// A pointer: borrows a mark for as long as it is over the plot. Nil is the
    /// pointer leaving, which hands back whatever a tap had parked. Nothing while
    /// a stage owns the playhead.
    private func borrow(_ hit: ChannelHit?) {
        guard cursorEnabled else { return }
        hovered = hit.flatMap(mark(for:))
        emit()
    }

    /// A sample's place on the axis: the hit's own lap at its grid index, or —
    /// for a place every lap shares — the first lit lap's.
    private func mark(for hit: ChannelHit) -> Mark? {
        guard let x = frame().x(hit.chIdx ?? lit.first, Double(hit.k)) else { return nil }
        return Mark(x: x, hit: hit)
    }

    /// A tap on a lap-axis chart (a trace, the delta, the gear ribbon) at axis
    /// value x: parks the cursor there, or clears it when it is already there —
    /// or, on a stage, seeks there.
    ///
    /// The toggle compares against the **parked** mark rather than the one on
    /// screen: with a pointer resting on the plot the mark under your finger is
    /// borrowed, not committed, and tapping there means "keep this", never
    /// "cancel it".
    private func tapAxis(_ x: Double) {
        let f = frame()
        let x = min(max(x, 0), f.x1)
        if let onSeek {
            // On a stage a tap pauses and seeks the video there (NS-51): the
            // fractional place under the finger, not a snapped one.
            if let k = stageGrid(x, f) {
                onSeek(k)
                Haptics.select()
            }
            return
        }
        let snapped = snap(x, f)
        if let parked, abs(parked.x - snapped) < 1e-6 {
            self.parked = nil
        } else {
            parked = Mark(x: snapped, hit: nil)
            Haptics.select()
        }
        emit()
    }

    /// The same mark under a pointer (NS-34 ticket 5): no haptic, because
    /// nothing was committed, and no toggle, because a pointer that stays still
    /// is not asking twice.
    private func hoverAxis(_ x: Double?) {
        guard cursorEnabled else { return }
        let f = frame()
        hovered = x.map { Mark(x: snap(min(max($0, 0), f.x1), f), hit: nil) }
        emit()
    }

    /// VoiceOver's swipe up / down on a chart card: the cursor (or, on a stage,
    /// the playhead) a twentieth of the axis along — the same place a tap would
    /// put it, for a reader who cannot point at one.
    private func stepCursor(_ direction: AccessibilityAdjustmentDirection) {
        let f = frame()
        let step = f.x1 / 20
        guard step > 0 else { return }
        let current: Double?
        if cursorEnabled {
            current = parked?.x
        } else {
            current = playhead?.mark.flatMap { f.x(playhead?.aLap, $0.k) }
        }
        let next: Double
        switch direction {
        case .increment: next = current.map { min(f.x1, $0 + step) } ?? 0
        case .decrement: next = current.map { max(0, $0 - step) } ?? 0
        @unknown default: return
        }
        if let onSeek {
            if let k = stageGrid(next, f) { onSeek(k) }
            return
        }
        parked = Mark(x: snap(next, f), hit: nil)
        emit()
    }

    /// The Clear control and the cards' named action.
    private func clearCursor() {
        parked = nil
        emit()
    }

    /// A tap's place snapped to something a driver can read back: the nearest
    /// grid point on distance, the nearest tenth of a second on time — which is
    /// also what makes a second tap on the same place clear it.
    private func snap(_ x: Double, _ f: AxisFrame) -> Double {
        f.mode == .time ? (x * 10).rounded() / 10 : (x / f.dStepM).rounded() * f.dStepM
    }

    /// The stage's side-A grid index at axis value x — what `onSeek` takes. On
    /// a time axis it is where A's own time series reaches x (`gridAtElapsed`),
    /// since a chart there has no grid index of its own.
    private func stageGrid(_ x: Double, _ f: AxisFrame) -> Double? {
        guard f.dStepM > 0 else { return nil }
        if f.mode == .distance { return x / f.dStepM }
        guard let xs = f.xs(playhead?.aLap ?? lit.first) else { return nil }
        return VideoSync.gridAtElapsed(xs, x)
    }

    /// Where each lit lap is at the mark, in slot order.
    private func places(_ mark: Mark?, _ f: AxisFrame) -> [LapAxis.Place] {
        guard let mark else { return [] }
        return LapAxis.axisPlaces(channels.laps, channels.dStepM, f.mode, mark.x, lit)
    }

    /// The cursor on a track map: one dot per lit lap, in its slot colour, at its
    /// own fraction of the lap. Nothing while a stage owns the playhead.
    private func cursorDots(_ f: AxisFrame) -> [TrackMapView.Dot] {
        guard cursorEnabled else { return [] }
        return places(mark, f).compactMap { place in
            color(forLapIndex: place.chIdx).map { TrackMapView.Dot(frac: place.frac, color: $0) }
        }
    }

    /// Tell whatever is drawn beside the panel where it is pointing. One funnel,
    /// so a tap and a pointer can't disagree about what the map should show.
    private func emit() {
        onHit(mark?.hit)
        onCursor?(cursorDots(frame()))
    }

    /// The axis the charts are drawn on, for the current mode.
    private func frame() -> AxisFrame {
        seriesCache.frame(channels, axis)
    }

    /// Whether a time axis can be offered at all: it integrates a speed trace,
    /// which every stored lap carries today.
    private var canTime: Bool {
        channels.laps.contains { ($0.speed?.count ?? 0) >= 2 }
    }

    /// The slot colors, in the order laps take them.
    private static let slots: [Color] = [Color(.chartLine), Color(.chartLineB), Color(.chartLineC)]

    private var matches: [ChannelGraphs.LapMatch] {
        ChannelGraphs.matchLapsToChannels(laps, channels.laps)
    }

    private var present: [ChannelGraphs.Channel] {
        ChannelGraphs.presentChannels(channels)
    }

    var body: some View {
        let f = frame()
        VStack(alignment: .leading, spacing: 14) {
            if canTime {
                axisSwitch
            }
            chips
            // One question per tab (epic #193). Only populated tabs are offered,
            // and a single one renders flat — a tab bar with one tab in it is a
            // control that does nothing.
            let tabs = populatedTabs
            if tabs.count > 1 {
                tabBar(tabs)
            }
            if cursorEnabled, let parked {
                cursorBar(parked, f)
            }
            ForEach(tabs, id: \.self) { tabKey in
                if tabs.count == 1 || tabKey == selectedTab {
                    tabContent(tabKey, f)
                }
            }
            if !pro, let freeNote {
                TECard {
                    Text(freeNote)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityIdentifier("sharedFreeNote")
            } else if !pro, owner.isReadOnly {
                // A coach reading a free student's session (NS-38): the paywall is
                // the student's to answer, not theirs, so the panel says what is
                // missing and why instead of offering to sell it.
                TECard {
                    Text(owner.studentFreeNote)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityIdentifier("studentFreeNote")
            } else if !pro {
                // Under every tab rather than on one of them: what Pro adds is
                // spread across all four.
                ProUpsellCard(
                    title: "The rest of the recording is Pro",
                    blurb: "Pro unlocks the rest of the recording where it carries them: steering, RPM, lateral G and yaw traces, "
                    + "the gear ribbon and shift points, ABS and wheelspin marks on the map, sector splits with a "
                    + "theoretical best, the car-health strip, and lap-vs-lap delta charts."
                )
            }
        }
        .background { keyboardCommands }
        .onAppear {
            if lit.isEmpty {
                if let memory, let remembered = memory.lit,
                   remembered.allSatisfy({ channels.laps.indices.contains($0) }) {
                    lit = remembered
                    // A tab that no longer exists (an older build's Time or
                    // Inputs) reads as nil, which shows the first populated tab.
                    tab = memory.tab.flatMap(Tab.init(rawValue:))
                } else {
                    lit = preselect ?? ChannelGraphs.initialSelection(matches)
                }
            }
            if let remembered = memory?.axis.flatMap(LapAxis.Mode.init(rawValue:)), canTime {
                axis = remembered
            }
            onLitChange?(lit)
        }
        .onChange(of: lit) { _, lit in
            memory?.lit = lit
            onLitChange?(lit)
            // The lit laps are who the cursor's dots belong to.
            if mark != nil { emit() }
        }
        .onChange(of: tab) { _, tab in memory?.tab = tab?.rawValue }
        .onChange(of: axis) { _, axis in
            memory?.axis = axis.rawValue
            // A parked place is a value on the old axis; it means nothing on the
            // new one.
            parked = nil
            hovered = nil
            emit()
        }
    }

    // MARK: - The axis and the cursor

    /// Distance or time (item 4 of the feedback): a segmented control over the
    /// panel, remembered with the tab and the lit laps.
    private var axisSwitch: some View {
        HStack(spacing: 10) {
            Text("Plot against")
                .teStyle(.eyebrow)
                .foregroundStyle(Color(.textMuted))
            Spacer(minLength: 8)
            Picker("Plot against", selection: $axis) {
                Text("Distance").tag(LapAxis.Mode.distance)
                Text("Time").tag(LapAxis.Mode.time)
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 220)
            .accessibilityIdentifier("axisSwitch")
        }
    }

    /// "Marked at 0.68 mi · Clear" — what a tap parked, and the way to let go of
    /// it. A pointer's borrowed mark gets no bar: it goes when the pointer does.
    private func cursorBar(_ parked: Mark, _ f: AxisFrame) -> some View {
        HStack(spacing: 6) {
            Text("Marked at \(LapAxis.fmtAxisValue(parked.x, f.mode, units))")
                .teStyle(.sm)
                .foregroundStyle(Color(.textStrong))
            Text("·")
                .teStyle(.sm)
                .foregroundStyle(Color(.textFaint))
            Button("Clear") { clearCursor() }
                .teStyle(.sm)
                .foregroundStyle(Color(.accentInk))
                .buttonStyle(.plain)
                .accessibilityIdentifier("clearCursor")
                .accessibilityLabel("Clear the mark")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cursorBar")
    }

    /// A small track map at the top of the Traces tab, carrying the cursor's dots
    /// — for a panel with no map beside it.
    @ViewBuilder
    private func cursorMap(_ f: AxisFrame) -> some View {
        if cursorEnabled, let mapTrace, mapTrace.count >= 10 {
            let dots = cursorDots(f)
            TECard {
                VStack(alignment: .leading, spacing: 6) {
                    TrackMapView(trace: mapTrace, dots: dots)
                        .frame(height: 130)
                    Text(
                        dots.isEmpty
                            ? "Tap a chart to mark that place here — one dot per lap, on the best lap's line."
                            : "The marked place, one dot per lap, on the best lap's line."
                    )
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("cursorMap")
        }
    }

    /// The x-axis every lap-axis chart shares: nice distances in the unit the
    /// axis is labelled in, or m:ss on a time axis.
    private func xAxis(_ f: AxisFrame) -> some AxisContent {
        let ticks: [(x: Double, label: String)] = f.mode == .time
            ? LapAxis.timeAxisTicks(f.x1).map { ($0.s, $0.label) }
            : ChannelGraphs.distAxisTicks(max(1, f.x1), units, n: 4).map { ($0.m, $0.label) }
        return AxisMarks(values: ticks.map(\.x)) { value in
            AxisGridLine().foregroundStyle(Color(.chartGrid))
            AxisValueLabel {
                if let v = value.as(Double.self) {
                    Text(ticks.first { abs($0.x - v) < 1e-6 * max(1, abs(v)) }?.label ?? LapAxis.fmtAxisValue(v, f.mode, units))
                        .teStyle(.xxs)
                }
            }
        }
    }

    /// How a chart's spoken label names its axis. "driven distance" rather than
    /// the web's "distance", as it always has here.
    private func axisPhrase(_ f: AxisFrame) -> String {
        f.mode == .time ? "time" : "driven distance"
    }

    /// What VoiceOver hears first on a chart card while a place is marked.
    private func markedPrefix(_ text: String?) -> String {
        guard let text else { return "" }
        return "Marked at \(text). "
    }

    // MARK: - Keyboard (NS-34 ticket 5)

    /// The commands an iPad keyboard drives that no visible control carries.
    ///
    /// Titled `Button`s with `.keyboardShortcut` rather than `onKeyPress`, and
    /// deliberately: a shortcut declared this way becomes a `UIKeyCommand`, which
    /// is what lists it — by its title — in the ⌘-key overlay. A shortcut nobody
    /// can discover is a shortcut nobody uses, and holding ⌘ is where an iPad
    /// user looks. The tab shortcuts are on the tab buttons themselves, since
    /// those exist; these three have no control to hang off.
    ///
    /// Invisible, because the panel has no room for three more buttons, and
    /// hidden from accessibility rather than merely unlabelled: VoiceOver reaches
    /// the same two things through the chips and the friction circle, and a
    /// zero-sized button in the rotor is noise.
    @ViewBuilder
    private var keyboardCommands: some View {
        Group {
            Button("Previous lap") { stepLit(by: -1) }
                .keyboardShortcut("[", modifiers: [])
            Button("Next lap") { stepLit(by: 1) }
                .keyboardShortcut("]", modifiers: [])
            Button(showEnvelope ? "Hide the other laps" : "Show the other laps") {
                showEnvelope.toggle()
            }
            .keyboardShortcut("f", modifiers: .command)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    /// Step the newest highlighted lap one place through the laps that have
    /// channels.
    private func stepLit(by direction: Int) {
        let stepped = Self.stepped(lit, by: direction, over: matches.filter(\.hasChannels).map(\.chIdx))
        guard stepped != lit else { return }
        lit = stepped
        Haptics.select()
    }

    /// Move the **most recently lit** lap one place along, keeping the rest.
    ///
    /// The newest slot rather than the whole selection, because that is what
    /// makes the key useful: pin the two laps you are comparing against and scrub
    /// a third through the session without losing them. Laps already lit are
    /// skipped — two slots showing one lap is a selection with a hole in it — and
    /// the walk wraps, so neither key is ever a dead one. With nothing lit at all
    /// it lights an end, whichever end the direction points at.
    ///
    /// Pure and static so it can be tested without a view: `LapChannelChartTests`.
    static func stepped(_ lit: [Int], by direction: Int, over available: [Int]) -> [Int] {
        guard direction != 0, !available.isEmpty else { return lit }
        guard let current = lit.last, let from = available.firstIndex(of: current) else {
            return [direction > 0 ? available[0] : available[available.count - 1]]
        }
        let pinned = Set(lit.dropLast())
        for step in 1...available.count {
            let index = ((from + step * direction) % available.count + available.count) % available.count
            let candidate = available[index]
            if !pinned.contains(candidate) {
                return Array(lit.dropLast()) + [candidate]
            }
        }
        // Every lap is already lit, so there is nowhere to step to.
        return lit
    }

    // MARK: - Tabs

    /// The panel's tabs, in order — `TABS` in `public/js/channel-graphs.js`,
    /// ported as `ChannelGraphs.TABS` and asserted against it by
    /// `LapChannelPanelTests`. Traces is the data-logger view: the delta, speed
    /// and the driver's inputs stacked on one axis, because the question a trace
    /// answers is almost always "what was I doing with my feet and hands while
    /// the speed did that". Grip and Car need charts of their own kind.
    enum Tab: String, CaseIterable, Hashable {
        case traces, grip, car

        var label: String {
            switch self {
            case .traces: "Traces"
            case .grip: "Grip"
            case .car: "Car"
            }
        }
    }

    /// Which tab a channel's chart lands on — `TAB_OF` in the JS.
    static func tab(of channel: ChannelGraphs.Channel) -> Tab {
        switch channel {
        case .speed, .throttle, .brake, .steering, .rpm: .traces
        case .latG, .yaw: .grip
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
        case .traces:
            return true // the sector table and the speed chart both live here
        case .grip:
            return present.contains { Self.tab(of: $0) == tabKey }
        case .car:
            // The per-lap scalars (#190). A session of hand-entered laps carries
            // none, and the tab is then absent rather than empty. Pro only: the
            // server strips the scalars for a free account, so this is belt and
            // braces rather than the gate.
            return pro && Health.sessionHealth(channels) != nil
        }
    }

    private func tabBar(_ tabs: [Tab]) -> some View {
        HStack(spacing: 2) {
            ForEach(Array(tabs.enumerated()), id: \.element) { index, tabKey in
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
                        // An unselected tab's fill is `.clear`, which isn't hit-tested.
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                // 1…3 on an attached keyboard (NS-34 ticket 5). Numbered by the
                // tab's **place in the bar**, not by the `Tab` case: an unpopulated
                // tab isn't drawn, and a shortcut that skips a number to honour a
                // tab nobody can see would be a puzzle. Safe as an index because
                // there are only ever three cases.
                .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [])
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
    private func tabContent(_ tabKey: Tab, _ f: AxisFrame) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            // Everything above the traces is the Pro half (#264): it derives
            // from channels the server strips for a free account, or — the
            // sectors and the delta — from the free speed trace, and is gated
            // here for that reason.
            switch tabKey {
            case .traces:
                // Where the cursor is on track, for a panel with no map beside it.
                cursorMap(f)
                if pro {
                    // Sector splits + theoretical best for the highlighted laps (#146).
                    SectorTable(
                        channels: channels, lit: lit, slots: Self.slots,
                        lapNumber: lapNumber(forLapIndex:),
                        onHit: park,
                        onHover: borrow
                    )
                    deltaChart(f)
                }
            case .grip:
                if pro {
                    // The friction circle (#186) above the lateral-G trace it
                    // summarises. It draws nothing unless the session stored longG
                    // too, so a source with only lateral G still gets its trace.
                    FrictionCircle(
                        channels: channels, lit: lit, slots: Self.slots,
                        lapNumber: lapNumber(forLapIndex:),
                        // The point of the column (NS-34 ticket 3): the tapped
                        // sample's place is marked across every chart that shares
                        // the axis and handed outward so the map can ring it. A
                        // pointer does the same without committing it (ticket 5).
                        onHit: park,
                        onHover: borrow,
                        showEnvelope: showEnvelope
                    )
                    // Under it, the balance scatter and its per-corner table (#189),
                    // above the lateral-G and yaw traces they are read from. It draws
                    // nothing unless the session stored yaw, steering and speed.
                    BalanceScatter(
                        channels: channels, lit: lit, slots: Self.slots,
                        lapNumber: lapNumber(forLapIndex:),
                        onHit: park,
                        onHover: borrow
                    )
                }
            case .car:
                if pro {
                    // The session health strip (#190): what the car was doing while
                    // you drove it, which is the other half of a track day.
                    HealthStrip(
                        channels: channels, lit: lit, slots: Self.slots,
                        lapNumber: lapNumber(forLapIndex:)
                    )
                }
            }
            ForEach(channels(on: tabKey), id: \.self) { channel in
                channelChart(channel, f)
                // The gear ribbon rides under the RPM trace, where each shift is
                // the drop in the sawtooth above it (#187).
                if channel == .rpm && pro {
                    GearRibbon(
                        channels: channels, lit: lit, slots: Self.slots,
                        lapNumber: lapNumber(forLapIndex:),
                        axis: f,
                        cursorX: cursorEnabled ? mark?.x : nil,
                        onAxisTap: tapAxis,
                        onAxisHover: hoverAxis,
                        onAxisStep: stepCursor,
                        onClear: ribbonClear
                    )
                }
            }
            if tabKey == .traces && pro {
                // The session's shift points (#187), last: under the traces and
                // the gear ribbon they explain.
                ShiftTable(channels: channels)
            }
        }
    }

    /// The charted channels a tab holds, in stacking order.
    private func channels(on tabKey: Tab) -> [ChannelGraphs.Channel] {
        present.filter { Self.tab(of: $0) == tabKey }
    }

    /// The gear ribbon's "Clear the mark", while there is one to clear.
    private var ribbonClear: (() -> Void)? {
        guard cursorEnabled, parked != nil else { return nil }
        return { clearCursor() }
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
    private func channelChart(_ channel: ChannelGraphs.Channel, _ f: AxisFrame) -> some View {
        if let domain = ChannelGraphs.valueDomain(channel, in: channels, units: units) {
            let cursor = cursorEnabled ? mark : nil
            let cursorPlaces = places(cursor, f)
            let readout = cursor.map { readoutText(channel, places: cursorPlaces, x: $0.x, f) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(channel.label) (\(channel.unit(units)))")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textMuted))
                    Spacer()
                    if let readout {
                        Text(readout)
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textStrong))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    } else if let playhead {
                        PlayheadReadout(playhead: playhead) { k in readoutText(channel, atGrid: Int(k.rounded())) }
                    }
                }
                // One flat array of points through a single `ForEach`, and nothing
                // else in the builder — not a `RuleMark` for the cursor, not an
                // `if`. Mixing mark kinds here makes the builder's content type a
                // nested tuple over a few hundred marks per lap, and the app wedges
                // in layout before it ever draws (it did). The cursor and the
                // playhead are drawn over the plot in `.chartOverlay` instead, and
                // never enter these samples.
                Chart {
                    ForEach(samples(channel, f), id: \.id) { sample in
                        LineMark(
                            x: .value(f.mode == .time ? "Time" : "Distance", sample.x),
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
                .chartXScale(domain: 0...max(1, f.x1))
                // Limit bands (#188) go in the *background* rather than as marks:
                // a `RectangleMark` beside the lines would break the one
                // homogeneous `ForEach` rule above, and these shade the plot
                // rather than plotting anything.
                .chartBackground { proxy in
                    limitBands(channel, f, proxy: proxy)
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
                    xAxis(f)
                }
                .foregroundStyle(Color(.textMuted))
                .frame(height: 150)
                .chartOverlay { proxy in
                    ZStack {
                        if let cursor {
                            AxisMarkLayer(
                                proxy: proxy, lineX: cursor.x,
                                dots: cursorPlaces.compactMap { place in
                                    guard let series = channel.series(of: channels.laps[place.chIdx]),
                                          let raw = VideoSync.valueAt(series, place.k),
                                          let x = f.x(place.chIdx, place.k)
                                    else { return nil }
                                    return AxisMarkLayer.Dot(
                                        id: place.chIdx, color: color(forLapIndex: place.chIdx) ?? Color(.chartDim),
                                        x: x, y: channel.convert(raw, units)
                                    )
                                }
                            )
                        } else if let playhead {
                            PlayheadLayer(
                                playhead: playhead, proxy: proxy,
                                axisX: { chIdx, k in f.x(chIdx, k) },
                                traces: playheadTraces(channel)
                            )
                        }
                        tapLayer(proxy)
                    }
                }
                // Belt and braces with the per-mark suppression above: this alone does
                // *not* prune the marks — that is what the per-mark modifier is for —
                // but it does keep the plot's own furniture out of the hierarchy.
                .accessibilityHidden(true)
            }
            // So the chart reads as one element with the summary below, which is what
            // a chart should say. Tapping a place has two VoiceOver equivalents on
            // the card itself (AGENTS.md: a tap inside a single-element card is
            // otherwise unreachable): swipe up / down moves the mark, and a named
            // action clears it.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(channel.label) by \(axisPhrase(f)), per lap")
            .accessibilityValue(markedPrefix(readout) + summary(channel))
            .accessibilityAdjustableAction(stepCursor)
            .accessibilityActions { clearAction }
        }
    }

    /// The tap and the pointer over a lap-axis plot, turned into an axis value.
    private func tapLayer(_ proxy: ChartProxy) -> some View {
        GeometryReader { geometry in
            Rectangle().fill(.clear).contentShape(.rect)
                .onTapGesture { location in
                    if let x = axisValue(at: location, proxy: proxy, geometry: geometry) { tapAxis(x) }
                }
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let location):
                        if let x = axisValue(at: location, proxy: proxy, geometry: geometry) { hoverAxis(x) }
                    case .ended:
                        hoverAxis(nil)
                    @unknown default:
                        hoverAxis(nil)
                    }
                }
        }
    }

    /// "Clear the mark", on every lap-axis chart card while one is parked.
    @ViewBuilder
    private var clearAction: some View {
        if cursorEnabled, parked != nil {
            Button("Clear the mark") { clearCursor() }
        }
    }

    /// The axis value under a point in the plot, or nil off it.
    private func axisValue(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> Double? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        return proxy.value(atX: location.x - geometry[plotFrame].origin.x)
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
    private func limitBands(_ channel: ChannelGraphs.Channel, _ f: AxisFrame, proxy: ChartProxy) -> some View {
        let kinds = Limits.LIMIT_KINDS.filter { $0.channel == channel }
        if !kinds.isEmpty {
            GeometryReader { geometry in
                if let plotFrame = proxy.plotFrame {
                    let plot = geometry[plotFrame]
                    ForEach(bands(kinds, f), id: \.id) { band in
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

    /// One shaded stretch of the axis.
    private struct Band {
        let id: String
        let from: Double
        let to: Double
        let side: Limits.Side
        let filled: Bool
    }

    /// Each lit lap's runs, placed on the panel's axis by that lap's own series —
    /// so on a time axis a lap's ABS band sits where *that lap* braked.
    private func bands(_ kinds: [Limits.Kind], _ f: AxisFrame) -> [Band] {
        var out: [Band] = []
        for chIdx in lit where channels.laps.indices.contains(chIdx) {
            let entry = channels.laps[chIdx]
            for run in Limits.limitRuns(entry) {
                guard let kind = kinds.first(where: { $0.key == run.kind }),
                      let from = f.x(chIdx, max(0, Double(run.k0) - 0.5)),
                      let to = f.x(chIdx, Double(run.k1) + 0.5)
                else { continue }
                out.append(
                    Band(
                        id: "\(chIdx)-\(run.kind)-\(run.k0)",
                        from: from,
                        to: to,
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
    /// the same axis as the channels below it. Positive is slower, so a climbing
    /// trace is time slipping away. The reference lap draws no trace — it *is*
    /// the zero line. On a time axis each grid point's delta sits at the
    /// **reference** lap's elapsed time there, as on the web. The maths is
    /// `ChannelGraphs.deltaSeries`, pinned to the web implementation by
    /// `contracts/logic/lap-delta.json`.
    @ViewBuilder
    private func deltaChart(_ f: AxisFrame) -> some View {
        if let refIdx = ChannelGraphs.deltaReference(lit, in: channels),
           let refXs = f.mode == .time ? f.xs(refIdx) : (0..<(channels.laps[refIdx].speed?.count ?? 0)).map({ Double($0) * f.dStepM }) {
            let deltas: [(chIdx: Int, series: [Double])] = lit
                .filter { $0 != refIdx && channels.laps.indices.contains($0) }
                .compactMap { chIdx in
                    ChannelGraphs.deltaSeries(channels.laps[chIdx], channels.laps[refIdx], channels.dStepM)
                        .map { (chIdx, $0) }
                }
            if !deltas.isEmpty, let domain = ChannelGraphs.deltaDomain(deltas.map(\.series)) {
                let cursor = cursorEnabled ? mark : nil
                let cursorPlaces = places(cursor, f)
                let readout = cursor.map { deltaReadoutText(deltas, places: cursorPlaces, x: $0.x, f) }
                // Where a delta at a lap's grid index k is drawn.
                let deltaX = { (k: Double) -> Double? in
                    f.mode == .time ? LapAxis.axisAtGrid(refXs, k) : k * f.dStepM
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Delta (s) vs lap \(String(lapNumber(forLapIndex: refIdx))) — above the line is slower")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textMuted))
                        Spacer()
                        if let readout {
                            Text(readout)
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textStrong))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        } else if let playhead {
                            PlayheadReadout(playhead: playhead) { k in
                                deltaReadoutText(deltas, atGrid: Int(k.rounded()))
                            }
                        }
                    }
                    // Same one-homogeneous-ForEach rule as the channel charts
                    // (see the comment there): the zero line is a two-point series
                    // inside the same sample array.
                    Chart {
                        ForEach(deltaSamples(deltas, refXs: refXs, f), id: \.id) { sample in
                            LineMark(
                                x: .value(f.mode == .time ? "Time" : "Distance", sample.x),
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
                    .chartXScale(domain: 0...max(1, f.x1))
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
                        xAxis(f)
                    }
                    .foregroundStyle(Color(.textMuted))
                    .frame(height: 150)
                    .chartOverlay { proxy in
                        ZStack {
                            if let cursor {
                                AxisMarkLayer(
                                    proxy: proxy, lineX: cursor.x,
                                    dots: cursorPlaces.compactMap { place in
                                        guard let series = deltas.first(where: { $0.chIdx == place.chIdx })?.series,
                                              let value = VideoSync.valueAt(series, place.k),
                                              let x = deltaX(place.k)
                                        else { return nil }
                                        return AxisMarkLayer.Dot(
                                            id: place.chIdx, color: color(forLapIndex: place.chIdx) ?? Color(.chartDim),
                                            x: x, y: value
                                        )
                                    }
                                )
                            } else if let playhead {
                                PlayheadLayer(
                                    playhead: playhead, proxy: proxy,
                                    axisX: { _, k in deltaX(k) },
                                    traces: deltas.map {
                                        PlayheadLayer.Trace(
                                            id: $0.chIdx, color: color(forLapIndex: $0.chIdx) ?? Color(.chartDim),
                                            values: $0.series
                                        )
                                    }
                                )
                            }
                            tapLayer(proxy)
                        }
                    }
                    .accessibilityHidden(true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Time delta to lap \(String(lapNumber(forLapIndex: refIdx))) by \(axisPhrase(f)) — above the zero line is slower")
                .accessibilityValue(markedPrefix(readout) + deltaSummary(deltas, refIdx: refIdx))
                .accessibilityAdjustableAction(stepCursor)
                .accessibilityActions { clearAction }
            }
        }
    }

    /// Delta traces in painter's order plus the zero line (the reference lap),
    /// all in one homogeneous array.
    private func deltaSamples(
        _ deltas: [(chIdx: Int, series: [Double])], refXs: [Double], _ f: AxisFrame
    ) -> [Sample] {
        var out: [Sample] = []
        for (k, x) in [0.0, max(1, f.x1)].enumerated() {
            out.append(Sample(id: -10 - k, lapIndex: -2, x: x, value: 0, color: Color(.textFaint), lineWidth: 1))
        }
        for (chIdx, series) in deltas {
            let color = color(forLapIndex: chIdx) ?? Color(.chartDim)
            for (k, v) in series.enumerated() where k < refXs.count {
                out.append(
                    Sample(
                        id: chIdx * 100_000 + k,
                        lapIndex: chIdx,
                        x: refXs[k],
                        value: v,
                        color: color,
                        lineWidth: 2
                    )
                )
            }
        }
        return out
    }

    /// "1.2 km · L3 +0.42 s" — the cursor's place once, then each lap's delta to
    /// the reference where that lap was at it.
    private func deltaReadoutText(
        _ deltas: [(chIdx: Int, series: [Double])], places: [LapAxis.Place], x: Double, _ f: AxisFrame
    ) -> String {
        let values = places.compactMap { place -> String? in
            guard let series = deltas.first(where: { $0.chIdx == place.chIdx })?.series else { return nil }
            let index = Int(place.k.rounded())
            guard series.indices.contains(index) else { return nil }
            return "L\(String(lapNumber(forLapIndex: place.chIdx))) \(Self.fmtDelta(series[index], decimals: 2)) s"
        }
        let at = LapAxis.fmtAxisValue(x, f.mode, units)
        return values.isEmpty ? at : "\(at) · \(values.joined(separator: " · "))"
    }

    /// The playhead's read-out: one grid index for every lap.
    private func deltaReadoutText(_ deltas: [(chIdx: Int, series: [Double])], atGrid index: Int) -> String {
        let values = deltas.compactMap { (chIdx, series) -> String? in
            guard series.indices.contains(index) else { return nil }
            return "L\(String(lapNumber(forLapIndex: chIdx))) \(Self.fmtDelta(series[index], decimals: 2)) s"
        }
        let distance = Units.fmtDist(Double(index) * channels.dStepM, units)
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

    /// One point of one lap's trace, ready to plot. `x` is on the panel's axis.
    private struct Sample: Identifiable {
        let id: Int
        let lapIndex: Int
        let x: Double
        let value: Double
        let color: Color
        let lineWidth: CGFloat
    }

    /// Every lap's points for a channel, flattened in painter's order: the dim
    /// envelope first, then the highlighted laps in slot order, so the lap you
    /// selected first is never buried under the ones you didn't. Each lap is laid
    /// out by its own axis series — on a time axis, its own elapsed time — and a
    /// lap with no series on this axis is left out.
    private func samples(_ channel: ChannelGraphs.Channel, _ f: AxisFrame) -> [Sample] {
        let dim = channels.laps.indices.filter { !lit.contains($0) }
        var out: [Sample] = []
        for chIdx in dim + lit {
            guard let series = channel.series(of: channels.laps[chIdx]) else { continue }
            let xs = f.mode == .time ? f.xs(chIdx) : nil
            if f.mode == .time && xs == nil { continue }
            let color = color(forLapIndex: chIdx)
            for (k, raw) in series.enumerated() {
                let x: Double
                if let xs {
                    guard k < xs.count else { break }
                    x = xs[k]
                } else {
                    x = Double(k) * f.dStepM
                }
                out.append(
                    Sample(
                        // Unique across laps: `Chart` identifies marks by this, and a
                        // shared id would collapse the laps into one line.
                        id: chIdx * 100_000 + k,
                        lapIndex: chIdx,
                        x: x,
                        value: channel.convert(raw, units),
                        color: color ?? Color(.chartDim),
                        lineWidth: color == nil ? 1 : 2
                    )
                )
            }
        }
        return out
    }

    // MARK: - Playhead (NS-51)

    /// Each lit lap's trace in display units, for the playhead's dots.
    private func playheadTraces(_ channel: ChannelGraphs.Channel) -> [PlayheadLayer.Trace] {
        lit.compactMap { chIdx in
            guard channels.laps.indices.contains(chIdx), let series = channel.series(of: channels.laps[chIdx]) else {
                return nil
            }
            return PlayheadLayer.Trace(
                id: chIdx, color: color(forLapIndex: chIdx) ?? Color(.chartDim),
                values: series.map { channel.convert($0, units) }
            )
        }
    }

    // MARK: - Read-out

    /// "1.2 km · L3 92 · L5 88" — the cursor's place once, then a value per
    /// highlighted lap in its slot order, each read where *that lap* was at the
    /// place (the same grid index on distance, its own on time).
    private func readoutText(
        _ channel: ChannelGraphs.Channel, places: [LapAxis.Place], x: Double, _ f: AxisFrame
    ) -> String {
        let values = places.compactMap { place -> String? in
            let index = Int(place.k.rounded())
            guard let v = ChannelGraphs.value(channel, lapIndex: place.chIdx, gridIndex: index, in: channels, units: units) else {
                return nil
            }
            // What was active there, if anything (#188) — the read-out says "ABS"
            // where the band is shaded, so the two never have to be matched by eye.
            let active = Limits.activeLimitLabels(channels.laps[place.chIdx], index)
            let suffix = active.isEmpty ? "" : " (\(active.joined(separator: ", ")))"
            return "L\(String(lapNumber(forLapIndex: place.chIdx))) \(fmtValue(v, channel))\(suffix)"
        }
        let at = LapAxis.fmtAxisValue(x, f.mode, units)
        return values.isEmpty ? at : "\(at) · \(values.joined(separator: " · "))"
    }

    /// The playhead's read-out: one grid index — side A's — for every lap.
    private func readoutText(_ channel: ChannelGraphs.Channel, atGrid index: Int) -> String {
        let values = lit.compactMap { chIdx -> String? in
            guard let v = ChannelGraphs.value(channel, lapIndex: chIdx, gridIndex: index, in: channels, units: units) else {
                return nil
            }
            let active = Limits.activeLimitLabels(channels.laps[chIdx], index)
            let suffix = active.isEmpty ? "" : " (\(active.joined(separator: ", ")))"
            return "L\(String(lapNumber(forLapIndex: chIdx))) \(fmtValue(v, channel))\(suffix)"
        }
        let distance = Units.fmtDist(Double(index) * channels.dStepM, units)
        return values.isEmpty ? distance : "\(distance) · \(values.joined(separator: " · "))"
    }

    /// What VoiceOver gets: the range each highlighted lap covered, not the pixels.
    private func summary(_ channel: ChannelGraphs.Channel) -> String {
        let parts = lit.compactMap { chIdx -> String? in
            guard let series = channel.series(of: channels.laps[chIdx]),
                  let low = series.map({ channel.convert($0, units) }).min(),
                  let high = series.map({ channel.convert($0, units) }).max()
            else { return nil }
            return """
                Lap \(String(lapNumber(forLapIndex: chIdx))), \
                \(fmtValue(low, channel)) to \(fmtValue(high, channel)) \(channel.unit(units))
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

/// A channel panel's tab, lit laps and axis, kept by its owner so they outlive
/// the panel's view (see `LapChannelPanel.memory`). Not observed: the panel
/// reads it once, when it is built, and writes it as it changes.
@MainActor
final class PanelMemory {
    var lit: [Int]?
    var tab: String?
    /// `LapAxis.Mode`'s raw value.
    var axis: String?
}

/// The axis a panel's lap-axis charts are drawn on: the mode, its extent, and
/// each lap's series on it — the native counterpart of the web's `axisFrame`.
struct AxisFrame {
    let mode: LapAxis.Mode
    let dStepM: Double
    /// `LapAxis.lapAxisSeries` per channel lap, by index.
    let series: [[Double]?]
    /// How far the axis runs: the longest lap's last value.
    let x1: Double

    init(_ channels: SessionChannels, _ mode: LapAxis.Mode) {
        self.mode = mode
        dStepM = channels.dStepM
        series = channels.laps.map { LapAxis.lapAxisSeries($0, channels.dStepM, mode) }
        x1 = series.reduce(0) { max($0, $1?.last ?? 0) }
    }

    func xs(_ chIdx: Int?) -> [Double]? {
        guard let chIdx, series.indices.contains(chIdx) else { return nil }
        return series[chIdx]
    }

    /// Where lap `chIdx`'s grid index k sits on the axis. On distance that is
    /// k · dStepM for every lap (no lap needed); on time it is the lap's own
    /// elapsed time there, nil without the lap.
    func x(_ chIdx: Int?, _ k: Double) -> Double? {
        if mode == .distance { return k * dStepM }
        return LapAxis.axisAtGrid(xs(chIdx), k)
    }
}

/// Each lap's axis series, kept until the laps or the mode change. Keyed by a
/// fingerprint — the grid step, and each lap's time and series lengths — rather
/// than by the channels themselves, whose equality would walk every sample.
@MainActor
final class AxisSeriesCache {
    private struct Key: Equatable {
        var mode: LapAxis.Mode
        var dStepM: Double
        var laps: [[Int]]
    }

    private var key: Key?
    private var cached: AxisFrame?

    func frame(_ channels: SessionChannels, _ mode: LapAxis.Mode) -> AxisFrame {
        let key = Key(
            mode: mode, dStepM: channels.dStepM,
            laps: channels.laps.map { [$0.timeMs, $0.speed?.count ?? -1, $0.throttle?.count ?? -1, $0.gear?.count ?? -1] }
        )
        if let cached, key == self.key { return cached }
        let frame = AxisFrame(channels, mode)
        self.key = key
        cached = frame
        return frame
    }
}

/// A line across a plot at one axis value and a dot on each lap's trace — what
/// the cursor and the stage's playhead both draw. Drawn in a chart's
/// `.chartOverlay`, placed with `proxy.position(forX:)`, and **never appended to
/// the chart's samples**: that array is the chart's data, and changing it as the
/// mark moves would re-lay-out every chart — the same family of failure as the
/// mixed-mark wedge `channelChart` documents.
struct AxisMarkLayer: View {
    struct Dot: Identifiable {
        /// The channel-lap index the dot belongs to.
        let id: Int
        let color: Color
        /// Axis value and display-unit value.
        let x: Double
        let y: Double
    }

    let proxy: ChartProxy
    /// nil: dots only.
    let lineX: Double?
    let dots: [Dot]

    var body: some View {
        GeometryReader { geometry in
            if let plotFrame = proxy.plotFrame {
                let plot = geometry[plotFrame]
                if let lineX, let x = proxy.position(forX: lineX) {
                    Path { path in
                        path.move(to: CGPoint(x: plot.minX + x, y: plot.minY))
                        path.addLine(to: CGPoint(x: plot.minX + x, y: plot.maxY))
                    }
                    .stroke(Color(.textStrong), lineWidth: 1.5)
                }
                ForEach(dots) { dot in
                    if let dx = proxy.position(forX: dot.x), let dy = proxy.position(forY: dot.y) {
                        Circle()
                            .fill(dot.color)
                            .overlay(Circle().strokeBorder(Color(.surfaceCard), lineWidth: 1.5))
                            .frame(width: 9, height: 9)
                            .position(x: plot.minX + dx, y: plot.minY + dy)
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// The stage's playhead over one chart (NS-51): a line at side A's place and a
/// dot on each lit lap's trace at its own.
///
/// This view is the only thing that reads `playhead.mark`, so a frame
/// re-renders it and nothing under it.
struct PlayheadLayer: View {
    struct Trace: Identifiable {
        /// The channel-lap index the dot belongs to.
        let id: Int
        let color: Color
        let values: [Double]
    }

    let playhead: LapPlayhead
    let proxy: ChartProxy
    /// Where lap chIdx's grid index k sits on the chart's axis — the line asks
    /// with side A's lap (`LapPlayhead.aLap`).
    let axisX: (Int?, Double) -> Double?
    let traces: [Trace]

    var body: some View {
        if let mark = playhead.mark {
            AxisMarkLayer(
                proxy: proxy,
                lineX: axisX(playhead.aLap, mark.k),
                dots: traces.compactMap { trace in
                    guard let k = mark.dots[trace.id], let value = VideoSync.valueAt(trace.values, k),
                          let x = axisX(trace.id, k)
                    else { return nil }
                    return AxisMarkLayer.Dot(id: trace.id, color: trace.color, x: x, y: value)
                }
            )
        }
    }
}

/// A chart's title read-out while the stage plays: the values at the playhead,
/// in the words a tap would park. Its own view for the same reason as
/// `PlayheadLayer` — it is the only thing that reads the playhead.
struct PlayheadReadout: View {
    let playhead: LapPlayhead
    let text: (Double) -> String

    var body: some View {
        if let mark = playhead.mark {
            Text(text(mark.k))
                .teStyle(.xs)
                .foregroundStyle(Color(.textStrong))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }
}

#if DEBUG
extension LapChannelChart {
    /// The panel on synthetic data, for `-channelGraphs` (see `RootView`) and for
    /// previews. Shaped like a real import: three laps of a 2.4 km circuit on the
    /// importer's 20 m grid, all seven charted channels plus the ones a PDR
    /// import adds — `gear`, `wheelSlip`, the ABS/TC/VSC `flags` bitfield and
    /// the per-lap scalars (#187, #188, #190) — so the gear ribbon, the shift
    /// table, the limit bands, the balance scatter (#189) and the Car tab's
    /// health strip all have something to draw.
    static var demoScreen: some View {
        LapChannelChart(channels: demoChannels, laps: demoLaps, mapTrace: demoTrace)
    }

    /// A 2.4 km loop for the Traces tab's cursor map — the same shape the
    /// `-lapStage` demo draws.
    static let demoTrace: [TracePoint] = (0..<120).map { k in
        let a = Double(k) / 120 * 2 * .pi
        return TracePoint(x: 380 * cos(a) + 60 * cos(3 * a), y: 260 * sin(a), v: 25 + 15 * sin(Double(k) / 9))
    }

    static let demoTimes = [118_400, 116_900, 117_600]

    static var demoLaps: [Lap] {
        demoTimes.enumerated().map { index, ms in
            Lap(id: index + 1, sessionId: 1, lapNum: index + 1, timeMs: ms)
        }
    }

    static var demoChannels: SessionChannels {
        let times = demoTimes
        return SessionChannels(
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
                // Longitudinal G a quarter turn out of phase with the cornering
                // — braking into the corners, power out of them — so the
                // friction circle fills rather than drawing a cross (#186).
                let longG: [Double] = wave.map { v in v * 1.3 }
                // Rotation that mostly follows the steering but falls short
                // through the back half of the lap, so the balance scatter has a
                // band to draw and its table a corner that pushes (#189).
                let yaw: [Double] = (0..<120).map { (k: Int) -> Double in
                    let mps: Double = speed[k] / 3.6
                    let slip: Double = k > 60 ? 0.7 : 1
                    return steering[k] * mps * 0.012 * slip
                }
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
                // The per-lap scalars the Car tab reads (#190): oil climbing past
                // its line by the last lap, fuel draining, and a tire spread that
                // is a camber question rather than noise.
                let heat = Double(index)
                return LapChannels(
                    n: index + 1, timeMs: ms, speed: speed, rpm: rpm, latG: latG,
                    throttle: throttle, brake: brake, steering: steering, longG: longG,
                    yaw: yaw, gear: gear, wheelSlip: wheelSlip,
                    boost: wave.map { v in 60 + 90 * (1 + v) / 2 }, flags: flags,
                    oilC: 118 + heat * 8, oilKpa: 320 - heat * 20, coolantC: 99 + heat * 5,
                    transC: 94 + heat * 6, fuelPct: 74 - heat * 12, battV: 13.6 - heat * 0.4,
                    tyreKpaLF: 214 + heat * 9, tyreKpaRF: 210 + heat * 8,
                    tyreKpaLR: 205 + heat * 7, tyreKpaRR: 204 + heat * 7,
                    tyreCLF: 82 + heat * 9, tyreCRF: 74 + heat * 7,
                    tyreCLR: 68 + heat * 6, tyreCRR: 66 + heat * 6
                )
            }
        )
    }
}

#Preview {
    LapChannelChart.demoScreen
}
#endif
