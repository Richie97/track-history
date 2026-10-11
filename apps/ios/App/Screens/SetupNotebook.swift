import SwiftUI
import TrackEvolutionKit

/// The per-day setup notebook on the event page (NS-40) — the port of the web's
/// `setupNotebookHtml`, brought to the phone because a sheet is filled in at the
/// car, between sessions, with a gauge in one hand. Android's
/// `SetupNotebookCard` is the same card.
///
/// Each day of the event is a row: its sheet in the driver's units, the values
/// that changed since the previous day's sheet marked (`Garage.diffSetups`
/// against `Garage.previousSheet`, so on stored values), and a door to the
/// form — *Log day N setup*, which copies the day before forward, or *Edit*.
/// Under the days, when a session recorded tire pressures, the pressure loop.
///
/// The loop sits **here**, not on the channel panel's Car tab where the web puts
/// it: below expanded width that panel is a sheet, and the last session out is
/// the one the next cold pressures are for.
///
/// Pro: a free account sees the card locked in place, never missing.
struct SetupNotebookCard: View {
    let event: Event
    let setups: [Setup]
    let sessions: [Session]
    let parts: [Part]
    let targetHotPsi: Double?
    let units: UnitSystem
    let pro: Bool
    let onOpenDay: (Int) -> Void
    let onRecordHots: (Int, SetupSheet) -> Void
    let onSetNextCold: (Int, SetupSheet) -> Void

    var body: some View {
        if pro {
            notebook
        } else {
            ProUpsellCard(
                title: "Setup notebook",
                blurb: """
                    Log each day's pressures, alignment, dampers and fuel, see what changed since the \
                    day before, and turn the hot pressures a session recorded into next session's colds.
                    """
            )
        }
    }

    /// *Set day N+1 cold*, when there is a next day to set.
    private func setNext(
        _ nextDay: Int?, _ byDay: [Int: SetupSheet], _ sheet: SetupSheet?, _ loop: Health.PressureLoop
    ) -> (() -> Void)? {
        guard let nextDay else { return nil }
        let next = Health.nextDaySheet(byDay[nextDay], sheet, loop)
        return { onSetNextCold(nextDay, next) }
    }

    private var notebook: some View {
        let days = SetupNotebook.setupDays(event, setups)
        let byDay = Dictionary(setups.map { ($0.day, $0.data) }, uniquingKeysWith: { _, last in last })
        return TECard {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(days.enumerated()), id: \.element) { index, day in
                    if index > 0 { Divider().overlay(Color(.borderHairline)) }
                    SetupDayRow(
                        day: day,
                        date: days.count > 1 || byDay[day] != nil
                            ? EventDates.eventDayISO(event.startDate, day: day).map { EventDates.fmtDate($0) }
                            : nil,
                        sheet: byDay[day],
                        previous: Garage.previousSheet(setups, day),
                        parts: parts,
                        units: units,
                        onOpen: { onOpenDay(day) }
                    )
                }

                if let session = SetupNotebook.loopSession(sessions) {
                    let day = SetupNotebook.defaultLoopDay(days, byDay)
                    let sheet = byDay[day]
                    if let loop = Health.pressureLoop(session.channels, sheet, targetHotPsi) {
                        let nextDay = days.first(where: { $0 == day + 1 })
                        Divider().overlay(Color(.borderHairline))
                        PressureLoopView(
                            session: session,
                            day: day,
                            loop: loop,
                            units: units,
                            hasTarget: targetHotPsi != nil,
                            nextDay: nextDay,
                            onRecord: { onRecordHots(day, Health.recordHotSheet(sheet, loop)) },
                            onSetNext: setNext(nextDay, byDay, sheet, loop)
                        )
                    }
                }
            }
        }
        .accessibilityIdentifier("setupNotebook")
    }
}

/// One day of the notebook.
private struct SetupDayRow: View {
    let day: Int
    let date: String?
    let sheet: SetupSheet?
    let previous: SetupSheet?
    let parts: [Part]
    let units: UnitSystem
    let onOpen: () -> Void

    var body: some View {
        let changed = sheet.map { Set(Garage.diffSetups(previous, $0).map(\.key)) } ?? []
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Day \(day)")
                    .teStyle(.bodyStrong)
                    .foregroundStyle(Color(.textStrong))
                if let date {
                    Text(date)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
                Spacer()
                // `.plain` is what keeps this tap to this button: the notebook is
                // one `List` row, and a default-styled button there makes the whole
                // row its hit area — one tap fired every day's button and pushed
                // the form once per day, last day on top.
                Button(sheet == nil ? "Log day \(day) setup" : "Edit", action: onOpen)
                    .buttonStyle(.plain)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.accentInk))
                    .accessibilityIdentifier("setupOpen-\(day)")
            }
            if let sheet {
                ForEach(Garage.SETUP_FIELDS) { field in
                    let keys = Garage.flatKeys(field).filter { Garage.sheetValue(sheet, $0) != nil }
                    if !keys.isEmpty {
                        SetupValueLine(
                            label: field.label, keys: keys, sheet: sheet, previous: previous,
                            changed: changed, units: units
                        )
                    }
                }
                ForEach(Garage.PART_REFS) { ref in
                    if let id = Garage.partRefValue(sheet, ref.key) {
                        let name = parts.first(where: { $0.id == id }).map { Garage.partTitle($0) } ?? "Part #\(id)"
                        let isChanged = changed.contains(ref.key)
                        Text("\(ref.label): \(name)")
                            .teStyle(isChanged ? .bodyStrong : .sm)
                            .foregroundStyle(Color(isChanged ? .accentInk : .textStrong))
                            .accessibilityLabel(
                                isChanged
                                    ? "\(ref.label): \(name), changed from the day before"
                                    : "\(ref.label): \(name)"
                            )
                    }
                }
                if let notes = sheet.notes, !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(notes)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                        .padding(.top, 2)
                }
            } else {
                Text(previous != nil ? "Logging copies day \(day - 1)'s sheet forward." : "No sheet yet.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
        }
        .accessibilityIdentifier("setupDay-\(day)")
    }
}

/// One field of a sheet on one line — "Cold  FL 26 psi · FR 26 psi …" — with a
/// changed value set in the accent **and** said as "changed from …", so the mark
/// is never colour alone.
private struct SetupValueLine: View {
    let label: String
    let keys: [String]
    let sheet: SetupSheet
    let previous: SetupSheet?
    let changed: Set<String>
    let units: UnitSystem

    private func sub(_ key: String) -> String {
        let full = Garage.flatLabel(key)
        return full.hasPrefix(label)
            ? String(full.dropFirst(label.count)).trimmingCharacters(in: .whitespaces)
            : full
    }

    private func value(_ key: String) -> String {
        Garage.fmtSetupValue(key, Garage.sheetValue(sheet, key), units)
    }

    var body: some View {
        let shown = keys.map { key in
            [sub(key), value(key) + (changed.contains(key) ? " •" : "")]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        }
        .joined(separator: " · ")
        let spoken = keys.map { key in
            let was = changed.contains(key)
                ? " (changed from \(Garage.fmtSetupValue(key, Garage.sheetValue(previous, key), units)))"
                : ""
            return "\(sub(key)) \(value(key))\(was)".trimmingCharacters(in: .whitespaces)
        }
        .joined(separator: ", ")
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
                .frame(width: 120, alignment: .leading)
            Text(shown)
                .teStyle(.sm)
                .foregroundStyle(Color(keys.contains(where: { changed.contains($0) }) ? .accentInk : .textStrong))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(spoken)")
    }
}

/// The tire-pressure loop (NS-40, the web's `pressureLoopHtml`): per corner the
/// sheet's cold, the session's hot, the target and the cold to start from next
/// time, with the two writes it offers. One accessibility element whose buttons
/// are also named actions — the NS-34 rule for a card of numbers.
private struct PressureLoopView: View {
    let session: Session
    let day: Int
    let loop: Health.PressureLoop
    let units: UnitSystem
    let hasTarget: Bool
    let nextDay: Int?
    let onRecord: () -> Void
    let onSetNext: (() -> Void)?

    private static let pressureField = Garage.SETUP_FIELDS.first { $0.key == "tp_cold" }!

    private func psi(_ v: Double?) -> String {
        guard let v else { return "—" }
        let shown = Garage.setupToDisplay(Self.pressureField, v, units) ?? v
        return Units.toFixed(shown, Units.isMetric(units) ? 2 : 1)
    }

    var body: some View {
        let unit = Garage.setupUnit(Self.pressureField, units)
        VStack(alignment: .leading, spacing: 6) {
            Text("Tire pressures — \(session.label ?? "Session") vs day \(day)")
                .teStyle(.bodyStrong)
                .foregroundStyle(Color(.textStrong))
            Text("Cold from the sheet, hot from the session (the highest end-of-lap reading), and the cold to start from next time to land on target. \(unit).")
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
                GridRow {
                    Text("")
                    ForEach(["Cold", "Hot", "Target", "Next cold"], id: \.self) { title in
                        Text(title).teStyle(.xxs).foregroundStyle(Color(.textMuted))
                    }
                }
                ForEach(loop.rows) { row in
                    GridRow {
                        Text(row.corner).teStyle(.sm).foregroundStyle(Color(.textMuted))
                        Text(psi(row.coldPsi)).teStyle(.sm).foregroundStyle(Color(.textStrong))
                        Text(psi(row.hotPsi)).teStyle(.sm).foregroundStyle(Color(.textStrong))
                        Text(psi(row.targetPsi)).teStyle(.sm).foregroundStyle(Color(.textStrong))
                        Text(psi(row.suggestion?.suggestedPsi)).teStyle(.bodyStrong).foregroundStyle(Color(.accentInk))
                    }
                }
            }
            .monospacedDigit()
            if !hasTarget {
                Text("Set a target hot pressure on the car's page to get a suggestion.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            HStack(spacing: 16) {
                Button("Record hot pressures", action: onRecord)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.accentInk))
                    .accessibilityIdentifier("loopRecord")
                if let onSetNext, let nextDay, loop.coldSheet != nil {
                    Button("Set day \(nextDay) cold", action: onSetNext)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.accentInk))
                        .accessibilityIdentifier("loopNext")
                }
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Record hot pressures on day \(day)", onRecord)
        .accessibilityActions {
            if let onSetNext, let nextDay, loop.coldSheet != nil {
                Button("Set day \(nextDay) cold pressures", action: onSetNext)
            }
        }
        .accessibilityIdentifier("pressureLoop")
    }
}

/// The notebook's pure decisions, kept apart from the views so the app target's
/// tests can reach them — Android's `setupDays` / `loopSession` /
/// `defaultLoopDay`, under the same names.
enum SetupNotebook {
    /// The days a notebook has a row for: every day of the event (a fractional
    /// day count rounds up, as the web's `setupDays` does), plus any day a sheet
    /// was logged on beyond them.
    static func setupDays(_ event: Event, _ setups: [Setup]) -> [Int] {
        let span = max(1, Int(event.days.rounded(.up)))
        return Array(Set(Array(1...span) + setups.map(\.day))).sorted()
    }

    /// The session the loop reads: the latest one that recorded tire pressures.
    static func loopSession(_ sessions: [Session]) -> Session? {
        sessions.last(where: { Health.hotPressures($0.channels) != nil })
    }

    /// The day the loop compares against: the latest day whose sheet has cold
    /// pressures, else the latest day with a sheet, else day 1 — the web's
    /// `defaultHealthDay`.
    static func defaultLoopDay(_ days: [Int], _ byDay: [Int: SetupSheet]) -> Int {
        days.last(where: { byDay[$0]?.tpCold != nil }) ?? days.last(where: { byDay[$0] != nil }) ?? 1
    }

    /// The cost line items that were entered, "Entry fee $495 · Fuel $145" — nil
    /// when none was, so an uncosted day says nothing rather than "$0" (#147).
    static func costBreakdown(_ event: Event) -> String? {
        let values = [event.costEntryCents, event.costFuelCents, event.costTravelCents, event.costMiscCents]
        let parts = zip(Costs.COST_FIELDS, values).compactMap { field, cents in
            cents.flatMap { Costs.fmtSpend($0) }.map { "\(field.label) \($0)" }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What a set of events cost, as the web's track page says it: "$1,960
    /// spent", or "… spent (2 of 3 events costed)". Past events only, and nil
    /// when none was costed (#147).
    static func spentLine(_ events: [Event], now: Date = Date()) -> String? {
        let past = events.filter { !EventDates.isUpcoming($0.startDate, now: now) }
        let costed = past.compactMap(\.costCents)
        guard !costed.isEmpty, let total = Costs.fmtSpend(costed.reduce(0, +)) else { return nil }
        return costed.count < past.count
            ? "\(total) spent (\(costed.count) of \(past.count) events costed)"
            : "\(total) spent"
    }
}
