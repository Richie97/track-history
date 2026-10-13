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
/// - **No clip yet, on its way** (the owner's own lap, never a coach's): *Video
///   uploading* / *Video waiting for Wi-Fi*, until `ClipUploader` finishes and
///   the page re-reads its event.
/// - **A cut that failed**: *Couldn't save this lap's video*, once.
struct LapVideoSection: View {
    let session: Session
    let lap: Lap
    /// Re-read the event — after a delete, or when an upload finishes.
    var reload: () async -> Void

    @Environment(AuthController.self) private var auth
    @Environment(ClipUploader.self) private var clips: ClipUploader?
    @Environment(\.logbookOwner) private var owner
    @State private var failedCut = false

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
                if let pending = clips?.pendingText(sessionId: session.id, timeMs: lap.timeMs) {
                    TECard {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(pending)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textMuted))
                            Spacer(minLength: 0)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("lapVideoPending")
                } else if failedCut {
                    TECard {
                        Text("Couldn't save this lap's video")
                            .teStyle(.sm)
                            .foregroundStyle(Color(.textMuted))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .task(id: lap.id) {
            if !owner.isReadOnly, lap.clip == nil, isClipLap, let clips {
                failedCut = clips.takeFailedCut(sessionId: session.id, timeMs: lap.timeMs)
            }
        }
        // An upload finished somewhere: if it was this lap's, the event now
        // carries the clip.
        .onChange(of: clips?.finishedCount) { _, _ in
            if lap.clip == nil { Task { await reload() } }
        }
    }

    /// The lap a clip with this time lands on — the lowest lap number with it.
    private var isClipLap: Bool {
        ClipUploadQueue.clipLap(session.laps, timeMs: lap.timeMs)?.id == lap.id
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
                        }
                        .accessibilityLabel("Video options")
                        .accessibilityIdentifier("lapVideoMenu")
                    }
                }

                if let player {
                    VideoPlayer(player: player)
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
        // Seek once the item can, so the first play starts at the line.
        while item.status == .unknown, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        switch item.status {
        case .readyToPlay:
            let offset = CMTime(value: CMTimeValue(clip.lapOffsetMs), timescale: 1000)
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
