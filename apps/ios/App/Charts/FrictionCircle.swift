import SwiftUI
import TrackEvolutionKit

/// The friction circle (#186) — the counterpart of `frictionCircleSvg` and
/// `gripReadoutHtml` in `public/js/grip.js`.
///
/// Every 20 m sample of the highlighted laps plotted lateral against
/// longitudinal G, over a dim envelope of the session's other laps, with a
/// dashed reference arc at the session's own peak combined G. A driver who
/// brakes in a straight line, turns, then accelerates draws a cross; one who
/// trails the brake in and feeds the power out fills the circle, and the empty
/// space between the two is the lost time. The maths is the Kit's `Grip`,
/// pinned to the web implementation by `contracts/logic/grip.json`; this file
/// draws.
///
/// Three things about the drawing are load-bearing.
///
/// **Braking is up.** `longG` is negative under braking, so the y mapping adds
/// rather than subtracts — deceleration is what a driver feels pitching the car
/// forward, and it is the one axis on this chart with a fixed place in their
/// head. Same call the web made, and `GripTests` is not where it would be
/// caught, so it is stated here.
///
/// **The plot area is square** (`aspectRatio(1, contentMode: .fit)`), because a
/// circle that draws as an ellipse makes the whole reading wrong.
///
/// **Hand-rolled on `Canvas`, not Swift Charts.** This is a polar picture —
/// concentric rings, a dashed arc, thousands of unconnected points — and a
/// `PointMark` per sample inside the panel's sheet is exactly the "chart of this
/// many marks never settles" hazard `LapChannelChart` documents. The points are
/// drawn as two paths (dim envelope, then the lit laps), which is also what
/// keeps a full session cheap: `MAX_TOTAL_VALUES` caps a stored session's
/// channels, so `latG` tops out in the low thousands of samples.
///
/// **A tap points, and a pointer borrows.** The web answers a *hover* over a dot
/// by marking that distance on every chart and ringing the place on the track
/// map; a phone has no pointer, so NS-34 ticket 3 gave that to a tap instead.
/// An iPad with a trackpad has both, so ticket 5 wires the pointer up as well —
/// additive to the tap, never a replacement, because the same iPad is used by
/// touch a moment later. A hovered mark lasts as long as the pointer is over the
/// plot; a tapped one stays until it is tapped away.
struct FrictionCircle: View {
    let channels: SessionChannels
    /// Channel-lap indexes in slot order, as `LapChannelPanel` keeps them.
    let lit: [Int]
    let slots: [Color]
    /// The session's own lap number for a channel entry.
    let lapNumber: (Int) -> Int
    /// Tapping a sample answers "which corner is this dot" on everything drawn
    /// beside it (NS-34 ticket 3). Nil clears the answer.
    var onHit: (ChannelHit?) -> Void = { _ in }
    /// The same answer from a *pointer* (NS-34 ticket 5), which the panel holds
    /// only while the pointer is over the plot. Nil means it has left.
    var onHover: (ChannelHit?) -> Void = { _ in }
    /// Whether to draw the laps that aren't highlighted (⌘F).
    ///
    /// The envelope is what a lit lap is read *against*, so it is on by default
    /// and only a keyboard can turn it off — on a crowded session the dim cloud
    /// can bury the three laps being compared, and that is the one case worth a
    /// shortcut rather than a control.
    var showEnvelope: Bool = true

    /// Ring spacing, in G. 0.5 G rings are readable on every car this app sees;
    /// a slow car simply draws fewer of them.
    private static let ringStepG: Double = 0.5

    private struct Row: Identifiable {
        let color: Color
        let lap: Grip.LapShares
        var id: Int { lap.chIdx }
    }

    var body: some View {
        if let sg = Grip.sessionGrip(channels) {
            let rows = lit.enumerated().compactMap { slot, chIdx -> Row? in
                guard slot < slots.count, let lap = sg.laps.first(where: { $0.chIdx == chIdx }) else { return nil }
                return Row(color: slots[slot], lap: lap)
            }
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Friction circle")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textMuted))
                        Text("How much of the tyre is being used. 20 m samples, so this is the shape of grip usage, not peak G.")
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textFaint))
                    }
                    Canvas { context, size in
                        draw(sg, in: context, size: size)
                    }
                    .aspectRatio(1, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    // Tap *and* hover, over one hit-test: a finger commits a
                    // mark and a pointer borrows one, and both ask the same
                    // question of the same geometry so the two can never come to
                    // different answers about which dot is under them.
                    .overlay {
                        GeometryReader { geometry in
                            Color.clear
                                .contentShape(Rectangle())
                                .onTapGesture { location in
                                    onHit(hit(sg, at: location, size: geometry.size))
                                }
                                .onContinuousHover { phase in
                                    switch phase {
                                    case .active(let location):
                                        onHover(hit(sg, at: location, size: geometry.size))
                                    case .ended:
                                        onHover(nil)
                                    @unknown default:
                                        onHover(nil)
                                    }
                                }
                        }
                    }
                    readout(sg, rows)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Friction circle: cornering against braking and acceleration")
            .accessibilityValue(summary(sg, rows))
            .accessibilityIdentifier("frictionCircle")
        }
    }

    // MARK: - Plot

    /// The axis domain: the furthest sample, or the reference arc if it somehow
    /// reaches further, with a little air — rounded up to a ring boundary so the
    /// outermost ring is a labelled one. `axisMaxG` in the JS.
    private func axisMaxG(_ sg: Grip.SessionGrip) -> Double {
        let need = max(sg.maxG, sg.peakG ?? 0) * 1.04
        return max(Self.ringStepG, (need / Self.ringStepG).rounded(.up) * Self.ringStepG)
    }

    /// The plotted sample nearest a tap, among the **highlighted** laps only.
    ///
    /// The envelope behind them is every other lap at once; a tap landing on it
    /// has no single answer to give, so it clears instead. Within a lit lap the
    /// nearest sample wins, but only inside a finger-sized radius — a tap on
    /// empty canvas should mean "never mind", not "the closest dot, wherever it
    /// is".
    ///
    /// The transform is `draw`'s, deliberately duplicated rather than hoisted:
    /// the drawing takes a `GraphicsContext` and this takes a tap, and pulling
    /// the four lines they share into a shape object would be more indirection
    /// than the arithmetic is worth. They fail together — a change to one that
    /// misses the other puts the ring in the wrong corner, which is visible the
    /// first time it is used.
    private func hit(_ sg: Grip.SessionGrip, at location: CGPoint, size: CGSize) -> ChannelHit? {
        let inset: CGFloat = 18
        let side = min(size.width, size.height) - inset * 2
        guard side > 0 else { return nil }
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let scale = Double(side / 2) / axisMaxG(sg)
        guard scale > 0 else { return nil }

        var best: (distance: CGFloat, hit: ChannelHit)?
        for chIdx in lit {
            guard let lap = Grip.gripLaps(channels).first(where: { $0.chIdx == chIdx }) else { continue }
            let points = Grip.gripPoints(lap.entry)
            guard points.count > 1 else { continue }
            for p in points {
                let plotted = CGPoint(
                    x: center.x + CGFloat(p.lat * scale),
                    y: center.y + CGFloat(p.long * scale)
                )
                let d = hypot(plotted.x - location.x, plotted.y - location.y)
                if best == nil || d < best!.distance {
                    best = (
                        d,
                        ChannelHit(
                            chIdx: chIdx,
                            k: p.k,
                            frac: points.count > 1 ? Double(p.k) / Double(points.count - 1) : 0
                        )
                    )
                }
            }
        }
        guard let best, best.distance <= 22 else { return nil }
        return best.hit
    }

    private func draw(_ sg: Grip.SessionGrip, in context: GraphicsContext, size: CGSize) {
        // Room for the axis words above and below the plot.
        let inset: CGFloat = 18
        let side = min(size.width, size.height) - inset * 2
        guard side > 0 else { return }
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let axis = axisMaxG(sg)
        let scale = Double(side / 2) / axis
        // Braking is up: longG is negative under braking, so y *adds*.
        func point(_ lat: Double, _ long: Double) -> CGPoint {
            CGPoint(x: center.x + CGFloat(lat * scale), y: center.y + CGFloat(long * scale))
        }

        // Rings every ringStepG, labelled along the +x axis.
        var ring = Self.ringStepG
        while ring <= axis + 1e-9 {
            let r = CGFloat(ring * scale)
            context.stroke(
                Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)),
                with: .color(Color(.chartGrid)), lineWidth: 1
            )
            context.draw(
                context.resolve(
                    Text(String(format: "%.1f", ring))
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundColor(Color(.textFaint))
                ),
                at: CGPoint(x: center.x + r, y: center.y + 9)
            )
            ring += Self.ringStepG
        }

        // The axes.
        var axes = Path()
        axes.move(to: CGPoint(x: center.x - CGFloat(side / 2), y: center.y))
        axes.addLine(to: CGPoint(x: center.x + CGFloat(side / 2), y: center.y))
        axes.move(to: CGPoint(x: center.x, y: center.y - CGFloat(side / 2)))
        axes.addLine(to: CGPoint(x: center.x, y: center.y + CGFloat(side / 2)))
        context.stroke(axes, with: .color(Color(.borderStrong)), lineWidth: 1)

        // The dim envelope: every lap that isn't highlighted, as one path.
        let litSet = Set(lit)
        var dim = Path()
        var hot: [(Color, Path)] = []
        for lap in Grip.gripLaps(channels) {
            let points = Grip.gripPoints(lap.entry)
            if let slot = lit.firstIndex(of: lap.chIdx), slot < slots.count {
                var path = Path()
                for p in points {
                    let c = point(p.lat, p.long)
                    path.addEllipse(in: CGRect(x: c.x - 2.4, y: c.y - 2.4, width: 4.8, height: 4.8))
                }
                hot.append((slots[slot], path))
            } else if showEnvelope, !litSet.contains(lap.chIdx) {
                for p in points {
                    let c = point(p.lat, p.long)
                    dim.addEllipse(in: CGRect(x: c.x - 1.3, y: c.y - 1.3, width: 2.6, height: 2.6))
                }
            }
        }
        context.fill(dim, with: .color(Color(.chartDim)))

        // The reference arc: what this car did today, at the 99th percentile.
        if let peak = sg.peakG, peak > 0 {
            let r = CGFloat(peak * scale)
            context.stroke(
                Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)),
                with: .color(Color(.accent)),
                style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
            )
            context.draw(
                context.resolve(
                    Text(String(format: "%.2f G", peak))
                        .font(.system(size: 10, weight: .semibold).monospacedDigit())
                        .foregroundColor(Color(.accentInk))
                ),
                at: CGPoint(x: center.x, y: center.y - r - 8)
            )
        }

        for (color, path) in hot {
            context.fill(path, with: .color(color.opacity(0.75)))
        }

        // Axis words. The sides say "cornering" rather than left/right, because
        // the side is derived from the steering sign rather than stored.
        func label(_ text: String, at position: CGPoint, size fontSize: CGFloat = 10) {
            context.draw(
                context.resolve(Text(text).font(.system(size: fontSize)).foregroundColor(Color(.textFaint))),
                at: position
            )
        }
        label("braking", at: CGPoint(x: center.x, y: center.y - CGFloat(side / 2) - 9))
        label("power", at: CGPoint(x: center.x, y: center.y + CGFloat(side / 2) + 9))
        // The plot is a disc, so a corner of the square is the one place no
        // sample can ever land.
        context.draw(
            context.resolve(Text("cornering (G)").font(.system(size: 10)).foregroundColor(Color(.textFaint))),
            in: CGRect(
                x: center.x - CGFloat(side / 2), y: center.y - CGFloat(side / 2),
                width: 100, height: 14
            )
        )
    }

    // MARK: - Read-out

    /// The share of *loaded* samples spent doing two things at once, per
    /// highlighted lap, with the session pooled underneath once there is more
    /// than one lap to pool — `gripReadoutHtml` in the JS.
    @ViewBuilder
    private func readout(_ sg: Grip.SessionGrip, _ rows: [Row]) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 8) {
                    GridRow {
                        Text("")
                            .gridColumnAlignment(.leading)
                        Text("Braking +\ncornering")
                            .teStyle(.eyebrow)
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(Color(.textFaint))
                        Text("Cornering +\npower")
                            .teStyle(.eyebrow)
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(Color(.textFaint))
                    }
                    ForEach(rows) { row in
                        GridRow {
                            HStack(spacing: 6) {
                                Circle().fill(row.color).frame(width: 8, height: 8)
                                Text("Lap \(String(lapNumber(row.lap.chIdx)))")
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textMuted))
                            }
                            .gridColumnAlignment(.leading)
                            percent(row.lap.trailPct, color: Color(.textStrong))
                            percent(row.lap.powerPct, color: Color(.textStrong))
                        }
                    }
                    if sg.laps.count >= 2 {
                        GridRow {
                            Text("Session")
                                .teStyle(.xs)
                                .italic()
                                .foregroundStyle(Color(.textMuted))
                                .gridColumnAlignment(.leading)
                            percent(sg.all.trailPct, color: Color(.textMuted))
                            percent(sg.all.powerPct, color: Color(.textMuted))
                        }
                    }
                }
                Text("Share of the samples where the tyre was working (\(String(format: "%.2f", Grip.MIN_LOAD_G)) G combined or more) spent doing two things at once. Brake straight, turn, then accelerate and both stay low — the gap to the arc is time.")
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
            }
        }
    }

    private func percent(_ value: Double, color: Color) -> some View {
        Text("\(Int(value.rounded()))%")
            .teStyle(.sm)
            .monospacedDigit()
            .foregroundStyle(color)
    }

    /// What VoiceOver gets: the two figures per lap and the envelope — a scatter
    /// is exactly the kind of picture a screen-reader user cannot see.
    private func summary(_ sg: Grip.SessionGrip, _ rows: [Row]) -> String {
        var parts = rows.map { row in
            "Lap \(String(lapNumber(row.lap.chIdx))): \(Int(row.lap.trailPct.rounded())) percent braking while cornering, "
                + "\(Int(row.lap.powerPct.rounded())) percent cornering on the power"
        }
        if let peak = sg.peakG {
            parts.append("Peak combined \(String(format: "%.2f", peak)) G")
        }
        // The envelope going away changes what the plot shows, and a scatter is
        // the one picture a screen-reader user can't check for themselves — so
        // ⌘F says so here rather than only on screen.
        if !showEnvelope {
            parts.append("Other laps hidden")
        }
        return parts.joined(separator: ". ")
    }
}
