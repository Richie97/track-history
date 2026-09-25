import SwiftUI
import TrackEvolutionKit

/// Season Wrapped (NS-36): the season handed back as a story of full-screen
/// cards, over `GET /api/wrapped/:year`.
///
/// The port of `viewWrapped` in `public/app.js` and `public/js/wrapped-story.js`.
/// The numbers are the server's and the card rules are the Kit's
/// `WrappedStory` — pinned to the web by `contracts/logic/wrapped.json` — so what
/// lives here is only the layout, the navigation and the share image.
///
/// Presented over the **whole window** at every width (`Route.ownsTheWindow`):
/// a story is a thing you are doing instead of reading the logbook, and half of
/// an iPad is a worse version of it rather than a bigger one. The cover's Back
/// button is the way out.
struct WrappedScreen: View {
    let year: Int

    @Environment(AuthController.self) private var auth
    @State private var model: WrappedModel?

    var body: some View {
        Group {
            if let model {
                switch model.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    TEPage {
                        TEErrorBanner(message: message)
                        Button("Try again") { Task { await model.load(model.year) } }
                            .buttonStyle(TEButtonStyle(kind: .quiet))
                    }
                case .empty:
                    TEPage {
                        Text("No track days in \(String(model.year)) — yet")
                            .teStyle(.h1)
                            .foregroundStyle(Color(.textStrong))
                        Text("Wrapped tells the story of a season once there's a track day in it.")
                            .teStyle(.body)
                            .foregroundStyle(Color(.textMuted))
                    }
                case .ready(let data):
                    WrappedStoryView(
                        data: data,
                        shareURL: shareURL(year: data.year),
                        onYear: { y in Task { await model.load(y) } }
                    )
                    // A new year is a new story, from its cover.
                    .id(data.year)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(WrappedBackground().ignoresSafeArea())
        .navigationTitle("\(String(model?.year ?? year)) Wrapped")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = WrappedModel(api: auth.api, year: year)
                self.model = model
                await model.load(year)
            }
        }
    }

    /// The season's public page, when the account has a share link — the web's
    /// Copy link. Without one there is nothing public to point at.
    private func shareURL(year: Int) -> URL? {
        guard let slug = auth.me?.user.shareSlug, !slug.isEmpty else { return nil }
        return URL(string: "\(auth.server.url.absoluteString)/share/\(slug)/wrapped/\(year)")
    }
}

/// The page behind the story: the page colour with the accent's glow in the top
/// corner — the web's `.wrapped` background.
struct WrappedBackground: View {
    var body: some View {
        ZStack {
            Color(.bgPage)
            RadialGradient(
                colors: [Color(.accentTint), .clear],
                center: UnitPoint(x: 0.85, y: 0),
                startRadius: 0,
                endRadius: 520
            )
        }
    }
}

// MARK: - The model

@MainActor
@Observable
final class WrappedModel {
    enum Phase {
        case loading
        case ready(Wrapped)
        /// A 404: the year has no track days. A page, not an error.
        case empty
        case failed(String)
    }

    private let api: APIClient
    private(set) var year: Int
    private(set) var phase: Phase = .loading

    init(api: APIClient, year: Int) {
        self.api = api
        self.year = year
    }

    func load(_ year: Int) async {
        self.year = year
        phase = .loading
        do {
            phase = .ready(try await api.wrapped(year: year))
        } catch let error as APIError where error.status == 404 {
            phase = .empty
        } catch let error as APIError {
            phase = .failed(error.message)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

// MARK: - The story

/// One card at a time, in `WrappedStory.wrappedCards`' order. Navigation is a
/// tap on the left or right third, a horizontal swipe, the arrow buttons (with
/// ← and → on an iPad keyboard) or the progress bar's segments, which are
/// buttons. VoiceOver reads the card in view and adjusts to the next or
/// previous one; Reduce Motion turns the slide into a cut.
struct WrappedStoryView: View {
    let data: Wrapped
    let shareURL: URL?
    var onYear: (Int) -> Void = { _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var index = 0
    @State private var forward = true

    private var cards: [WrappedStory.Card] { WrappedStory.wrappedCards(data) }

    var body: some View {
        let cards = self.cards
        VStack(spacing: 10) {
            progress(cards)
            GeometryReader { geo in
                ZStack {
                    WrappedCardView(card: cards[index], data: data, shareURL: shareURL, onYear: onYear)
                        .id(index)
                        .transition(transition)
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .contentShape(Rectangle())
                // The thirds, like the web: the middle does nothing, so reading a
                // card never turns it. Buttons on a card keep their own taps.
                .onTapGesture { location in
                    if location.x < geo.size.width / 3 { go(index - 1) }
                    else if location.x > geo.size.width * 2 / 3 { go(index + 1) }
                }
                .gesture(
                    DragGesture(minimumDistance: 30).onEnded { value in
                        let dx = value.translation.width
                        guard abs(dx) > 40, abs(dx) > abs(value.translation.height) * 1.5 else { return }
                        go(index + (dx < 0 ? 1 : -1))
                    }
                )
                .accessibilityElement(children: .contain)
                .accessibilityLabel("\(index + 1) of \(cards.count): \(WrappedStory.CARD_TITLES[cards[index].kind] ?? "")")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: go(index + 1)
                    case .decrement: go(index - 1)
                    @unknown default: break
                    }
                }
            }
            HStack {
                stepButton("Previous card", systemImage: "arrow.left", enabled: index > 0, key: .leftArrow) { go(index - 1) }
                Spacer()
                stepButton("Next card", systemImage: "arrow.right", enabled: index < cards.count - 1, key: .rightArrow) { go(index + 1) }
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
    }

    private var transition: AnyTransition {
        if reduceMotion { return .identity }
        return .asymmetric(
            insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
            removal: .opacity
        )
    }

    private func go(_ i: Int) {
        let next = max(0, min(cards.count - 1, i))
        guard next != index else { return }
        forward = next > index
        if reduceMotion {
            index = next
        } else {
            withAnimation(.easeOut(duration: 0.28)) { index = next }
        }
        let title = WrappedStory.CARD_TITLES[cards[next].kind] ?? ""
        UIAccessibility.post(notification: .screenChanged, argument: "\(next + 1) of \(cards.count): \(title)")
    }

    private func progress(_ cards: [WrappedStory.Card]) -> some View {
        HStack(spacing: 4) {
            ForEach(Array(cards.enumerated()), id: \.offset) { i, card in
                Button { go(i) } label: {
                    Capsule()
                        .fill(i <= index ? Color(.accent) : Color(.borderStrong))
                        .frame(height: 4)
                        .frame(maxWidth: .infinity)
                        // The 4pt bar is the look; the hit area is taller.
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Card \(i + 1): \(WrappedStory.CARD_TITLES[card.kind] ?? "")")
                .accessibilityAddTraits(i == index ? .isSelected : [])
            }
        }
    }

    private func stepButton(
        _ label: String, systemImage: String, enabled: Bool, key: KeyEquivalent, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color(.textStrong))
                .frame(width: 44, height: 44)
                .background(Color(.surfaceCard), in: .circle)
                .overlay(Circle().strokeBorder(Color(.borderHairline), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .keyboardShortcut(key, modifiers: [])
        .accessibilityLabel(label)
    }
}

// MARK: - The cards

/// One card's words — `cardBody` in `wrapped-story.js`, case for case.
struct WrappedCardView: View {
    let card: WrappedStory.Card
    let data: Wrapped
    let shareURL: URL?
    var onYear: (Int) -> Void = { _ in }

    @Environment(\.unitSystem) private var units

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 24)
            .frame(minHeight: 0)
        }
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(.center)
    }

    @ViewBuilder
    private var content: some View {
        let t = data.totals
        switch card.kind {
        case .cover:
            kicker("Track Evolution · Wrapped")
            huge("Your \(String(data.year))", accent: false)
            lede("Your season on track, handed back to you.")
            if let through = data.through {
                foot("So far — through \(Self.day(through)).")
            }
            if data.years.count > 1 {
                HStack(spacing: 8) {
                    ForEach(data.years, id: \.self) { y in
                        Button(String(y)) { onYear(y) }
                            .buttonStyle(YearChipStyle(selected: y == data.year))
                            .disabled(y == data.year)
                    }
                }
                .padding(.top, 26)
            }
        case .numbers:
            kicker("The numbers")
            let dist = WrappedStory.trackDistance(t.miles, units)
            let cells: [(String, String)] = [
                (WrappedStory.fmtDays(t.trackDays), WrappedStory.plural(t.trackDays, "track day")),
                (WrappedStory.int(Double(t.tracks)), WrappedStory.plural(Double(t.tracks), "track")),
                (WrappedStory.int(Double(t.laps)), WrappedStory.plural(Double(t.laps), "lap")),
            ] + (t.milesTracksCounted != 0 ? [(dist.value, dist.unit)] : [])
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 26) {
                ForEach(cells, id: \.1) { value, label in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(value)
                            .font(.system(size: 52, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(Color(.accentInk))
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                        Text(label).teStyle(.sm).foregroundStyle(Color(.textMuted))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 22)
            if t.milesTracksCounted != 0 && t.milesTracksCounted < t.tracks {
                foot("Distance across \(t.milesTracksCounted) of \(t.tracks) tracks — the ones whose lap length we know.")
            } else {
                foot("\(WrappedStory.int(Double(t.events))) \(WrappedStory.plural(Double(t.events), "event")) in the logbook.")
            }
        case .mostDriven:
            if let m = data.mostDriven {
                kicker("Most driven")
                lede("You kept coming back to")
                big(m.trackName)
                line([
                    "\(WrappedStory.fmtDays(m.trackDays)) \(WrappedStory.plural(m.trackDays, "day"))",
                    "\(WrappedStory.int(Double(m.laps))) \(WrappedStory.plural(Double(m.laps), "lap"))",
                    m.bestMs.map { "best \(LapTime.fmtMs($0))" },
                ])
            }
        case .improvement:
            if let g = data.improvement {
                let first = g.baseline == "first_event"
                kicker("Biggest improvement")
                lede(first ? "A first year at \(g.trackName) — and you found" : "At \(g.trackName), you found")
                huge(WrappedStory.fmtGain(g.gainMs), accent: true)
                line(["\(LapTime.fmtMs(g.bestBefore)) → \(LapTime.fmtMs(g.bestThisYear))"])
                foot(first ? "From the first timed day there this year to the best." : "Against the best from every year before \(String(data.year)).")
            }
        case .fastest:
            if let f = data.fastest {
                kicker("Fastest lap")
                huge(LapTime.fmtMs(f.bestMs), accent: true)
                line([f.trackName, Self.day(f.date)])
            }
        case .newTracks:
            kicker("New tracks")
            lede("First time at")
            VStack(alignment: .leading, spacing: 0) {
                ForEach(data.newTracks, id: \.trackId) { track in
                    Text(track.trackName)
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(Color(.textStrong))
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { Rectangle().fill(Color(.borderHairline)).frame(height: 1) }
                }
            }
            .padding(.top, 14)
        case .hours:
            kicker("Hours behind the wheel")
            huge(WrappedStory.fmtHoursWord(t.hours), accent: true)
            line(["\(WrappedStory.plural(t.hours, "hour")) on track"])
            foot("Two hours a track day, or the logged lap time when that's more.")
        case .hottest:
            if let h = data.hottest {
                kicker("Hottest day")
                huge(SessionConditions.tempText(h.tempC, units == .metric ? .metric : .us), accent: true)
                line([h.trackName, Self.day(h.date)])
            }
        case .tire:
            if card.locked {
                locked("Favorite tire", "The tire with the most track days on it this year, from your garage.")
            } else if let tire = data.pro?.tire {
                kicker("Favorite tire")
                lede("The rubber you lived on")
                big(tire.name)
                line(["\(WrappedStory.fmtDays(tire.trackDays)) \(WrappedStory.plural(tire.trackDays, "track day"))", tire.vehicleName])
            }
        case .topSpeed:
            if card.locked {
                locked("Top speed", "The fastest your telemetry ever saw you go this year, and where.")
            } else if let top = data.pro?.topSpeed {
                kicker("Top speed")
                huge(Units.fmtSpeedKph(top.kph, units), accent: true)
                line([top.trackName, Self.day(top.date)])
            }
        case .poster:
            WrappedPosterCard(data: data, units: units)
            WrappedShareButtons(data: data, units: units, shareURL: shareURL)
                .padding(.top, 16)
        }
    }

    // MARK: pieces

    private func kicker(_ text: String) -> some View {
        Text(text.uppercased())
            .teStyle(.eyebrow)
            .foregroundStyle(Color(.accentInk))
    }

    private func huge(_ text: String, accent: Bool) -> some View {
        Text(text)
            .font(.system(size: 72, weight: .semibold))
            .monospacedDigit()
            .tracking(-2)
            .foregroundStyle(accent ? Color(.accentInk) : Color(.textStrong))
            .minimumScaleFactor(0.5)
            .lineLimit(2)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }

    private func big(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 36, weight: .semibold))
            .foregroundStyle(Color(.textStrong))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 8)
    }

    private func lede(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 19))
            .foregroundStyle(Color(.textBody))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 14)
    }

    private func line(_ parts: [String?]) -> some View {
        Text(parts.compactMap { $0 }.joined(separator: " · "))
            .font(.system(size: 17))
            .monospacedDigit()
            .foregroundStyle(Color(.textBody))
            .padding(.top, 10)
    }

    private func foot(_ text: String) -> some View {
        Text(text)
            .teStyle(.sm)
            .foregroundStyle(Color(.textMuted))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 22)
    }

    /// A Pro card on a free account: its shape, one line on what it would show,
    /// and the paywall behind a button — `ProUpsellCard`, which hangs its sheet
    /// off that button rather than off this screen.
    @ViewBuilder
    private func locked(_ title: String, _ what: String) -> some View {
        HStack(spacing: 8) {
            kicker(title)
            Text("PRO")
                .teStyle(.xxs)
                .foregroundStyle(Color(.accentContrast))
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Color(.accent), in: .capsule)
        }
        Text("•••")
            .font(.system(size: 60, weight: .semibold))
            .foregroundStyle(Color(.borderStrong))
            .padding(.vertical, 12)
            .accessibilityHidden(true)
        ProUpsellCard(title: "\(title) is Pro", blurb: "\(what) Wrapped itself is free.")
    }

    /// "Jul 19" — the story names days without the weekday.
    static func day(_ iso: String) -> String {
        let parse = DateFormatter()
        parse.calendar = Calendar(identifier: .gregorian)
        parse.locale = Locale(identifier: "en_US_POSIX")
        parse.timeZone = TimeZone(identifier: "UTC")
        parse.dateFormat = "yyyy-MM-dd"
        guard let date = parse.date(from: iso) else { return iso }
        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US")
        out.timeZone = TimeZone(identifier: "UTC")
        out.dateFormat = "MMM d"
        return out.string(from: date)
    }
}

private struct YearChipStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .teStyle(.sm)
            .foregroundStyle(selected ? Color(.accentContrast) : Color(.textBody))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(selected ? Color(.accent) : Color(.surfaceCard), in: .rect(cornerRadius: TERadius.sm))
            .overlay(RoundedRectangle(cornerRadius: TERadius.sm).strokeBorder(Color(.borderHairline), lineWidth: selected ? 0 : 1))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

// MARK: - The poster

/// The summary card — `posterLines`, drawn as the web's `.wr-poster`.
struct WrappedPosterCard: View {
    let data: Wrapped
    let units: UnitSystem

    var body: some View {
        let p = WrappedStory.posterLines(data, units)
        VStack(alignment: .leading, spacing: 0) {
            Text(p.title)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color(.textStrong))
            Text(p.headline.joined(separator: " · "))
                .teStyle(.bodyStrong)
                .monospacedDigit()
                .foregroundStyle(Color(.accentInk))
                .padding(.top, 8)
                .padding(.bottom, 16)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(p.rows, id: \.self) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row[0]).teStyle(.sm).foregroundStyle(Color(.textMuted))
                        Text(row[1]).teStyle(.sm).foregroundStyle(Color(.textStrong))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Text("trackevolution.app")
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
                .padding(.top, 18)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.surfaceCard))
        // The web's `inset 0 3px 0 var(--accent)`: a lime edge along the top,
        // clipped to the card's corners with everything else.
        .overlay(alignment: .top) {
            Rectangle().fill(Color(.accent)).frame(height: 3)
        }
        .clipShape(.rect(cornerRadius: TERadius.xl))
        .overlay(RoundedRectangle(cornerRadius: TERadius.xl).strokeBorder(Color(.borderHairline), lineWidth: 1))
    }
}

/// Share, and the public link when there is one. `ShareLink` rather than a
/// presented `UIActivityViewController`, so the story view presents nothing of
/// its own — the one-modal-per-view hazard stays out of reach — and the system
/// sheet already offers Save Image beside every app.
struct WrappedShareButtons: View {
    let data: Wrapped
    let units: UnitSystem
    let shareURL: URL?

    @Environment(\.colorScheme) private var colorScheme
    @State private var story: Image?
    @State private var wide: Image?

    var body: some View {
        let title = WrappedStory.posterLines(data, units).title
        VStack(alignment: .leading, spacing: 12) {
            if let story {
                ShareLink(item: story, preview: SharePreview(title, image: story)) {
                    Label("Share image", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .accessibilityIdentifier("wrappedShareImage")
            } else {
                ProgressView()
            }
            HStack(spacing: 12) {
                if let wide {
                    ShareLink(item: wide, preview: SharePreview(title, image: wide)) {
                        Text("Share wide")
                    }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                }
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Text("Share link")
                    }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            }
            if shareURL == nil {
                Text("Want a link to post instead? Create a share link in Settings and this season gets a page of its own.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
        }
        // Drawn when the poster card comes into view, not on the tap, so the
        // share sheet opens at once.
        .task(id: colorScheme) { render() }
    }

    private func render() {
        story = Self.image(WrappedPosterImage(data: data, units: units, wide: false), colorScheme: colorScheme)
        wide = Self.image(WrappedPosterImage(data: data, units: units, wide: true), colorScheme: colorScheme)
    }

    @MainActor
    static func image(_ view: WrappedPosterImage, colorScheme: ColorScheme) -> Image? {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, colorScheme))
        renderer.scale = 1
        guard let ui = renderer.uiImage else { return nil }
        return Image(uiImage: ui)
    }
}

/// The poster as a picture: 1080×1920 for a story, 1200×630 for everywhere
/// else — `public/js/wrapped-image.js`'s two sizes and layouts, in the viewer's
/// appearance, drawn by `ImageRenderer` at scale 1 so a point is a pixel.
struct WrappedPosterImage: View {
    let data: Wrapped
    let units: UnitSystem
    let wide: Bool

    var body: some View {
        let p = WrappedStory.posterLines(data, units)
        Group {
            if wide { wideLayout(p) } else { storyLayout(p) }
        }
        .frame(width: wide ? 1200 : 1080, height: wide ? 630 : 1920)
        .background(WrappedBackground())
    }

    private func brand(_ size: CGFloat) -> some View {
        HStack(spacing: size * 0.35) {
            BrandMark(size: size)
            Text("Track Evolution")
                .font(.system(size: size * 0.52, weight: .semibold))
                .foregroundStyle(Color(.textStrong))
        }
    }

    private func storyLayout(_ p: WrappedStory.Poster) -> some View {
        let t = data.totals
        let dist = WrappedStory.trackDistance(t.miles, units)
        let stats: [(String, String)] = [
            (WrappedStory.fmtDays(t.trackDays), WrappedStory.plural(t.trackDays, "track day")),
            (WrappedStory.int(Double(t.tracks)), WrappedStory.plural(Double(t.tracks), "track")),
            (WrappedStory.int(Double(t.laps)), WrappedStory.plural(Double(t.laps), "lap")),
        ] + (t.milesTracksCounted != 0 ? [(dist.value, dist.unit)] : [])
        return VStack(alignment: .leading, spacing: 0) {
            brand(76)
            Text("SEASON WRAPPED")
                .font(.system(size: 32, weight: .semibold))
                .tracking(4)
                .foregroundStyle(Color(.accentInk))
                .padding(.top, 120)
            Text(p.title)
                .font(.system(size: 92, weight: .semibold))
                .foregroundStyle(Color(.textStrong))
                .lineLimit(3)
                .padding(.top, 16)
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 40) {
                ForEach(stats, id: \.1) { value, label in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(value)
                            .font(.system(size: 140, weight: .semibold))
                            .foregroundStyle(Color(.accentInk))
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                        Text(label).font(.system(size: 38)).foregroundStyle(Color(.textMuted))
                    }
                }
            }
            .padding(.top, 60)
            Rectangle().fill(Color(.borderHairline)).frame(height: 2).padding(.vertical, 50)
            VStack(alignment: .leading, spacing: 30) {
                ForEach(p.rows, id: \.self) { row in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(row[0]).font(.system(size: 32)).foregroundStyle(Color(.textMuted))
                        Text(row[1]).font(.system(size: 44, weight: .semibold)).foregroundStyle(Color(.textStrong)).lineLimit(2)
                    }
                }
            }
            Spacer(minLength: 0)
            Text("trackevolution.app")
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(Color(.textMuted))
        }
        .padding(96)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func wideLayout(_ p: WrappedStory.Poster) -> some View {
        HStack(alignment: .top, spacing: 60) {
            VStack(alignment: .leading, spacing: 0) {
                brand(52)
                Text(p.title)
                    .font(.system(size: 54, weight: .semibold))
                    .foregroundStyle(Color(.textStrong))
                    .lineLimit(3)
                    .padding(.top, 70)
                Text(p.headline.joined(separator: " · "))
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Color(.accentInk))
                    .padding(.top, 20)
                Spacer(minLength: 0)
                Text("trackevolution.app")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(Color(.textMuted))
            }
            .frame(width: 560, alignment: .leading)
            VStack(alignment: .leading, spacing: 22) {
                ForEach(p.rows, id: \.self) { row in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(row[0]).font(.system(size: 22)).foregroundStyle(Color(.textMuted))
                        Text(row[1]).font(.system(size: 30, weight: .semibold)).foregroundStyle(Color(.textStrong)).lineLimit(2)
                    }
                }
            }
            .padding(.top, 70)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(64)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

#if DEBUG
extension WrappedScreen {
    /// The story on a sample season, for `-wrapped` (see `RootView`) — the only
    /// way to see it without a signed-in account with track days. Decoded from
    /// the golden's shape rather than built field by field, since the model's
    /// memberwise initialiser is internal to the Kit.
    static var demo: some View {
        let json = """
        {"year":2026,"years":[2026,2025],"through":"2026-09-23","name":"Eric",
         "totals":{"events":9,"track_days":14,"tracks":6,"laps":1923,"hours":31.5,"miles":4281.4,"miles_tracks_counted":5},
         "most_driven":{"track_id":3,"track_name":"Virginia International Raceway (Full)","track_days":5,"laps":612,"best_ms":120030},
         "improvement":{"track_id":7,"track_name":"Summit Point (Main Circuit)","best_before":94120,"best_this_year":89290,"gain_ms":4830,"baseline":"prior_years"},
         "fastest":{"track_id":3,"track_name":"Virginia International Raceway (Full)","best_ms":120030,"event_id":41,"date":"2026-06-14"},
         "new_tracks":[{"track_id":9,"track_name":"Road Atlanta"}],
         "hottest":{"event_id":44,"track_name":"Virginia International Raceway (Full)","date":"2026-07-19","temp_c":34.5},
         "pro":\(ProcessInfo.processInfo.arguments.contains("-wrappedPro")
            ? #"{"tire":{"part_id":1,"vehicle_id":1,"vehicle_name":"Corvette C7","name":"Continental ExtremeContact Force","track_days":6,"hours":12},"top_speed":{"kph":254.3,"track_id":3,"track_name":"Virginia International Raceway (Full)","event_id":41,"date":"2026-06-14"}}"#
            : "null")}
        """
        let data = try! JSONDecoder().decode(Wrapped.self, from: Data(json.utf8))
        return NavigationStack {
            WrappedStoryView(data: data, shareURL: URL(string: "https://trackevolution.app/share/demo/wrapped/2026"))
                .background(WrappedBackground().ignoresSafeArea())
                .navigationTitle("2026 Wrapped")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}
#endif
