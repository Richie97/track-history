import Foundation

/// The module's unit helpers, named from file scope: inside `Health`, `Units`
/// is the health strip's own metric/US enum.
private typealias UnitFormat = Units

/// The tire-pressure loop (NS-40) — `pressureLoop`, `nextTimeNote` and the two
/// sheets its buttons write, `recordHotSheet` and `nextDaySheet`, from
/// `public/js/health.js` under the same names. Pinned with the setup-sheet
/// helpers by `contracts/logic/setups.json` (`SetupsTests`); Android's `:core`
/// asserts against the same fixture.
public extension Health {
    /// One corner of the loop: the sheet's cold, the import's hot, the target
    /// and the suggestion — all psi.
    struct LoopRow: Hashable, Sendable, Identifiable {
        public let corner: String
        public let key: String
        public let coldPsi: Double?
        public let hotPsi: Double?
        public let hotChIdx: Int?
        public let targetPsi: Double?
        public let suggestion: ColdSuggestion?

        public var id: String { key }
    }

    /// The loop for one session. `hotSheet` is the sheet's `tp_hot` as the
    /// import measured it, on the sheet's step, with only the corners that
    /// recorded one; `coldSheet` the suggested colds, when every corner has one.
    struct PressureLoop: Hashable, Sendable {
        public let rows: [LoopRow]
        public let hotSheet: CornerValues
        public let coldSheet: CornerValues?
    }

    /// `pressureLoop`: per corner, the day's sheet's cold, the import's hot (the
    /// peak end-of-lap reading, psi), the vehicle's target, and the suggestion
    /// when all three exist. nil when the session stored no hot pressure.
    static func pressureLoop(_ channels: SessionChannels?, _ sheet: SetupSheet?, _ targetPsi: Double?) -> PressureLoop? {
        guard let hot = hotPressures(channels) else { return nil }
        let rows = TYRE_CORNERS.map { entry -> LoopRow in
            let (corner, key) = entry
            let h = hot[corner]
            let hotPsi = h.map { kpaToPsi($0.peakKpa) }
            let coldPsi = sheet?.tpCold?[key]
            return LoopRow(
                corner: corner, key: key, coldPsi: coldPsi, hotPsi: hotPsi, hotChIdx: h?.peakChIdx,
                targetPsi: targetPsi, suggestion: suggestCold(coldPsi, hotPsi, targetPsi)
            )
        }
        var hotSheet = CornerValues()
        for row in rows { if let h = row.hotPsi { hotSheet[row.key] = roundPsi(h) } }
        var coldSheet: CornerValues?
        if rows.allSatisfy({ $0.suggestion != nil }) {
            var cold = CornerValues()
            for row in rows { cold[row.key] = row.suggestion?.suggestedPsi }
            coldSheet = cold
        }
        return PressureLoop(rows: rows, hotSheet: hotSheet, coldSheet: coldSheet)
    }

    /// The line *Record hot pressures* appends to the sheet's notes, so the
    /// suggestion rides the copy-forward prefill: "Next time cold: LF 24.5 / …
    /// psi (hots ran 35.5 / … vs 34.0 target)". nil without a cold suggestion.
    static func nextTimeNote(_ loop: PressureLoop?) -> String? {
        guard let loop, let cold = loop.coldSheet else { return nil }
        let colds = TYRE_CORNERS.map { "\($0.corner) \(UnitFormat.toFixed(cold[$0.key] ?? 0, 1))" }.joined(separator: " / ")
        let hots = TYRE_CORNERS.map { c in loop.hotSheet[c.key].map { UnitFormat.toFixed($0, 1) } ?? "—" }.joined(separator: " / ")
        let target = loop.rows.first { $0.targetPsi != nil }?.targetPsi
        return "Next time cold: \(colds) psi (hots ran \(hots) vs \(target.map { UnitFormat.toFixed($0, 1) } ?? "—") target)"
    }

    /// `recordHotSheet`: `sheet` (or an empty one) with the import's hots merged
    /// over its `tp_hot` and ``nextTimeNote(_:)`` appended to its notes — once.
    static func recordHotSheet(_ sheet: SetupSheet?, _ loop: PressureLoop?) -> SetupSheet {
        var out = sheet ?? SetupSheet()
        var merged = out.tpHot ?? CornerValues()
        if let hot = loop?.hotSheet {
            for (_, key) in TYRE_CORNERS { if let v = hot[key] { merged[key] = v } }
        }
        out.tpHot = merged
        if let line = nextTimeNote(loop), !(out.notes?.contains(line) ?? false) {
            // `base.notes ? … : line` — an empty string is falsy in the JS.
            out.notes = (out.notes ?? "").isEmpty ? line : "\(out.notes!)\n\(line)"
        }
        return out
    }

    /// `nextDaySheet`: the next day's own sheet when there is one, else
    /// `todaySheet` without its hots, which belong to today — either way with
    /// the loop's suggested colds.
    static func nextDaySheet(_ nextSheet: SetupSheet?, _ todaySheet: SetupSheet?, _ loop: PressureLoop?) -> SetupSheet {
        var carried: SetupSheet
        if let nextSheet {
            carried = nextSheet
        } else {
            carried = todaySheet ?? SetupSheet()
            carried.tpHot = nil
        }
        carried.tpCold = loop?.coldSheet
        return carried
    }
}
