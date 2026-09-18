import SwiftUI
import TrackEvolutionKit

/// The car-catalog picker (#222): one searchable list over `GET /api/car-catalog`,
/// presented as a sheet from the two vehicle forms. One field rather than
/// year → make → model dropdowns, because a driver can type "c7" in two
/// keystrokes and a dealer-site cascade is four taps to the same row.
///
/// Ranking is the Kit's `Garage.matchCatalogCars`, pinned against the web by
/// `contracts/logic/car-catalog-match.json`, so "c7" finds the same row here as
/// it does in the browser. The catalog is a cached GET, so the search works
/// offline; it is the *save* that needs a connection, as every garage write does.
///
/// A sheet, not the event form's strip of chips: "Chevrolet Corvette · C7 ·
/// 2014–2019" seven times over does not fit in a strip, and the generation and
/// years are exactly what the driver picks by.
struct CatalogCarPicker: View {
    let api: APIClient
    let onPick: (CatalogCar) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var rows: [CatalogCar]?
    @State private var error: String?
    @State private var query = ""
    @FocusState private var searching: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Corvette C7, MX-5 ND, 718 Cayman…", text: $query)
                    .teInput()
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($searching)
                    .accessibilityIdentifier("catalogSearch")
                    .padding(.horizontal, 16)

                Text("Picking a car fills in the wheelbase and steering ratio the balance read-out uses — nothing else changes.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
                    .padding(.horizontal, 16)

                if let error {
                    TEErrorBanner(message: error)
                        .padding(.horizontal, 16)
                } else if let rows {
                    let matches = Garage.matchCatalogCars(query, rows)
                    if matches.isEmpty {
                        TEEmpty("No car in the catalog matches that — close this and type the numbers in yourself.")
                            .padding(.horizontal, 16)
                    } else {
                        List(matches) { car in
                            Button {
                                onPick(car)
                                dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Garage.catalogCarLabel(car))
                                        .teStyle(.body)
                                        .foregroundStyle(Color(.textStrong))
                                    Text(Self.geometryLine(car))
                                        .teStyle(.xs)
                                        .foregroundStyle(Color(.textMuted))
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .accessibilityLabel(Garage.catalogCarLabel(car))
                            .accessibilityIdentifier("catalogRow")
                            .listRowBackground(Color(.bgPage))
                        }
                        .listStyle(.plain)
                        .scrollDismissesKeyboard(.interactively)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 12)
            .background(Color(.bgPage))
            .navigationTitle("Find your car")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                guard rows == nil else { return }
                do {
                    rows = try await api.carCatalog()
                } catch let error as APIError {
                    self.error = error.message
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .onAppear { searching = true }
        }
    }

    /// "2710 mm · 16.25:1", or "2475 mm · no single steering ratio" for a
    /// variable-ratio rack — what a pick would fill in, so the driver sees the
    /// numbers before trusting them.
    static func geometryLine(_ car: CatalogCar) -> String {
        let ratio = car.steeringRatio.map { "\(fmtRatio($0)):1" } ?? "no single steering ratio"
        return "\(car.wheelbaseMm) mm · \(ratio)"
    }

    /// 16.0 reads as "16"; 16.25 stays "16.25" — what a driver would have typed.
    static func fmtRatio(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
    }
}
