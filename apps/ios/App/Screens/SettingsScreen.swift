import SwiftUI
import TrackEvolutionKit

/// Account, theme, the public share link, and the legal pages.
///
/// `viewSettings` in `public/app.js` is the reference. Two structural differences:
///
/// - **Share-link management lives here**, not on the dashboard. The web app puts it
///   at the bottom of the dashboard; on a phone a settings screen is where it's
///   looked for, and the dashboard is long enough already.
/// - **Vehicles are managed here**, matching the web app: this screen owns the
///   list, the default flag and deletion, while a car's consumables and wear live
///   on its garage page (`VehicleScreen`).
///
/// **Privacy and terms are required on every platform.** The web app carries them in
/// the footer on signed-out pages and in Settings for signed-in users; the native app
/// renders no footer at all, so this screen is the only place they can be — which is
/// why they are not behind a disclosure or an "About" tap.
struct SettingsScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(ThemeStore.self) private var theme
    @Environment(AppRouter.self) private var router
    @Environment(StoreController.self) private var store

    @State private var model: SettingsModel?
    @State private var showingPaywall = false
    @State private var confirmingSignOut = false
    @State private var confirmingDisableShare = false
    @State private var deletingVehicle: Vehicle?

    private static let docsURL = URL(string: "https://docs.trackevolution.app")!

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model {
                content(model)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = SettingsModel(api: auth.api, auth: auth)
                self.model = model
                await model.load()
            }
        }
        .confirmationDialog(
            model?.hasUnsyncedChanges == true
                ? "You have offline changes that haven't synced yet — signing out discards them."
                : "Sign out of Track Evolution?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                Task {
                    await auth.signOut()
                    router.popToRoot()
                }
            }
            Button("Stay signed in", role: .cancel) {}
        }
        .confirmationDialog(
            "Disable your public share link? The URL will stop working.",
            isPresented: $confirmingDisableShare,
            titleVisibility: .visible
        ) {
            Button("Disable link", role: .destructive) {
                Task { await model?.disableShare() }
            }
            Button("Keep it", role: .cancel) {}
        }
        .confirmationDialog(
            deletingVehicle.map {
                "Delete \($0.name)? Its consumables, measurements and wear history go with it. "
                    + "Events keep their car name and simply stop being linked."
            } ?? "",
            isPresented: .init(get: { deletingVehicle != nil }, set: { if !$0 { deletingVehicle = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete vehicle", role: .destructive) {
                if let vehicle = deletingVehicle {
                    Task { await model?.deleteVehicle(id: vehicle.id) }
                }
                deletingVehicle = nil
            }
            Button("Keep it", role: .cancel) { deletingVehicle = nil }
        }
    }

    private func content(_ model: SettingsModel) -> some View {
        @Bindable var model = model
        return TEPage {
            accountCard(model)

            TESectionHeader("Subscription")
            subscriptionCard

            TESectionHeader("Appearance")
            TECard {
                Picker("Theme", selection: Binding(get: { theme.preference }, set: { theme.preference = $0 })) {
                    ForEach(ThemePreference.allCases) { preference in
                        Text(preference.label).tag(preference)
                    }
                }
                .pickerStyle(.segmented)
            }

            TESectionHeader("Share your history")
            shareCard(model)

            TESectionHeader("Leaderboards")
            leaderboardCard(model)

            TESectionHeader("Prep checklist")
            checklistTemplateCard(model)

            TESectionHeader("Vehicles")
            vehiclesCard(model)

            TESectionHeader("About & legal")
            TECard {
                VStack(alignment: .leading, spacing: 12) {
                    Link(destination: Self.docsURL.appending(path: "docs/privacy.html")) {
                        legalRow("Privacy policy")
                    }
                    Divider().overlay(Color(.borderHairline))
                    Link(destination: Self.docsURL.appending(path: "docs/terms.html")) {
                        legalRow("Terms of use")
                    }
                    Divider().overlay(Color(.borderHairline))
                    Link(destination: Self.docsURL) {
                        legalRow("Documentation")
                    }
                    // `String(...)`, not the bare Int: `Text` interpolation formats a
                    // number for the locale, and a year is an identifier rather than a
                    // quantity — grouping turns 2026 into "2,026".
                    Text("© \(String(Calendar.current.component(.year, from: Date()))) Speedshift LLC")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    Text(Self.versionLine)
                        .teStyle(.xxs)
                        .foregroundStyle(Color(.textFaint))
                }
            }

            Button("Sign out") { confirmingSignOut = true }
                .buttonStyle(TEButtonStyle(kind: .danger))
                .padding(.top, 8)
        }
        .refreshable { await model.load() }
    }

    private func legalRow(_ title: String) -> some View {
        HStack {
            Text(title)
                .teStyle(.body)
                .foregroundStyle(Color(.textBody))
            Spacer()
            Image(systemName: "arrow.up.right")
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
        }
    }

    /// "1.0 (12)" — what a bug report needs to be actionable.
    private static var versionLine: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Version \(version) (\(build))"
    }

    // MARK: - Account

    private func accountCard(_ model: SettingsModel) -> some View {
        TECard {
            HStack(spacing: 14) {
                avatar(model.user)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.user?.name ?? model.user?.email ?? "Signed in")
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    if let email = model.user?.email, model.user?.name != nil {
                        Text(email)
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    }
                    // Shown only when it isn't the hosted app, which is the case
                    // that's worth knowing about: a dev build pointed at a LAN server
                    // looks identical otherwise.
                    if !auth.server.isDefault, let host = auth.server.url.host() {
                        Text("Server: \(host)")
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }
                Spacer()
            }
        }
    }

    @ViewBuilder
    private func avatar(_ user: User?) -> some View {
        if let picture = user?.picture, let url = URL(string: picture) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color(.surfaceRaised)
            }
            .frame(width: 44, height: 44)
            .clipShape(.circle)
        } else {
            Text(String((user?.name ?? user?.email ?? "?").prefix(1)).uppercased())
                .teStyle(.h3)
                .foregroundStyle(Color(.accentContrast))
                .frame(width: 44, height: 44)
                .background(Color(.accent), in: .circle)
        }
    }

    // MARK: - Subscription

    /// Tier and source, as the server last said them (NS-32): "Pro · renews Mar 4,
    /// 2027", "Pro · lifetime" for a paid-app buyer, or "Free" with the way in.
    /// Manage goes to the store that sold it — the system sheet for the App Store,
    /// a link for Google Play — and legacy has nothing to manage.
    ///
    /// The paywall hangs off its button. This screen already presents three
    /// confirmation dialogs, and a fourth presentation on its root is the SwiftUI
    /// hazard the README documents.
    private var subscriptionCard: some View {
        let entitlement = auth.entitlement
        return TECard {
            VStack(alignment: .leading, spacing: 10) {
                Text(Entitlement.entitlementSummary(entitlement, fmtDate: PaywallSheet.fmtDate))
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                    .accessibilityIdentifier("subscriptionSummary")
                Text(subscriptionDetail(entitlement))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))

                if Entitlement.isPro(entitlement) {
                    manageControl(entitlement)
                } else {
                    Button("Subscribe to Pro") { showingPaywall = true }
                        .buttonStyle(TEButtonStyle(kind: .accent))
                        .accessibilityIdentifier("subscribeButton")
                        .sheet(isPresented: $showingPaywall) {
                            PaywallSheet(context: .general)
                        }
                    if let url = Entitlement.manageUrl(entitlement), entitlement?.source == .google {
                        // Lapsed on Android: the way back is Play's, not ours.
                        Link("Manage on Google Play", destination: url)
                            .buttonStyle(TEButtonStyle(kind: .quiet))
                    }
                }

                if let error = store.error {
                    TEErrorBanner(message: error)
                }
            }
        }
    }

    @ViewBuilder
    private func manageControl(_ entitlement: Entitlement?) -> some View {
        switch entitlement?.source {
        case .apple:
            Button("Manage subscription") { Task { await store.showManageSubscriptions() } }
                .buttonStyle(TEButtonStyle(kind: .quiet))
                .accessibilityIdentifier("manageSubscription")
        case .google:
            if let url = Entitlement.manageUrl(entitlement) {
                Link("Manage on Google Play", destination: url)
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityIdentifier("manageSubscription")
            }
        case .legacy, nil:
            EmptyView()
        }
    }

    private func subscriptionDetail(_ entitlement: Entitlement?) -> String {
        guard Entitlement.isPro(entitlement) else {
            return "Free is the logbook. Pro adds the GPS lap recorder, video telemetry import, "
                + "channel graphs and garage wear tracking — on every device you sign in on."
        }
        switch entitlement?.source {
        case .legacy: return "You bought the app before subscriptions — Pro is yours for life."
        case .apple: return "Billed through the App Store. Cancel or switch plans in your Apple ID subscriptions."
        case .google: return "Billed through Google Play. Cancel or switch plans there."
        case nil: return "Track Evolution Pro is active on this account."
        }
    }

    // MARK: - Vehicles

    /// The garage's front door: one row per car, each opening its own page. The
    /// default car pre-fills new events, which is the only reason the flag is
    /// worth surfacing at all.
    /// The prep list every new checklist starts from.
    ///
    /// Editing it never touches a checklist already on an event: those are
    /// snapshots taken when the list was started, and rewriting them would tick
    /// items the driver had already dealt with.
    private func checklistTemplateCard(_ model: SettingsModel) -> some View {
        @Bindable var model = model
        return TECard {
            VStack(alignment: .leading, spacing: 12) {
                Text("The list an upcoming event starts from. Checklists already on an event keep whatever is on them.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))

                ForEach(Array(auth.checklistTemplate.enumerated()), id: \.offset) { index, text in
                    HStack(spacing: 8) {
                        Text(text)
                            .teStyle(.body)
                            .foregroundStyle(Color(.textBody))
                        Spacer(minLength: 8)
                        Button {
                            Task { await model.moveChecklistItem(from: index, by: -1) }
                        } label: {
                            Image(systemName: "arrow.up")
                        }
                        .disabled(index == 0)
                        .accessibilityLabel("Move \(text) up")
                        Button {
                            Task { await model.moveChecklistItem(from: index, by: 1) }
                        } label: {
                            Image(systemName: "arrow.down")
                        }
                        .disabled(index == auth.checklistTemplate.count - 1)
                        .accessibilityLabel("Move \(text) down")
                        Button(role: .destructive) {
                            Task { await model.removeChecklistItem(at: index) }
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .accessibilityLabel("Remove \(text)")
                    }
                    .buttonStyle(.plain)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textFaint))
                    if index < auth.checklistTemplate.count - 1 {
                        Divider().overlay(Color(.borderHairline))
                    }
                }

                HStack(spacing: 8) {
                    TextField("Add item…", text: $model.newChecklistItem)
                        .teInput()
                        .submitLabel(.done)
                        .onSubmit { Task { await model.addChecklistItem() } }
                        .accessibilityIdentifier("checklistTemplateField")
                    Button("Add") { Task { await model.addChecklistItem() } }
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.accentInk))
                        .disabled(model.newChecklistItem.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("addChecklistTemplateItem")
                }

                Text(auth.hasCustomChecklistTemplate
                    ? "This is your own list."
                    : "This is the app's default — your first edit makes it yours.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))

                if auth.hasCustomChecklistTemplate {
                    Button("Reset to default") {
                        Task { await model.resetChecklistTemplate() }
                    }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityIdentifier("resetChecklistTemplate")
                }

                if let error = model.checklistError {
                    TEErrorBanner(message: error)
                }
            }
        }
    }

    private func vehiclesCard(_ model: SettingsModel) -> some View {
        @Bindable var model = model
        return TECard {
            VStack(alignment: .leading, spacing: 14) {
                Text("""
                    Your cars. The default one pre-fills new events, and an event's Car field is \
                    matched to a vehicle by name — so consumables accrue wear from the events you \
                    already log. Open a car to track pads, tires and fluid.
                    """)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))

                if model.vehicles.isEmpty {
                    TEEmpty("No vehicles yet — add one and its consumables start tracking themselves.")
                } else {
                    ForEach(model.vehicles) { vehicle in
                        vehicleRow(model, vehicle)
                    }
                }

                if let error = model.vehicleError {
                    TEErrorBanner(message: error)
                }

                // Stacked, not side by side. `TEButtonStyle` sets
                // `frame(maxWidth: .infinity)`, and pinning that down with
                // `.fixedSize()` inside an `HStack` gives the layout engine a
                // contradiction to chew on — which it does, until the watchdog
                // kills the app mid-keystroke. Full-width is also the shape every
                // other primary button on this screen has.
                TextField("Corvette Z06", text: $model.newVehicleName)
                    .teInput()
                    .accessibilityIdentifier("newVehicleName")
                Button("Add vehicle") { Task { await model.addVehicle() } }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                    .disabled(model.newVehicleName.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("addVehicle")
            }
        }
    }

    private func vehicleRow(_ model: SettingsModel, _ vehicle: Vehicle) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    router.push(.vehicle(vehicle.id))
                } label: {
                    HStack(spacing: 8) {
                        Text(vehicle.name)
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.textStrong))
                        if vehicle.isDefault {
                            Text("Default")
                                .teStyle(.xxs)
                                .foregroundStyle(Color(.accentInk))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Color(.accentTint), in: .capsule)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("vehicleRow")
            }
            HStack(spacing: 14) {
                if !vehicle.isDefault {
                    Button("Make default") { Task { await model.makeDefault(id: vehicle.id) } }
                        .teStyle(.xs)
                        .foregroundStyle(Color(.accentInk))
                }
                Button("Delete") { deletingVehicle = vehicle }
                    .teStyle(.xs)
                    .foregroundStyle(Color(.dangerInk))
                Spacer()
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Leaderboards

    /// The per-track leaderboard opt-in — the same privacy posture as the web's
    /// Settings section: exactly two things are shared per track, and everything
    /// else stays private.
    private func leaderboardCard(_ model: SettingsModel) -> some View {
        @Bindable var model = model
        return TECard {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(
                    "Appear on per-track leaderboards",
                    isOn: Binding(
                        get: { model.leaderboardOptIn },
                        set: { newValue in Task { await model.setLeaderboardOptIn(newValue) } }
                    )
                )
                .teStyle(.body)
                .foregroundStyle(Color(.textBody))
                .tint(Color(.accent))
                Text("""
                    Opting in shares exactly two things with other signed-in drivers, per track: your \
                    name and your best lap (with its date). Your events, notes, laps and garage stay \
                    private. Leaderboards exist only for tracks the app's catalog knows.
                    """)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
                if let error = model.leaderboardError {
                    TEErrorBanner(message: error)
                }
            }
        }
    }

    // MARK: - Share link

    private func shareCard(_ model: SettingsModel) -> some View {
        @Bindable var model = model
        return TECard {
            VStack(alignment: .leading, spacing: 12) {
                Text("""
                    Publish a read-only page of your track history — bests, run groups and consistency \
                    (notes stay private). Handy for HPDE run-group placement. Anyone with the link can view it.
                    """)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))

                TEField(label: "Link path") {
                    HStack(spacing: 4) {
                        Text("\(auth.server.url.host() ?? "")/share/")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textFaint))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        TextField("your-name", text: $model.slugDraft)
                            .teInput()
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                }

                if let error = model.writeError {
                    TEErrorBanner(message: error)
                }

                HStack(spacing: 12) {
                    Button(model.slug == nil ? "Create link" : "Update path") {
                        Task { await model.saveSlug() }
                    }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                    if model.slug != nil {
                        Button("Disable") { confirmingDisableShare = true }
                            .buttonStyle(TEButtonStyle(kind: .danger))
                    }
                }

                if let url = model.shareURL(serverURL: auth.server.url) {
                    HStack(spacing: 16) {
                        ShareLink(item: url) {
                            Label("Share…", systemImage: "square.and.arrow.up")
                                .teStyle(.bodyStrong)
                                .foregroundStyle(Color(.accentInk))
                        }
                        Link(destination: url) {
                            Text("Open ↗")
                                .teStyle(.bodyStrong)
                                .foregroundStyle(Color(.textMuted))
                        }
                    }
                }
            }
        }
    }
}

/// Settings' data: who you are, the share slug, and the garage's vehicle list.
@MainActor
@Observable
final class SettingsModel {
    private let api: APIClient

    private(set) var state: LoadState = .loading
    private(set) var user: User?
    private(set) var slug: String?
    var slugDraft = ""
    var writeError: String?
    private(set) var vehicles: [Vehicle] = []
    var newVehicleName = ""
    /// Kept apart from `writeError` so a rejected slug and a duplicate vehicle
    /// name don't overwrite each other's message halfway down the screen.
    var vehicleError: String?
    /// Writes still waiting to reach the server — signing out would discard them, so
    /// the confirmation says so.
    private(set) var hasUnsyncedChanges = false

    /// The account, so the checklist template written here and the one the event
    /// page reads stay the same value rather than two copies.
    private let auth: AuthController

    var newChecklistItem = ""
    var checklistError: String?

    /// The per-track leaderboard opt-in, mirrored from `/me`.
    private(set) var leaderboardOptIn = false
    var leaderboardError: String?

    init(api: APIClient, auth: AuthController) {
        self.api = api
        self.auth = auth
    }

    // MARK: - Prep checklist template

    func addChecklistItem() async {
        let text = newChecklistItem.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await writeChecklist(auth.checklistTemplate + [text]) { self.newChecklistItem = "" }
    }

    func removeChecklistItem(at index: Int) async {
        var next = auth.checklistTemplate
        guard next.indices.contains(index) else { return }
        next.remove(at: index)
        await writeChecklist(next)
    }

    func moveChecklistItem(from index: Int, by offset: Int) async {
        var next = auth.checklistTemplate
        let target = index + offset
        guard next.indices.contains(index), next.indices.contains(target) else { return }
        next.swapAt(index, target)
        await writeChecklist(next)
    }

    /// Back to the app's built-in list. Sending an empty list is what clears the
    /// stored one — see `sanitizeChecklistTemplate`.
    func resetChecklistTemplate() async {
        await writeChecklist([])
    }

    private func writeChecklist(_ items: [String], onSuccess: () -> Void = {}) async {
        checklistError = nil
        do {
            try await auth.setChecklistTemplate(items)
            onSuccess()
            Haptics.select()
        } catch let error as APIError {
            checklistError = error.message
        } catch {
            checklistError = error.localizedDescription
        }
    }

    func load() async {
        // The vehicle list is a section, not the screen: an empty garage or a
        // failed fetch must not take the account and legal pages down with it.
        async let vehicleList = try? api.vehicles()
        do {
            let me = try await api.me()
            user = me.user
            slug = me.user.shareSlug
            slugDraft = me.user.shareSlug ?? ""
            leaderboardOptIn = me.user.leaderboardOptIn ?? false
            hasUnsyncedChanges = (await api.syncStatus()?.pending ?? 0) > 0
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
        vehicles = await vehicleList ?? []
    }

    // MARK: - Vehicles

    /// The first vehicle in an empty garage becomes the default server-side, so
    /// this never asks about that — it just adds the car.
    func addVehicle() async {
        let name = newVehicleName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        await vehicleWrite {
            _ = try await $0.createVehicle(VehicleDraft(name: name))
            self.newVehicleName = ""
        }
    }

    func makeDefault(id: Int) async {
        var patch = VehiclePatch()
        patch.isDefault = .set(true)
        await vehicleWrite { try await $0.updateVehicle(id: id, patch) }
    }

    /// Cascades to the vehicle's parts and measurements. Events keep their
    /// free-text car name and simply lose the link.
    func deleteVehicle(id: Int) async {
        await vehicleWrite { try await $0.deleteVehicle(id: id) }
    }

    /// Garage writes are deliberately off the offline queue, so this surfaces the
    /// server's own message — including the 409 for a duplicate name, which is the
    /// one a user actually hits.
    private func vehicleWrite(_ body: (APIClient) async throws -> Void) async {
        vehicleError = nil
        do {
            try await body(api)
            vehicles = (try? await api.vehicles()) ?? vehicles
            Haptics.confirm()
        } catch let error as APIError {
            vehicleError = error.message
            Haptics.warn()
        } catch {
            vehicleError = error.localizedDescription
            Haptics.warn()
        }
    }

    /// Join or leave the per-track leaderboards. A live write on purpose — never
    /// queued offline: publishing your name shouldn't replay silently later. On
    /// failure the toggle snaps back rather than lying about the state.
    func setLeaderboardOptIn(_ optIn: Bool) async {
        leaderboardError = nil
        let previous = leaderboardOptIn
        leaderboardOptIn = optIn
        do {
            try await api.setLeaderboardOptIn(optIn)
            Haptics.select()
        } catch let error as APIError {
            leaderboardOptIn = previous
            leaderboardError = error.message
        } catch {
            leaderboardOptIn = previous
            leaderboardError = error.localizedDescription
        }
    }

    /// `PUT /api/share`. Deliberately **not** on the offline queue — a slug is
    /// claimed against everyone else's, so it needs the server to answer.
    func saveSlug() async {
        writeError = nil
        do {
            let saved = try await api.shareSlug(slugDraft.trimmingCharacters(in: .whitespaces))
            slug = saved
            slugDraft = saved
            Haptics.confirm()
        } catch let error as APIError {
            writeError = error.message
            Haptics.warn()
        } catch {
            writeError = error.localizedDescription
            Haptics.warn()
        }
    }

    func disableShare() async {
        writeError = nil
        do {
            try await api.clearShare()
            slug = nil
            slugDraft = ""
        } catch let error as APIError {
            writeError = error.message
        } catch {
            writeError = error.localizedDescription
        }
    }

    func shareURL(serverURL: URL) -> URL? {
        guard let slug else { return nil }
        return URL(string: "\(serverURL.absoluteString)/share/\(slug)")
    }
}
