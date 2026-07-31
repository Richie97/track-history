import AuthenticationServices
import SwiftUI
import UIKit
import TrackEvolutionKit

/// Sign in with Google, or with Apple when the server advertises it.
struct SignInScreen: View {
    @Environment(AuthController.self) private var auth
    /// Apple's button style is chosen against the background it sits on, so the
    /// screen has to know which one it's drawing. See `buttons`.
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingServerSheet = false

    /// `.login-buttons { max-width: 260px }` in `public/style.css`. Full-bleed
    /// buttons on a phone read as a form to fill in rather than a choice to make,
    /// and the web login card has never done it.
    ///
    /// Scaled rather than fixed: at accessibility text sizes 260pt would clip
    /// "Continue with Google", and the parent's 420pt frame still caps it.
    @ScaledMetric(relativeTo: .body) private var buttonWidth: CGFloat = 260

    /// `ASAuthorizationAppleIDButton` draws its own label and doesn't follow
    /// Dynamic Type, so a fixed height leaves it visibly slighter than the Google
    /// button at large text sizes — and the guidelines are explicit that Sign in
    /// with Apple mustn't be the less prominent option. Scaling the frame scales
    /// the label with it.
    @ScaledMetric(relativeTo: .body) private var appleButtonHeight: CGFloat = 46

    var body: some View {
        ZStack {
            Color(.bgPage).ignoresSafeArea()

            VStack(spacing: 18) {
                Spacer()

                VStack(spacing: 6) {
                    BrandMark()
                        .padding(.bottom, 10)
                    Text("Track Evolution")
                        .teStyle(.h1)
                        .foregroundStyle(Color(.textStrong))
                    Text("Your track-day logbook")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                }

                if auth.state == .signingIn {
                    ProgressView()
                        .padding(.vertical, 8)
                } else {
                    buttons
                }

                if !auth.server.isDefault {
                    devServerBadge
                }

                if let error = auth.error {
                    Text(error)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.dangerInk))
                        .multilineTextAlignment(.center)
                }

                Spacer()
                serverFooter
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: 420)
        }
        .sheet(isPresented: $showingServerSheet) {
            ServerSheet()
        }
        // Ask again every time this screen appears, not just at launch. The launch
        // fetch is a single silent attempt (`try?`), so a phone that cold-starts
        // without signal — or a sign-out in the paddock, which doesn't re-ask —
        // would leave `providers` at its Google-only default with no way back but
        // relaunching the app. This is the screen that can't work without the
        // answer, so this is where it's worth re-asking.
        .task { await auth.refreshProviders() }
    }

    @ViewBuilder
    private var buttons: some View {
        VStack(spacing: 10) {
            if auth.providers.google {
                Button("Continue with Google") {
                    Task { await auth.signIn(with: .google) }
                }
                .buttonStyle(TEButtonStyle(kind: .accent))
            }
            // Apple's own button: App Review rejects approximations, and it only
            // appears when the server carries the APPLE_* secrets. The flow still
            // goes through /auth/apple/login rather than
            // ASAuthorizationAppleIDProvider — the server owns the exchange.
            if auth.providers.apple {
                // Black on light, white on dark — Apple's rule, and the same
                // inversion `.btn.apple` already does on the web via
                // `--text-strong`/`--surface-card`. It was pinned to `.white`,
                // which put a white button on the near-white `bgPage` and was
                // near-invisible in light mode.
                AppleSignInButton(style: colorScheme == .dark ? .white : .black) {
                    Task { await auth.signIn(with: .apple) }
                }
                .frame(height: appleButtonHeight)
                // The style is fixed at init and no property can change it, so the
                // view has to be rebuilt when the theme flips.
                .id(colorScheme)
            }
        }
        .frame(maxWidth: buttonWidth)
    }

    /// A non-default server is easy to leave set by accident — and then sign-in
    /// opens a browser at a host that may not even be running, which looks like
    /// the app being broken rather than the server being absent. Say so loudly.
    private var devServerBadge: some View {
        Button {
            showingServerSheet = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text("Signing in against \(auth.server.url.absoluteString)")
            }
            .teStyle(.xs)
            .foregroundStyle(Color(.dangerInk))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.dangerTint), in: .rect(cornerRadius: TERadius.sm))
        }
        .buttonStyle(.plain)
    }

    private var serverFooter: some View {
        Button {
            showingServerSheet = true
        } label: {
            Text(auth.server.isDefault ? "trackevolution.app" : (auth.server.url.host() ?? "custom server"))
                .teStyle(.xs)
                .foregroundStyle(Color(.textFaint))
        }
        .buttonStyle(.plain)
    }
}

/// Apple's own button, wrapped so it can run *our* action.
///
/// `SignInWithAppleButton` is bound to `ASAuthorizationController`, which isn't
/// this flow — the server owns the token exchange, so the button only needs to
/// open `/auth/apple/login`. The styling has to be Apple's: App Review rejects
/// approximations, and the guidelines allow exactly three appearances (black,
/// white, white-with-outline) with no custom colors for the mark or the title.
///
/// `cornerRadius` is the one thing they do let you set — "you can use a corner
/// radius value that matches the other buttons in your UI" — so it takes
/// `TERadius.md`, the same radius `TEButtonStyle` draws.
private struct AppleSignInButton: UIViewRepresentable {
    /// Chosen by the caller against the background it sits on. The view is
    /// rebuilt (via `.id`) when that changes, because this is init-only.
    let style: ASAuthorizationAppleIDButton.Style
    let action: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(
            authorizationButtonType: .continue, authorizationButtonStyle: style
        )
        button.cornerRadius = TERadius.md
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    func updateUIView(_ uiView: ASAuthorizationAppleIDButton, context: Context) {}
}

/// Point the app at another instance — `wrangler dev`, or a self-hosted deploy.
private struct ServerSheet: View {
    @Environment(AuthController.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://trackevolution.app", text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("Server")
                } footer: {
                    Text("""
                        Point the app at your own deployment, or at `npm run dev` \
                        (http://localhost:8787 in the simulator). Changing this signs \
                        you out.
                        """)
                }

                if !auth.server.isDefault {
                    Section {
                        Button("Use trackevolution.app") {
                            Task { await auth.useServer(TrackEvolutionKit.defaultBaseURL) }
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("Server")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use") {
                        if let url = URL(string: text.trimmingCharacters(in: .whitespaces)), url.host() != nil {
                            Task { await auth.useServer(url) }
                        }
                        dismiss()
                    }
                }
            }
        }
        .onAppear { text = auth.server.url.absoluteString }
    }
}
