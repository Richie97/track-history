import Foundation

/// One generation of the seeded car catalog (`GET /api/car-catalog`, #221):
/// the make / model / generation a driver picks a car by, the two spec-sheet
/// numbers a pick pre-fills on the vehicle (`Vehicle.wheelbaseMm`,
/// `Vehicle.steeringRatio`), and where both came from.
///
/// `steeringRatio` is nil where no single reliable figure exists — a
/// variable-ratio rack the maker only quotes as a range, or a generation
/// nobody has curated yet — and never a guess; `source` says which. The whole
/// catalog is small enough to ship in one response, which is what lets the
/// picker (#222) work offline from the response cache.
public struct CatalogCar: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var make: String
    public var model: String
    /// The user-facing disambiguator ("C7", "ND", "981"); nil when a model has
    /// only ever had one.
    public var generation: String?
    public var yearFrom: Int
    /// nil while still in production.
    public var yearTo: Int?
    public var wheelbaseMm: Int
    public var steeringRatio: Double?
    public var source: String

    public enum CodingKeys: String, CodingKey {
        case id, make, model, generation, source
        case yearFrom = "year_from"
        case yearTo = "year_to"
        case wheelbaseMm = "wheelbase_mm"
        case steeringRatio = "steering_ratio"
    }

    /// "Chevrolet Corvette C7" — how a picker row reads.
    public var displayName: String {
        [make, model, generation].compactMap { $0 }.joined(separator: " ")
    }

    /// "2014–2019" or "2020–" — the years beside a row.
    public var yearRange: String {
        yearTo.map { "\(yearFrom)–\($0)" } ?? "\(yearFrom)–"
    }
}
