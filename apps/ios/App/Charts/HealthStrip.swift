import SwiftUI
import TrackEvolutionKit

/// The session health strip (#190) — the counterpart of `healthStripHtml` and
/// `sparklineSvg` in `public/js/health.js`.
///
/// The panel's Car tab: one card per figure the import stored — peak oil,
/// coolant and transmission temperature, minimum oil pressure and battery, fuel
/// and the four tyre pressures at lap end, peak tyre temperature per corner,
/// and per-lap peak boost — carrying the session's number by that channel's own
/// rule, a sparkline across the laps with its threshold bands shaded, and the
/// cross-corner tyre spread and fuel outlook under them. The maths is the Kit's
/// `Health`, pinned to the web implementation by `contracts/logic/health.json`;
/// this file draws.
///
/// Four things are load-bearing.
///
/// **Thresholds shade, they never alarm.** A card past its watch line takes a
/// tinted border and one past its `over` line a tinted background, in the
/// garage's own wear colours — `danger` — rather than a second severity scale
/// invented here. Nothing blocks, nothing pops.
///
/// **The number is the importer's reduction, and the card says which** ("peak",
/// "min", "at lap end"), because "oil 134 °C" means nothing without knowing it
/// is the lap's peak rather than its average.
///
/// **The figures show in °F and psi** (`Health.Units.us`), matching the rest of
/// the logbook, while the maths stays in the stored units — the conversion is
/// the last step, exactly as on the web.
///
/// **The web's per-lap table is deliberately absent.** Fifteen columns is a
/// desk layout; on a phone the sparkline carries the shape and the highlighted
/// laps are marked on it in their slot colours, which is the same question
/// answered in the space available.
struct HealthStrip: View {
    let channels: SessionChannels
    /// Channel-lap indexes in slot order, as `LapChannelPanel` keeps them.
    let lit: [Int]
    let slots: [Color]
    /// The session's own lap number for a channel entry.
    let lapNumber: (Int) -> Int

    private static let units = Health.Units.us

    var body: some View {
        if let sh = Health.sessionHealth(channels) {
            let order = sh.laps.map(\.chIdx)
            TECard {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Car")
                            .teStyle(.eyebrow)
                            .foregroundStyle(Color(.textMuted))
                        Text(
                            "What the car was doing while you drove it. One figure per lap, "
                                + "reduced the way the recorder stored it."
                        )
                        .teStyle(.xxs)
                        .foregroundStyle(Color(.textFaint))
                    }
                    ForEach(Health.HEALTH_GROUPS.map(\.key), id: \.self) { group in
                        let columns = sh.columns.filter { Health.defFor($0.key)?.group == group }
                        if !columns.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(Health.HEALTH_GROUPS.first { $0.key == group }?.label ?? group)
                                    .teStyle(.eyebrow)
                                    .foregroundStyle(Color(.textFaint))
                                LazyVGrid(
                                    columns: [GridItem(.adaptive(minimum: 140), spacing: 8)], spacing: 8
                                ) {
                                    ForEach(columns, id: \.key) { column in
                                        card(column, order: order)
                                    }
                                }
                            }
                        }
                    }
                    spreadLines()
                    fuelLine()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Car: the session's health figures")
            .accessibilityValue(summary(sh))
            .accessibilityIdentifier("healthStrip")
        }
    }

    // MARK: - One figure

    @ViewBuilder
    private func card(_ column: Health.Column, order: [Int]) -> some View {
        if let def = Health.defFor(column.key) {
            let display = Health.displayValue(def, column.extreme.v, Self.units)
            VStack(alignment: .leading, spacing: 2) {
                Text(def.label)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(display.text)
                        .teStyle(.h3)
                        .monospacedDigit()
                        .foregroundStyle(Color(.textStrong))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let word = statusWord(column.status) {
                        Text(word)
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.dangerInk))
                    }
                }
                Text(ruleWord(def))
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
                Canvas { context, size in
                    sparkline(def, column, order: order, in: context, size: size)
                }
                .frame(height: 34)
                .padding(.top, 2)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(column.status == .due ? Color(.dangerTint) : Color.clear, in: .rect(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(borderColor(column.status), lineWidth: 1)
            )
        }
    }

    /// The importer's rule, said out loud — `ruleWord` in the JS.
    private func ruleWord(_ def: Health.Def) -> String {
        switch def.reduce {
        case .max: "peak"
        case .min: "min"
        case .end: "at lap end"
        }
    }

    private func statusWord(_ status: Health.Status?) -> String? {
        switch status {
        case .due: "over the line"
        case .low: "watch"
        default: nil
        }
    }

    private func borderColor(_ status: Health.Status?) -> Color {
        switch status {
        case .due: Color(.danger)
        case .low: Color(.danger).opacity(0.45)
        default: Color(.borderHairline)
        }
    }

    // MARK: - Sparkline

    /// One column across the session's health laps: x is the lap's position
    /// among them (so every card lines up), the threshold bands shaded behind
    /// the line, and the highlighted laps marked in their slot colours.
    private func sparkline(
        _ def: Health.Def, _ column: Health.Column, order: [Int],
        in context: GraphicsContext, size: CGSize
    ) {
        let series = column.series
        guard !series.isEmpty, size.width > 0, size.height > 0 else { return }
        let pad: CGFloat = 4
        let n = max(2, order.count)
        var index: [Int: Int] = [:]
        for (i, chIdx) in order.enumerated() { index[chIdx] = i }

        var y0 = series.map(\.v).min() ?? 0
        var y1 = series.map(\.v).max() ?? 1
        // Bring the lines into view when the data sits near them, so the shading
        // says how close the session came rather than only whether it crossed.
        if let watch = def.watch, let over = def.over {
            let near = def.low ? watch * 1.05 : watch * 0.95
            if def.low ? y0 < near : y1 > near {
                y0 = Swift.min(y0, over)
                y1 = Swift.max(y1, over)
            }
        }
        let ypad = Swift.max((y1 - y0) * 0.15, 1e-6)
        y0 -= ypad
        y1 += ypad

        func X(_ i: Int) -> CGFloat { pad + CGFloat(i) / CGFloat(n - 1) * (size.width - pad * 2) }
        func Y(_ v: Double) -> CGFloat {
            pad + CGFloat((y1 - v) / (y1 - y0)) * (size.height - pad * 2)
        }
        func clampY(_ v: Double) -> CGFloat { Swift.min(Swift.max(Y(v), pad), size.height - pad) }

        // The bands: past `over` in the danger tint, between the lines lighter.
        if let watch = def.watch, let over = def.over {
            func band(_ from: Double, _ to: Double, _ opacity: Double) {
                let ya = clampY(to), yb = clampY(from)
                guard abs(yb - ya) > 0.5 else { return }
                context.fill(
                    Path(CGRect(x: 0, y: Swift.min(ya, yb), width: size.width, height: abs(yb - ya))),
                    with: .color(Color(.danger).opacity(opacity))
                )
            }
            band(def.low ? y0 : over, def.low ? over : y1, 0.18)
            band(def.low ? over : watch, def.low ? watch : over, 0.09)
        }

        var line = Path()
        for (i, s) in series.enumerated() {
            let point = CGPoint(x: X(index[s.chIdx] ?? i), y: Y(s.v))
            if i == 0 { line.move(to: point) } else { line.addLine(to: point) }
        }
        context.stroke(line, with: .color(Color(.chartLine)), lineWidth: 1.5)

        // The highlighted laps, in the slot colours the chips use.
        for (slot, chIdx) in lit.enumerated() where slot < slots.count {
            guard let s = series.first(where: { $0.chIdx == chIdx }), let i = index[chIdx] else { continue }
            let c = CGPoint(x: X(i), y: Y(s.v))
            context.fill(
                Path(ellipseIn: CGRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5)),
                with: .color(slots[slot])
            )
        }
    }

    // MARK: - Spread and fuel

    /// Cross-corner spread is the figure a setup change is judged by, so it gets
    /// words rather than a chart: left−right on each axle and front−rear, for
    /// the last lap that carried all four corners.
    @ViewBuilder
    private func spreadLines() -> some View {
        let temps = Health.sessionSpread(channels, "tyreC").last
        let pressures = Health.sessionSpread(channels, "tyreKpa").last
        if temps != nil || pressures != nil {
            VStack(alignment: .leading, spacing: 4) {
                Text("Cross-corner spread")
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textFaint))
                if let temps, let def = Health.defFor("tyreCLF") {
                    Text(spreadText(def, temps, "Tyre temps"))
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
                if let pressures, let def = Health.defFor("tyreKpaLF") {
                    Text(spreadText(def, pressures, "Tyre pressures"))
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
            }
        }
    }

    private func spreadText(_ def: Health.Def, _ spread: Health.LapSpread, _ label: String) -> String {
        let front = Health.displayDelta(def, spread.front, Self.units).text
        let rear = Health.displayDelta(def, spread.rear, Self.units).text
        let axle = Health.displayDelta(def, spread.axle, Self.units).text
        return "\(label) — front L−R \(front), rear L−R \(rear), front−rear \(axle)"
    }

    @ViewBuilder
    private func fuelLine() -> some View {
        if let fuel = Health.fuelBurn(channels) {
            Text(
                "Fuel — \(Int(fuel.perLapPct.rounded()))% a lap, \(Int(fuel.lastPct.rounded()))% left: "
                    + "≈\(fuel.lapsRemaining) lap\(fuel.lapsRemaining == 1 ? "" : "s") at this rate"
            )
            .teStyle(.xs)
            .foregroundStyle(Color(.textMuted))
        }
    }

    /// What VoiceOver gets: the stats line's own sentence when there is one,
    /// else every figure by name — a grid of sparklines is exactly what a
    /// screen-reader user cannot see.
    private func summary(_ sh: Health.SessionHealth) -> String {
        if let line = Health.healthSummary(channels, Self.units) { return line }
        return sh.columns.compactMap { column -> String? in
            guard let def = Health.defFor(column.key) else { return nil }
            return "\(def.label) \(Health.displayValue(def, column.extreme.v, Self.units).text)"
        }
        .joined(separator: ", ")
    }
}
