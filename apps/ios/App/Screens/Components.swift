import SwiftUI
import TrackEvolutionKit

/// The pieces every logbook screen is built from. The web app's `.tile`, `.card`,
/// `h2`, `.empty` and `.error-banner` have native counterparts here so a screen
/// reads as layout rather than as styling.

/// What a screen's data is doing. Every screen model exposes one of these, so the
/// cases are handled once rather than reinvented per screen — and "failed"
/// always carries the server's own message.
///
/// `paywall` is the 402 (NS-32 rule 5): a Pro-gated *read* has to look like an
/// offer, not like a server error, so it is its own case rather than a `failed`
/// carrying "pro required" — the same reason `APIError.proRequired` is distinct
/// from the rest.
enum LoadState: Equatable {
    case loading
    case ready
    case failed(String)
    case paywall
}

/// A page of cards on the app background.
struct TEPage<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TESpacing.gridGap) {
                content
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.bgPage))
    }
}

/// The loading/failed/ready switch, with a retry that re-runs the screen's load.
struct TELoadable<Content: View>: View {
    let state: LoadState
    let retry: () async -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        switch state {
        case .loading:
            ZStack {
                Color(.bgPage).ignoresSafeArea()
                ProgressView()
            }
        case .failed(let message):
            TEPage {
                TECard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Couldn't load this")
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Text(message)
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                        Button("Try again") { Task { await retry() } }
                            .buttonStyle(TEButtonStyle(kind: .quiet))
                    }
                }
            }
        case .paywall:
            TEPage {
                ProUpsellCard(
                    title: "Garage wear tracking is Pro",
                    blurb: """
                        Pads, tires, rotors and fluid, each with the hours it has actually done — \
                        accrued from your own track days — and what's left of them before the next \
                        event. Your cars themselves stay free.
                        """
                )
            }
        case .ready:
            content()
        }
    }
}

/// The paywall as a page element: what the feature is, and one button to the
/// sheet. The sheet hangs off the *button*, never off the screen — a second
/// `.sheet` on a view that already presents one is the SwiftUI hazard documented
/// on `VehicleScreen`.
struct ProUpsellCard: View {
    let title: String
    let blurb: String
    var context: PaywallSheet.Context = .general

    @State private var showingPaywall = false

    var body: some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                Text(blurb)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                Button("See Track Evolution Pro") { showingPaywall = true }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                    .accessibilityIdentifier("proUpsell")
                    .sheet(isPresented: $showingPaywall) {
                        PaywallSheet(context: context)
                    }
            }
        }
    }
}

/// One headline number — the web app's `.tile`.
struct TEStatTile: View {
    let label: String
    let value: String
    /// Lap times get tabular figures; counts don't need them.
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .teStyle(.eyebrow)
                .foregroundStyle(Color(.textFaint))
            Text(value)
                .teStyle(monospaced ? .lapTime : .h2)
                .foregroundStyle(Color(.textStrong))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.md))
    }
}

/// A row of tiles that reflows to fewer columns at large text sizes rather than
/// squeezing four of them across a phone.
///
/// Deliberately **not** a `LazyVGrid`: three or four tiles never need laziness, and
/// lazy rows below the fold don't exist yet — which makes them invisible to
/// VoiceOver's element order and to any test that looks for them without scrolling
/// first. Laziness bought nothing and cost that.
struct TEStatRow: View {
    let tiles: [TEStatTile]
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 10) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, tile in tile }
                    // Keeps a short last row's tiles the same width as a full one's.
                    if row.count < columns {
                        ForEach(0..<(columns - row.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
    }

    /// One column once the text is big enough that even two across would truncate.
    private var columns: Int {
        typeSize >= .accessibility1 ? 1 : (tiles.count > 3 ? 2 : max(1, tiles.count))
    }

    private var rows: [[TEStatTile]] {
        stride(from: 0, to: tiles.count, by: columns).map {
            Array(tiles[$0..<min($0 + columns, tiles.count)])
        }
    }
}

/// A section heading — the web app's `h2`.
struct TESectionHeader: View {
    let title: String
    /// The quiet count or hint that sits beside it.
    var detail: String?

    init(_ title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .teStyle(.h2)
                .foregroundStyle(Color(.textStrong))
            if let detail {
                Text(detail)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            Spacer()
        }
        .padding(.top, 8)
    }
}

/// Nothing here yet, said without alarm.
struct TEEmpty: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .teStyle(.sm)
            .foregroundStyle(Color(.textMuted))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 18)
            .padding(.horizontal, 16)
            .background(Color(.bgSubtle), in: .rect(cornerRadius: TERadius.md))
    }
}

/// A failed write, in the server's own words — the `.error-banner`.
struct TEErrorBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
            Text(message)
        }
        .teStyle(.sm)
        .foregroundStyle(Color(.dangerInk))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.dangerTint), in: .rect(cornerRadius: TERadius.sm))
    }
}

/// A labelled text field, matching the web form's `.field`.
struct TEField<Content: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .teStyle(.eyebrow)
                .foregroundStyle(Color(.textMuted))
            content()
            if let hint {
                Text(hint)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
        }
    }
}

/// The app's text-field skin, so inputs match the design tokens instead of the
/// system's grey rounded border.
struct TEInputStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .teStyle(.body)
            .foregroundStyle(Color(.textStrong))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.surfaceInput), in: .rect(cornerRadius: TERadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: TERadius.sm)
                    .strokeBorder(Color(.borderHairline), lineWidth: 1)
            )
    }
}

extension View {
    func teInput() -> some View {
        modifier(TEInputStyle())
    }
}

/// A tappable card that pushes a route — the web app's `<a class="card">`.
struct TENavCard<Content: View>: View {
    let route: Route
    /// A stable handle for UI tests. Card *titles* are user data — a seeded track
    /// name today, a renamed one tomorrow — so tests navigate by this instead.
    var identifier: String?
    @ViewBuilder let content: () -> Content
    @Environment(AppRouter.self) private var router

    var body: some View {
        Button {
            router.push(route)
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) { content() }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.surfaceCard), in: .rect(cornerRadius: TERadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: TERadius.md)
                    .strokeBorder(Color(.borderHairline), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier ?? "")
    }
}

/// A lap time, or any other value that belongs in a monospaced column.
struct TETime: View {
    let ms: Int?
    var emphasized = false

    var body: some View {
        Text(LapTime.fmtMs(ms))
            .teStyle(.lapTime)
            .foregroundStyle(emphasized ? Color(.accentInk) : Color(.textStrong))
    }
}

/// The quiet metadata line under a title — "3 events · 5 days · Jul 30, 2026".
struct TEMeta: View {
    let parts: [String]

    init(_ parts: [String?]) {
        self.parts = parts.compactMap { $0 }.filter { !$0.isEmpty }
    }

    var body: some View {
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
        }
    }
}

/// Conditions, in the web app's wording (`CONDITIONS` in `public/app.js`).
extension Conditions {
    var label: String {
        switch self {
        case .dry: "Dry"
        case .damp: "Damp"
        case .wet: "Wet"
        case .mixed: "Mixed"
        // A value a newer server added: show it rather than swallowing it.
        default: rawValue.capitalized
        }
    }
}

/// "2 days" / "1.5 days" — the column is fractional, so this trims a trailing
/// `.0` rather than rounding a half day away.
func fmtDays(_ days: Double) -> String {
    let count = days == days.rounded() ? String(Int(days)) : String(format: "%.1f", days)
    return "\(count) day\(days == 1 ? "" : "s")"
}

/// "3 events" / "1 event".
func fmtCount(_ n: Int, _ noun: String) -> String {
    "\(n) \(noun)\(n == 1 ? "" : "s")"
}
