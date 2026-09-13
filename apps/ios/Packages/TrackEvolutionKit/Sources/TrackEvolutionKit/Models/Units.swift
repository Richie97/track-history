import Foundation

/// The unit system — imperial or metric — as pure conversions.
///
/// A port of `public/js/units.js` under the same function and constant names, so
/// the two diff by eye, with that file's test cases carried over (`UnitsTests`).
/// The preference lives on the account (`User.units`, set by `PUT /api/me/units`)
/// and **nothing stored changes with it**: lap times are milliseconds, an event's
/// temperature whole °F (`Event.tempF`), channel speeds km/h, and a wear
/// measurement carries whatever unit it was logged in. Everything here converts
/// at the edges — display, and form input on the way back — so the server and
/// the offline mirror never see a converted value.
///
/// The JS module's cached choice (`currentUnits` / `cacheUnits`) has no
/// counterpart: on iOS the account is `AuthController.me`, and its system reaches
/// every view as `User.effectiveUnits` through one environment value, so there is
/// a single source and nothing to clear on sign-out.
///
/// Two functions here are `public/js/garage.js`'s rather than `units.js`'s —
/// `wearLimitHint` and `defaultMeasurementUnit` — kept beside the conversions
/// because they are the only garage helpers that read the preference, and
/// `PartKind.wearLimitHint` stays the imperial `WEAR_LIMIT_HINTS` table that
/// `contracts/logic/garage-status.json` pins.
public enum Units {
    /// One of the two systems as the Settings picker offers it: its id, its
    /// label, and the one-line summary of what changes.
    public struct System: Hashable, Sendable {
        public let id: UnitSystem
        public let label: String
        public let detail: String
    }

    /// `UNIT_SYSTEMS` — in the order the picker offers them.
    public static let UNIT_SYSTEMS: [System] = [
        System(id: .imperial, label: "Imperial", detail: "mph · °F · psi · gal"),
        System(id: .metric, label: "Metric", detail: "km/h · °C · bar · L"),
    ]

    /// What an account that never chose sees — the app always showed imperial, so
    /// the default keeps every existing logbook reading the way it did. Mirrors
    /// `DEFAULT_UNITS` in `src/lib/validate.ts`.
    public static let DEFAULT_UNITS: UnitSystem = .imperial

    public static func isMetric(_ units: UnitSystem) -> Bool { units == .metric }

    // MARK: - Speed (stored km/h)

    public static let KPH_TO_MPH = 0.621371
    /// m/s → mph, for the live recorder's read-out. 3.6 × `KPH_TO_MPH`, spelled
    /// out so the two speed paths can't disagree at a rounding boundary.
    public static let MPS_TO_MPH = 3.6 * KPH_TO_MPH

    public static func speedUnit(_ units: UnitSystem) -> String {
        isMetric(units) ? "km/h" : "mph"
    }

    public static func convSpeedKph(_ kph: Double, _ units: UnitSystem) -> Double {
        isMetric(units) ? kph : kph * KPH_TO_MPH
    }

    public static func convSpeedMps(_ mps: Double, _ units: UnitSystem) -> Double {
        isMetric(units) ? mps * 3.6 : mps * MPS_TO_MPH
    }

    /// "121 mph" / "195 km/h".
    public static func fmtSpeedKph(_ kph: Double, _ units: UnitSystem, dp: Int = 0) -> String {
        "\(toFixed(convSpeedKph(kph, units), dp)) \(speedUnit(units))"
    }

    // MARK: - Distance (stored metres)

    public static let M_PER_MI = 1609.344
    public static let FT_PER_M = 3.28084

    /// Axis-tick / read-out style: "940 m" / "2.4 km", or "800 ft" / "0.75 mi".
    /// Feet give way to miles at a quarter mile — below that a distance reads
    /// better in feet, above it in the number a driver already knows a track by.
    /// Zero is "0 mi" so an imperial axis doesn't open in a different unit than it
    /// continues in.
    public static func fmtDist(_ m: Double, _ units: UnitSystem) -> String {
        if !isMetric(units) {
            let mi = m / M_PER_MI
            if m == 0 || mi >= 0.25 { return "\(trimmed(toFixed(mi, 2))) mi" }
            return "\(jsInt(m * FT_PER_M)) ft"
        }
        if m >= 1000 {
            return "\(toFixed(m / 1000, m.truncatingRemainder(dividingBy: 1000) != 0 ? 1 : 0)) km"
        }
        return "\(jsNumber(m)) m"
    }

    /// GPS accuracy style: "±4 m" / "±13 ft".
    public static func fmtAccuracy(_ m: Double, _ units: UnitSystem) -> String {
        isMetric(units) ? "±\(jsInt(m)) m" : "±\(jsInt(m * FT_PER_M)) ft"
    }

    // MARK: - Temperature (stored whole °F)

    public static func tempUnit(_ units: UnitSystem) -> String {
        isMetric(units) ? "°C" : "°F"
    }

    /// Stored °F → the whole degrees the user reads; nil passes through.
    public static func tempToDisplay(_ f: Int?, _ units: UnitSystem) -> Int? {
        guard let f else { return nil }
        return isMetric(units) ? jsInt(Double(f - 32) * 5 / 9) : f
    }

    /// Form input in the user's system → the whole °F the server stores; nil
    /// passes through. Rounded, so a whole °C survives a save-and-edit cycle.
    public static func tempToStored(_ v: Double?, _ units: UnitSystem) -> Int? {
        guard let v else { return nil }
        return jsInt(isMetric(units) ? v * 9 / 5 + 32 : v)
    }

    /// "72°F" / "22°C"; "" for nil, like the JS.
    public static func fmtTemp(_ f: Int?, _ units: UnitSystem) -> String {
        guard let shown = tempToDisplay(f, units) else { return "" }
        return "\(shown)\(tempUnit(units))"
    }

    /// The event form's input bounds — the °F range is what `isValidTemp` in
    /// `src/lib/validate.ts` enforces; the °C one maps onto it.
    public struct TempInputSpec: Hashable, Sendable {
        public let min: Int
        public let max: Int
        public let placeholder: Int
    }

    public static func tempInputSpec(_ units: UnitSystem) -> TempInputSpec {
        isMetric(units)
            ? TempInputSpec(min: -40, max: 65, placeholder: 22)
            : TempInputSpec(min: -40, max: 150, placeholder: 72)
    }

    // MARK: - Pressure (stored psi) and fuel (stored gallons)

    /// The setup notebook these serve is web-only; the constants port so the two
    /// clients can never disagree if that changes.
    public static let PSI_PER_BAR = 14.503774
    public static let L_PER_GAL = 3.785412

    // MARK: - Garage (`public/js/garage.js`)

    /// The suggested replace-at level for a part kind, as a form placeholder. Pads
    /// and rotors are specified in millimetres on both sides of the Atlantic; only
    /// tread depth changes idiom (32nds of an inch vs. mm). nil where the JS
    /// returns "" — a kind with no hint.
    public static func wearLimitHint(_ kind: PartKind, _ units: UnitSystem) -> String? {
        isMetric(units) && kind == .tires ? "3 (mm)" : kind.wearLimitHint
    }

    /// The unit a new wear measurement is offered in. A measurement stores its own
    /// unit string, so this is only a default — a part's later measurements follow
    /// its first one.
    public static func defaultMeasurementUnit(_ kind: PartKind, _ units: UnitSystem) -> String {
        kind == .tires && !isMetric(units) ? "32nds" : "mm"
    }

    // MARK: - JavaScript number formatting

    /// `Math.round` — ties toward +infinity. Non-finite input reads as 0 rather
    /// than trapping; nothing here is handed a NaN on purpose.
    static func jsInt(_ v: Double) -> Int {
        JSMath.roundToInt(v) ?? 0
    }

    /// `Number.prototype.toFixed(dp)`: a fixed number of decimals, ties rounded up.
    static func toFixed(_ v: Double, _ dp: Int) -> String {
        let factor = pow(10.0, Double(dp))
        return String(format: "%.\(dp)f", JSMath.round(v, factor))
    }

    /// `Number(x.toFixed(2))` as a string — the trailing zeros dropped, and the
    /// point with them: "0.50" → "0.5", "1.00" → "1".
    static func trimmed(_ fixed: String) -> String {
        guard fixed.contains(".") else { return fixed }
        var s = fixed
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }

    /// `${m}` for a metre count: a whole number prints without a decimal.
    static func jsNumber(_ v: Double) -> String {
        v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
    }
}
