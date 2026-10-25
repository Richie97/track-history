import Foundation
import Network
import OSLog
import TrackEvolutionKit
import UIKit

/// A picked video, kept readable from the review until its clip is cut (NS-45).
///
/// A document from Files arrives security-scoped, and the parse's byte source
/// gives that scope back the moment the parse ends — but the best lap is cut at
/// *save*, so the review holds one of these per video item, and the cut holds
/// it again until it has finished. Released on save or discard, never earlier:
/// the scope is stopped when the last reference goes. A Photos asset's URL needs
/// no scope (the library permission covers it), and asking is harmless.
final class ClipSource: @unchecked Sendable {
    let url: URL
    private let scoped: Bool

    init(url: URL) {
        self.url = url
        scoped = url.startAccessingSecurityScopedResource()
    }

    deinit {
        if scoped { url.stopAccessingSecurityScopedResource() }
    }
}

/// What the review hands over for one lap of an included video: where to cut
/// from, and which lap — `lapNum` its place in the posted session, which the
/// create sends as `lap_num` (NS-50).
struct ClipCutRequest: Sendable {
    var source: ClipSource
    var lap: ParsedLap
    var lapNum: Int
    var durationS: Double
}

/// Cuts lap clips — each session's best lap, or with NS-50's *Every lap* every
/// full lap of a PDR session, one job per lap — and uploads them in the
/// background (NS-45).
///
/// The state machine is the Kit's `ClipUploadQueue`; this is its driver: the
/// manifest on disk (`Application Support/clips/manifest.json`, beside the cut
/// files, excluded from backup), the cutter, the requests, and the timers. One
/// cut and one job run at a time, oldest first — so a session saved lap by lap
/// cuts and uploads in lap order rather than a dozen at once:
///
/// - **Create and complete** are small JSON calls through `APIClient`.
/// - **Each part** is copied to a file of its own and sent by a *background*
///   `URLSession` upload task, so a 50 MiB part keeps going while the app is
///   suspended — and, if iOS ends the app meanwhile, its answer is delivered on
///   the next launch (`handleEventsForBackgroundURLSession`).
/// - **Wi-Fi only unless Settings says otherwise**: `allowsCellularAccess` on
///   every part, and no create or complete while the only path is expensive.
///
/// A job whose session id is still a temp id waits for the offline queue to
/// flush it; one whose session the server refused is dropped. The cut file is
/// deleted when `complete` answers, or when the job is dropped — and a drop is
/// told to the driver on the lap page, never swallowed.
///
/// **Nothing may sit in the background session forever.** A part handed over
/// while the app is in the background is *discretionary* to iOS whatever the
/// configuration says, and can wait hours for power and Wi-Fi; a part on a bad
/// track-side connection can hang without failing. Both looked like *Video
/// uploading* forever. So: a part created in the background is re-sent the
/// moment the app is in front again; a part that sends no bytes for
/// `stallSeconds` while the app is in front and the network is usable is
/// cancelled and retried; and arriving on a usable network, or opening the
/// app, ends any backoff, since the failures it was counting were the old
/// network's.
@MainActor
@Observable
final class ClipUploader {
    private static let log = Logger(subsystem: "app.trackevolution", category: "clips")
    static let cellularKey = "uploadLapVideosOverCellular"
    static let sessionIdentifier = "app.trackevolution.clips"
    /// How long a part may send nothing, with the app in front and a usable
    /// network, before it is treated as stuck.
    static let stallSeconds: TimeInterval = 60

    /// The lap a page asks about. `isClipLap` is whether it is the lap a clip
    /// matched on time alone lands on (the lowest lap number with its time) —
    /// what a job from before lap numbers is matched by.
    struct LapKey: Equatable {
        var sessionId: Int
        var timeMs: Int
        var lapNum: Int
        var isClipLap: Bool
    }

    /// Where one lap's clip stands, for the lap page.
    enum Status: Equatable {
        case cutting
        /// The session was saved offline and hasn't reached the server yet.
        case waitingForSession
        case waitingForConnection
        case waitingForWiFi
        /// `fraction` of the clip's bytes the server holds or is receiving.
        case uploading(fraction: Double)
        /// The last attempt failed; the next is at `atMs` (epoch ms).
        case retrying(atMs: Int)
    }

    /// Why we cancelled a part ourselves.
    private enum CancelReason {
        /// Send it again straight away: the cellular switch moved, or the part
        /// was handed over in the background and is being re-sent from the front.
        case resend
        /// It stopped moving: a failure like any other, so it backs off.
        case stalled
    }

    /// Settings' *Upload lap videos over cellular*, off by default.
    var allowsCellular: Bool {
        didSet {
            UserDefaults.standard.set(allowsCellular, forKey: Self.cellularKey)
            // Parts already handed to the system carry the old setting; send them
            // again under the new one.
            transport?.cancelAll()
            Task { await pump() }
        }
    }

    private(set) var manifest = ClipUploadManifest()
    /// Bumped each time a clip finishes uploading, so an open lap page can
    /// re-read its event and show the player.
    private(set) var finishedCount = 0
    /// Whether the only network is an expensive one (cellular, a hotspot).
    private(set) var onExpensiveNetwork = false
    private(set) var online = true

    private let auth: AuthController
    private var transport: ClipTransport!
    private let monitor = NWPathMonitor()
    /// Jobs with a part in the hands of the background session, by job id.
    private var inFlight: [String: Int] = [:]
    /// Of those, the ones whose part was handed over while the app was in the
    /// background — discretionary to iOS, so re-sent when the app comes forward.
    private var sentInBackground: Set<String> = []
    /// Bytes of the in-flight part sent so far, by job id.
    private(set) var partBytesSent: [String: Int64] = [:]
    /// When each in-flight part last sent a byte (or was last given a fresh
    /// start), by job id — the stall watchdog's clock.
    private var lastProgressAt: [String: Date] = [:]
    private var cancelReasons: [String: CancelReason] = [:]
    private var watchdog: Task<Void, Never>?
    /// Whether the previous watchdog tick found the app in front and the
    /// network usable; the first tick after either changes starts every clock.
    private var watchdogWasLive = false
    /// The network the last path update described, to notice a new one.
    private var pathSignature = ""
    /// Temp → real session ids seen this run, so a lap page on the real id finds
    /// a job still filed under the temp one.
    private var resolvedSessions: [Int: Int] = [:]
    /// Cuts under way or waiting their turn, as "<session>/<time>/<lap>".
    private var cutting: Set<String> = []
    /// The cut before the newest, which the next waits for: one cut at a time,
    /// since each reads the source and writes a file the size of a lap.
    private var cutChain: Task<Void, Never>?
    /// Cuts waiting for a session id: a review that saved onto the New Event
    /// form hands its drafts over before the event exists (#344), and the form
    /// posts them later. Held in memory — with their sources — until then.
    private var staged: [SessionDraft: [ClipCutRequest]] = [:]
    private var pumping = false
    private var pumpAgain = false
    private var wake: Task<Void, Never>?
    private var started = false
    /// The system's completion handler for a background launch, called once the
    /// session has delivered everything.
    var backgroundCompletion: (() -> Void)?

    init(auth: AuthController) {
        self.auth = auth
        allowsCellular = UserDefaults.standard.bool(forKey: Self.cellularKey)
    }

    /// Load the manifest, reattach to the background session and start
    /// watching the network. Called once, at launch.
    func start() {
        guard !started else { return }
        started = true
        manifest = Self.loadManifest()
        transport = ClipTransport(
            identifier: Self.sessionIdentifier,
            onComplete: { [weak self] description, status, body, error in
                Task { @MainActor in self?.partFinished(description, status: status, body: body, error: error) }
            },
            onProgress: { [weak self] description, sent in
                Task { @MainActor in self?.partProgressed(description, sent: sent) }
            },
            onFinishEvents: { [weak self] in
                Task { @MainActor in
                    self?.backgroundCompletion?()
                    self?.backgroundCompletion = nil
                }
            }
        )
        transport.inFlight { [weak self] descriptions in
            Task { @MainActor in
                guard let self else { return }
                for description in descriptions {
                    guard let parsed = Self.parse(description),
                          self.manifest.jobs.contains(where: { $0.id == parsed.jobId })
                    else { continue }
                    self.inFlight[parsed.jobId] = parsed.part
                    // Not known to have been sent from the front: a launch that
                    // finds a part already handed over can't tell, so it is
                    // treated as discretionary and re-sent once the app is active.
                    if parsed.background || UIApplication.shared.applicationState != .active {
                        self.sentInBackground.insert(parsed.jobId)
                    }
                }
                self.startWatchdog()
                self.resendBackgroundParts()
                await self.pump()
            }
        }
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            let expensive = path.isExpensive
            let signature = "\(online) \(expensive) \(path.availableInterfaces.map(\.name))"
            Task { @MainActor in
                guard let self else { return }
                let wasUsable = self.canUseNetwork
                let changed = self.pathSignature != signature
                self.pathSignature = signature
                self.online = online
                self.onExpensiveNetwork = expensive
                guard changed else { return }
                // A new, usable network: whatever the backoff was counting
                // happened on the old one (the track's one bar of signal), so
                // don't make the driver wait out an hour of it on home Wi-Fi.
                if self.canUseNetwork {
                    self.retryEverythingNow()
                    if !wasUsable { self.resendBackgroundParts() }
                }
                await self.pump()
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.trackevolution.clips.path"))
    }

    // MARK: - What the lap page reads

    /// Where this lap's clip stands, or nil when nothing is on its way.
    func status(_ lap: LapKey) -> Status? {
        if let job = job(lap) {
            if inFlight[job.id] != nil {
                if !online { return .waitingForConnection }
                if onExpensiveNetwork && !allowsCellular { return .waitingForWiFi }
                return .uploading(fraction: fraction(of: job))
            }
            if let notBefore = job.notBeforeMs, job.failures > 0, notBefore > Self.nowMs {
                return .retrying(atMs: notBefore)
            }
            if OfflineStore.isTemp(job.sessionId), resolvedSessions[job.sessionId] == nil {
                return .waitingForSession
            }
            if !online { return .waitingForConnection }
            if onExpensiveNetwork && !allowsCellular { return .waitingForWiFi }
            return .uploading(fraction: fraction(of: job))
        }
        let cuttingNow = cutting.contains(Self.key(lap.sessionId, lap.timeMs, lap.lapNum))
            || resolvedSessions.contains {
                $0.value == lap.sessionId && cutting.contains(Self.key($0.key, lap.timeMs, lap.lapNum))
            }
        return cuttingNow ? .cutting : nil
    }

    /// The lap page's *Retry now*: end this clip's backoff, and if a part is
    /// sitting in the background session, send it again from here.
    func retry(_ lap: LapKey) {
        guard var job = job(lap) else { return }
        job.notBeforeMs = nil
        replace(job)
        if inFlight[job.id] != nil {
            cancel(jobId: job.id, .resend)
        } else {
            Task { await pump() }
        }
    }

    /// Why this lap's clip failed, if it did and the driver hasn't been told —
    /// said once, then forgotten.
    func takeFailure(_ lap: LapKey) -> String? {
        guard let index = manifest.failedCuts.firstIndex(where: {
            ClipUploadQueue.isFor(
                sessionId: $0.sessionId, timeMs: $0.timeMs, lapNum: $0.lapNum,
                sessionId: lap.sessionId, resolved: resolvedSessions[$0.sessionId], timeMs: lap.timeMs,
                lapNum: lap.lapNum, isClipLap: lap.isClipLap
            )
        }) else { return nil }
        let failure = manifest.failedCuts.remove(at: index)
        persist()
        return Self.failureText(failure.reason)
    }

    static func failureText(_ reason: String?) -> String {
        switch reason.flatMap(ClipUploadQueue.DropReason.init(rawValue:)) {
        case .storageFull: "Couldn't upload this lap's video: your video storage is full."
        case .proRequired: "Couldn't upload this lap's video: saving lap videos needs Pro."
        case .some: "Couldn't upload this lap's video."
        case nil: "Couldn't save this lap's video."
        }
    }

    private func job(_ lap: LapKey) -> ClipUploadJob? {
        manifest.jobs.first {
            ClipUploadQueue.isFor(
                sessionId: $0.sessionId, timeMs: $0.timeMs, lapNum: $0.lapNum,
                sessionId: lap.sessionId, resolved: resolvedSessions[$0.sessionId], timeMs: lap.timeMs,
                lapNum: lap.lapNum, isClipLap: lap.isClipLap
            )
        }
    }

    /// The share of the clip's bytes the server holds, plus what the part in
    /// flight has sent.
    private func fraction(of job: ClipUploadJob) -> Double {
        guard job.sizeBytes > 0, let partBytes = job.partBytes, let parts = job.parts else { return 0 }
        let held = job.uploaded.reduce(0) {
            $0 + ClipUploadQueue.partRange(sizeBytes: job.sizeBytes, partBytes: partBytes, parts: parts, part: $1).length
        }
        let sending = inFlight[job.id] != nil ? Int(partBytesSent[job.id] ?? 0) : 0
        return min(1, Double(held + sending) / Double(job.sizeBytes))
    }

    // MARK: - From the review

    /// Cut one lap's clip for a session the review just posted, then queue its
    /// upload. Not awaited by the save: the review closes when the sessions are
    /// saved, and a cut that fails costs that lap's clip, never the session or
    /// another lap's. Cuts run one after another, in the order handed over.
    func cutAndQueue(_ request: ClipCutRequest, sessionId: Int) {
        guard let window = LapClips.clipWindow(request.lap, request.durationS),
              let lapStartS = request.lap.startT
        else { return }
        let key = Self.key(sessionId, request.lap.timeMs, request.lapNum)
        cutting.insert(key)
        let previous = cutChain
        cutChain = Task {
            await previous?.value
            defer { cutting.remove(key) }
            let id = UUID().uuidString
            do {
                let output = try ClipCutter.directory().appending(path: "\(id).mp4")
                var sourceURL = request.source.url
                #if DEBUG
                if DebugImportFixture.synthesizesClipVideo {
                    sourceURL = try await DebugImportFixture.syntheticVideo(durationS: request.durationS)
                }
                #endif
                let from = sourceURL
                let cut = try await Task.detached(priority: .utility) {
                    // `request` rides along so its source stays open until the cut is done.
                    _ = request
                    return try await ClipCutter.cut(source: from, window: window, lapStartS: lapStartS, to: output)
                }.value
                enqueue(ClipUploadJob(
                    id: id, sessionId: sessionId, timeMs: request.lap.timeMs, lapNum: request.lapNum,
                    file: output.lastPathComponent, sizeBytes: cut.sizeBytes, durationMs: cut.durationMs,
                    lapOffsetMs: cut.lapOffsetMs, createdAtMs: Self.nowMs
                ))
            } catch {
                Self.log.error("clip cut failed: \(error.localizedDescription, privacy: .public)")
                manifest.failedCuts.append(.init(sessionId: sessionId, timeMs: request.lap.timeMs, lapNum: request.lapNum))
                persist()
            }
        }
    }

    /// Hold a draft's cuts — one per lap it saves — for the New Event form to post.
    func stage(_ requests: [ClipCutRequest], for draft: SessionDraft) {
        staged[draft] = requests
    }

    /// The form posted a staged draft: cut its clips now.
    func sessionPosted(_ draft: SessionDraft, id: Int) {
        guard let requests = staged.removeValue(forKey: draft) else { return }
        for request in requests { cutAndQueue(request, sessionId: id) }
    }

    // MARK: - Lifecycle

    /// Sign-out, or another server: the jobs are the account's, so they go —
    /// files, transfers and all.
    func clear() {
        transport?.cancelAll()
        inFlight = [:]
        sentInBackground = []
        partBytesSent = [:]
        lastProgressAt = [:]
        staged = [:]
        for job in manifest.jobs { deleteFiles(of: job) }
        manifest = ClipUploadManifest()
        persist()
    }

    /// The app came to the front. Every backoff ends — the driver is looking,
    /// and whatever failed may have failed on a network they've since left —
    /// and any part handed over while the app was in the background, which iOS
    /// may be holding for hours as discretionary, is sent again from here.
    func becameActive() {
        guard started else { return }
        retryEverythingNow()
        resendBackgroundParts()
        startWatchdog()
        Task { await pump() }
    }

    /// With the app in front and a network the parts may use, send again every
    /// part iOS may be holding as discretionary.
    private func resendBackgroundParts() {
        guard UIApplication.shared.applicationState == .active, canUseNetwork else { return }
        for jobId in sentInBackground where inFlight[jobId] != nil && cancelReasons[jobId] == nil {
            Self.log.notice("re-sending a clip part handed over in the background")
            cancel(jobId: jobId, .resend)
        }
    }

    /// Take a step on everything that can move. Safe to call often.
    func pump() async {
        guard started else { return }
        if pumping {
            pumpAgain = true
            return
        }
        pumping = true
        repeat {
            pumpAgain = false
            await stepAll()
        } while pumpAgain
        pumping = false
        scheduleWake()
    }

    // MARK: - The driver

    private var canUseNetwork: Bool {
        online && (allowsCellular || !onExpensiveNetwork)
    }

    private func enqueue(_ job: ClipUploadJob) {
        manifest.jobs.append(job)
        persist()
        Task { await pump() }
    }

    /// Clear every job's backoff (not its failure count, so a server that is
    /// really down still backs off after the next failure).
    private func retryEverythingNow() {
        var changed = false
        for index in manifest.jobs.indices where manifest.jobs[index].notBeforeMs != nil {
            manifest.jobs[index].notBeforeMs = nil
            changed = true
        }
        if changed { persist() }
        // Every part gets a fresh minute before the watchdog judges it.
        let now = Date()
        for jobId in inFlight.keys { lastProgressAt[jobId] = now }
    }

    /// Every job with no part in flight takes its next step. A session saved
    /// lap by lap (NS-50) is a job per lap, all in the background session at
    /// once: one part each, so the system can carry them all while the app is
    /// suspended rather than waking it for every part in turn.
    private func stepAll() async {
        guard auth.isSignedIn else { return }
        for id in manifest.jobs.map(\.id) where inFlight[id] == nil {
            await step(jobId: id)
        }
    }

    /// Run one job until it has to wait: for its session, a backoff, the
    /// network, or a part in the background session's hands.
    private func step(jobId: String) async {
        while let job = manifest.jobs.first(where: { $0.id == jobId }), inFlight[jobId] == nil {
            guard canUseNetwork else { return }
            let state = await sessionState(of: job)
            if case .real(let real) = state, real != job.sessionId {
                resolvedSessions[job.sessionId] = real
                var mapped = job
                mapped.sessionId = real
                replace(mapped)
                continue
            }
            let action = ClipUploadQueue.nextAction(job, session: state, nowMs: Self.nowMs)
            switch action {
            case .waitForSession, .waitUntil:
                return
            case .drop(let reason):
                drop(job, reason)
                return
            case .create(let sessionId, let body):
                let response: ClipUploadQueue.Response
                do {
                    response = .created(try await auth.api.createClip(sessionId: sessionId, body))
                } catch {
                    response = Self.response(for: error)
                }
                handle(ClipUploadQueue.apply(job, action, response, nowMs: Self.nowMs), job)
            case .uploadPart(let clipId, let part, let offset, let length):
                do {
                    try await send(job: job, clipId: clipId, part: part, offset: offset, length: length)
                } catch {
                    // The part file couldn't be written (the cut is gone, or the
                    // disk is full): there is nothing to send, now or later.
                    Self.log.error("clip part failed locally: \(error.localizedDescription, privacy: .public)")
                    drop(job, .refused)
                }
                return
            case .complete(let clipId):
                let response: ClipUploadQueue.Response
                do {
                    _ = try await auth.api.completeClip(id: clipId)
                    response = .ok
                } catch let missing as ClipMissingParts {
                    response = .missingParts(missing.missing)
                } catch {
                    response = Self.response(for: error)
                }
                handle(ClipUploadQueue.apply(job, action, response, nowMs: Self.nowMs), job)
            }
        }
    }

    private func sessionState(of job: ClipUploadJob) async -> ClipUploadQueue.SessionState {
        guard OfflineStore.isTemp(job.sessionId) else { return .real(job.sessionId) }
        let state = await auth.api.tempIdState(job.sessionId)
        return ClipUploadQueue.sessionState(job.sessionId, mapped: state.mapped, queued: state.queued)
    }

    /// Copy one part to its own file and hand it to the background session.
    private func send(job: ClipUploadJob, clipId: Int, part: Int, offset: Int, length: Int) async throws {
        let source = try ClipCutter.directory().appending(path: job.file)
        let partFile = try Self.partURL(jobId: job.id, part: part)
        try await Task.detached(priority: .utility) {
            try Self.copyRange(of: source, offset: offset, length: length, to: partFile)
        }.value
        var request = try await auth.api.authorizedRequest("PUT", "/clips/\(clipId)/parts/\(part)")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.allowsCellularAccess = allowsCellular
        let background = UIApplication.shared.applicationState == .background
        inFlight[job.id] = part
        partBytesSent[job.id] = 0
        lastProgressAt[job.id] = Date()
        if background { sentInBackground.insert(job.id) } else { sentInBackground.remove(job.id) }
        transport.upload(request, from: partFile, description: "\(job.id) \(part)" + (background ? " bg" : ""))
        startWatchdog()
    }

    /// `"<job> <part>"`, plus `" bg"` when it was handed over in the background.
    private nonisolated static func parse(_ description: String?) -> (jobId: String, part: Int, background: Bool)? {
        guard let fields = description?.split(separator: " "), fields.count == 2 || fields.count == 3,
              let part = Int(fields[1])
        else { return nil }
        return (String(fields[0]), part, fields.count == 3 && fields[2] == "bg")
    }

    private func partProgressed(_ description: String?, sent: Int64) {
        guard let parsed = Self.parse(description), inFlight[parsed.jobId] == parsed.part else { return }
        partBytesSent[parsed.jobId] = sent
        lastProgressAt[parsed.jobId] = Date()
    }

    private func cancel(jobId: String, _ reason: CancelReason) {
        guard let part = inFlight[jobId] else { return }
        cancelReasons[jobId] = reason
        transport.cancel(where: { description in
            guard let parsed = Self.parse(description) else { return false }
            return parsed.jobId == jobId && parsed.part == part
        }, found: { [weak self] found in
            guard !found else { return }
            // No such task: the session finished or lost it without a word to
            // us. Left alone the job would wait on an answer that never comes —
            // the very "uploading forever" this exists to end — so let it go.
            Task { @MainActor in
                guard let self, self.inFlight[jobId] == part else { return }
                self.partFinished("\(jobId) \(part)", status: nil, body: Data(), error: URLError(.cancelled))
            }
        })
    }

    /// While a part is in flight and the app is in front, look every 15 s for
    /// one that has stopped moving.
    private func startWatchdog() {
        guard watchdog == nil else { return }
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                if self.inFlight.isEmpty {
                    self.watchdog = nil
                    self.watchdogWasLive = false
                    return
                }
                self.checkForStalls()
            }
        }
    }

    private func checkForStalls() {
        let live = UIApplication.shared.applicationState == .active && canUseNetwork
        defer { watchdogWasLive = live }
        // Suspended, or no network the parts may use: a quiet part is waiting,
        // not stuck — and nothing was watching while the app was away.
        guard live else { return }
        let now = Date()
        guard watchdogWasLive else {
            for jobId in inFlight.keys { lastProgressAt[jobId] = now }
            return
        }
        for jobId in inFlight.keys where cancelReasons[jobId] == nil {
            let last = lastProgressAt[jobId] ?? now
            if lastProgressAt[jobId] == nil { lastProgressAt[jobId] = now }
            if now.timeIntervalSince(last) > Self.stallSeconds {
                Self.log.notice("clip part stalled; cancelling to retry")
                cancel(jobId: jobId, .stalled)
            }
        }
    }

    /// A part's answer, from the background session.
    private func partFinished(_ description: String?, status: Int?, body: Data, error: (any Error)?) {
        guard let parsed = Self.parse(description) else { return }
        let jobId = parsed.jobId, part = parsed.part
        // A late answer for a part we've since replaced says nothing about the
        // one now in flight.
        if let current = inFlight[jobId], current != part { return }
        inFlight[jobId] = nil
        sentInBackground.remove(jobId)
        partBytesSent[jobId] = nil
        lastProgressAt[jobId] = nil
        let reason = cancelReasons.removeValue(forKey: jobId)
        if let partFile = try? Self.partURL(jobId: jobId, part: part) {
            try? FileManager.default.removeItem(at: partFile)
        }
        let cancelled = (error as? URLError)?.code == .cancelled
        // Cancelled to be sent again (the cellular switch moved, a part handed
        // over in the background, *Retry now*), or by iOS when the app was
        // force-quit: not a failure, just send it again.
        if cancelled, reason != .stalled {
            Task { await pump() }
            return
        }
        guard let job = manifest.jobs.first(where: { $0.id == jobId }), let clipId = job.clipId else { return }
        let response: ClipUploadQueue.Response
        if cancelled || error != nil || status == nil {
            response = .transport
        } else if let status, (200..<300).contains(status) {
            response = .ok
        } else {
            let message = (try? JSONDecoder().decode(ServerErrorBody.self, from: body))?.error
            response = .status(status ?? 0, error: message)
        }
        let action = ClipUploadQueue.Action.uploadPart(clipId: clipId, part: part, offset: 0, length: 0)
        handle(ClipUploadQueue.apply(job, action, response, nowMs: Self.nowMs), job)
        Task { await pump() }
    }

    private func handle(_ outcome: ClipUploadQueue.Outcome, _ job: ClipUploadJob) {
        switch outcome {
        case .continue(let next):
            replace(next)
        case .finished:
            remove(job)
            finishedCount += 1
            // The storage line and the review's quota read `/me`.
            Task { await auth.refreshAccount() }
        case .dropped(let reason):
            drop(job, reason)
        }
    }

    private func drop(_ job: ClipUploadJob, _ reason: ClipUploadQueue.DropReason) {
        Self.log.notice("clip upload dropped: \(reason.rawValue, privacy: .public)")
        // Say so on the lap page rather than letting the video quietly not
        // appear. A lap that already has a clip shows it, which says enough.
        if reason != .alreadyHasClip {
            manifest.failedCuts.append(.init(
                sessionId: job.sessionId, timeMs: job.timeMs, lapNum: job.lapNum, reason: reason.rawValue
            ))
        }
        remove(job)
    }

    private func replace(_ job: ClipUploadJob) {
        guard let index = manifest.jobs.firstIndex(where: { $0.id == job.id }) else { return }
        manifest.jobs[index] = job
        persist()
    }

    private func remove(_ job: ClipUploadJob) {
        manifest.jobs.removeAll { $0.id == job.id }
        deleteFiles(of: job)
        persist()
    }

    private func deleteFiles(of job: ClipUploadJob) {
        guard let dir = try? ClipCutter.directory() else { return }
        try? FileManager.default.removeItem(at: dir.appending(path: job.file))
        if let parts = try? FileManager.default.contentsOfDirectory(at: dir.appending(path: "parts"), includingPropertiesForKeys: nil) {
            for file in parts where file.lastPathComponent.hasPrefix("\(job.id)-") {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    /// Come back when the soonest backoff ends, or in half a minute while a job
    /// waits on its session — the offline queue flushes on its own schedule.
    private func scheduleWake() {
        wake?.cancel()
        let idle = manifest.jobs.filter { inFlight[$0.id] == nil }
        guard !idle.isEmpty else { return }
        let now = Self.nowMs
        let soonest = idle.compactMap(\.notBeforeMs).min().map { max(1_000, $0 - now) } ?? 30_000
        let delay = min(soonest, 30_000)
        wake = Task {
            try? await Task.sleep(for: .milliseconds(delay))
            if !Task.isCancelled { await pump() }
        }
    }

    /// The Kit's reading of an answer that came back as an error.
    private static func response(for error: any Error) -> ClipUploadQueue.Response {
        guard let api = error as? APIError else { return .transport }
        switch api {
        case .transport, .decoding: return .transport
        case .readOnly: return .status(403, error: api.message)
        case .unauthorized, .proRequired, .server: return .status(api.status ?? 0, error: api.message)
        }
    }

    // MARK: - Files

    private static var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    private static func key(_ sessionId: Int, _ timeMs: Int, _ lapNum: Int) -> String { "\(sessionId)/\(timeMs)/\(lapNum)" }

    private static func partURL(jobId: String, part: Int) throws -> URL {
        let dir = try ClipCutter.directory().appending(path: "parts", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appending(path: "\(jobId)-\(part).part")
    }

    private nonisolated static func copyRange(of source: URL, offset: Int, length: Int, to target: URL) throws {
        try? FileManager.default.removeItem(at: target)
        FileManager.default.createFile(atPath: target.path, contents: nil)
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: target)
        defer { try? output.close() }
        try input.seek(toOffset: UInt64(offset))
        var remaining = length
        while remaining > 0 {
            let chunk = try input.read(upToCount: min(remaining, 4 * 1024 * 1024)) ?? Data()
            if chunk.isEmpty { throw CocoaError(.fileReadCorruptFile) }
            try output.write(contentsOf: chunk)
            remaining -= chunk.count
        }
    }

    private static func manifestURL() throws -> URL {
        try ClipCutter.directory().appending(path: "manifest.json")
    }

    private static func loadManifest() -> ClipUploadManifest {
        guard let url = try? manifestURL(), let data = try? Data(contentsOf: url),
              let manifest = try? JSONDecoder().decode(ClipUploadManifest.self, from: data)
        else { return ClipUploadManifest() }
        return manifest
    }

    private func persist() {
        do {
            let data = try JSONEncoder().encode(manifest)
            try data.write(to: Self.manifestURL(), options: .atomic)
        } catch {
            Self.log.error("clip manifest not saved: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// The background `URLSession` the parts go up on, and its delegate.
///
/// A background session needs a delegate rather than completion handlers, and
/// it outlives the process: a part still uploading when iOS ends the app is
/// answered here on the next launch, under the same identifier.
final class ClipTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    typealias Completion = @Sendable (_ description: String?, _ status: Int?, _ body: Data, _ error: (any Error)?) -> Void

    private let lock = NSLock()
    private var bodies: [Int: Data] = [:]
    private let onComplete: Completion
    private let onProgress: @Sendable (_ description: String?, _ sent: Int64) -> Void
    private let onFinishEvents: @Sendable () -> Void
    private var session: URLSession!

    init(
        identifier: String,
        onComplete: @escaping Completion,
        onProgress: @escaping @Sendable (_ description: String?, _ sent: Int64) -> Void,
        onFinishEvents: @escaping @Sendable () -> Void
    ) {
        self.onComplete = onComplete
        self.onProgress = onProgress
        self.onFinishEvents = onFinishEvents
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sessionSendsLaunchEvents = true
        // Not discretionary: the driver asked for this upload, and the system's
        // own Wi-Fi-and-power scheduling would hold a part for hours.
        config.isDiscretionary = false
        // Per request, from Settings; the session itself allows both so the
        // request's own flag decides.
        config.allowsCellularAccess = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func upload(_ request: URLRequest, from file: URL, description: String) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = description
        task.resume()
    }

    /// The descriptions of the parts already in the session's hands.
    func inFlight(_ handler: @escaping @Sendable ([String]) -> Void) {
        session.getAllTasks { tasks in
            handler(tasks.compactMap { task in
                task.state == .running || task.state == .suspended ? task.taskDescription : nil
            })
        }
    }

    func cancelAll() {
        session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    }

    /// Cancel the running tasks whose description matches; each answers
    /// through `onComplete` with `URLError.cancelled`. `found` says whether
    /// there was one.
    func cancel(where matches: @escaping @Sendable (String?) -> Bool, found: @escaping @Sendable (Bool) -> Void) {
        session.getAllTasks { tasks in
            let matching = tasks.filter {
                ($0.state == .running || $0.state == .suspended) && matches($0.taskDescription)
            }
            matching.forEach { $0.cancel() }
            found(!matching.isEmpty)
        }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64, totalBytesExpectedToSend: Int64
    ) {
        onProgress(task.taskDescription, totalBytesSent)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock { bodies[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let body = lock.withLock { bodies.removeValue(forKey: task.taskIdentifier) } ?? Data()
        let status = (task.response as? HTTPURLResponse)?.statusCode
        onComplete(task.taskDescription, status, body, error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        onFinishEvents()
    }
}
