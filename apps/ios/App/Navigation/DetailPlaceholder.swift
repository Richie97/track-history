import SwiftUI
import TrackEvolutionKit

/// What the detail pane says when nothing is selected (spec: NS-34).
///
/// It names the **next upcoming event** and offers it, rather than sitting there
/// as an empty half of the screen or — the thing the spec rules out by name —
/// showing the dashboard a second time. On a track-day morning the one thing you
/// want from this pane is already known, so it may as well be one tap away.
///
/// With nothing upcoming it says "Pick an event" and stops. That is deliberately
/// not a call to action: the dashboard beside it already offers *Add event*, and
/// a second button competing with it would be two answers to the same question.
struct DetailPlaceholder: View {
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var next: Event?
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 14) {
            BrandMark()
                .frame(width: 44, height: 44)
                .opacity(0.5)

            if let next {
                Text("Next up")
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textFaint))
                Text(next.trackName)
                    .teStyle(.h2)
                    .foregroundStyle(Color(.textStrong))
                    .multilineTextAlignment(.center)
                if let countdown = EventDates.fmtCountdown(next.startDate) {
                    Text(countdown)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.accentInk))
                }
                // No `.fixedSize()`: `TEButtonStyle` already sets a width on its
                // label, and pairing the two is the hazard documented on
                // `VehicleScreen` — it takes the app down with a watchdog
                // "lost connection" rather than a stack trace.
                Button("Open this event") { router.open(.event(next.id)) }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
            } else {
                Text("Pick an event")
                    .teStyle(.h2)
                    .foregroundStyle(Color(.textStrong))
                Text(loaded ? "Nothing coming up — choose a track day from the list." : "")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                    .multilineTextAlignment(.center)
            }
        }
        .padding(TESpacing.cardPadding)
        .frame(maxWidth: 380)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.bgPage))
        .accessibilityIdentifier("detailPlaceholder")
        // The dashboard beside this has already fetched — and warmed — the same
        // list, so through the offline layer this is normally a cache read rather
        // than a request. A failure is swallowed on purpose: an empty pane that
        // says "Pick an event" is a fine outcome, and an error here would be about
        // the one thing on screen that nobody asked for.
        .task {
            guard !loaded else { return }
            next = try? await auth.api.events()
                .filter { EventDates.isUpcoming($0.startDate) }
                .min { $0.startDate < $1.startDate }
            loaded = true
        }
    }
}
