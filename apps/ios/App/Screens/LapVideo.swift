import AVFoundation
import AVKit
import SwiftUI
import TrackEvolutionKit

/// The lap page's best-lap video (NS-45), in every state it can be in.
///
/// - **A clip, and the tier to play it** (the owner's own, or — in a coach's
///   view — the *student's*): the player, with *Download* and *Delete* in its
///   menu for the owner and no menu for a coach.
/// - **A clip, and no Pro**: the owner sees `ProUpsellCard` — the clip is kept,
///   and the offer is to play it — with *Delete* beside it, since deleting is
///   free, always. A coach sees the student-tier sentence instead, because the
///   upgrade is the student's to make (`studentFreeNote`'s rule).
/// - **No clip yet, on its way** (the owner's own lap, never a coach's): what
///   it is waiting for, or how far it has got — `ClipUploader.Status` — until
///   the upload finishes and the page re-reads its event. An attempt that
///   failed says so, when it will try again, and offers *Retry now*.
/// - **A cut that failed, or an upload given up on**: why, once.
struct LapVideoSection: View {
    let session: Session
    let lap: Lap
    /// Re-read the event — after a delete, or when an upload finishes.
    var reload: () async -> Void

    @Environment(AuthController.self) private var auth
    @Environment(ClipUploader.self) private var clips: ClipUploader?
    @Environment(\.logbookOwner) private var owner
    @State private var failure: String?

    var body: some View {
        Group {
            if let clip = lap.clip {
                if Entitlement.canSaveLapVideo(owner.channelEntitlement(viewer: auth.entitlement)) {
                    LapVideoPlayer(clip: clip, readOnly: owner.isReadOnly, onDeleted: reload)
                } else if owner.isReadOnly {
                    TECard {
                        Text("Lap videos play while \(owner.displayName) has Pro.")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier("lapVideoStudentLocked")
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ProUpsellCard(
                            title: "Lap video",
                            blurb: "Your best-lap video is kept. Pro plays it, downloads it and saves new ones from a video import."
                        )
                        DeleteClipButton(clipId: clip.id, onDeleted: reload)
                    }
                }
            } else if !owner.isReadOnly, isClipLap {
                if let clips, let status = clips.status(sessionId: session.id, timeMs: lap.timeMs) {
                    ClipPendingCard(status: status) {
                        clips.retry(sessionId: session.id, timeMs: lap.timeMs)
                    }
                } else if let failure {
                    TECard {
                        Text(failure)
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier("lapVideoFailed")
                }
            }
        }
        .task(id: lap.id) {
            if !owner.isReadOnly, lap.clip == nil, isClipLap, let clips {
                failure = clips.takeFailure(sessionId: session.id, timeMs: lap.timeMs)
            }
        }
        // An upload finished somewhere: if it was this lap's, the event now
        // carries the clip.
        .onChange(of: clips?.finishedCount) { _, _ in
            if lap.clip == nil { Task { await reload() } }
        }
        // An upload given up on while the page was open: say why now, not on
        // the next visit.
        .onChange(of: clips?.status(sessionId: session.id, timeMs: lap.timeMs) == nil) { _, gone in
            if gone, lap.clip == nil, !owner.isReadOnly, isClipLap, let clips, failure == nil {
                failure = clips.takeFailure(sessionId: session.id, timeMs: lap.timeMs)
            }
        }
    }

    /// The lap a clip with this time lands on — the lowest lap number with it.
    private var isClipLap: Bool {
        ClipUploadQueue.clipLap(session.laps, timeMs: lap.timeMs)?.id == lap.id
    }
}

/// A clip on its way: what it's waiting for or how far it has got, and — after
/// a failed attempt — when it tries again, with *Retry now*.
private struct ClipPendingCard: View {
    let status: ClipUploader.Status
    var retry: () -> Void

    var body: some View {
        TECard {
            // Re-drawn every few seconds so "in 2 min" counts down.
            TimelineView(.periodic(from: .now, by: 5)) { context in
                HStack(spacing: 10) {
                    if isRetrying {
                        Image(systemName: "exclamationmark.arrow.circlepath")
                            .foregroundStyle(Color(.textMuted))
                    } else {
                        ProgressView()
                    }
                    Text(Self.text(status, now: context.date))
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if isRetrying {
                        // A text button, not `TEButtonStyle`: that style fills
                        // its column, and `.fixedSize()` on it is the watchdog
                        // crash AGENTS.md lists.
                        Button(action: retry) {
                            Text("Retry now")
                                .teStyle(.sm)
                                .foregroundStyle(Color(.accentInk))
                                .contentShape(Rectangle().inset(by: -10))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if isRetrying { Button("Retry now", action: retry) }
        }
        .accessibilityIdentifier("lapVideoPending")
    }

    private var isRetrying: Bool {
        if case .retrying = status { true } else { false }
    }

    static func text(_ status: ClipUploader.Status, now: Date) -> String {
        switch status {
        case .cutting: return "Preparing video"
        case .waitingForSession: return "Video waiting for this session to sync"
        case .waitingForConnection: return "Video waiting for a connection"
        case .waitingForWiFi: return "Video waiting for Wi-Fi"
        case .uploading(let fraction):
            let percent = Int((fraction * 100).rounded(.down))
            return percent > 0 ? "Video uploading · \(percent)%" : "Video uploading"
        case .retrying(let atMs):
            let seconds = Double(atMs) / 1000 - now.timeIntervalSince1970
            let minutes = Int((seconds / 60).rounded(.up))
            return seconds <= 60
                ? "Video upload interrupted. Trying again shortly."
                : "Video upload interrupted. Trying again in \(minutes) min."
        }
    }
}

/// The player: a signed URL that plays for an hour, opened on the lap's first
/// frame — the pre-roll is one scrub back.
private struct LapVideoPlayer: View {
    let clip: LapClip
    let readOnly: Bool
    var onDeleted: () async -> Void

    @Environment(AuthController.self) private var auth
    @Environment(\.logbookOwner) private var owner
    @State private var player: AVPlayer?
    @State private var ready = false
    @State private var problem: String?
    @State private var downloading = false
    @State private var downloaded: URL?
    @State private var confirmingDelete = false
    @State private var actionError: String?

    static let needsConnection = "Playing a lap video needs a connection."

    var body: some View {
        TECard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Lap video")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textMuted))
                    Spacer()
                    if !readOnly {
                        Menu {
                            Button {
                                Task { await download() }
                            } label: {
                                Label("Download video", systemImage: "arrow.down.circle")
                            }
                            .disabled(downloading)
                            Button(role: .destructive) {
                                confirmingDelete = true
                            } label: {
                                Label("Delete video", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(Color(.textMuted))
                                .frame(width: 44, height: 44)
                                .contentShape(.rect)
                        }
                        .padding(.vertical, -12)
                        .padding(.trailing, -12)
                        .accessibilityLabel("Video options")
                        .accessibilityIdentifier("lapVideoMenu")
                    }
                }

                if let player {
                    LapPlayerView(player: player)
                        .aspectRatio(16 / 9, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("lapVideoPlayer")
                        .accessibilityValue(ready ? "ready" : "loading")
                } else if let problem {
                    Text(problem)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                        .accessibilityIdentifier("lapVideoProblem")
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .aspectRatio(16 / 9, contentMode: .fit)
                }

                if downloading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Downloading…")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                    }
                }
                if let downloaded {
                    ShareLink(item: downloaded) {
                        Label("Save or share the video", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(TEButtonStyle(kind: .quiet))
                    .accessibilityIdentifier("lapVideoShare")
                }
                if let actionError {
                    Text(actionError)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.dangerInk))
                }
            }
        }
        .confirmationDialog("Delete this lap video?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete video", role: .destructive) { Task { await delete() } }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The lap and its telemetry stay.")
        }
        .task(id: clip.id) { await load() }
        .onDisappear { player?.pause() }
    }

    private func load() async {
        problem = nil
        ready = false
        let signed: ClipURL
        do {
            signed = try await auth.api.scoped(to: owner).clipURL(id: clip.id)
        } catch let error as APIError {
            problem = Self.words(for: error)
            return
        } catch {
            problem = error.localizedDescription
            return
        }
        let item = AVPlayerItem(url: signed.url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        // Seek once the item can, so the first play starts a couple of seconds
        // before the line and the crossing is on screen.
        while item.status == .unknown, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        switch item.status {
        case .readyToPlay:
            let offset = CMTime(value: CMTimeValue(LapClips.playbackStartMs(clip.lapOffsetMs)), timescale: 1000)
            await player.seek(to: offset, toleranceBefore: .zero, toleranceAfter: .zero)
            ready = true
        case .failed:
            self.player = nil
            if let error = item.error as? URLError, [.notConnectedToInternet, .networkConnectionLost].contains(error.code) {
                problem = Self.needsConnection
            } else {
                problem = "This video couldn't be played. \(item.error?.localizedDescription ?? "")"
            }
        default:
            break
        }
    }

    static func words(for error: APIError) -> String {
        switch error {
        case .transport: needsConnection
        case .server(404, _): "This video has been deleted."
        default: error.message
        }
    }

    /// The file itself, named after its track, day and lap by the server's
    /// `Content-Disposition`, handed to the share sheet — Save to Files, Photos
    /// or anywhere else.
    private func download() async {
        downloading = true
        actionError = nil
        defer { downloading = false }
        do {
            let request = try await auth.api.authorizedRequest("GET", "/clips/\(clip.id)/download")
            let (temp, response) = try await URLSession.shared.download(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                try? FileManager.default.removeItem(at: temp)
                actionError = "Couldn't download the video."
                return
            }
            let dir = FileManager.default.temporaryDirectory.appending(path: "lap-videos", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let name = response.suggestedFilename.flatMap { $0.hasSuffix(".mp4") ? $0 : nil } ?? "lap-video-\(clip.id).mp4"
            let target = dir.appending(path: name)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temp, to: target)
            downloaded = target
        } catch let error as URLError where [.notConnectedToInternet, .networkConnectionLost].contains(error.code) {
            actionError = "Downloading a lap video needs a connection."
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func delete() async {
        actionError = nil
        do {
            try await auth.api.deleteClip(id: clip.id)
            player?.pause()
            await onDeleted()
            await auth.refreshAccount()
        } catch let error as APIError {
            if case .transport = error {
                actionError = "Deleting a lap video needs a connection."
            } else {
                actionError = error.message
            }
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// AVKit's own player controller, embedded, rather than SwiftUI's `VideoPlayer`:
/// the same controls, plus the **fullscreen** button `VideoPlayer` doesn't draw,
/// and AirPlay and rotation with it, all AVKit's. Fullscreen is
/// AVKit's own presentation from the hosting controller, not a SwiftUI
/// `.sheet`, so it doesn't count against the one-modal-per-view rule. On a Mac
/// (Designed for iPad) the same button fills the window.
private struct LapPlayerView: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.exitsFullScreenWhenPlaybackEnds = true
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }
}

/// *Delete video* on its own, for a lapsed driver whose clip is locked: a
/// delete is free, always (NS-45).
private struct DeleteClipButton: View {
    let clipId: Int
    var onDeleted: () async -> Void

    @Environment(AuthController.self) private var auth
    @State private var confirming = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button("Delete video", role: .destructive) { confirming = true }
                .buttonStyle(TEButtonStyle(kind: .quiet))
                .accessibilityIdentifier("lapVideoDelete")
            if let error {
                Text(error)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.dangerInk))
            }
        }
        .confirmationDialog("Delete this lap video?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete video", role: .destructive) {
                Task {
                    do {
                        try await auth.api.deleteClip(id: clipId)
                        await onDeleted()
                        await auth.refreshAccount()
                    } catch let failure as APIError {
                        if case .transport = failure {
                            error = "Deleting a lap video needs a connection."
                        } else {
                            error = failure.message
                        }
                    } catch let failure {
                        error = failure.localizedDescription
                    }
                }
            }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The lap and its telemetry stay.")
        }
    }
}
