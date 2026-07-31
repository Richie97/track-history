import SwiftUI
import TrackEvolutionKit

/// The garage's shared pieces: how a wear estimate looks, and how a maintenance
/// reminder reads. Used by both the vehicle page and the dashboard, so the two
/// can't drift apart on what "due" means.

extension Garage.PartStatus {
    /// Text colour for the status line — `.garage-status` in the stylesheet.
    var ink: Color {
        switch self {
        case .due, .low: Color(.dangerInk)
        case .ok: Color(.positive)
        }
    }

    var label: String {
        switch self {
        case .due: "replace now"
        case .low: "due soon"
        case .ok: "in service"
        }
    }
}

/// The fraction of a part's life used up — the web app's `.wear-bar`.
///
/// Drawn only when there's a projection to draw. An empty track would read as
/// "brand new" when the truth is "nobody knows", which is the one thing a wear
/// bar must never say.
struct WearBar: View {
    let wear: WearEstimate

    var body: some View {
        if let pctUsed = wear.pctUsed {
            let fraction = min(1, max(0, pctUsed))
            let percent = Int((fraction * 100).rounded())
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.surfaceRaised))
                    fill
                        // A 2% floor, as on the web: a barely-used part should still
                        // show a sliver rather than an empty trough.
                        .frame(width: max(geometry.size.width * 0.02, geometry.size.width * fraction))
                }
            }
            .frame(height: 8)
            .overlay(Capsule().strokeBorder(Color(.borderHairline), lineWidth: 1))
            .accessibilityElement()
            .accessibilityLabel("\(percent) percent used")
        }
    }

    /// The stylesheet mixes accent with danger for `low`
    /// (`color-mix(in srgb, var(--accent) 45%, var(--danger))`). Compositing danger
    /// over accent at 55% is that mix — and unlike blending two resolved `UIColor`s
    /// it stays correct in dark mode, because each token resolves itself.
    @ViewBuilder
    private var fill: some View {
        switch Garage.partStatus(wear) ?? .ok {
        case .due:
            Capsule().fill(Color(.danger))
        case .low:
            Capsule()
                .fill(Color(.accent))
                .overlay(Capsule().fill(Color(.danger).opacity(0.55)))
        case .ok:
            Capsule().fill(Color(.accent))
        }
    }
}

/// One line of wear story for a part: usage, remaining life, and how much to
/// trust the projection. `wearStatusHtml` in `public/app.js`.
struct WearStatusLine: View {
    let part: Part

    var body: some View {
        Text(Self.text(part))
            .teStyle(.xs)
            .foregroundStyle(Color(.textMuted))
            .fixedSize(horizontal: false, vertical: true)
    }

    static func text(_ part: Part) -> String {
        let wear = part.wear
        var bits = ["\(Garage.fmtHours(wear.hours)) on part"]
        // Tyres wear by heat cycle more than by hour, so they count days; anything
        // else counts events, which is what a pad's life is spoken about in.
        if part.kind == .tires {
            bits.append("\(fmtCount(wear.cycles, "heat cycle"))")
        } else if wear.events > 0 {
            bits.append(fmtCount(wear.events, "event"))
        }
        if let remaining = Garage.fmtRemaining(wear) {
            bits.append(remaining)
            if wear.source == .measured, let perHour = wear.wearPerHour {
                let rate = JSMath.round(perHour, 100)
                bits.append("measured \(rate) \(wear.unit ?? "")/h")
            } else {
                bits.append("vs. \(Garage.fmtHours(wear.expectedHours)) expected")
            }
        } else if part.retiredOn == nil {
            bits.append("no life estimate — set expected hours or log two measurements")
        }
        return bits.joined(separator: " · ")
    }
}

/// Parts at or near the end of their life, worst first — `alertStripHtml`.
///
/// `collapsed` is the dashboard's form: a glanceable count that expands on tap,
/// because the dashboard is not a maintenance screen. The vehicle page shows the
/// chips outright, since there maintenance *is* the point of the view.
struct MaintenanceStrip: View {
    let garage: [GarageVehicle]
    var collapsed = false

    @Environment(AppRouter.self) private var router
    @State private var expanded = false

    private var alerts: [Garage.Alert] { Garage.garageAlerts(garage) }

    var body: some View {
        if !alerts.isEmpty {
            TECard(padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    if collapsed {
                        Button {
                            withAnimation(TEMotion.standard) { expanded.toggle() }
                        } label: {
                            header
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("maintenanceStrip")
                        if expanded { chips }
                    } else {
                        header
                        chips
                    }
                }
            }
        }
    }

    private var dueCount: Int { alerts.filter { $0.status == .due }.count }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "wrench.and.screwdriver")
                .foregroundStyle(Color(.textMuted))
            Text(
                collapsed
                    ? fmtCount(alerts.count, "maintenance reminder")
                    : "Maintenance due"
            )
            .teStyle(.bodyStrong)
            .foregroundStyle(dueCount > 0 ? Color(.dangerInk) : Color(.textStrong))
            Spacer()
            if collapsed {
                Image(systemName: "chevron.right")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
        }
    }

    private var chips: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(alerts) { alert in
                Button {
                    router.push(.vehicle(alert.vehicle.id))
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(alert.part.kind.label)
                            .teStyle(.sm)
                            .foregroundStyle(alert.status == .due ? Color(.dangerInk) : Color(.textStrong))
                        Text(
                            alert.status == .due
                                ? "replace now"
                                : Garage.fmtRemaining(alert.part.wear) ?? ""
                        )
                        .teStyle(.sm)
                        .foregroundStyle(alert.status == .due ? Color(.dangerInk) : Color(.textMuted))
                        Spacer(minLength: 8)
                        Text(alert.vehicle.name)
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        alert.status == .due ? Color(.dangerTint) : Color(.surfaceRaised),
                        in: .rect(cornerRadius: TERadius.xs)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: TERadius.xs)
                            .strokeBorder(
                                alert.status == .due ? Color(.danger) : Color(.borderHairline),
                                lineWidth: 1
                            )
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("maintenanceChip")
            }
        }
    }
}
