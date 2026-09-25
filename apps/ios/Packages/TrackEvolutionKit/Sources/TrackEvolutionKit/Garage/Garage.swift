import Foundation

/// Garage logbook presentation logic — pure, unit-tested.
///
/// A port of the consumable half of `public/js/garage.js` plus `garageAlerts` from
/// `public/app.js`, keeping the JS function and constant names so the two diff by
/// eye. The setup-sheet half of that file (`SETUP_FIELDS`, `flattenSetup`,
/// `diffSetups`) is **not** here: the setup notebook is a separate deferred
/// feature (`docs/specs/native/README.md`), and porting its spec without its UI
/// would be dead code that silently drifts from `sanitizeSetup`.
///
/// **The wear math is not here either, and must not be added.** `wearEstimate` in
/// `src/lib/wear.ts` runs on the server and arrives pre-computed on every part
/// (`Part.wear`), so there is exactly one implementation of it. This file only
/// decides how to *say* what the server computed — which is why the garage needs
/// a live server and its writes never queue offline (`OfflineStore`).
public enum Garage {
    /// Rough conversion for "how many more track days" phrasing — matches
    /// `DEFAULT_HOURS_PER_DAY` in `src/lib/wear.ts`.
    public static let HOURS_PER_DAY = 2.0

    /// Traffic-light status for a part's wear estimate. `nil` means there was no
    /// basis for one — no expected life and fewer than two measurements — which
    /// reads differently from "fine": the app says so rather than showing green.
    public enum PartStatus: String, Hashable, Sendable {
        /// Replace now: over the limit, or past the expected life.
        case due
        /// Roughly two track days or less remaining.
        case low
        /// Plenty left.
        case ok
    }

    /// `partStatus` in `public/js/garage.js`.
    public static func partStatus(_ wear: WearEstimate?) -> PartStatus? {
        guard let wear, let remaining = wear.remainingHours else { return nil }
        if remaining <= 0 || (wear.pctUsed ?? 0) >= 1 { return .due }
        if remaining <= 2 * HOURS_PER_DAY { return .low }
        return .ok
    }

    /// "4.5 h", "12 h", "—". Rounded to 1dp the JavaScript way, and a whole number
    /// keeps no trailing `.0` — `${Math.round(h * 10) / 10} h` stringifies that way.
    public static func fmtHours(_ hours: Double?) -> String {
        guard let hours, hours.isFinite else { return "—" }
        return "\(trimmed(JSMath.round(hours, 10))) h"
    }

    /// "~4.5 h left (≈2 track days)" — the phrasing used for remaining life, or
    /// nil when there is no projection to phrase.
    public static func fmtRemaining(_ wear: WearEstimate?) -> String? {
        guard let wear, let remaining = wear.remainingHours else { return nil }
        if remaining <= 0 { return "replace now" }
        let days = remaining / HOURS_PER_DAY
        // Half-day precision below two days, whole days above: "≈1.5 track days"
        // is useful, "≈7.5" is false precision on an estimate this soft.
        let roundedDays = days >= 2 ? JSMath.round(days, 1) : JSMath.round(days, 2)
        let noun = roundedDays == 1 ? "track day" : "track days"
        return "~\(fmtHours(remaining)) left (≈\(trimmed(roundedDays)) \(noun))"
    }

    /// Cents → "$389" / "$389.50". Whole dollars lose the cents, as in the JS.
    public static func fmtCost(_ cents: Int?) -> String? {
        guard let cents else { return nil }
        let dollars = Double(cents) / 100
        return cents % 100 == 0
            ? "$\(String(format: "%.0f", dollars))"
            : "$\(String(format: "%.2f", dollars))"
    }

    // MARK: - The car's own odometer (#192)

    /// `vehicleOdometerLine` in `public/js/garage.js`: what the car's own
    /// odometer last said, naming the recorded session it came from — only
    /// video imports carry a reading, so the line never claims to be current.
    public static func vehicleOdometerLine(_ odo: VehicleOdometer?, _ units: UnitSystem) -> String? {
        guard let odo else { return nil }
        let line = "Odometer: \(Units.fmtOdometer(odo.km, units)) at the last recorded session (\(odo.on))"
        if odo.otherCar == 0 { return line }
        let noun = odo.otherCar == 1 ? "reading" : "readings"
        return "\(line) · \(odo.otherCar) lower \(noun) skipped as another car's"
    }

    /// `partOdometerLine`: the distance the odometer covered between a part's
    /// first and last recorded sessions — a lower bound, and worded as one.
    public static func partOdometerLine(_ odo: PartOdometer?, _ units: UnitSystem) -> String? {
        guard let odo else { return nil }
        return "Odometer: \(Units.fmtOdometer(odo.km, units)) between its first and last recorded sessions"
    }

    /// A part at or near the end of its life, and the vehicle it's fitted to.
    public struct Alert: Hashable, Sendable, Identifiable {
        public let vehicle: GarageVehicle
        public let part: Part
        public let status: PartStatus

        public var id: Int { part.id }

        public init(vehicle: GarageVehicle, part: Part, status: PartStatus) {
            self.vehicle = vehicle
            self.part = part
            self.status = status
        }
    }

    /// The maintenance items worth shouting about: parts **on the car** that are
    /// due or low, worst first. `garageAlerts` in `public/app.js`.
    ///
    /// Retired parts are excluded on purpose — a worn-out part you already
    /// replaced is history, not a reminder — and so are spares on the shelf
    /// (`equipped == false`, migration 0029), which aren't wearing.
    public static func garageAlerts(_ garage: [GarageVehicle]) -> [Alert] {
        garage
            .flatMap { vehicle in
                vehicle.parts.compactMap { part -> Alert? in
                    guard part.retiredOn == nil, part.equipped != false,
                          let status = partStatus(part.wear),
                          status == .due || status == .low
                    else { return nil }
                    return Alert(vehicle: vehicle, part: part, status: status)
                }
            }
            // Stable, like the JS `sort` on a 0/1 key: due first, and within each
            // group the order the vehicles and parts already came in.
            .enumerated()
            .sorted { a, b in
                let rank = { (alert: Alert) in alert.status == .due ? 0 : 1 }
                return rank(a.element) == rank(b.element)
                    ? a.offset < b.offset
                    : rank(a.element) < rank(b.element)
            }
            .map(\.element)
    }

    // MARK: - On the car, or on the shelf (migration 0029)

    /// `equipSwapKinds` in `public/js/garage.js` (and `src/lib/wear.ts`): which
    /// kinds share a place on the car with `kind` — what equipping a part takes
    /// off. A full set swaps with either pair and the pairs swap with a full
    /// set, but a front pair leaves the rears alone; `other` swaps nothing.
    public static func equipSwapKinds(_ kind: PartKind) -> [PartKind] {
        switch kind {
        case .other: []
        case .tires: [.tires, .tiresFront, .tiresRear]
        case .tiresFront, .tiresRear: [kind, .tires]
        default: [kind]
        }
    }

    /// `equipSwapsOff`: the equipped parts that equipping a part of `kind` (with
    /// id `partId`, nil for one not created yet) would take off the car. The
    /// server makes the same choice; this is only so the switch can say so
    /// first. A part with no `equipped` — cached before 0029 — is never named,
    /// as in the JS, where `undefined` is falsy.
    public static func equipSwapsOff(partId: Int?, kind: PartKind, in parts: [Part]) -> [Part] {
        let kinds = equipSwapKinds(kind)
        return parts.filter {
            $0.id != partId && $0.equipped == true && $0.retiredOn == nil && kinds.contains($0.kind)
        }
    }

    /// `partTitle`: the part's name with its size, when it has one —
    /// "Hoosier A7 · 285/30R18".
    public static func partTitle(name: String?, size: String?) -> String {
        if let size, !size.isEmpty { return "\(name ?? "") · \(size)" }
        return name ?? ""
    }

    public static func partTitle(_ part: Part) -> String { partTitle(name: part.name, size: part.size) }

    /// On the car right now — `onCarParts` in `public/app.js`. A part with no
    /// `equipped` (a response cached before 0029) counts as on the car.
    public static func isOnCar(_ part: Part) -> Bool { part.retiredOn == nil && part.equipped != false }

    /// On the shelf: off the car but not retired — a spare set, the street pads.
    public static func isSpare(_ part: Part) -> Bool { part.retiredOn == nil && part.equipped == false }

    /// Parts in the car's own order — pads, tires full set then front then rear,
    /// rotors, fluids — newest first within a kind, as the web page lists them.
    /// A kind the client doesn't know sorts first, like the JS's `findIndex` of -1.
    public static func sortedByKind(_ parts: [Part]) -> [Part] {
        let order = { (kind: PartKind) in PartKind.all.firstIndex(of: kind) ?? -1 }
        return parts.enumerated().sorted { a, b in
            let (ka, kb) = (order(a.element.kind), order(b.element.kind))
            if ka != kb { return ka < kb }
            if a.element.installedOn != b.element.installedOn { return a.element.installedOn > b.element.installedOn }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// When the part last came off the car (the latest `removedOn`), or nil if
    /// it never has — a spare with no history is "not fitted yet".
    public static func lastOff(_ part: Part) -> String? {
        (part.mounts ?? []).compactMap(\.removedOn).max()
    }

    /// The earliest date the Equipped switch accepts for its swap: taking a part
    /// off can't predate the stretch it is on, and putting one on can't go back
    /// inside a stretch it was already on. The server refuses the same.
    public static func earliestSwapDate(_ part: Part) -> String {
        if part.equipped != false {
            return (part.mounts ?? []).first { $0.removedOn == nil }?.mountedOn ?? part.installedOn
        }
        if let off = lastOff(part), off > part.installedOn { return off }
        return part.installedOn
    }

    /// What the Equipped switch says before it writes: taking a part off, or
    /// putting it on and what that takes off. The web page's confirm row.
    public static func equipNote(_ part: Part, in parts: [Part]) -> String {
        if part.equipped != false {
            return "Take it off the car? It moves to Spares with its history, and its wear stops until it goes back on."
        }
        let swaps = equipSwapsOff(partId: part.id, kind: part.kind, in: parts)
        return swaps.isEmpty
            ? "Put it on the car? Its wear picks up from here."
            : "Put it on the car? This takes off \(swapList(swaps)) — \(movesTo(swaps)) to Spares."
    }

    /// What adding (or refreshing into) a new part of `kind` takes off when it
    /// goes on the car; nil when nothing does. The add form's hint.
    public static func addSwapNote(_ kind: PartKind, in parts: [Part]) -> String? {
        let swaps = equipSwapsOff(partId: nil, kind: kind, in: parts)
        return swaps.isEmpty ? nil : "Takes off \(swapList(swaps)) — \(movesTo(swaps)) to Spares."
    }

    private static func swapList(_ swaps: [Part]) -> String { swaps.map(partTitle).joined(separator: " and ") }
    private static func movesTo(_ swaps: [Part]) -> String { swaps.count == 1 ? "it moves" : "they move" }

    // MARK: - Car catalog (#222)

    /// "Chevrolet Corvette C7" — `catalogCarName`: the name a pick writes into an
    /// *empty* name field.
    public static func catalogCarName(_ car: CatalogCar) -> String {
        [car.make, car.model, car.generation].compactMap { $0 }.joined(separator: " ")
    }

    /// "2014–2019", or "2020–" while still in production — `catalogCarYears`.
    public static func catalogCarYears(_ car: CatalogCar) -> String {
        car.yearTo.map { "\(car.yearFrom)–\($0)" } ?? "\(car.yearFrom)–"
    }

    /// "Chevrolet Corvette · C7 · 2014–2019" — `catalogCarLabel`: how a picker row
    /// reads. The generation and the year span are what disambiguate seven
    /// Corvettes, so they are rendered rather than the bare model repeated.
    public static func catalogCarLabel(_ car: CatalogCar) -> String {
        ["\(car.make) \(car.model)", car.generation, catalogCarYears(car)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// How well one query token fits a row — `tokenScore`: 3 for a whole word
    /// ("c7"), 2 for a word prefix ("corv"), 1 for a substring anywhere, 0 for no
    /// fit. Words are compared as written and with punctuation stripped, so "mx5"
    /// finds "MX-5"; a four-digit token that fits nothing by name is tried as a
    /// model year inside the row's span, so "corvette 2017" finds the C7.
    private static func tokenScore(_ token: String, words: [String], row: CatalogCar) -> Int {
        var best = 0
        for w in words {
            let plain = w.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
            if w == token || plain == token {
                best = max(best, 3)
            } else if w.hasPrefix(token) || plain.hasPrefix(token) {
                best = max(best, 2)
            } else if w.contains(token) || plain.contains(token) {
                best = max(best, 1)
            }
        }
        if best == 0, token.count == 4, token.allSatisfy({ $0.isASCII && $0.isNumber }), let year = Int(token) {
            if year >= row.yearFrom, row.yearTo.map({ year <= $0 }) ?? true { best = 2 }
        }
        return best
    }

    /// The catalog rows matching a query, best first — `matchCatalogCars`. Every
    /// whitespace-separated token has to fit the row somewhere (make, model,
    /// generation or year span), so "chevrolet corvette" narrows rather than
    /// widens; ties keep the catalog's own order, and an empty query is the whole
    /// list. Pinned against the JS by `contracts/logic/car-catalog-match.json`.
    public static func matchCatalogCars(_ query: String, _ rows: [CatalogCar]) -> [CatalogCar] {
        let tokens = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        if tokens.isEmpty { return rows }
        var scored: [(row: CatalogCar, score: Int, index: Int)] = []
        for (i, row) in rows.enumerated() {
            let words = catalogCarName(row).lowercased().split(separator: " ").map(String.init)
            var score = 0
            var fits = true
            for t in tokens {
                let s = tokenScore(t, words: words, row: row)
                if s == 0 { fits = false; break }
                score += s
            }
            if fits { scored.append((row, score, i)) }
        }
        return scored
            .sorted { a, b in a.score == b.score ? a.index < b.index : a.score > b.score }
            .map(\.row)
    }

    /// The numbers on a vehicle form that a catalog pick may fill.
    public struct VehicleGeometry: Hashable, Sendable {
        public var wheelbaseMm: Int?
        public var steeringRatio: Double?

        public init(wheelbaseMm: Int? = nil, steeringRatio: Double? = nil) {
            self.wheelbaseMm = wheelbaseMm
            self.steeringRatio = steeringRatio
        }
    }

    /// What a pick may do to one field — the three outcomes of `catalogPrefill`.
    public enum CatalogPrefillAction: String, Hashable, Sendable {
        /// Write the catalog's value, nil included: a car re-picked from a C7 to
        /// a car with no single ratio must not keep the C7's.
        case fill
        /// The number is the driver's and differs; ask before replacing it.
        case ask
        /// Nothing to do: already equal, or the driver's own number and the
        /// catalog has nothing better than "unknown".
        case keep
    }

    public struct CatalogPrefillStep<Value: Hashable & Sendable>: Hashable, Sendable {
        public let value: Value?
        public let action: CatalogPrefillAction

        public init(value: Value?, action: CatalogPrefillAction) {
            self.value = value
            self.action = action
        }
    }

    public struct CatalogPrefillPlan: Hashable, Sendable {
        public let wheelbaseMm: CatalogPrefillStep<Int>
        public let steeringRatio: CatalogPrefillStep<Double>

        public init(wheelbaseMm: CatalogPrefillStep<Int>, steeringRatio: CatalogPrefillStep<Double>) {
            self.wheelbaseMm = wheelbaseMm
            self.steeringRatio = steeringRatio
        }
    }

    /// The "pre-fill, never overwrite" rule, decided per field — `catalogPrefill`.
    ///
    /// A number is the driver's when it is set and is not what the previous pick
    /// (`previous`: the row the form's numbers came from, or nil for a car typed
    /// by hand) filled in — so a corrected ratio survives a re-pick behind a
    /// question, and an untouched one is replaced silently.
    public static func catalogPrefill(
        _ row: CatalogCar, current: VehicleGeometry, previous: CatalogCar?
    ) -> CatalogPrefillPlan {
        func step<V: Hashable & Sendable>(_ value: V?, _ cur: V?, _ prev: V?) -> CatalogPrefillStep<V> {
            let driverOwned = cur != nil && (previous == nil || cur != prev)
            let action: CatalogPrefillAction
            if cur == value {
                action = .keep
            } else if !driverOwned {
                action = .fill
            } else if value == nil {
                action = .keep
            } else {
                action = .ask
            }
            return CatalogPrefillStep(value: value, action: action)
        }
        return CatalogPrefillPlan(
            wheelbaseMm: step(row.wheelbaseMm, current.wheelbaseMm, previous?.wheelbaseMm),
            steeringRatio: step(row.steeringRatio, current.steeringRatio, previous?.steeringRatio)
        )
    }

    /// A number the way JavaScript stringifies it: `4.5` → "4.5", `4.0` → "4".
    private static func trimmed(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15
            ? String(Int(value))
            : String(value)
    }
}

public extension PartKind {
    /// `PART_KINDS` in `public/js/garage.js` — the label shown for each kind. A
    /// kind a newer server introduced falls back to its raw value rather than
    /// rendering blank.
    var label: String {
        switch self {
        case .padsFront: "Front pads"
        case .padsRear: "Rear pads"
        case .tires: "Tires (full set)"
        case .tiresFront: "Front tires"
        case .tiresRear: "Rear tires"
        case .rotorsFront: "Front rotors"
        case .rotorsRear: "Rear rotors"
        case .brakeFluid: "Brake fluid"
        case .oil: "Oil"
        case .other: "Other"
        default: rawValue
        }
    }

    /// `WEAR_LIMIT_HINTS` — the suggested replace-at level, shown as a form
    /// placeholder. A hint, never enforced. The imperial table, which is the one
    /// `contracts/logic/garage-status.json` pins; `Units.wearLimitHint` applies
    /// the account's system on top (tread depth in mm rather than 32nds).
    var wearLimitHint: String? {
        switch self {
        case .padsFront, .padsRear: "3 (mm)"
        case .tires, .tiresFront, .tiresRear: "3 (32nds)"
        case .rotorsFront: "28 (mm)"
        case .rotorsRear: "26 (mm)"
        default: nil
        }
    }
}
