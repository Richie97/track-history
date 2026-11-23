import SwiftUI
import TrackEvolutionKit

// Publish a best-lap video to YouTube (NS-46,
// docs/specs/native/NS-46-youtube-upload.md). The upload runs on the server —
// R2 to YouTube — so the phone is a form and a status line: nothing here reads
// the video, and an upload carries on with the app closed. Every sentence and
// decision is the Kit's `YouTubeUpload`, the port of `public/js/youtube.js`.

/// The pushed page behind *Upload to YouTube…* and *Connect YouTube…*
/// (`Route.youtubeUpload(clipId:)`): the consent text and Connect while there is
/// no live grant, the form once there is.
///
/// A page, never a sheet — the lap page already presents one. What is typed is
/// held on the router (`heldFields`, with the event form's `_hydrated` rule), so
/// a resize across 840 pt keeps it and a draft arriving late never overwrites
/// it.
struct YouTubeUploadScreen: View {
    let clipId: Int

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var account: String?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var sendError: String?
    @State private var sending = false

    private var route: Route { .youtubeUpload(clipId: clipId) }
    private var youtube: YouTubeAccount? { auth.me?.user.youtube }

    var body: some View {
        TEPage {
            if youtube?.available != true {
                TEEmpty("Uploading to YouTube isn't available on this account.")
            } else if youtube?.connected != true {
                TECard { YouTubeConnectStep() }
            } else if let loadError {
                TEErrorBanner(message: loadError)
                TERetryButton { await load() }
            } else if loaded {
                form
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .background(Color(.bgPage))
        .navigationTitle("Upload to YouTube")
        .navigationBarTitleDisplayMode(.inline)
        // Keyed on the grant: connecting on this page loads the draft next.
        .task(id: youtube?.connected == true) {
            if youtube?.connected == true, !loaded { await load() }
        }
    }

    @ViewBuilder
    private var form: some View {
        TECard {
            VStack(alignment: .leading, spacing: 14) {
                TEField(
                    label: "Title",
                    hint: "\(YouTubeUpload.titleLength(held("title").wrappedValue)) / \(YouTubeUpload.YOUTUBE_TITLE_MAX)"
                ) {
                    TextField("Title", text: title)
                        .teInput()
                        .accessibilityIdentifier("youtubeTitle")
                }
                TEField(label: "Description") {
                    TextField("Description", text: held("description"), axis: .vertical)
                        .teInput()
                        .lineLimit(4...10)
                        .accessibilityIdentifier("youtubeDescription")
                }
                TEField(label: "Visibility") {
                    Picker("Visibility", selection: held("privacy")) {
                        ForEach(YouTubeUpload.YOUTUBE_PRIVACY, id: \.value) { choice in
                            Text(choice.label).tag(choice.value)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("youtubePrivacy")
                }
                Text(
                    (account.map { "Uploading to \($0) · " } ?? "") + YouTubeUpload.YOUTUBE_KIDS_TEXT
                )
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
            }
        }
        if let sendError {
            TEErrorBanner(message: sendError)
        }
        Button(sending ? "Starting…" : "Upload") {
            Task { await send() }
        }
        .buttonStyle(TEButtonStyle(kind: .accent))
        .disabled(sending || held("title").wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("youtubeUpload")
    }

    private func held(_ key: String) -> Binding<String> {
        Binding(
            get: { router.heldText(route, key) },
            set: { router.hold($0, key, route) }
        )
    }

    /// The title, kept inside YouTube's limit — counted in code points, the
    /// server's way — so a send isn't refused for a length the form could hold.
    private var title: Binding<String> {
        Binding(
            get: { router.heldText(route, "title") },
            set: { next in
                let scalars = next.unicodeScalars
                let kept = scalars.count > YouTubeUpload.YOUTUBE_TITLE_MAX
                    ? String(String.UnicodeScalarView(scalars.prefix(YouTubeUpload.YOUTUBE_TITLE_MAX)))
                    : next
                router.hold(kept, "title", route)
            }
        )
    }

    private func load() async {
        loadError = nil
        do {
            let draft = try await auth.api.youTubeDraft(clipId: clipId)
            account = draft.account
            // A draft arriving after a restore never overwrites what was typed.
            if router.heldText(route, "_hydrated").isEmpty {
                router.hold(draft.title, "title", route)
                router.hold(draft.description, "description", route)
                let known = YouTubeUpload.YOUTUBE_PRIVACY.contains { $0.value == draft.privacy }
                router.hold(known ? draft.privacy : YouTubeUpload.YOUTUBE_DEFAULT_PRIVACY, "privacy", route)
                router.hold("1", "_hydrated", route)
            }
            loaded = true
        } catch let error as APIError {
            loadError = Self.words(for: error)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func send() async {
        sending = true
        sendError = nil
        defer { sending = false }
        do {
            let upload = try await auth.api.startYouTubeUpload(
                clipId: clipId,
                YouTubeUploadBody(
                    title: router.heldText(route, "title"),
                    description: router.heldText(route, "description"),
                    privacy: router.heldText(route, "privacy")
                )
            )
            auth.noteYouTubeUpload(clipId, upload)
            dismiss()
        } catch let error as APIError {
            sendError = Self.words(for: error)
        } catch {
            sendError = error.localizedDescription
        }
    }

    static func words(for error: APIError) -> String {
        switch error {
        case .transport: YouTubeUpload.YOUTUBE_OFFLINE
        case .proRequired: YouTubeUpload.youtubeRequestError("pro required")
        default: YouTubeUpload.youtubeRequestError(error.message)
        }
    }
}

/// The consent explanation, word for word as on the web, with the two
/// documents Google's API terms require as links under it.
struct YouTubeConsentText: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(YouTubeUpload.YOUTUBE_CONNECT_TEXT)
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(YouTubeUpload.YOUTUBE_LINKS, id: \.url) { link in
                Link(link.label, destination: link.url)
                    .font(.footnote)
                    .tint(Color(.accentInk))
            }
        }
    }
}

/// The consent text, *Connect YouTube…*, and what the round trip said — the
/// upload page's first step and Settings' not-connected state.
struct YouTubeConnectStep: View {
    @Environment(AuthController.self) private var auth
    @State private var connecting = false
    @State private var result: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            YouTubeConsentText()
            Button(connecting ? "Connecting…" : "Connect YouTube…") {
                Task {
                    connecting = true
                    result = await auth.connectYouTube()
                    connecting = false
                }
            }
            .buttonStyle(TEButtonStyle(kind: .quiet))
            .disabled(connecting)
            .accessibilityIdentifier("youtubeConnect")
            if let result, result != "connected", let words = YouTubeUpload.YOUTUBE_RESULT_TEXT[result] {
                Text(words)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.dangerInk))
                    .accessibilityIdentifier("youtubeConnectResult")
            }
        }
    }
}

/// Under a lap's player: where its YouTube upload stands. *Waiting…* /
/// *Uploading · 40%* polled every 5 s while the page is visible, *On YouTube ·
/// Unlisted* with Open, or the failure with *Try again*. Draws nothing in any
/// other state — the menu carries *Upload to YouTube…* and *Connect YouTube…*.
struct YouTubeClipStatus: View {
    let clip: LapClip
    /// Re-read the event once an upload reaches an end, so the lap carries it.
    var reload: () async -> Void

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router: AppRouter?
    @Environment(\.logbookOwner) private var owner
    @Environment(\.openURL) private var openURL

    var body: some View {
        let offer = auth.youtubeOffer(for: clip, readOnly: owner.isReadOnly)
        Group {
            switch offer {
            case .pending, .done, .failed:
                HStack(spacing: 10) {
                    if offer == .pending { ProgressView() }
                    Text(line)
                        .teStyle(.sm)
                        .foregroundStyle(Color(offer == .failed ? .dangerInk : .textMuted))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if offer == .done, let url {
                        action("Open") { openURL(url) }
                    } else if offer == .failed {
                        action("Try again", tryAgain)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityActions {
                    if offer == .done, let url { Button("Open on YouTube") { openURL(url) } }
                    if offer == .failed { Button("Try again", action: tryAgain) }
                }
                .accessibilityIdentifier("lapVideoYouTube")
            case .none, .locked, .connect, .upload:
                EmptyView()
            }
        }
        .task(id: offer == .pending ? clip.id : nil) {
            guard offer == .pending else { return }
            await poll()
        }
    }

    private var latest: YouTubeUpload? { auth.youtubeUploads[clip.id] }

    private var line: String {
        latest.map { YouTubeUpload.youtubeStatusLine($0) } ?? YouTubeUpload.youtubeStatusLine(clip.youtube)
    }

    private var url: URL? {
        (latest?.url ?? clip.youtube?.url).flatMap(URL.init(string:))
    }

    private func tryAgain() {
        router?.push(.youtubeUpload(clipId: clip.id))
    }

    // A text button, not `TEButtonStyle`: that style fills its column.
    private func action(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title)
                .teStyle(.sm)
                .foregroundStyle(Color(.accentInk))
                .contentShape(Rectangle().inset(by: -10))
        }
        .buttonStyle(.plain)
    }

    /// Cancelled with the view, so it polls only while the page is visible. A
    /// failed read is skipped — the next one is five seconds away.
    private func poll() async {
        while !Task.isCancelled {
            if let upload = try? await auth.api.youTubeUpload(clipId: clip.id) {
                auth.noteYouTubeUpload(clip.id, upload)
                if !YouTubeUpload.youtubeIsPending(upload.status) {
                    await reload()
                    return
                }
            }
            try? await Task.sleep(for: .seconds(5))
        }
    }
}

/// Settings → YouTube, drawn only while `user.youtube.available`: which account
/// is connected, *Disconnect* and Google's permissions page — or the consent
/// text and *Connect YouTube…*. Its own view so its confirmation hangs off its
/// own button.
struct YouTubeSettingsCard: View {
    @Environment(AuthController.self) private var auth
    @State private var confirming = false
    @State private var working = false
    @State private var error: String?

    var body: some View {
        let youtube = auth.me?.user.youtube
        TECard {
            VStack(alignment: .leading, spacing: 12) {
                Text(YouTubeUpload.youtubeAccountLine(youtube))
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("youtubeAccountLine")
                if youtube?.connected == true {
                    Text("Upload a lap's video from its lap page.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                    Button(working ? "Disconnecting…" : "Disconnect") { confirming = true }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .disabled(working)
                        .accessibilityIdentifier("youtubeDisconnect")
                        .confirmationDialog("Disconnect YouTube?", isPresented: $confirming, titleVisibility: .visible) {
                            Button("Disconnect", role: .destructive) { Task { await disconnect() } }
                            Button("Keep", role: .cancel) {}
                        } message: {
                            Text(YouTubeUpload.YOUTUBE_DISCONNECT_NOTE)
                        }
                    Link("Manage Google permissions", destination: YouTubeUpload.GOOGLE_PERMISSIONS_URL)
                        .font(.footnote)
                        .tint(Color(.accentInk))
                } else {
                    YouTubeConnectStep()
                }
                if let error {
                    Text(error)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.dangerInk))
                }
            }
        }
    }

    private func disconnect() async {
        working = true
        error = nil
        defer { working = false }
        do {
            try await auth.api.disconnectYouTube()
            auth.forgetYouTubeUploads()
            await auth.refreshAccount()
        } catch let failure as APIError {
            if case .transport = failure {
                error = "Disconnecting YouTube needs a connection."
            } else {
                error = failure.message
            }
        } catch let failure {
            error = failure.localizedDescription
        }
    }
}
