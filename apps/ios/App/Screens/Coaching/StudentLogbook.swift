import SwiftUI
import TrackEvolutionKit

// MARK: - Whose logbook this is

/// Whose logbook the screens below are showing (NS-38): `.me` everywhere but
/// under a student's route, where `StudentLogbook` sets it.
///
/// An environment value rather than an argument to every screen, because the
/// owner's screens are reused as they are — the event, track, lap, compare and
/// vehicle pages — and what they need from it reaches the sheets they present
/// and the cards they draw (`TENavCard`) without each one passing it on. Three
/// things read it, the native counterparts of the web's `viewing` seams:
///
/// - `auth.api.scoped(to: owner)`, which prefixes every read with
///   `/students/<id>` and refuses a write before it is sent;
/// - `owner.link(_:)`, which keeps a link inside the student's logbook;
/// - `owner.canViewChannels(viewer:)`, the channel panel's gate — the
///   **student's** tier, not the viewer's.
///
/// A page that grows a new write control owes it an `owner.isReadOnly` check,
/// and a new link owes it `owner.link` — the same two rules `readOnly()` and
/// `L()` carry on the web.
private struct LogbookOwnerKey: EnvironmentKey {
    static let defaultValue: LogbookOwner = .me
}

extension EnvironmentValues {
    var logbookOwner: LogbookOwner {
        get { self[LogbookOwnerKey.self] }
        set { self[LogbookOwnerKey.self] = newValue }
    }
}

// MARK: - A student's logbook

/// One page of a student's logbook, read-only (NS-38) — `routeStudent` in
/// `public/app.js`.
///
/// Every page asks first who the student is and whether this account may still
/// read them: `GET /api/students/<id>/me/profile`, which the server answers only
/// while the grant stands. That is what supplies the tier the channel panel
/// opens by, and it is also how a revoked grant is noticed — a 404 there clears
/// what this device kept of the student's logbook and says so, rather than
/// going on answering from the offline cache.
struct StudentLogbook: View {
    let studentId: Int
    let page: StudentPage

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var state: LoadState = .loading
    @State private var student: ProfileResponse?
    @State private var revoked = false

    var body: some View {
        Group {
            if revoked {
                revokedPage
            } else {
                TELoadable(state: state, retry: load) {
                    if let student {
                        let owner = LogbookOwner.student(id: student.id, name: student.name, pro: student.pro)
                        content(owner, student)
                            .environment(\.logbookOwner, owner)
                            .safeAreaInset(edge: .top, spacing: 0) { StudentBanner(owner: owner) }
                    }
                }
            }
        }
        .task { if student == nil { await load() } }
    }

    @ViewBuilder
    private func content(_ owner: LogbookOwner, _ student: ProfileResponse) -> some View {
        switch page {
        case .home:
            StudentHomeScreen(owner: owner, profile: student.profile)
        case .event(let id):
            EventScreen(eventId: id)
        case .track(let id):
            TrackScreen(trackId: id)
        case .lap(let eventId, let sessionId, let lapId):
            LapDetailScreen(eventId: eventId, sessionId: sessionId, lapId: lapId)
        case .vehicle(let id):
            VehicleScreen(vehicleId: id)
        }
    }

    private var revokedPage: some View {
        TEPage {
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Not shared with you")
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    Text("""
                        This logbook isn't shared with you — the driver may have stopped sharing it, or you left. \
                        Anything this device had kept of it has been cleared.
                        """)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                    Button("Leave this logbook") { router.dropStudent(studentId) }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .accessibilityIdentifier("leaveRevokedStudent")
                }
            }
        }
        .navigationTitle("Not shared")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func load() async {
        do {
            student = try await auth.api.scoped(toStudent: studentId).profile()
            state = .ready
        } catch let error as APIError where error.status == 404 {
            // The grant is gone. What the cache holds of it is no longer this
            // account's to read, so it goes before anything else can answer.
            await auth.api.forgetStudent(studentId)
            revoked = true
        } catch let error as APIError {
            if error.isUnauthorized { auth.handleUnauthorized() }
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// Whose logbook this is, on every page of it — the web's `viewing` banner.
struct StudentBanner: View {
    let owner: LogbookOwner

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye")
                .teStyle(.xs)
                .foregroundStyle(Color(.accentInk))
            Text("You're viewing **\(owner.displayName)**'s logbook · read-only")
                .teStyle(.xs)
                .foregroundStyle(Color(.textBody))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, TESpacing.pageGutter)
        .padding(.vertical, 8)
        .background(Color(.accentTint))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("studentBanner")
    }
}

// MARK: - The student's dashboard

/// A student's front page, for their coach — `viewStudentHome` in
/// `public/app.js`. Its own small view rather than the owner's dashboard, which
/// carries the recorder, Wrapped, the garage line and the add-event door on
/// every line: their profile first, since that is what a coach reads before a
/// session, then what they have done.
struct StudentHomeScreen: View {
    let owner: LogbookOwner
    let profile: DriverProfile?

    @Environment(AuthController.self) private var auth

    @State private var state: LoadState = .loading
    @State private var tracks: [Track] = []
    @State private var events: [Event] = []
    @State private var vehicles: [Vehicle] = []

    var body: some View {
        TELoadable(state: state, retry: load) {
            content
        }
        .navigationTitle(owner.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task { if state == .loading { await load() } }
    }

    private var past: [Event] { events.filter { !EventDates.isUpcoming($0.startDate) } }
    private var upcoming: [Event] {
        events.filter { EventDates.isUpcoming($0.startDate) }.sorted { $0.startDate < $1.startDate }
    }
    private var tracksWithData: [Track] {
        tracks.filter { $0.eventCount > 0 }.sorted { ($0.lastDate ?? "") > ($1.lastDate ?? "") }
    }

    private var content: some View {
        TEPage {
            Text(owner.displayName)
                .teStyle(.h1)
                .foregroundStyle(Color(.textStrong))
            if case .student(_, _, false) = owner {
                Text(owner.studentFreeNote)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
            }

            TEStatRow(tiles: [
                TEStatTile(label: "Events", value: "\(past.count)"),
                TEStatTile(label: "Track days", value: fmtDays(past.reduce(0) { $0 + $1.days })),
                TEStatTile(label: "Tracks", value: "\(tracksWithData.count)")
            ])

            TESectionHeader("Driver profile")
            ProfileCard(profile: profile, empty: "\(owner.displayName) hasn't filled in a driver profile yet.")

            if !upcoming.isEmpty {
                TESectionHeader("Upcoming")
                ForEach(upcoming) { event in
                    TENavCard(route: .event(event.id), identifier: "studentUpcoming") {
                        Text(event.trackName)
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        if let countdown = EventDates.fmtCountdown(event.startDate) {
                            Text(countdown)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.accentInk))
                        }
                        TEMeta([EventDates.fmtDate(event.startDate), event.club, event.runGroup])
                    }
                }
            }

            // The latest days out: where a coach usually starts, since it is
            // what they are being asked about.
            TESectionHeader("Latest events")
            if past.isEmpty {
                TEEmpty("No track days logged yet.")
            } else {
                ForEach(past.prefix(8)) { event in
                    TENavCard(route: .event(event.id), identifier: "studentEvent") {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(event.trackName)
                                    .teStyle(.bodyStrong)
                                    .foregroundStyle(Color(.textStrong))
                                TEMeta([EventDates.fmtDate(event.startDate), event.runGroup, event.car])
                            }
                            Spacer(minLength: 8)
                            VStack(alignment: .trailing, spacing: 2) {
                                TETime(ms: event.bestMs)
                                Text(fmtCount(event.lapCount, "lap"))
                                    .teStyle(.xxs)
                                    .foregroundStyle(Color(.textFaint))
                            }
                        }
                    }
                }
            }

            TESectionHeader("Tracks")
            if tracksWithData.isEmpty {
                TEEmpty("No tracks yet.")
            } else {
                TECardGrid(items: tracksWithData) { track in
                    TrackCard(track: track)
                }
            }

            if !vehicles.isEmpty {
                TESectionHeader("Cars")
                ForEach(vehicles) { vehicle in
                    TENavCard(route: .vehicle(vehicle.id), identifier: "studentCar") {
                        Text(vehicle.name)
                            .teStyle(.h3)
                            .foregroundStyle(Color(.textStrong))
                        Text(Garage.vehicleTileLine(
                            Garage.vehicleLogbook(vehicle.id, events, today: EventDates.todayISO())
                        ))
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                    }
                }
            }
        }
        .refreshable { await load() }
    }

    private func load() async {
        let api = auth.api.scoped(to: owner)
        do {
            async let trackList = api.tracks()
            async let eventList = api.events()
            let loaded = try await (tracks: trackList, events: eventList)
            tracks = loaded.tracks
            events = loaded.events
            // The cars are a courtesy on this page: a failure leaves the
            // logbook readable rather than failing it.
            vehicles = (try? await api.vehicles()) ?? []
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// The driver profile as grouped lines — `profileCardHtml` in `public/app.js`,
/// over the Kit's `profileSections`. What a coach reads about the driver, and
/// what the driver sees of their own on the Coaching page.
struct ProfileCard: View {
    let profile: DriverProfile?
    let empty: String

    var body: some View {
        let sections = DriverProfile.profileSections(profile)
        if sections.isEmpty {
            TEEmpty(empty)
        } else {
            TECard {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(sections, id: \.title) { section in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(section.title)
                                .teStyle(.eyebrow)
                                .foregroundStyle(Color(.textFaint))
                            ForEach(section.rows, id: \.key) { row in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.label)
                                        .teStyle(.xs)
                                        .foregroundStyle(Color(.textMuted))
                                    Text(row.value)
                                        .teStyle(.sm)
                                        .foregroundStyle(Color(.textBody))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityIdentifier("profileCard")
        }
    }
}
