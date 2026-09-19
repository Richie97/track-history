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

    /// The maintenance items worth shouting about: **active** parts that are due
    /// or low, worst first. `garageAlerts` in `public/app.js`.
    ///
    /// Retired parts are excluded on purpose — a worn-out part you already
    /// replaced is history, not a reminder.
    public static func garageAlerts(_ garage: [GarageVehicle]) -> [Alert] {
        garage
            .flatMap { vehicle in
                vehicle.parts.compactMap { part -> Alert? in
                    guard part.retiredOn == nil,
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
        case .tires: "Tires"
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
        case .tires: "3 (32nds)"
        case .rotorsFront: "28 (mm)"
        case .rotorsRear: "26 (mm)"
        default: nil
        }
    }
}
