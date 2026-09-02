import SwiftUI
import TrackEvolutionKit

/// Sector splits and the theoretical best lap for the highlighted laps of a channel
/// session (#146) — the counterpart of `sectorTableHtml` in `public/js/sectors.js`.
///
/// One row per highlighted lap in its slot color, a cell per sector — the session's
/// best in a sector in the accent, every other cell carrying its gap to that best —
/// and, once two or more laps could be split, a closing "best sectors" row that *is*
/// the theoretical best lap, with the gap to the actual best above it. The maths is
/// the Kit's `Sectors`, pinned to the web implementation by
/// `contracts/logic/sectors.json`; this file lays it out.
///
/// Best sectors are taken across *every* lap of the session, not only the highlighted
/// ones, so the table answers "where does my time go" against the session rather
/// than against whichever laps happen to be lit.
struct SectorTable: View {
    let channels: SessionChannels
    /// Channel-lap indexes in slot order, as `LapChannelPanel` keeps them.
    let lit: [Int]
    let slots: [Color]
    /// The session's own lap number for a channel entry.
    let lapNumber: (Int) -> Int

    private struct Row: Identifiable {
        let color: Color
        let lap: Sectors.LapSplit
        var id: Int { lap.chIdx }
    }

    var body: some View {
        if let sec = Sectors.sessionSectors(channels) {
            let rows = lit.enumerated().compactMap { slot, chIdx -> Row? in
                guard slot < slots.count, let lap = sec.laps.first(where: { $0.chIdx == chIdx }) else { return nil }
                return Row(color: slots[slot], lap: lap)
            }
            if !rows.isEmpty {
                TECard {
                    VStack(alignment: .leading, spacing: 10) {
                        if sec.laps.count >= 2 {
                            headline(sec)
                        }
                        Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 8) {
                            GridRow {
                                Text("Sectors")
                                    .teStyle(.eyebrow)
                                    .foregroundStyle(Color(.textFaint))
                                    .gridColumnAlignment(.leading)
                                ForEach(0..<sec.n, id: \.self) { k in
                                    Text("S\(k + 1)")
                                        .teStyle(.eyebrow)
                                        .foregroundStyle(Color(.textFaint))
                                }
                                Text("Lap")
                                    .teStyle(.eyebrow)
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
                                    ForEach(0..<sec.n, id: \.self) { k in
                                        cell(row.lap.sectors[k], gap: row.lap.sectors[k] - sec.bestSectors[k])
                                    }
                                    time(row.lap.timeMs, color: Color(.textStrong))
                                }
                            }
                            if sec.laps.count >= 2 {
                                GridRow {
                                    Text("Best sectors")
                                        .teStyle(.xs)
                                        .italic()
                                        .foregroundStyle(Color(.textMuted))
                                        .gridColumnAlignment(.leading)
                                    ForEach(0..<sec.n, id: \.self) { k in
                                        time(sec.bestSectors[k], color: Color(.textMuted))
                                    }
                                    time(sec.theoreticalBestMs, color: Color(.textStrong))
                                }
                            }
                        }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Sector splits")
                .accessibilityValue(summary(sec, rows))
                .accessibilityIdentifier("sectorTable")
            }
        }
    }

    /// "Theoretical best 1:47.312 — the best sectors of 12 laps strung together,
    /// 0.85s quicker than the best lap", the same words the web uses.
    private func headline(_ sec: Sectors.SessionSplits) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Theoretical best")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                Text(LapTime.fmtMs(sec.theoreticalBestMs))
                    .teStyle(.lapTime)
                    .foregroundStyle(Color(.accentInk))
            }
            Text(gapSentence(sec))
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
        }
    }

    private func gapSentence(_ sec: Sectors.SessionSplits) -> String {
        if sec.gapMs > 0 {
            let gap = LapTime.fmtDelta(sec.gapMs).replacingOccurrences(of: "+", with: "")
            return "The best sectors of \(sec.laps.count) laps strung together — \(gap) quicker than the best lap."
        }
        return "The best lap already strings together the session's best sectors."
    }

    /// One sector: the split, in the accent when it is the session's best, with its
    /// gap to that best underneath otherwise.
    private func cell(_ ms: Int, gap: Int) -> some View {
        VStack(alignment: .trailing, spacing: 0) {
            time(ms, color: gap == 0 ? Color(.accentInk) : Color(.textStrong))
            if gap != 0 {
                Text(LapTime.fmtDelta(gap))
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
            }
        }
    }

    private func time(_ ms: Int, color: Color) -> some View {
        Text(LapTime.fmtMs(ms))
            .teStyle(.lapTime)
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
    }

    /// What VoiceOver gets: each row's splits in words, then the theoretical best.
    private func summary(_ sec: Sectors.SessionSplits, _ rows: [Row]) -> String {
        var parts = rows.map { row in
            let splits = row.lap.sectors.enumerated()
                .map { "S\($0.offset + 1) \(LapTime.fmtMs($0.element))" }
                .joined(separator: ", ")
            return "Lap \(String(lapNumber(row.lap.chIdx))): \(splits), lap \(LapTime.fmtMs(row.lap.timeMs))"
        }
        if sec.laps.count >= 2 {
            parts.append("Theoretical best \(LapTime.fmtMs(sec.theoreticalBestMs)). \(gapSentence(sec))")
        }
        return parts.joined(separator: ". ")
    }
}
