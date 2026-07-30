import SwiftUI
import TrackEvolutionKit

/// Account, theme, the public share link, and the legal pages.
///
/// `viewSettings` in `public/app.js` is the reference. Two structural differences:
///
/// - **Share-link management lives here**, not on the dashboard. The web app puts it
///   at the bottom of the dashboard; on a phone a settings screen is where it's
///   looked for, and the dashboard is long enough already.
/// - **Vehicle and garage management links out to the web app.** Wear tracking, the
///   setup notebook and the garage pages are deferred (`docs/specs/native/README.md`)
///   and building a vehicle editor here would be the first half of a feature.
///
/// **Privacy and terms are required on every platform.** The web app carries them in
/// the footer on signed-out pages and in Settings for signed-in users; the native app
/// renders no footer at all, so this screen is the only place they can be — which is
/// why they are not behind a disclosure or an "About" tap.
struct SettingsScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(ThemeStore.self) private var theme
    @Environment(AppRouter.self) private var router

    @State private var model: SettingsModel?
    @State private var confirmingSignOut = false
    @State private var confirmingDisableShare = false

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
                let model = SettingsModel(api: auth.api)
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
    }

    private func content(_ model: SettingsModel) -> some View {
        @Bindable var model = model
        return TEPage {
            accountCard(model)

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

            TESectionHeader("Vehicles & garage")
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("""
                        Your garage — consumable wear, measurements and the per-day setup notebook — \
                        lives in the web app for now. The event form's Car field is free text and is \
                        matched to a garage vehicle automatically.
                        """)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                    Link(destination: auth.server.url) {
                        Text("Open the garage on the web ↗")
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.accentInk))
                    }
                    .accessibilityIdentifier("garageLinkOut")
                }
            }

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

/// Settings' data: who you are, and the share slug.
@MainActor
@Observable
final class SettingsModel {
    private let api: APIClient

    private(set) var state: LoadState = .loading
    private(set) var user: User?
    private(set) var slug: String?
    var slugDraft = ""
    var writeError: String?
    /// Writes still waiting to reach the server — signing out would discard them, so
    /// the confirmation says so.
    private(set) var hasUnsyncedChanges = false

    init(api: APIClient) {
        self.api = api
    }

    func load() async {
        do {
            let me = try await api.me()
            user = me.user
            slug = me.user.shareSlug
            slugDraft = me.user.shareSlug ?? ""
            hasUnsyncedChanges = (await api.syncStatus()?.pending ?? 0) > 0
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
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
