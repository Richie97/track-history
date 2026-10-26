import SwiftUI
import TrackEvolutionKit

/// The lap stage (NS-51): the video slot(s), the transport, the now-strip and on
/// large screens the map card, pinned above whatever the page scrolls — the
/// channel panel, the facts, a head-to-head.
///
/// A container rather than a card a page drops in: the stage decides how the
/// page scrolls under it (wholly pinned on a phone and on a wide pane, only the
/// transport pinned on a medium one, split at the crease on a tabletop), so the
/// page hands over its `header` (scrolls away above the stage) and its `content`
/// (scrolls under it). The layout is `StageLayout.choose` over the **pane's**
/// content width.
///
/// Nothing here reads the per-frame clock. The transport, the now-strip and the
/// map card do, as their own small views, so a frame re-renders those and the
/// rest of the page — the panel above all — stays put.
struct LapStageView<Header: View, Content: View>: View {
    let model: LapStageModel
    /// Whether the mode control shows: the compares, never a single lap's
    /// stage, whose B is a quiet reference with no slot.
    var compare = true
    @ViewBuilder var header: () -> Header
    @ViewBuilder var content: () -> Content

    @Environment(\.layout) private var layout
    @Environment(\.foldGeometry) private var fold
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.unitSystem) private var units

    /// Why the full-bleed cover is up, if it is: a phone turned on its side
    /// (turning back dismisses it), or the fullscreen button (its back chip does).
    @State private var fullBleed: FullBleedReason?
    /// Whether a phone's stage has scrolled out, so its mini bar shows.
    ///
    /// The compact stage is **not pinned**, and the mini bar is an overlay, so
    /// collapsing never changes the page's height. It did once — a pinned
    /// ~380pt stage shrinking to a 64pt bar made the page that much shorter, so
    /// near the bottom the scroll offset was clamped back under the threshold,
    /// the stage grew again, and the page was thrown back up: the bottom of the
    /// panel could not be reached. The web's stage made the same call.
    @State private var collapsed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visibleHeight: CGFloat = 800

    private enum FullBleedReason { case rotation, button }

    private var stageLayout: StageLayout {
        StageLayout.choose(
            contentWidth: layout.contentWidth,
            sideColumnWidth: layout.sideColumnWidth(
                fraction: StageLayout.SIDE_FRACTION, minimum: StageLayout.SIDE_MIN, maximum: StageLayout.SIDE_MAX
            ),
            fold: fold
        )
    }

    var body: some View {
        Group {
            switch stageLayout {
            case .tabletop(let share):
                tabletop(share)
            case let other:
                scrolling(other)
            }
        }
        .background { StageKeyboard(model: model, compare: compare) }
        .accessibilityIdentifier("lapStage")
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { visibleHeight = $0 }
        .onChange(of: verticalSizeClass, initial: true) { _, size in autoFullBleed(size) }
        .onChange(of: model.hasAnyVideo) { _, _ in autoFullBleed(verticalSizeClass) }
        // Backgrounded mid-play: pause. Picture-in-picture is out of scope.
        // `.background` only: a fold or a rotation passes through `.inactive`.
        .onChange(of: scenePhase) { _, phase in
            if LapStageModel.pausesFor(phase) { model.pause(announce: false) }
        }
        .onChange(of: units, initial: true) { _, units in model.units = units }
        // Counted rather than torn down: a resize rebuilds this view around the
        // same model, and the video carries on (`viewerDisappeared`).
        .onAppear { model.viewerAppeared() }
        .onDisappear { model.viewerDisappeared() }
        // The stage's one presentation. A host must present nothing else from
        // this view: two modal presentations on one view is the watchdog crash
        // AGENTS.md lists.
        .fullScreenCover(isPresented: Binding(get: { fullBleed != nil }, set: { if !$0 { fullBleed = nil } })) {
            FullBleedStage(model: model) { fullBleed = nil }
                .onChange(of: verticalSizeClass) { _, size in
                    if fullBleed == .rotation, size != .compact { fullBleed = nil }
                }
        }
    }

    private func autoFullBleed(_ size: UserInterfaceSizeClass?) {
        if StageLayout.goesFullBleed(verticalSizeClass: size, hasVideo: model.hasAnyVideo) {
            if fullBleed == nil { fullBleed = .rotation }
        } else if fullBleed == .rotation {
            fullBleed = nil
        }
    }

    private var gutter: CGFloat { TESpacing.pageGutter }

    // MARK: - Scrolling layouts

    @ViewBuilder
    private func scrolling(_ stage: StageLayout) -> some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                    header()
                        .padding(.horizontal, gutter)
                        .padding(.top, gutter)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id("stageTop")
                    if case .medium = stage {
                        mediumTop.padding(.horizontal, gutter)
                    }
                    if stage == .compact {
                        // Not pinned, unlike the other layouts: see `collapsed`.
                        compactStage
                            .onGeometryChange(for: Bool.self) { proxy in
                                // Past once the transport has slid under the top of
                                // the scroll view. A Bool, so the stage re-renders
                                // at the crossing and not on every scrolled frame.
                                proxy.frame(in: .scrollView).maxY < 40
                            } action: { past in
                                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { collapsed = past }
                            }
                    }
                    Section {
                        content()
                            .padding(.horizontal, gutter)
                            .padding(.bottom, gutter)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } header: {
                        pinned(stage, reader: reader)
                            .background(Color(.bgPage))
                    }
                }
            }
            .modifier(RememberScroll(model: model))
            .overlay(alignment: .top) {
                if stage == .compact, collapsed {
                    miniBar {
                        withAnimation(nil) { reader.scrollTo("stageTop", anchor: .top) }
                    }
                    .background(Color(.bgPage))
                    .transition(.opacity)
                }
            }
        }
    }

    @ViewBuilder
    private func pinned(_ stage: StageLayout, reader: ScrollViewProxy) -> some View {
        switch stage {
        case .wide(let sideWidth):
            wide(sideWidth)
        case .medium:
            StageTransport(model: model, compare: compare, large: true)
                .padding(.horizontal, gutter)
                .padding(.vertical, 8)
        case .compact, .tabletop:
            // The compact stage scrolls with the page; nothing pins.
            EmptyView()
        }
    }

    // MARK: - Wide

    private func wide(_ sideWidth: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 10) {
                slotsRow(rounded: true)
                    // The stage is at most 45% of what is visible, so the charts
                    // it pins over always get the larger share.
                    .frame(maxHeight: max(160, visibleHeight * 0.45 - 70))
                StageTransport(model: model, compare: compare, large: true)
            }
            VStack(spacing: 10) {
                if model.trace != nil, model.hasAnyVideo {
                    StageMapCard(model: model)
                }
                NowStrip(model: model, row: false)
            }
            .frame(width: sideWidth)
        }
        .padding(.horizontal, gutter)
        .padding(.vertical, 10)
    }

    // MARK: - Medium

    private var mediumTop: some View {
        VStack(spacing: 10) {
            // Held to the same share of the height as Wide: a lone 16:9 replay
            // map across a whole pane is taller than the screen has to give.
            slotsRow(rounded: true)
                .frame(maxHeight: max(160, visibleHeight * 0.45))
            HStack(alignment: .top, spacing: 10) {
                if model.trace != nil, model.hasAnyVideo {
                    StageMapCard(model: model)
                        .frame(width: layout.contentWidth * 0.46, height: 190)
                }
                NowStrip(model: model, row: false)
            }
        }
    }

    // MARK: - Compact

    private var compactStage: some View {
        VStack(spacing: 0) {
            compactPlayer
            VStack(spacing: 8) {
                StageTransport(model: model, compare: compare, large: false) {
                    fullBleed = .button
                }
                NowStrip(model: model, row: true)
                if compare, model.isTwoSided {
                    ModeControl(model: model)
                }
            }
            .padding(.horizontal, gutter)
            .padding(.vertical, 8)
        }
    }

    /// Edge to edge: the master large, and the follower — when it has a
    /// picture — as an inset at the bottom right; tap it to swap.
    private var compactPlayer: some View {
        let master = model.masterKey
        let other: VideoSync.SideKey = master == .A ? .B : .A
        return ZStack(alignment: .bottomTrailing) {
            if model.hasVideo(master) {
                VideoSlot(model: model, key: master, rounded: false)
            } else {
                ReplaySlot(model: model, key: master, rounded: false)
            }
            if model.isTwoSided, model.hasVideo(other), model.hasVideo(master) {
                Button {
                    model.swap()
                    Haptics.select()
                } label: {
                    VideoSlot(model: model, key: other, rounded: true, chipless: true)
                        .frame(width: StageLayout.insetWidth(contentWidth: layout.contentWidth))
                        .overlay(
                            RoundedRectangle(cornerRadius: TERadius.sm)
                                .strokeBorder(Color(.chartLineB), lineWidth: 2)
                        )
                }
                .buttonStyle(.plain)
                .padding(10)
                .accessibilityLabel("Swap videos")
                .accessibilityHint("Makes \(model.input(other)?.chip ?? "the other lap") the large video")
                .accessibilityIdentifier("stageInset")
            }
        }
    }

    /// The mini bar a phone's player shrinks to once the charts have scrolled:
    /// play/pause and the scrubber stay in reach while reading the steering
    /// trace at the bottom of the panel. A tap on the thumbnail scrolls back.
    private func miniBar(expand: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Button(action: expand) {
                Group {
                    if model.hasVideo(model.masterKey) {
                        StageVideoView(player: model.videos[model.masterKey]?.player)
                    } else {
                        Color(.surfaceRaised)
                    }
                }
                .frame(width: 80, height: 45)
                .clipShape(RoundedRectangle(cornerRadius: TERadius.xs))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show the video")
            StageTransport(model: model, compare: compare, large: false, mini: true)
        }
        .frame(height: 64)
        .padding(.horizontal, gutter)
    }

    // MARK: - Tabletop

    /// Above the crease the picture; below it the transport and the now-strip
    /// in one row, then the charts — weighted by where the hinge actually is.
    /// A narrow window (a cover display) keeps the picture to itself above the
    /// crease and stacks the now-strip under the transport: beside each other
    /// at that width the scrubber has no room left.
    private func tabletop(_ share: Double) -> some View {
        let roomy = layout.contentWidth >= StageLayout.MEDIUM_MIN
        return GeometryReader { geo in
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    slotsRow(rounded: true)
                    if roomy, model.trace != nil, model.hasAnyVideo {
                        StageMapCard(model: model).frame(maxWidth: 260)
                    }
                }
                .padding(gutter)
                .frame(height: geo.size.height * share)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                        Section {
                            header().padding(.horizontal, gutter)
                            content().padding(.horizontal, gutter).padding(.bottom, gutter)
                        } header: {
                            Group {
                                if roomy {
                                    VStack(spacing: 8) {
                                        HStack(alignment: .center, spacing: 12) {
                                            // The mode gets its own row: beside the
                                            // now-strip it was squeezed to "S S".
                                            StageTransport(model: model, compare: false, large: true)
                                            NowStrip(model: model, row: true).frame(maxWidth: 380)
                                        }
                                        if compare, model.isTwoSided { ModeControl(model: model) }
                                    }
                                } else {
                                    VStack(spacing: 8) {
                                        StageTransport(model: model, compare: compare, large: false)
                                        NowStrip(model: model, row: true)
                                        if compare, model.isTwoSided { ModeControl(model: model) }
                                    }
                                }
                            }
                            .padding(.horizontal, gutter)
                            .padding(.vertical, 8)
                            .background(Color(.bgPage))
                        }
                    }
                }
            }
        }
    }

    // MARK: - Slots

    /// The videos side by side — or, with no picture anywhere, **one** map with
    /// a dot per side, rather than two identical replay slots.
    @ViewBuilder
    private func slotsRow(rounded: Bool) -> some View {
        if !model.hasAnyVideo {
            ReplaySlot(model: model, key: .A, rounded: rounded)
        } else {
            HStack(spacing: 10) {
                ForEach(compare ? [VideoSync.SideKey.A, .B] : [.A], id: \.self) { key in
                    if model.input(key) != nil {
                        if model.hasVideo(key) {
                            VideoSlot(model: model, key: key, rounded: rounded)
                        } else {
                            ReplaySlot(model: model, key: key, rounded: rounded)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Continuity

/// Lands a rebuilt page back near where it was scrolled (iOS 18's
/// `ScrollPosition`): a resize that swaps the shell builds a new scroll view,
/// which would otherwise open at the top. Approximate by design — the stage's
/// own height can change with the layout — and on iOS 17 the page simply opens
/// at the top, as before.
private struct RememberScroll: ViewModifier {
    let model: LapStageModel

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            RestoringScroll(model: model, content: content)
        } else {
            content
        }
    }
}

@available(iOS 18.0, *)
private struct RestoringScroll<Content: View>: View {
    let model: LapStageModel
    let content: Content
    @State private var position = ScrollPosition(edge: .top)

    var body: some View {
        content
            .scrollPosition($position)
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, y in
                model.scrollY = y
            }
            .onAppear {
                if model.scrollY > 1 { position.scrollTo(y: model.scrollY) }
            }
    }
}

// MARK: - Slots

/// A side's video: the picture, its chip, and a spinner until it can play.
private struct VideoSlot: View {
    let model: LapStageModel
    let key: VideoSync.SideKey
    let rounded: Bool
    var chipless = false

    var body: some View {
        let video = model.videos[key]
        ZStack(alignment: .topLeading) {
            StageVideoView(player: video?.player)
            if video?.isReady != true {
                ProgressView()
                    .tint(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if !chipless, let input = model.input(key) {
                SideChip(key: key, text: input.chip)
                    .padding(8)
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: rounded ? TERadius.md : 0))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(model.input(key)?.chip ?? "Lap") video")
        .accessibilityValue(video?.isReady == true ? "ready" : "loading")
        .accessibilityIdentifier("stageVideo\(key.rawValue)")
    }
}

/// A side with no playable video: the map with its dot, and why there is no
/// picture.
private struct ReplaySlot: View {
    let model: LapStageModel
    let key: VideoSync.SideKey
    let rounded: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(.surfaceCard)
            if let trace = model.trace {
                ReplayMap(model: model, trace: trace)
                    .padding(.top, 28)
            }
            VStack(alignment: .leading, spacing: 4) {
                if model.hasAnyVideo || !model.isTwoSided, let input = model.input(key) {
                    SideChip(key: key, text: input.chip)
                }
                Text(label)
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textMuted))
            }
            .padding(8)
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: rounded ? TERadius.md : 0))
        .overlay(
            RoundedRectangle(cornerRadius: rounded ? TERadius.md : 0)
                .strokeBorder(Color(.borderHairline), lineWidth: rounded ? 1 : 0)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stageReplay\(key.rawValue)")
    }

    private var label: String {
        if case .failed(let words) = model.videos[key]?.status { return words }
        return "No video · replaying telemetry"
    }
}

/// The map inside a replay slot — its own view because its dots move every
/// frame.
private struct ReplayMap: View {
    let model: LapStageModel
    let trace: [TracePoint]

    var body: some View {
        TrackMapView(trace: trace, dots: model.mapDots())
    }
}

/// "● Lap 5 · 2:19.812 ★" over a slot. The colour is never the only way to
/// tell the sides apart: the lap number is in the words.
private struct SideChip: View {
    let key: VideoSync.SideKey
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(key == .A ? Color(.chartLine) : Color(.chartLineB))
                .frame(width: 8, height: 8)
            Text(text)
                .teStyle(.xs)
                .monospacedDigit()
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.55), in: .capsule)
    }
}

// MARK: - Map card

/// "Where the car is": the best lap's line with the playhead's dot (two in
/// *Same time*).
struct StageMapCard: View {
    let model: LapStageModel

    var body: some View {
        TECard {
            VStack(alignment: .leading, spacing: 6) {
                Text("Where the car is")
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textMuted))
                if let trace = model.trace {
                    TrackMapView(trace: trace, dots: model.mapDots())
                        .frame(minHeight: 110)
                }
            }
        }
    }
}

// MARK: - Transport

/// Play/pause, the scrubber, the times — and, in a compare on a large screen,
/// the mode control, plus a rate menu; on a phone, a fullscreen button.
struct StageTransport: View {
    let model: LapStageModel
    var compare = true
    var large = true
    var mini = false
    var onFullscreen: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            PlayButton(model: model, size: mini ? 34 : 38)
            StageScrubber(model: model)
            if !mini {
                StageClock(model: model)
                if large, compare, model.isTwoSided {
                    ModeControl(model: model).frame(maxWidth: 220)
                }
                if large {
                    RateMenu(model: model)
                }
                if let onFullscreen, model.hasAnyVideo {
                    Button(action: onFullscreen) {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .foregroundStyle(Color(.textMuted))
                            .frame(width: 36, height: 36)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Full screen")
                    .accessibilityIdentifier("stageFullscreen")
                }
            }
        }
    }
}

private struct PlayButton: View {
    let model: LapStageModel
    var size: CGFloat = 38

    var body: some View {
        Button {
            model.togglePlay()
        } label: {
            Image(systemName: model.playing ? "pause.fill" : "play.fill")
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(Color(.accentContrast))
                .frame(width: size, height: size)
                .background(Color(.accent), in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.playing ? "Pause" : "Play")
        .accessibilityValue(model.playing ? "playing" : "paused")
        .accessibilityIdentifier("stagePlay")
    }
}

/// "0:36.0 / 2:19.8" — the master's lap time.
private struct StageClock: View {
    let model: LapStageModel

    var body: some View {
        Text("\(VideoSync.fmtStageTime(model.eMaster)) / \(VideoSync.fmtStageTime(model.scrub.lapS))")
            .teStyle(.lapTime)
            .monospacedDigit()
            .foregroundStyle(Color(.textMuted))
            .lineLimit(1)
            .fixedSize()
            .accessibilityHidden(true)
    }
}

struct ModeControl: View {
    let model: LapStageModel

    var body: some View {
        Picker("Sync", selection: Binding(get: { model.mode }, set: { model.mode = $0 })) {
            Text("Same place").tag(VideoSync.SyncMode.place)
            Text("Same time").tag(VideoSync.SyncMode.time)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("stageMode")
    }
}

private struct RateMenu: View {
    let model: LapStageModel

    var body: some View {
        Menu {
            ForEach([0.25, 0.5, 1.0], id: \.self) { rate in
                Button {
                    model.setRate(rate)
                } label: {
                    if rate == model.rate {
                        Label(Self.label(rate), systemImage: "checkmark")
                    } else {
                        Text(Self.label(rate))
                    }
                }
            }
        } label: {
            Text(Self.label(model.rate))
                .teStyle(.xs)
                .monospacedDigit()
                .foregroundStyle(Color(.textMuted))
                .frame(minWidth: 40, minHeight: 36)
                .contentShape(.rect)
        }
        .accessibilityLabel("Playback speed, \(Self.label(model.rate))")
    }

    static func label(_ rate: Double) -> String {
        rate == 1 ? "1×" : rate == 0.5 ? "0.5×" : "0.25×"
    }
}

// MARK: - Scrubber

/// The scrubber: the master's lap with the run-up either side, the delta drawn
/// along it (A's speed with nothing to compare), ticks at each corner's start
/// and the sector boundaries, a dashed tick at the line.
///
/// **One adjustable element** for VoiceOver, whose value is `playheadText`'s
/// spoken line and whose swipe up/down steps corner by corner.
struct StageScrubber: View {
    let model: LapStageModel
    @Environment(\.unitSystem) private var units

    var body: some View {
        GeometryReader { geo in
            let g = model.scrub
            let span = max(0.001, g.max - g.min)
            let x = { (e: Double) in CGFloat((e - g.min) / span) * geo.size.width }
            ZStack(alignment: .leading) {
                ScrubTrack(geometry: g)
                    .equatable()
                Circle()
                    .fill(Color(.textStrong))
                    .overlay(Circle().strokeBorder(Color(.surfaceCard), lineWidth: 2))
                    .frame(width: 14, height: 14)
                    .position(x: min(max(x(model.eMaster), 0), geo.size.width), y: geo.size.height / 2)
            }
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        model.beginScrub()
                        model.scrub(to: g.min + Double(value.location.x / max(1, geo.size.width)) * span)
                    }
                    .onEnded { value in
                        model.endScrub(at: g.min + Double(value.location.x / max(1, geo.size.width)) * span)
                    }
            )
        }
        .frame(height: 34)
        .accessibilityElement()
        .accessibilityLabel("Lap position")
        .accessibilityValue(model.text(units)?.value ?? "")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: model.nextCorner(1)
            case .decrement: model.nextCorner(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("stageScrubber")
    }
}

/// What the scrubber draws under its thumb — equatable, so it is drawn when the
/// sides change and never because the thumb moved.
private struct ScrubTrack: View, Equatable {
    let geometry: LapStageModel.ScrubGeometry

    nonisolated static func == (a: ScrubTrack, b: ScrubTrack) -> Bool {
        a.geometry == b.geometry
    }

    var body: some View {
        Canvas { context, size in
            let g = geometry
            let span = max(0.001, g.max - g.min)
            let x = { (e: Double) in CGFloat((e - g.min) / span) * size.width }
            let mid = size.height / 2
            var rail = Path()
            rail.move(to: CGPoint(x: 0, y: mid))
            rail.addLine(to: CGPoint(x: size.width, y: mid))
            context.stroke(rail, with: .color(Color(.borderStrong)), lineWidth: 2)

            if g.points.count > 1 {
                var line = Path()
                for (i, p) in g.points.enumerated() {
                    // A delta around the middle (up is slower); a speed from the bottom.
                    let y = g.isDelta ? mid - p.y * (mid - 4) : size.height - 4 - p.y * (size.height - 8)
                    let point = CGPoint(x: x(p.x), y: y)
                    if i == 0 { line.move(to: point) } else { line.addLine(to: point) }
                }
                context.stroke(
                    line, with: .color(g.isDelta ? Color(.danger) : Color(.chartDim)),
                    style: .init(lineWidth: 1.25, lineJoin: .round)
                )
            }
            for e in g.corners {
                var tick = Path()
                tick.move(to: CGPoint(x: x(e), y: size.height - 6))
                tick.addLine(to: CGPoint(x: x(e), y: size.height))
                context.stroke(tick, with: .color(Color(.textFaint)), lineWidth: 1)
            }
            for e in g.sectors {
                var tick = Path()
                tick.move(to: CGPoint(x: x(e), y: 0))
                tick.addLine(to: CGPoint(x: x(e), y: 6))
                context.stroke(tick, with: .color(Color(.textMuted)), lineWidth: 1.5)
            }
            // The line, dashed: e = 0.
            var line = Path()
            line.move(to: CGPoint(x: x(0), y: 2))
            line.addLine(to: CGPoint(x: x(0), y: size.height - 2))
            context.stroke(line, with: .color(Color(.textMuted)), style: .init(lineWidth: 1, dash: [3, 2]))
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Now-strip

/// What the car is doing at the playhead, for side A: where, how fast, which
/// gear, the pedals, and the delta — or in *Same time* the gap.
struct NowStrip: View {
    let model: LapStageModel
    /// One row (phones, the tabletop's lower half) or a card with rows.
    let row: Bool
    @Environment(\.unitSystem) private var units

    var body: some View {
        let text = model.text(units)
        let st = model.state
        let now = st?.inLap == true ? st?.a.now : nil
        Group {
            if row {
                HStack(spacing: 10) {
                    Text(text?.place ?? "—")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    speed(now)
                    gear(now)
                    bars(now)
                    delta(text, st)
                }
            } else {
                TECard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(text?.place ?? "—")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textStrong))
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            speed(now)
                            gear(now)
                            Spacer(minLength: 0)
                            bars(now)
                        }
                        if model.isTwoSided, let b = st?.b, st?.inLap == true, let v = b.now.speedKph {
                            Text("B \(Units.fmtSpeedKph(v, units))")
                                .teStyle(.xs)
                                .monospacedDigit()
                                .foregroundStyle(Color(.textMuted))
                        }
                        delta(text, st)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stageNowStrip")
    }

    private func speed(_ now: VideoSync.Readings?) -> some View {
        Text(now?.speedKph.map { Units.fmtSpeedKph($0, units) } ?? "—")
            .teStyle(.h2)
            .monospacedDigit()
            .foregroundStyle(Color(.textStrong))
            .lineLimit(1)
            .fixedSize()
    }

    @ViewBuilder
    private func gear(_ now: VideoSync.Readings?) -> some View {
        if let gear = now?.gear, gear > 0 {
            Text(String(Int(gear)))
                .teStyle(.bodyStrong)
                .monospacedDigit()
                .foregroundStyle(Color(.textStrong))
                .padding(.horizontal, 6)
                .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.xs))
                .accessibilityLabel("gear \(Int(gear))")
        }
    }

    @ViewBuilder
    private func bars(_ now: VideoSync.Readings?) -> some View {
        if now?.throttle != nil || now?.brake != nil {
            HStack(alignment: .bottom, spacing: 3) {
                bar(now?.throttle, Color(.limitPower))
                bar(now?.brake, Color(.limitBrake))
            }
            .frame(height: 26)
            .accessibilityElement()
            .accessibilityLabel(
                "throttle \(Int((now?.throttle ?? 0).rounded())) percent, brake \(Int((now?.brake ?? 0).rounded())) percent"
            )
        }
    }

    private func bar(_ value: Double?, _ color: Color) -> some View {
        ZStack(alignment: .bottom) {
            Capsule().fill(Color(.surfaceRaised))
            Capsule().fill(color).frame(height: 26 * CGFloat(min(max((value ?? 0) / 100, 0), 1)))
        }
        .frame(width: 6, height: 26)
    }

    @ViewBuilder
    private func delta(_ text: VideoSync.Text?, _ st: VideoSync.Playhead?) -> some View {
        if let words = text?.delta {
            let color: Color = st?.mode == .time ? Color(.textStrong)
                : (st?.deltaS ?? 0) > 0 ? Color(.dangerInk)
                : (st?.deltaS ?? 0) < 0 ? Color(.positive) : Color(.textStrong)
            Text(words + (model.isTwoSided && st?.mode == .place ? " vs \(referenceName)" : ""))
                .teStyle(.bodyStrong)
                .monospacedDigit()
                .foregroundStyle(color)
                .lineLimit(1)
                .fixedSize()
        }
    }

    /// "vs B", or on a single lap's stage "vs best" / "vs lap 3".
    private var referenceName: String {
        guard let b = model.input(.B) else { return "B" }
        return b.isBest ? "best" : "lap \(b.lapNum)"
    }
}

// MARK: - Full-bleed

/// A phone on its side with a video on the stage: the master video fills the
/// window, a HUD over a bottom gradient, the scrubber along the bottom, the map
/// and B's inset top-right, the back chip top-left. The same model, so playback
/// carries on rather than restarting.
private struct FullBleedStage: View {
    let model: LapStageModel
    let dismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            StageVideoView(player: model.videos[model.masterKey]?.player)
                .ignoresSafeArea()
            VStack(spacing: 0) {
                HStack(alignment: .top) {
                    Button(action: dismiss) {
                        Label("Back", systemImage: "chevron.backward")
                            .teStyle(.sm)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(.black.opacity(0.55), in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("fullBleedBack")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 8) {
                        if let trace = model.trace {
                            ReplayMap(model: model, trace: trace)
                                .frame(width: 150, height: 110)
                                .background(Color(.surfaceCard).opacity(0.85), in: .rect(cornerRadius: TERadius.sm))
                        }
                        let other: VideoSync.SideKey = model.masterKey == .A ? .B : .A
                        if model.isTwoSided, model.hasVideo(other) {
                            Button {
                                model.swap()
                            } label: {
                                StageVideoView(player: model.videos[other]?.player)
                                    .frame(width: 150, height: 84)
                                    .clipShape(RoundedRectangle(cornerRadius: TERadius.sm))
                                    // Bordered in B's colour: a dark frame on the
                                    // black around it would otherwise vanish.
                                    .overlay(
                                        RoundedRectangle(cornerRadius: TERadius.sm)
                                            .strokeBorder(Color(.chartLineB), lineWidth: 2)
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Swap videos")
                        }
                    }
                }
                Spacer()
                VStack(spacing: 6) {
                    NowStrip(model: model, row: true)
                        .environment(\.colorScheme, .dark)
                    StageTransport(model: model, compare: false, large: false, mini: true)
                        .environment(\.colorScheme, .dark)
                }
                .padding(12)
                .background(
                    LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom),
                    in: .rect(cornerRadius: TERadius.md)
                )
            }
            .padding(12)
        }
        .statusBarHidden()
        .accessibilityIdentifier("fullBleedStage")
    }
}

// MARK: - Keyboard

/// The stage's keyboard (iPad, Mac): Space play/pause, ← / → a second, ⌥← / ⌥→
/// one grid point (20 m), `,` / `.` a frame while paused, `S` the sync mode.
///
/// Zero-sized titled `Button`s with `.keyboardShortcut`, the panel's
/// `keyboardCommands` pattern: declared this way they become `UIKeyCommand`s and
/// list by their titles in the ⌘ overlay. None clashes with the panel's `1`–`4`,
/// `[` / `]` and ⌘F.
private struct StageKeyboard: View {
    let model: LapStageModel
    let compare: Bool

    var body: some View {
        Group {
            Button(model.playing ? "Pause" : "Play") { model.togglePlay() }
                .keyboardShortcut(.space, modifiers: [])
            Button("Back one second") { model.step(seconds: -1) }
                .keyboardShortcut(.leftArrow, modifiers: [])
            Button("Forward one second") { model.step(seconds: 1) }
                .keyboardShortcut(.rightArrow, modifiers: [])
            Button("Back 20 metres") { model.step(gridPoints: -1) }
                .keyboardShortcut(.leftArrow, modifiers: .option)
            Button("Forward 20 metres") { model.step(gridPoints: 1) }
                .keyboardShortcut(.rightArrow, modifiers: .option)
            Button("Previous frame") { model.step(frames: -1) }
                .keyboardShortcut(",", modifiers: [])
            Button("Next frame") { model.step(frames: 1) }
                .keyboardShortcut(".", modifiers: [])
            if compare, model.isTwoSided {
                Button(model.mode == .place ? "Sync by time" : "Sync by place") {
                    model.mode = model.mode == .place ? .time : .place
                }
                .keyboardShortcut("s", modifiers: [])
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}
