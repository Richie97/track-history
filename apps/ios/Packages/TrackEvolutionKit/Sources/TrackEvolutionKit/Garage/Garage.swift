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
    /// placeholder. A hint, never enforced.
    var wearLimitHint: String? {
        switch self {
        case .padsFront, .padsRear: "3 (mm)"
        case .tires: "3 (32nds)"
        case .rotorsFront: "28 (mm)"
        case .rotorsRear: "26 (mm)"
        default: nil
        }
    }

    /// The unit a first measurement of this kind is most likely in — the web
    /// measurement form's default (`viewVehicle` in `public/app.js`).
    var defaultUnit: String {
        self == .tires ? "32nds" : "mm"
    }
}
