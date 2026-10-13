import Foundation
import Network
import OSLog
import TrackEvolutionKit

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

/// What the review hands over for one included video: where to cut from, and
/// which lap.
struct ClipCutRequest: Sendable {
    var source: ClipSource
    var lap: ParsedLap
    var durationS: Double
}

/// Cuts best-lap clips and uploads them in the background (NS-45).
///
/// The state machine is the Kit's `ClipUploadQueue`; this is its driver: the
/// manifest on disk (`Application Support/clips/manifest.json`, beside the cut
/// files, excluded from backup), the cutter, the requests, and the timers. One
/// job runs at a time, oldest first:
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
/// deleted when `complete` answers, or when the job is dropped.
@MainActor
@Observable
final class ClipUploader {
    private static let log = Logger(subsystem: "app.trackevolution", category: "clips")
    static let cellularKey = "uploadLapVideosOverCellular"
    static let sessionIdentifier = "app.trackevolution.clips"

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
    /// Temp → real session ids seen this run, so a lap page on the real id finds
    /// a job still filed under the temp one.
    private var resolvedSessions: [Int: Int] = [:]
    /// Cuts under way, as "<session>/<time>".
    private var cutting: Set<String> = []
    /// Cuts waiting for a session id: a review that saved onto the New Event
    /// form hands its drafts over before the event exists (#344), and the form
    /// posts them later. Held in memory — with their sources — until then.
    private var staged: [SessionDraft: ClipCutRequest] = [:]
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
            onFinishEvents: { [weak self] in
                Task { @MainActor in
                    self?.backgroundCompletion?()
                    self?.backgroundCompletion = nil
                }
            }
        )
        transport.inFlight { [weak self] described in
            Task { @MainActor in
                for (jobId, part) in described { self?.inFlight[jobId] = part }
                await self?.pump()
            }
        }
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            let expensive = path.isExpensive
            Task { @MainActor in
                guard let self else { return }
                let changed = self.online != online || self.onExpensiveNetwork != expensive
                self.online = online
                self.onExpensiveNetwork = expensive
                if changed { await self.pump() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.trackevolution.clips.path"))
    }

    // MARK: - What the lap page reads

    /// *Video uploading* / *Video waiting for Wi-Fi* for a lap with a clip on its
    /// way, or nil.
    func pendingText(sessionId: Int, timeMs: Int) -> String? {
        let cuttingNow = cutting.contains(Self.key(sessionId, timeMs))
            || resolvedSessions.contains { $0.value == sessionId && cutting.contains(Self.key($0.key, timeMs)) }
        let queued = manifest.jobs.contains {
            ClipUploadQueue.isFor(
                sessionId: $0.sessionId, timeMs: $0.timeMs, sessionId: sessionId,
                resolved: resolvedSessions[$0.sessionId], timeMs: timeMs
            )
        }
        guard cuttingNow || queued else { return nil }
        if onExpensiveNetwork && !allowsCellular { return "Video waiting for Wi-Fi" }
        return "Video uploading"
    }

    /// Whether this lap's cut failed and the driver hasn't been told — true
    /// once, then forgotten.
    func takeFailedCut(sessionId: Int, timeMs: Int) -> Bool {
        guard let index = manifest.failedCuts.firstIndex(where: {
            ClipUploadQueue.isFor(
                sessionId: $0.sessionId, timeMs: $0.timeMs, sessionId: sessionId,
                resolved: resolvedSessions[$0.sessionId], timeMs: timeMs
            )
        }) else { return false }
        manifest.failedCuts.remove(at: index)
        persist()
        return true
    }

    // MARK: - From the review

    /// Cut a clip for a session the review just posted, then queue its upload.
    /// Not awaited by the save: the review closes when the sessions are saved,
    /// and a cut that fails costs the clip, never the session.
    func cutAndQueue(_ request: ClipCutRequest, sessionId: Int) {
        guard let window = LapClips.clipWindow(request.lap, request.durationS),
              let lapStartS = request.lap.startT
        else { return }
        let key = Self.key(sessionId, request.lap.timeMs)
        cutting.insert(key)
        Task {
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
                    id: id, sessionId: sessionId, timeMs: request.lap.timeMs, file: output.lastPathComponent,
                    sizeBytes: cut.sizeBytes, durationMs: cut.durationMs, lapOffsetMs: cut.lapOffsetMs,
                    createdAtMs: Self.nowMs
                ))
            } catch {
                Self.log.error("clip cut failed: \(error.localizedDescription, privacy: .public)")
                manifest.failedCuts.append(.init(sessionId: sessionId, timeMs: request.lap.timeMs))
                persist()
            }
        }
    }

    /// Hold a cut for a draft the New Event form will post.
    func stage(_ request: ClipCutRequest, for draft: SessionDraft) {
        staged[draft] = request
    }

    /// The form posted a staged draft: cut its clip now.
    func sessionPosted(_ draft: SessionDraft, id: Int) {
        guard let request = staged.removeValue(forKey: draft) else { return }
        cutAndQueue(request, sessionId: id)
    }

    // MARK: - Lifecycle

    /// Sign-out, or another server: the jobs are the account's, so they go —
    /// files, transfers and all.
    func clear() {
        transport?.cancelAll()
        inFlight = [:]
        staged = [:]
        for job in manifest.jobs { deleteFiles(of: job) }
        manifest = ClipUploadManifest()
        persist()
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
        inFlight[job.id] = part
        transport.upload(request, from: partFile, description: "\(job.id) \(part)")
    }

    /// A part's answer, from the background session.
    private func partFinished(_ description: String?, status: Int?, body: Data, error: (any Error)?) {
        guard let description else { return }
        let fields = description.split(separator: " ")
        guard fields.count == 2, let part = Int(fields[1]) else { return }
        let jobId = String(fields[0])
        inFlight[jobId] = nil
        if let partFile = try? Self.partURL(jobId: jobId, part: part) {
            try? FileManager.default.removeItem(at: partFile)
        }
        // Cancelled by us (the cellular switch moved, or a sign-out): not a
        // failure, just send it again.
        if let error = error as? URLError, error.code == .cancelled {
            Task { await pump() }
            return
        }
        guard let job = manifest.jobs.first(where: { $0.id == jobId }), let clipId = job.clipId else { return }
        let response: ClipUploadQueue.Response
        if error != nil || status == nil {
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

    private static func key(_ sessionId: Int, _ timeMs: Int) -> String { "\(sessionId)/\(timeMs)" }

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
    private let onFinishEvents: @Sendable () -> Void
    private var session: URLSession!

    init(identifier: String, onComplete: @escaping Completion, onFinishEvents: @escaping @Sendable () -> Void) {
        self.onComplete = onComplete
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

    /// The parts already in the session's hands, as (job id, part).
    func inFlight(_ handler: @escaping @Sendable ([(String, Int)]) -> Void) {
        session.getAllTasks { tasks in
            let described: [(String, Int)] = tasks.compactMap { task in
                guard task.state == .running || task.state == .suspended,
                      let fields = task.taskDescription?.split(separator: " "), fields.count == 2,
                      let part = Int(fields[1])
                else { return nil }
                return (String(fields[0]), part)
            }
            handler(described)
        }
    }

    func cancelAll() {
        session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
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
