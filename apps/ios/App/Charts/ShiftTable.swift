import SwiftUI
import TrackEvolutionKit

/// The shift-point read-out (#187) — the counterpart of `shiftTableHtml` in
/// `public/js/gears.js`.
///
/// One row per gear, carrying how many times the session upshifted out of it and
/// the earliest / typical / latest rpm it did so at. Short-shifting and bouncing
/// off the limiter each become a number that way, and each is worth a sentence
/// of advice — which is what `Gears.shiftNotes` writes underneath.
///
/// Two things about the figures are load-bearing and are said on screen rather
/// than only here. The rpm is read at the sample *before* the step, and on a
/// 20 m grid a shift takes about one grid point at speed — so every figure reads
/// a touch low and is labelled approximate. And the notes **report rather than
/// scold**: "upshifts from 4th come 800 rpm earlier than from 2nd" is a fact
/// about the session; "you are short-shifting" is a guess about why.
///
/// The maths is the Kit's `Gears`, pinned to the web implementation by
/// `contracts/logic/gears.json`; this file lays it out.
struct ShiftTable: View {
    let channels: SessionChannels

    var body: some View {
        if let sp = Gears.shiftPoints(channels) {
            let notes = Gears.shiftNotes(sp)
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("Upshifts")
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textMuted))
                            Text("≈\(Gears.fmtRpm(Double(sp.medianRpm))) rpm")
                                .teStyle(.lapTime)
                                .foregroundStyle(Color(.accentInk))
                        }
                        Text("Read at the last sample before each shift, so figures run a touch low.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                    Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 8) {
                        GridRow {
                            Text("Upshift")
                                .teStyle(.eyebrow)
                                .foregroundStyle(Color(.textFaint))
                                .gridColumnAlignment(.leading)
                            ForEach(["Count", "Earliest", "Typical", "Latest"], id: \.self) { heading in
                                Text(heading)
                                    .teStyle(.eyebrow)
                                    .foregroundStyle(Color(.textFaint))
                            }
                        }
                        ForEach(sp.gears, id: \.gear) { gear in
                            GridRow {
                                Text("From \(Gears.ordinal(gear.gear))")
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textMuted))
                                    .gridColumnAlignment(.leading)
                                value(String(gear.count), color: Color(.textMuted))
                                value(Gears.fmtRpm(gear.minRpm), color: Color(.textMuted))
                                value(Gears.fmtRpm(Double(gear.medianRpm)), color: Color(.textStrong))
                                value(Gears.fmtRpm(gear.maxRpm), color: Color(.textMuted))
                            }
                        }
                    }
                    if !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(notes, id: \.self) { note in
                                Text(note)
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textMuted))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Upshift rpm per gear")
            .accessibilityValue(summary(sp, notes))
            .accessibilityIdentifier("shiftTable")
        }
    }

    private func value(_ text: String, color: Color) -> some View {
        Text(text)
            .teStyle(.lapTime)
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
    }

    /// What VoiceOver gets: each gear's typical upshift, then the notes.
    private func summary(_ sp: Gears.SessionShifts, _ notes: [String]) -> String {
        var parts = sp.gears.map { gear in
            "Upshifts from \(Gears.ordinal(gear.gear)), \(gear.count) times, "
                + "typically \(Gears.fmtRpm(Double(gear.medianRpm))) rpm"
        }
        parts.append(contentsOf: notes)
        return parts.joined(separator: ". ")
    }
}
