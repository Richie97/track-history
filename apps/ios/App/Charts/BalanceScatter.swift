import SwiftUI
import TrackEvolutionKit

/// Balance — understeer or oversteer (#189) — the counterpart of
/// `balanceScatterSvg` and `balanceTableHtml` in `public/js/balance.js`.
///
/// Steering angle across, rotation per metre up, one point per 20 m sample of
/// the highlighted laps over a dim envelope of the session's other laps, with a
/// dashed line for this car's typical response. Points above the line are
/// oversteer — the car rotated more than the steering asked for — and points
/// below it understeer. Under the plot, one row per corner: how each
/// highlighted lap took it, and the session pooled. The maths is the Kit's
/// `Balance` and `Corners`, pinned to the web implementation by
/// `contracts/logic/balance.json` and `corners.json`; this file draws.
///
/// Four things about the drawing are load-bearing.
///
/// **More rotation is up**, which the friction circle beside it deliberately
/// isn't: there `longG` is negative under braking and the canvas's downward y
/// is used as-is, here the y value is *subtracted* so a car rotating more than
/// asked plots above the reference line. Getting this backwards swaps
/// understeer and oversteer while failing no test.
///
/// **The plot is not square.** The axes carry different units (degrees against
/// degrees per metre), so unlike the friction circle there is nothing to keep
/// round, and a wide box is what makes the band through the origin readable.
///
/// **Rotation is yaw rate ÷ speed**, so a neutral car is one line through the
/// origin rather than a fan of lines, one per speed. That is what frees colour
/// for lap identity, which is what colour means everywhere else in the panel.
///
/// **Readings are per corner, never per sample.** Yaw lags the steering at
/// entry and leads it at exit on the 20 m grid, so single points scatter around
/// the line: the scatter shows the shape and the table carries the numbers.
/// Samples that count toward no reading — straight-line, or slow — draw fainter
/// so the blob at the origin doesn't read as data.
///
/// The **corner rows** are what points outward: tapping one says where that
/// corner is, and on an iPad a pointer resting on the row does the same without
/// committing it (NS-34 ticket 5). The samples themselves stay untappable — a
/// point here is one 20 m sample of one lap, and the reading it belongs to is the
/// corner's, which is the row.
struct BalanceScatter: View {
    let channels: SessionChannels
    /// Channel-lap indexes in slot order, as `LapChannelPanel` keeps them.
    let lit: [Int]
    let slots: [Color]
    /// The session's own lap number for a channel entry.
    let lapNumber: (Int) -> Int
    /// Tapping a corner row answers "where is this on track" on everything drawn
    /// beside the panel (NS-34 ticket 3).
    var onHit: (ChannelHit?) -> Void = { _ in }
    /// The same answer from a *pointer* over the row (NS-34 ticket 5), held only
    /// while it is there. Nil means it has left.
    var onHover: (ChannelHit?) -> Void = { _ in }

    @Environment(\.layout) private var layout

    /// The axes are padded this much past the furthest sample, and floored so a
    /// session that never turned still draws a frame. `xMax` / `yMax` in the JS.
    private static let axisPad = 1.06
    private static let minRotation = 1e-3

    private struct Column: Identifiable {
        let chIdx: Int
        let color: Color
        var id: Int { chIdx }
    }

    private var readable: [Balance.BalanceLap] { Balance.balanceLaps(channels) }

    /// The highlighted laps that can actually be read, in slot order.
    private var columns: [Column] {
        lit.enumerated().compactMap { slot, chIdx in
            guard slot < slots.count, readable.contains(where: { $0.chIdx == chIdx }) else { return nil }
            return Column(chIdx: chIdx, color: slots[slot])
        }
    }

    var body: some View {
        if !readable.isEmpty {
            let sign = Balance.yawSign(channels)
            let refGain = Balance.referenceGain(channels, sign: sign)
            let sb = Balance.sessionBalance(channels)
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Balance")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textMuted))
                        Text(
                            "How much the car rotated for the steering it was given. Steering the car "
                                + "doesn't answer is understeer; rotation it wasn't asked for is oversteer."
                        )
                        .teStyle(.xxs)
                        .foregroundStyle(Color(.textFaint))
                    }
                    Canvas { context, size in
                        draw(sign: sign, refGain: refGain, in: context, size: size)
                    }
                    .aspectRatio(1.6, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    if let sb { table(sb) }
                    Text(
                        "Corners are stretches of sustained cornering force "
                            + "(\(String(format: "%.2f", Corners.CORNER_MIN_G)) G or more) counted from the "
                            + "start/finish line, so the T-numbers are this app's, not the circuit's. Each "
                            + "reading is how far the corner's rotation sits from this car's typical response "
                            + "over the whole session — the dashed line — because the exact version needs the "
                            + "wheelbase and steering ratio, which aren't recorded. That makes it relative: a "
                            + "car that pushes in every corner reads neutral in every corner, and what shows "
                            + "up is the corner that behaves differently from the rest."
                    )
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Balance: rotation per metre against steering angle")
            .accessibilityValue(summary(sb))
            .accessibilityIdentifier("balanceScatter")
            // The corner rows are tappable and this card is a *single*
            // accessibility element, so the taps would otherwise be unreachable
            // with VoiceOver. Named actions put them in the rotor, which is
            // where a one-element control's extra verbs belong.
            .accessibilityActions {
                ForEach(Balance.sessionBalance(channels)?.corners ?? [], id: \.corner.n) { row in
                    Button("Show where \(Corners.cornerLabel(row.corner)) is") {
                        onHit(hit(for: row.corner))
                    }
                }
            }
        }
    }

    // MARK: - Plot

    private func draw(sign: Double, refGain: Double?, in context: GraphicsContext, size: CGSize) {
        let pad = (l: 44.0, r: 10.0, t: 16.0, b: 20.0)
        let plotW = size.width - pad.l - pad.r
        let plotH = size.height - pad.t - pad.b
        guard plotW > 0, plotH > 0 else { return }
        let lapPoints = readable.map { (chIdx: $0.chIdx, pts: Balance.balancePoints($0.entry, sign)) }
        var xMax = 0.0, yMax = 0.0
        for lap in lapPoints {
            for p in lap.pts {
                xMax = max(xMax, abs(p.steer))
                yMax = max(yMax, abs(p.rot))
            }
        }
        xMax = max(xMax * Self.axisPad, Balance.MIN_STEER_DEG)
        yMax = max(yMax * Self.axisPad, Self.minRotation)

        let cx = pad.l + plotW / 2
        let cy = pad.t + plotH / 2
        let sx = plotW / 2 / xMax
        let sy = plotH / 2 / yMax
        func X(_ deg: Double) -> CGFloat { CGFloat(cx + deg * sx) }
        // More rotation is up — see the type's documentation.
        func Y(_ rot: Double) -> CGFloat { CGFloat(cy - rot * sy) }

        func label(_ text: String, at position: CGPoint, anchor: UnitPoint = .center) {
            context.draw(
                context.resolve(
                    Text(text).font(.system(size: 9).monospacedDigit()).foregroundColor(Color(.textFaint))
                ),
                at: position, anchor: anchor
            )
        }

        // The frame: half-way lines and the ends, rather than a tick algorithm —
        // both axes are symmetric about zero, so those are the marks that read.
        var grid = Path()
        for fraction in [-1.0, -0.5, 0.5, 1.0] {
            let y = Y(yMax * fraction)
            grid.move(to: CGPoint(x: pad.l, y: y))
            grid.addLine(to: CGPoint(x: size.width - pad.r, y: y))
            label(String(format: "%.2f", yMax * fraction), at: CGPoint(x: pad.l - 6, y: y), anchor: .trailing)
        }
        context.stroke(grid, with: .color(Color(.chartGrid)), lineWidth: 1)
        for fraction in [-1.0, -0.5, 0.5, 1.0] {
            label(
                String(format: "%.0f°", xMax * fraction),
                at: CGPoint(x: X(xMax * fraction), y: size.height - pad.b + 8)
            )
        }

        // The axes through the origin: a neutral car is a line through it.
        var axes = Path()
        axes.move(to: CGPoint(x: pad.l, y: CGFloat(cy)))
        axes.addLine(to: CGPoint(x: size.width - pad.r, y: CGFloat(cy)))
        axes.move(to: CGPoint(x: CGFloat(cx), y: pad.t))
        axes.addLine(to: CGPoint(x: CGFloat(cx), y: size.height - pad.b))
        context.stroke(axes, with: .color(Color(.borderStrong)), lineWidth: 1)

        // The dim envelope, then the highlighted laps: a sample that counts
        // toward no reading draws fainter.
        var dim = Path()
        var hot: [(Color, Path, Path)] = []
        for lap in lapPoints {
            if let column = columns.first(where: { $0.chIdx == lap.chIdx }) {
                var counted = Path()
                var uncounted = Path()
                for p in lap.pts {
                    let c = CGPoint(x: X(p.steer), y: Y(p.rot))
                    let dot = CGRect(x: c.x - 2.4, y: c.y - 2.4, width: 4.8, height: 4.8)
                    if p.usable { counted.addEllipse(in: dot) } else { uncounted.addEllipse(in: dot) }
                }
                hot.append((column.color, counted, uncounted))
            } else {
                for p in lap.pts {
                    let c = CGPoint(x: X(p.steer), y: Y(p.rot))
                    dim.addEllipse(in: CGRect(x: c.x - 1.3, y: c.y - 1.3, width: 2.6, height: 2.6))
                }
            }
        }
        context.fill(dim, with: .color(Color(.chartDim)))

        // The reference: this car's typical response, clipped to the plot.
        if let refGain, refGain > 0 {
            let xEnd = min(xMax, yMax / refGain)
            var line = Path()
            line.move(to: CGPoint(x: X(-xEnd), y: Y(-xEnd * refGain)))
            line.addLine(to: CGPoint(x: X(xEnd), y: Y(xEnd * refGain)))
            context.stroke(
                line, with: .color(Color(.accent)), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
            )
            // Region words, in the right-hand half where positive steering lives.
            label("oversteer", at: CGPoint(x: CGFloat(cx) + 6, y: pad.t + 6), anchor: .leading)
            label(
                "understeer", at: CGPoint(x: size.width - pad.r - 4, y: CGFloat(cy) + 10), anchor: .trailing
            )
        }

        for (color, counted, uncounted) in hot {
            context.fill(uncounted, with: .color(color.opacity(0.3)))
            context.fill(counted, with: .color(color.opacity(0.85)))
        }
    }

    // MARK: - Per-corner table

    /// One row per corner, a cell per highlighted lap and — with two or more
    /// readable laps — the session pooled: `balanceTableHtml` in the JS. The
    /// corner's place on track and its peak lateral G ride under its label
    /// rather than in columns of their own, which is what keeps the table inside
    /// a phone's width.
    @ViewBuilder
    private func table(_ sb: Balance.SessionBalance) -> some View {
        let cols = columns
        if !cols.isEmpty {
            let pooled = readable.count >= 2
            Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow {
                    Text("Corner")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textFaint))
                        .gridColumnAlignment(.leading)
                    if wideColumns {
                        Text("At")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textFaint))
                        Text("Peak G")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textFaint))
                    }
                    ForEach(cols) { col in
                        HStack(spacing: 4) {
                            Circle().fill(col.color).frame(width: 8, height: 8)
                            Text("Lap \(String(lapNumber(col.chIdx)))")
                                .teStyle(.eyebrow)
                                .foregroundStyle(Color(.textFaint))
                        }
                    }
                    if pooled {
                        Text("Session")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textFaint))
                    }
                }
                ForEach(sb.corners, id: \.corner.n) { row in
                    GridRow {
                        cornerLabel(row.corner)
                            .gridColumnAlignment(.leading)
                        // Given the width, the corner's place on track and its
                        // peak G get columns of their own rather than a second
                        // line under the label (NS-34 ticket 3) — which is how
                        // the web has always drawn them, and what makes two
                        // corners comparable down the column.
                        if wideColumns {
                            Text(fmtDist(Int((Double(row.corner.k0) * channels.dStepM).rounded())))
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textMuted))
                                .monospacedDigit()
                            Text(String(format: "%.2f", row.corner.peakG))
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textMuted))
                                .monospacedDigit()
                        }
                        ForEach(cols) { col in
                            cell(row.laps.first { $0.chIdx == col.chIdx }?.pct)
                        }
                        if pooled { cell(row.all.pct) }
                    }
                    // A corner is a place every lap shares, so the hit carries no
                    // lap of its own and the map rings it whichever lap the trace
                    // is — the rule `bindBalance` states on the web (NS-34).
                    .contentShape(Rectangle())
                    .onTapGesture { onHit(hit(for: row.corner)) }
                    .onHover { inside in onHover(inside ? hit(for: row.corner) : nil) }
                }
            }
        }
    }

    /// The corner's name, with its place and peak G under it when there is no
    /// room for columns — the phone layout, unchanged.
    @ViewBuilder
    private func cornerLabel(_ corner: Corners.Corner) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(Corners.cornerLabel(corner))
                .teStyle(.sm)
                .foregroundStyle(Color(.textStrong))
            if !wideColumns {
                Text(
                    "\(fmtDist(Int((Double(corner.k0) * channels.dStepM).rounded()))) · "
                        + "\(String(format: "%.2f", corner.peakG)) G"
                )
                .teStyle(.xxs)
                .foregroundStyle(Color(.textFaint))
            }
        }
    }

    /// Whether the table has room to give place and peak G their own columns.
    ///
    /// Measured against the **column this table is in**, not the window: the
    /// panel is a narrow right-hand column at expanded width, and reading the
    /// class would put five columns into 380pt.
    private var wideColumns: Bool {
        layout.contentWidth >= 520
    }

    /// Where a corner is, as a place on the lap.
    ///
    /// `chIdx` is deliberately nil: a corner is a stretch of track every lap goes
    /// through, not one lap's sample, so the map may ring it whatever lap the
    /// trace was drawn from.
    private func hit(for corner: Corners.Corner) -> ChannelHit? {
        let n = Self.sampleCount(channels)
        guard n > 1 else { return nil }
        return ChannelHit(chIdx: nil, k: corner.k0, frac: Double(corner.k0) / Double(n - 1))
    }

    /// The lap grid's length, from the longest lap that stored one.
    private static func sampleCount(_ channels: SessionChannels) -> Int {
        channels.laps.reduce(0) { longest, entry in
            max(longest, max(entry.latG?.count ?? 0, entry.speed?.count ?? 0))
        }
    }

    /// A reading, or an em dash for a corner this lap never steered through.
    /// Neutral reads faint and an off-reference corner strong — the same
    /// emphasis the web's table uses, and deliberately not a colour per side:
    /// colour is lap identity in this panel.
    private func cell(_ pct: Double?) -> some View {
        Group {
            if let pct {
                Text(Balance.fmtBalance(pct))
                    .teStyle(.xs)
                    .foregroundStyle(
                        abs(pct) < Balance.NEUTRAL_PCT ? Color(.textFaint) : Color(.textStrong)
                    )
                    .fontWeight(abs(pct) < Balance.NEUTRAL_PCT ? .regular : .semibold)
            } else {
                Text("—")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }

    private func fmtDist(_ m: Int) -> String {
        m >= 1000 ? "\(String(format: m % 1000 != 0 ? "%.1f" : "%.0f", Double(m) / 1000)) km" : "\(m) m"
    }

    /// What VoiceOver gets: the sentence from the session's stats line, which is
    /// the whole point of the picture, plus each highlighted lap's off-reference
    /// corners. A scatter is exactly the kind of thing a screen-reader user
    /// cannot see.
    private func summary(_ sb: Balance.SessionBalance?) -> String {
        guard let sb else { return "Not enough steering and rotation to read a balance" }
        var parts: [String] = []
        if let line = Balance.balanceSummary(channels) { parts.append("Session: \(line)") }
        for col in columns {
            let off = sb.corners.compactMap { row -> String? in
                guard let lap = row.laps.first(where: { $0.chIdx == col.chIdx }),
                    abs(lap.pct) >= Balance.NEUTRAL_PCT
                else { return nil }
                return "\(Corners.cornerLabel(row.corner)) \(Balance.fmtBalance(lap.pct))"
            }
            parts.append(
                "Lap \(String(lapNumber(col.chIdx))): "
                    + (off.isEmpty ? "neutral everywhere" : off.joined(separator: ", "))
            )
        }
        return parts.joined(separator: ". ")
    }
}
