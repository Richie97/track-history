import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import TrackEvolutionKit
import UIKit

/// Share with a coach (NS-38): both halves of a grant on one page — the
/// students whose logbooks you read, and, for a Pro driver, the invite links,
/// the coaches reading theirs and the driver profile they see. `viewCoaching` in
/// `public/app.js` is the reference for behaviour and copy.
///
/// Its own page rather than sections of Settings, as on the web: three lists
/// and a form behind it are a page's worth. Settings carries one row to it.
struct CoachingScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    @State private var model: CoachingModel?
    /// The one confirmation on this view — one presentation per view, the rule
    /// `VehicleScreen` documents — so which one is a value, not a bool each.
    @State private var confirming: CoachingModel.Confirmation?

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model {
                content(model)
            }
        }
        .navigationTitle("Coaching")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = CoachingModel(api: auth.api)
                self.model = model
                await model.load()
            }
        }
        // Back from the profile form, or from a student's logbook: the page's
        // lists and profile may have moved on while it was covered.
        .onAppear {
            if let model, model.state == .ready { Task { await model.load() } }
        }
        .confirmationDialog(
            confirming?.question ?? "",
            isPresented: .init(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible,
            presenting: confirming
        ) { confirmation in
            Button(confirmation.action, role: .destructive) {
                Task { await model?.perform(confirmation) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func content(_ model: CoachingModel) -> some View {
        TEPage {
            if !model.students.isEmpty {
                TESectionHeader("Your students")
                ForEach(model.students) { student in
                    studentRow(student)
                }
            }

            TESectionHeader("Share your logbook with a coach")
            Text("Give an instructor or coach read-only access to your whole logbook. They see \(Self.coachShares)")
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
                .fixedSize(horizontal: false, vertical: true)
            if Entitlement.isPro(auth.entitlement) {
                inviteCard(model)
            } else {
                ProUpsellCard(
                    title: "Share with a coach",
                    blurb: """
                        Send an instructor or coach a link that gives them read-only access to your logbook — every \
                        session, the channel graphs and your racing lines — so they can prepare before the next track day.
                        """
                )
            }

            TESectionHeader("Coaches who can see your logbook")
            if model.coaches.isEmpty {
                // The invite above is the next step, so the sentence alone.
                TEEmpty("Nobody can see your logbook yet.")
            } else {
                TECard {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.coaches) { coach in
                            coachRow(coach)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            TESectionHeader("Driver profile")
            Text("""
                What your coaches see about you — your experience, your gear and what you want to work on. \
                Only you and the coaches you've invited can see it.
                """)
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
                .fixedSize(horizontal: false, vertical: true)
            ProfileCard(profile: model.profile, empty: "Not filled in yet.")
            Button(model.profile == nil ? "Fill in your profile" : "Edit profile") {
                router.push(.profile)
            }
            .buttonStyle(TEButtonStyle(kind: .quiet))
            .accessibilityIdentifier("editProfile")

            if let error = model.error {
                TEErrorBanner(message: error)
            }
        }
        .refreshable { await model.load() }
    }

    // MARK: - Rows

    private func studentRow(_ student: Coaching.Student) -> some View {
        TECard(padding: 14) {
            HStack(alignment: .center, spacing: 12) {
                Button {
                    router.openStudent(student.id)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(student.name ?? "A driver")
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.accentInk))
                        Text(Coaching.studentLine(student, fmtDate: EventDates.fmtDate))
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("student-\(student.id)")
                Button("Stop coaching") {
                    confirming = .leave(id: student.id, name: student.name ?? "this driver")
                }
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
                .accessibilityIdentifier("stopCoaching-\(student.id)")
            }
        }
    }

    private func coachRow(_ coach: Coaching.Coach) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(coach.name ?? "A coach")
                    .teStyle(.bodyStrong)
                    .foregroundStyle(Color(.textStrong))
                Text("since \(Self.dateOfMs(coach.since)) · \(Coaching.lastViewedText(coach.lastViewedAt, now: Self.nowMs))")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            Spacer(minLength: 8)
            Button("Remove") {
                confirming = .removeCoach(id: coach.id, name: coach.name ?? "this coach")
            }
            .teStyle(.sm)
            .foregroundStyle(Color(.dangerInk))
        }
    }

    // MARK: - Invites

    private func inviteCard(_ model: CoachingModel) -> some View {
        TECard {
            VStack(alignment: .leading, spacing: 14) {
                Button(model.isCreating ? "Creating…" : "Create an invite link") {
                    Task { await model.createInvite() }
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
                .disabled(model.isCreating)
                .accessibilityIdentifier("createInvite")

                if let invite = model.created {
                    CreatedInvite(invite: invite)
                }

                if !model.invites.isEmpty {
                    Divider().overlay(Color(.borderHairline))
                    ForEach(model.invites) { invite in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Unused invite link")
                                    .teStyle(.sm)
                                    .foregroundStyle(Color(.textBody))
                                Text(Coaching.inviteExpiryText(invite.expiresAt, now: Self.nowMs))
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textMuted))
                            }
                            Spacer(minLength: 8)
                            Button("Withdraw") { Task { await model.withdraw(invite.id) } }
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textMuted))
                                .accessibilityIdentifier("withdrawInvite-\(invite.id)")
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// What a coach reads, as the page promises it before an invite is made —
    /// `COACH_SHARES` in `public/app.js`, kept in step with `COACH_ROUTES` in
    /// `src/lib/coaching.ts`.
    static let coachShares = """
        your events, sessions and laps with the full channel panel (as far as your plan includes it), your \
        racing lines, the conditions, your cars and their modifications, and your driver profile. Never your \
        notes, prep checklists, costs, setup sheets, parts or email — and they can't change anything.
        """

    static var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    static func dateOfMs(_ ms: Int) -> String {
        EventDates.fmtDate(EventDates.isoString(from: Date(timeIntervalSince1970: Double(ms) / 1000)))
    }
}

/// A link that was just minted, shown the one time it can be: the address, Copy,
/// the share sheet, and a QR code for handing it over in the paddock.
private struct CreatedInvite: View {
    let invite: CoachInvite
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(invite.url)
                .teStyle(.xs)
                .monospaced()
                .foregroundStyle(Color(.textStrong))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inviteURL")
            HStack(spacing: 10) {
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = invite.url
                    copied = true
                    Haptics.select()
                }
                .buttonStyle(TEButtonStyle(kind: .quiet))
                .accessibilityIdentifier("copyInvite")
                if let url = URL(string: invite.url) {
                    ShareLink(
                        item: url,
                        message: Text("Here's read-only access to my Track Evolution logbook")
                    ) {
                        Label("Share…", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                }
            }
            if let qr = QRCode.image(for: invite.url) {
                Image(uiImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 180, height: 180)
                    .padding(10)
                    // Always dark on white: a scanner reads contrast, and a code
                    // drawn in dark mode's inverse is one many cameras refuse.
                    .background(Color.white, in: .rect(cornerRadius: TERadius.md))
                    .accessibilityLabel("QR code for the invite link")
                    .accessibilityIdentifier("inviteQR")
            }
            Text("""
                Send this to your coach, or let them scan the code. It works once, \
                \(Coaching.inviteExpiryText(invite.expiresAt, now: CoachingScreen.nowMs)), and can't be shown \
                again — make a new one if it gets lost.
                """)
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A QR code for a string, drawn by Core Image's `CIQRCodeGenerator`.
enum QRCode {
    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        // Medium error correction: a phone screen held up in sunlight.
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Scaled up in whole modules so the edges stay sharp; the view then
        // draws it without interpolation.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cgImage = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

/// The Coaching page's data and writes. Every write re-reads `GET /api/coaching`
/// rather than patching a copy: the lists are short and the server's answer is
/// the one that says who can read what.
@MainActor
@Observable
final class CoachingModel {
    private let api: APIClient

    private(set) var state: LoadState = .loading
    private(set) var coaches: [Coaching.Coach] = []
    private(set) var students: [Coaching.Student] = []
    private(set) var invites: [Coaching.OpenInvite] = []
    private(set) var profile: DriverProfile?
    /// The invite just minted — its link exists only in this answer.
    private(set) var created: CoachInvite?
    private(set) var isCreating = false
    var error: String?

    enum Confirmation: Hashable {
        case removeCoach(id: Int, name: String)
        case leave(id: Int, name: String)

        var question: String {
            switch self {
            case .removeCoach(_, let name):
                "Stop sharing your logbook with \(name)? They lose access straight away."
            case .leave(_, let name):
                "Stop coaching \(name)? You'll need a new invite to see their logbook again."
            }
        }

        var action: String {
            switch self {
            case .removeCoach: "Remove coach"
            case .leave: "Stop coaching"
            }
        }
    }

    init(api: APIClient) {
        self.api = api
    }

    func load() async {
        do {
            async let coaching = api.coaching()
            async let mine = api.profile()
            let loaded = try await (coaching: coaching, profile: mine)
            coaches = loaded.coaching.coaches
            students = loaded.coaching.students
            invites = loaded.coaching.invites
            profile = loaded.profile.profile
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func createInvite() async {
        error = nil
        isCreating = true
        defer { isCreating = false }
        do {
            created = try await api.createCoachInvite()
            Haptics.confirm()
            await load()
        } catch let error as APIError {
            self.error = error.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    func withdraw(_ id: Int) async {
        await write { try await $0.withdrawCoachInvite(id: id) }
        if created?.id == id { created = nil }
    }

    func perform(_ confirmation: Confirmation) async {
        switch confirmation {
        case .removeCoach(let id, _): await write { try await $0.removeCoach(id: id) }
        case .leave(let id, _): await write { try await $0.leaveStudent(id: id) }
        }
    }

    private func write(_ body: (APIClient) async throws -> Void) async {
        error = nil
        do {
            try await body(api)
            await load()
        } catch let error as APIError {
            self.error = error.message
        } catch {
            self.error = error.localizedDescription
        }
    }
}
