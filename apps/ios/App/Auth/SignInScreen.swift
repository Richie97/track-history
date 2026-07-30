import AuthenticationServices
import SwiftUI
import UIKit
import TrackEvolutionKit

/// Sign in with Google, or with Apple when the server advertises it.
struct SignInScreen: View {
    @Environment(AuthController.self) private var auth
    @State private var showingServerSheet = false

    var body: some View {
        ZStack {
            Color(.bgPage).ignoresSafeArea()

            VStack(spacing: 18) {
                Spacer()

                VStack(spacing: 6) {
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
                AppleSignInButton { Task { await auth.signIn(with: .apple) } }
                    .frame(height: 46)
            }
        }
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
/// approximations.
private struct AppleSignInButton: UIViewRepresentable {
    let action: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(
            authorizationButtonType: .continue, authorizationButtonStyle: .white
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
