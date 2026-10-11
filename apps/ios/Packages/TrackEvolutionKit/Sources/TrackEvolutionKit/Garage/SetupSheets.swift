import Foundation

/// The setup-sheet half of `public/js/garage.js` (NS-40) — `SETUP_FIELDS` …
/// `diffSetups` and `previousSheet` — under the JS names, pinned by
/// `contracts/logic/setups.json` (`SetupsTests`), the same fixture Android's
/// `:core` asserts against.
///
/// A sheet is stored in psi and gallons and shown in the driver's system:
/// ``setupToDisplay(_:_:_:)`` on the way out, ``setupToStored(_:_:_:)`` on the
/// way back, and ``diffSetups(_:_:)`` always on stored values. The JS indexes a
/// plain object by flat key ("tp_cold.fl"); the typed ``SetupSheet`` needs
/// ``sheetValue(_:_:)`` / ``withSheetValue(_:_:_:)`` to do the same — those two,
/// ``flatKeys(_:)`` and ``isEmptySheet(_:)`` are port-only, for the form.
public extension Garage {
    /// A field's layout: four corners, two axles, or one number.
    enum SetupShape: String, Hashable, Sendable {
        case corners, axle, number
    }

    /// A field's metric alternative: `perUnit` stored units per displayed unit
    /// (psi per bar, gallons per litre), with the display step and precision.
    struct SetupMetric: Hashable, Sendable {
        public let unit: String
        public let perUnit: Double
        public let step: Double
        public let dp: Int
    }

    /// One row of the setup form — an entry of `SETUP_FIELDS`.
    struct SetupField: Hashable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let unit: String
        public let shape: SetupShape
        public let step: Double
        public let metric: SetupMetric?

        public var id: String { key }
    }

    private static let BAR = SetupMetric(unit: "bar", perUnit: Units.PSI_PER_BAR, step: 0.05, dp: 2)
    private static let LITRES = SetupMetric(unit: "L", perUnit: 1 / Units.L_PER_GAL, step: 1, dp: 1)

    /// The sheet's fields, in the order the form, the summary and the diff use.
    static let SETUP_FIELDS: [SetupField] = [
        SetupField(key: "tp_cold", label: "Tire pressure — cold", unit: "psi", shape: .corners, step: 0.5, metric: BAR),
        SetupField(key: "tp_hot", label: "Tire pressure — hot", unit: "psi", shape: .corners, step: 0.5, metric: BAR),
        SetupField(key: "camber", label: "Camber", unit: "°", shape: .axle, step: 0.1, metric: nil),
        SetupField(key: "toe", label: "Toe", unit: "", shape: .axle, step: 0.01, metric: nil),
        SetupField(key: "caster", label: "Caster", unit: "°", shape: .axle, step: 0.1, metric: nil),
        SetupField(key: "rebound", label: "Rebound", unit: "clk", shape: .axle, step: 1, metric: nil),
        SetupField(key: "compression", label: "Compression", unit: "clk", shape: .axle, step: 1, metric: nil),
        SetupField(key: "sway", label: "Sway bar", unit: "pos", shape: .axle, step: 1, metric: nil),
        SetupField(key: "fuel", label: "Fuel", unit: "gal", shape: .number, step: 0.5, metric: LITRES),
    ]

    static let CORNER_KEYS: [(key: String, label: String)] = [("fl", "FL"), ("fr", "FR"), ("rl", "RL"), ("rr", "RR")]
    static let AXLE_KEYS: [(key: String, label: String)] = [("f", "F"), ("r", "R")]

    /// A part reference a sheet can carry: which consumable was on the car.
    struct PartRef: Hashable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let kind: PartKind

        public var id: String { key }
    }

    static let PART_REFS: [PartRef] = [
        PartRef(key: "tires_id", label: "Tires", kind: .tires),
        PartRef(key: "tires_f_id", label: "Front tires", kind: .tiresFront),
        PartRef(key: "tires_r_id", label: "Rear tires", kind: .tiresRear),
        PartRef(key: "pads_f_id", label: "Front pads", kind: .padsFront),
        PartRef(key: "pads_r_id", label: "Rear pads", kind: .padsRear),
    ]

    private static func metricSpec(_ f: SetupField, _ units: UnitSystem) -> SetupMetric? {
        Units.isMetric(units) ? f.metric : nil
    }

    /// `Math.round(v * 10 ** dp) / 10 ** dp`.
    private static func roundTo(_ v: Double, _ dp: Int) -> Double { JSMath.round(v, pow(10, Double(dp))) }

    /// The unit label for a field in the driver's system.
    static func setupUnit(_ f: SetupField, _ units: UnitSystem) -> String { metricSpec(f, units)?.unit ?? f.unit }

    /// The input step for a field in the driver's system.
    static func setupStep(_ f: SetupField, _ units: UnitSystem) -> Double { metricSpec(f, units)?.step ?? f.step }

    /// Stored → displayed, rounded to the display unit's precision.
    static func setupToDisplay(_ f: SetupField, _ v: Double?, _ units: UnitSystem) -> Double? {
        guard let v else { return nil }
        guard let m = metricSpec(f, units) else { return v }
        return roundTo(v / m.perUnit, m.dp)
    }

    /// Displayed → stored, to two decimals — what `sanitizeSetup` keeps.
    static func setupToStored(_ f: SetupField, _ v: Double?, _ units: UnitSystem) -> Double? {
        guard let v else { return nil }
        guard let m = metricSpec(f, units) else { return v }
        return roundTo(v * m.perUnit, 2)
    }

    /// The field a flat key ("tp_cold.fl") belongs to, or nil (a part ref, notes).
    static func setupFieldFor(_ flatKey: String) -> SetupField? {
        let root = flatKey.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? flatKey
        return SETUP_FIELDS.first { $0.key == root }
    }

    private static func split(_ flatKey: String) -> (root: String, sub: String) {
        let parts = flatKey.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        return (parts.first ?? flatKey, parts.count > 1 ? parts[1] : "")
    }

    private static func subKeys(_ shape: SetupShape) -> [String] {
        (shape == .corners ? CORNER_KEYS : AXLE_KEYS).map(\.key)
    }

    /// A part reference's id by its key — `sheet[key]` in the JS.
    static func partRefValue(_ sheet: SetupSheet, _ key: String) -> Int? {
        switch key {
        case "tires_id": sheet.tiresId
        case "tires_f_id": sheet.tiresFId
        case "tires_r_id": sheet.tiresRId
        case "pads_f_id": sheet.padsFId
        case "pads_r_id": sheet.padsRId
        default: nil
        }
    }

    private static func corners(_ sheet: SetupSheet, _ key: String) -> CornerValues?? {
        switch key {
        case "tp_cold": .some(sheet.tpCold)
        case "tp_hot": .some(sheet.tpHot)
        default: nil
        }
    }

    private static func axles(_ sheet: SetupSheet, _ key: String) -> AxleValues?? {
        switch key {
        case "camber": .some(sheet.camber)
        case "toe": .some(sheet.toe)
        case "caster": .some(sheet.caster)
        case "rebound": .some(sheet.rebound)
        case "compression": .some(sheet.compression)
        case "sway": .some(sheet.sway)
        default: nil
        }
    }

    /// The value at a flat key ("tp_cold.fl", "fuel", "tires_id"), or nil.
    static func sheetValue(_ sheet: SetupSheet?, _ flatKey: String) -> Double? {
        guard let sheet else { return nil }
        let (root, sub) = split(flatKey)
        if root == "fuel" { return sheet.fuel }
        if let id = partRefValue(sheet, root) { return Double(id) }
        guard !sub.isEmpty else { return nil }
        if let group = corners(sheet, root) { return group?[sub] }
        if let group = axles(sheet, root) { return group?[sub] }
        return nil
    }

    /// The sheet with one flat key set (nil clears it). A group left with no
    /// value is dropped, as `sanitizeSetup` drops it.
    static func withSheetValue(_ sheet: SetupSheet, _ flatKey: String, _ value: Double?) -> SetupSheet {
        let (root, sub) = split(flatKey)
        var out = sheet
        let id = value.map { Int($0) }
        func corner(_ cur: CornerValues?) -> CornerValues? {
            var next = cur ?? CornerValues()
            next[sub] = value
            return next == CornerValues() ? nil : next
        }
        func axle(_ cur: AxleValues?) -> AxleValues? {
            var next = cur ?? AxleValues()
            next[sub] = value
            return next == AxleValues() ? nil : next
        }
        switch root {
        case "tp_cold": out.tpCold = corner(sheet.tpCold)
        case "tp_hot": out.tpHot = corner(sheet.tpHot)
        case "camber": out.camber = axle(sheet.camber)
        case "toe": out.toe = axle(sheet.toe)
        case "caster": out.caster = axle(sheet.caster)
        case "rebound": out.rebound = axle(sheet.rebound)
        case "compression": out.compression = axle(sheet.compression)
        case "sway": out.sway = axle(sheet.sway)
        case "fuel": out.fuel = value
        case "tires_id": out.tiresId = id
        case "tires_f_id": out.tiresFId = id
        case "tires_r_id": out.tiresRId = id
        case "pads_f_id": out.padsFId = id
        case "pads_r_id": out.padsRId = id
        default: break
        }
        return out
    }

    /// Every flat key a field has: "tp_cold.fl" … or just "fuel".
    static func flatKeys(_ f: SetupField) -> [String] {
        f.shape == .number ? [f.key] : subKeys(f.shape).map { "\(f.key).\($0)" }
    }

    /// True when a sheet records nothing at all — the server refuses to store one.
    static func isEmptySheet(_ sheet: SetupSheet) -> Bool {
        flattenSetup(sheet).isEmpty && (sheet.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A sheet flattened to "field.sub" → value, numbers then part refs, in spec
    /// order (notes left out). Part refs are their ids, as doubles.
    static func flattenSetup(_ sheet: SetupSheet?) -> [(key: String, value: Double)] {
        guard let sheet else { return [] }
        var out: [(key: String, value: Double)] = []
        for f in SETUP_FIELDS {
            for key in flatKeys(f) {
                if let v = sheetValue(sheet, key) { out.append((key, v)) }
            }
        }
        for ref in PART_REFS {
            if let id = partRefValue(sheet, ref.key) { out.append((ref.key, Double(id))) }
        }
        return out
    }

    /// Human label for a flat key: "tp_cold.fl" → "Tire pressure — cold FL".
    static func flatLabel(_ key: String) -> String {
        let (root, sub) = split(key)
        if let ref = PART_REFS.first(where: { $0.key == root }) { return ref.label }
        guard let f = SETUP_FIELDS.first(where: { $0.key == root }) else { return key }
        let subLabel = sub.isEmpty
            ? ""
            : (f.shape == .corners ? CORNER_KEYS : AXLE_KEYS).first { $0.key == sub }?.label ?? sub
        return subLabel.isEmpty ? f.label : "\(f.label) \(subLabel)"
    }

    /// Unit for a flat key ("psi" / "bar"); "" for part refs and unitless fields.
    static func flatUnit(_ key: String, _ units: UnitSystem) -> String {
        setupFieldFor(key).map { setupUnit($0, units) } ?? ""
    }

    /// A flat key's stored value as the driver reads it: "31 psi" / "2.14 bar",
    /// "-3.2°", unitless bare, "—" for none. Part refs come back as the bare id.
    static func fmtSetupValue(_ key: String, _ v: Double?, _ units: UnitSystem) -> String {
        guard let v else { return "—" }
        guard let f = setupFieldFor(key) else { return Units.jsNumber(v) }
        let unit = setupUnit(f, units)
        let shown = Units.jsNumber(setupToDisplay(f, v, units) ?? v)
        // "31 psi" but "-3.2°" — the degree sign attaches to its number.
        return unit.isEmpty ? shown : "\(shown)\(unit == "°" ? "" : " ")\(unit)"
    }

    /// One changed value between two sheets.
    struct SetupChange: Hashable, Sendable {
        public let key: String
        public let from: Double?
        public let to: Double?

        public init(key: String, from: Double?, to: Double?) {
            self.key = key
            self.from = from
            self.to = to
        }
    }

    /// What changed between two sheets, in spec order; a nil `prev` makes
    /// everything new.
    static func diffSetups(_ prev: SetupSheet?, _ cur: SetupSheet?) -> [SetupChange] {
        let beforeList = flattenSetup(prev)
        let afterList = flattenSetup(cur)
        let before = Dictionary(beforeList.map { ($0.key, $0.value) }, uniquingKeysWith: { a, _ in a })
        let after = Dictionary(afterList.map { ($0.key, $0.value) }, uniquingKeysWith: { a, _ in a })
        var keys: [String] = []
        for k in beforeList.map(\.key) + afterList.map(\.key) where !keys.contains(k) { keys.append(k) }
        return keys.filter { before[$0] != after[$0] }.map { SetupChange(key: $0, from: before[$0], to: after[$0]) }
    }

    /// `previousSheet`: the latest sheet on an earlier day of the same event, or
    /// nil. The changed-value marks diff against it, and offline it stands in
    /// for the server's prefill.
    static func previousSheet(_ setups: [Setup]?, _ day: Int) -> SetupSheet? {
        (setups ?? []).filter { $0.day < day }.max { $0.day < $1.day }?.data
    }
}

extension CornerValues {
    /// A corner by its sheet key ("fl" … "rr").
    public subscript(key: String) -> Double? {
        get {
            switch key {
            case "fl": fl
            case "fr": fr
            case "rl": rl
            case "rr": rr
            default: nil
            }
        }
        set {
            switch key {
            case "fl": fl = newValue
            case "fr": fr = newValue
            case "rl": rl = newValue
            case "rr": rr = newValue
            default: break
            }
        }
    }
}

extension AxleValues {
    /// An axle by its sheet key ("f" / "r").
    public subscript(key: String) -> Double? {
        get {
            switch key {
            case "f": f
            case "r": r
            default: nil
            }
        }
        set {
            switch key {
            case "f": f = newValue
            case "r": r = newValue
            default: break
            }
        }
    }
}
