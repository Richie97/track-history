import Foundation

/// Track-day costs on the event form and page (#147, NS-40) — the port of the
/// form half of `public/js/costs.js`, under the same names, pinned by
/// `contracts/logic/costs.json` (`CostsTests`), the fixture Android's `:core`
/// asserts against too.
///
/// Money is whole cents. The four line items are plain event columns
/// (`cost_*_cents`); ``eventCostCents(_:_:_:_:)`` is their total, nil — never
/// zero — when none was entered: the mirror of `eventCostCents` in
/// `src/lib/costs.ts` that `OfflineMirrors.recomputeDetail` calls.
public enum Costs {
    /// A line item: its column, the form's label and the input's placeholder.
    public struct CostField: Hashable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let placeholder: String

        public var id: String { key }
    }

    /// The line items, in the order the form and the breakdown render them.
    public static let COST_FIELDS: [CostField] = [
        CostField(key: "cost_entry_cents", label: "Entry fee", placeholder: "450"),
        CostField(key: "cost_fuel_cents", label: "Fuel", placeholder: "120"),
        CostField(key: "cost_travel_cents", label: "Travel & lodging", placeholder: "300"),
        CostField(key: "cost_misc_cents", label: "Misc", placeholder: "tow, insurance, a mirror…"),
    ]

    /// The entered line items summed, nil when none was entered.
    public static func eventCostCents(_ entry: Int?, _ fuel: Int?, _ travel: Int?, _ misc: Int?) -> Int? {
        let items = [entry, fuel, travel, misc].compactMap { $0 }
        return items.isEmpty ? nil : items.reduce(0, +)
    }

    /// Whether `t` is what JavaScript's `Number` reads as a plain decimal: an
    /// optional sign, digits with an optional fraction, an optional exponent.
    /// `Double(_:)` also takes "nan", "inf" and hex, which `Number` either
    /// refuses or makes non-finite.
    private static func isDecimal(_ t: String) -> Bool {
        t.range(of: #"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"#, options: .regularExpression) != nil
    }

    /// Dollars typed on a form → whole cents; nil for blank, negative or not a
    /// number. `Math.round(n * 100)` on the double, exactly as the web does, so
    /// "0.285" is 28 cents (the product is 28.499999999999996) — rounding the
    /// decimal string instead would be a cent out.
    public static func dollarsToCents(_ raw: String?) -> Int? {
        let t = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, isDecimal(t), let n = Double(t), n.isFinite, n >= 0 else { return nil }
        return JSMath.roundToInt(n * 100)
    }

    /// Cents → what the form's field shows: "389" / "389.50", "" for nil.
    public static func centsToDollars(_ cents: Int?) -> String {
        guard let cents else { return "" }
        let frac = cents % 100
        return frac == 0 ? "\(cents / 100)" : "\(cents / 100).\(frac < 10 ? "0" : "")\(frac)"
    }

    /// A spend as the roll-ups say it: "$1,234.56", "$980"; nil for nil.
    public static func fmtSpend(_ cents: Int?) -> String? {
        guard let cents else { return nil }
        let digits = String(cents / 100)
        var grouped = ""
        for (i, ch) in digits.enumerated() {
            if i > 0, (digits.count - i) % 3 == 0 { grouped.append(",") }
            grouped.append(ch)
        }
        let frac = cents % 100
        return frac == 0 ? "$\(grouped)" : "$\(grouped).\(frac < 10 ? "0" : "")\(frac)"
    }
}
