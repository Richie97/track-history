import SwiftUI
import TrackEvolutionKit

/// The gear ribbon (#187) — the counterpart of `gearRibbonSvg` in
/// `public/js/gears.js`.
///
/// One horizontal band per highlighted lap on the channel panel's shared
/// driven-distance axis, cut into blocks of one gear with the number written in
/// any block wide enough to hold it. **Not a line chart**: `gear` is an enum, and
/// a line between 3 and 4 implies a gear no car has — which is also why the
/// importer samples it by holding the last value. Gear 0 (clutch in / no gear)
/// renders as a *gap* rather than a block, because it is genuinely "no gear".
///
/// With two or more laps lit, the runs where they sit in different gears are
/// outlined, and that is the whole feature: "you took T5 in 3rd on your best lap
/// and 4th on this one". The cutting and the comparison rule are the Kit's
/// `Gears`, pinned to the web implementation by `contracts/logic/gears.json`;
/// this file draws.
///
/// Hand-rolled on `Canvas` rather than Swift Charts: a run of one gear is a
/// filled rectangle with a label inside it, which is a bar chart of nothing, and
/// the panel already pays for one `Chart` per channel.
struct GearRibbon: View {
    let channels: SessionChannels
    /// Channel-lap indexes in slot order, as `LapChannelPanel` keeps them.
    let lit: [Int]
    let slots: [Color]
    /// The session's own lap number for a channel entry.
    let lapNumber: (Int) -> Int

    private struct Band {
        let chIdx: Int
        let color: Color
        let gear: [Double]
    }

    private var bands: [Band] {
        lit.enumerated().compactMap { slot, chIdx in
            guard slot < slots.count, channels.laps.indices.contains(chIdx),
                  let gear = channels.laps[chIdx].gear, !gear.isEmpty
            else { return nil }
            return Band(chIdx: chIdx, color: slots[slot], gear: gear)
        }
    }

    /// The same x-extent the channel charts use, so the ribbon lines up with the
    /// RPM trace above it: the longest lap's speed series, falling back to gear.
    private var span: Double {
        var maxN = 0
        for l in channels.laps {
            let n = l.speed?.count ?? l.gear?.count ?? 0
            if n > maxN { maxN = n }
        }
        return max(1, Double(maxN - 1) * channels.dStepM)
    }

    private static let rowHeight: CGFloat = 22
    private static let rowGap: CGFloat = 6

    var body: some View {
        let rows = bands
        if !rows.isEmpty {
            let disagreements = Gears.gearDisagreements(rows.map { $0.gear })
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Gear")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textMuted))
                    Spacer()
                    if rows.count >= 2 {
                        Text(disagreements.isEmpty ? "same gears throughout" : "dashed: laps disagree")
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .trailing, spacing: Self.rowGap) {
                        ForEach(rows, id: \.chIdx) { row in
                            Text("L\(String(lapNumber(row.chIdx)))")
                                .teStyle(.xxs)
                                .foregroundStyle(row.color)
                                .frame(height: Self.rowHeight)
                        }
                    }
                    Canvas { context, size in
                        draw(rows, disagreements, in: context, size: size)
                    }
                    .frame(height: CGFloat(rows.count) * Self.rowHeight + CGFloat(rows.count - 1) * Self.rowGap)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Gear by driven distance, per lap")
            .accessibilityValue(summary(rows, disagreements))
            .accessibilityIdentifier("gearRibbon")
        }
    }

    private func draw(
        _ rows: [Band], _ disagreements: [Gears.Disagreement], in context: GraphicsContext, size: CGSize
    ) {
        let step = channels.dStepM
        func x(_ distance: Double) -> CGFloat { CGFloat(distance / span) * size.width }

        for (index, row) in rows.enumerated() {
            let y = CGFloat(index) * (Self.rowHeight + Self.rowGap)
            let last = row.gear.count - 1
            for segment in Gears.gearSegments(row.gear) where segment.gear > 0 {
                let xa = x(max(0, Double(segment.k0) - 0.5) * step) + 1
                let xb = x(min(Double(last), Double(segment.k1) + 0.5) * step) - 1
                guard xb > xa else { continue }
                let rect = CGRect(x: xa, y: y, width: xb - xa, height: Self.rowHeight)
                context.fill(Path(roundedRect: rect, cornerRadius: 2), with: .color(row.color))
                // Only where the block can hold the digit — a number clipped to a
                // sliver reads as noise on the ribbon.
                if rect.width >= 14 {
                    let text = Text(String(Int(segment.gear)))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Color(.surfaceCard))
                    context.draw(context.resolve(text), at: CGPoint(x: rect.midX, y: rect.midY))
                }
            }
        }

        guard rows.count >= 2 else { return }
        for run in disagreements {
            let xa = x(max(0, Double(run.k0) - 0.5) * step)
            let xb = x((Double(run.k1) + 0.5) * step)
            let rect = CGRect(x: xa, y: -2, width: xb - xa, height: size.height + 4)
            context.stroke(
                Path(roundedRect: rect, cornerRadius: 3),
                with: .color(Color(.danger)),
                style: .init(lineWidth: 1.5, dash: [3, 2])
            )
        }
    }

    /// What VoiceOver gets: the gears each lap used and where they disagree —
    /// the outline is precisely what a screen-reader user cannot see.
    private func summary(_ rows: [Band], _ disagreements: [Gears.Disagreement]) -> String {
        var parts = rows.map { row -> String in
            let used = Gears.gearSegments(row.gear)
                .filter { $0.gear > 0 }
                .map { Int($0.gear) }
            let low = used.min() ?? 0
            let high = used.max() ?? 0
            return "Lap \(String(lapNumber(row.chIdx))) used \(Gears.ordinal(Double(low))) to \(Gears.ordinal(Double(high)))"
        }
        if rows.count >= 2 {
            parts.append(
                disagreements.isEmpty
                    ? "The laps agree on gear throughout"
                    : "The laps take different gears in \(disagreements.count) place\(disagreements.count == 1 ? "" : "s")"
            )
        }
        return parts.joined(separator: ". ")
    }
}
