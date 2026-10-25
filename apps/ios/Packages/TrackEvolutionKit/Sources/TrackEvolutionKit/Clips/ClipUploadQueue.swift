import Foundation

/// One lap's clip on its way to the server (NS-45; one per lap since NS-50's
/// *Every lap*), persisted as JSON in the app's clips directory beside the file
/// it names.
///
/// `sessionId` is the id the session `POST` answered — a **temp** (negative) id
/// when the save was queued offline, rewritten to the real one once the offline
/// queue flushes it. Everything from `clipId` on is the server's answer to the
/// create, kept so an upload resumes where it stopped after the app is killed.
public struct ClipUploadJob: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var sessionId: Int
    /// The lap's time, which is how the server finds the lap (lowest lap number
    /// on a tie), since a session `POST` never answers its laps' ids.
    public var timeMs: Int
    /// The lap's place in the session (NS-50), sent as `lap_num` beside the
    /// time; nil on a job from a manifest written before it existed, which then
    /// posts without it and is matched on its time alone.
    public var lapNum: Int?
    /// The cut's file name inside the clips directory.
    public var file: String
    public var sizeBytes: Int
    public var durationMs: Int
    /// Where the lap starts inside the cut, measured from the file.
    public var lapOffsetMs: Int
    public var clipId: Int?
    public var partBytes: Int?
    public var parts: Int?
    /// Part numbers (1-based) the server holds.
    public var uploaded: [Int]
    /// Consecutive retryable failures — the backoff's exponent. Reset by any success.
    public var failures: Int
    /// Times the server lost the upload under us (a 404 on a part or `complete`:
    /// the user deleted the clip on another device, or the cron swept an
    /// upload abandoned for a week) and it was started over.
    public var restarts: Int
    /// Epoch ms before which nothing is tried (backoff).
    public var notBeforeMs: Int?
    public var createdAtMs: Int

    public init(
        id: String, sessionId: Int, timeMs: Int, lapNum: Int? = nil, file: String, sizeBytes: Int,
        durationMs: Int, lapOffsetMs: Int, createdAtMs: Int
    ) {
        self.id = id
        self.sessionId = sessionId
        self.timeMs = timeMs
        self.lapNum = lapNum
        self.file = file
        self.sizeBytes = sizeBytes
        self.durationMs = durationMs
        self.lapOffsetMs = lapOffsetMs
        self.clipId = nil
        self.partBytes = nil
        self.parts = nil
        self.uploaded = []
        self.failures = 0
        self.restarts = 0
        self.notBeforeMs = nil
        self.createdAtMs = createdAtMs
    }

    public enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case timeMs = "time_ms"
        case lapNum = "lap_num"
        case file
        case sizeBytes = "size_bytes"
        case durationMs = "duration_ms"
        case lapOffsetMs = "lap_offset_ms"
        case clipId = "clip_id"
        case partBytes = "part_bytes"
        case parts, uploaded, failures, restarts
        case notBeforeMs = "not_before_ms"
        case createdAtMs = "created_at_ms"
    }

    /// The body of `POST /sessions/:id/clip` for this job.
    public var createBody: ClipCreateBody {
        ClipCreateBody(timeMs: timeMs, lapNum: lapNum, sizeBytes: sizeBytes, durationMs: durationMs, lapOffsetMs: lapOffsetMs)
    }
}

/// The uploader's whole persisted state: the jobs, and the clips that failed —
/// a cut that couldn't be made, or an upload the server refused — and haven't
/// yet been told to the driver (the lap row says *"Couldn't save this lap's
/// video"* once).
public struct ClipUploadManifest: Codable, Hashable, Sendable {
    public var jobs: [ClipUploadJob]
    public var failedCuts: [FailedCut]

    public init(jobs: [ClipUploadJob] = [], failedCuts: [FailedCut] = []) {
        self.jobs = jobs
        self.failedCuts = failedCuts
    }

    public struct FailedCut: Codable, Hashable, Sendable {
        public var sessionId: Int
        public var timeMs: Int
        /// The lap's place in the session, as on the job; nil for a failure
        /// recorded before NS-50, matched on its time alone.
        public var lapNum: Int?
        /// Why an *upload* was given up on — a `DropReason`'s raw value — or nil
        /// for a cut that failed. Absent in a manifest written before it existed.
        public var reason: String?

        public init(sessionId: Int, timeMs: Int, lapNum: Int? = nil, reason: String? = nil) {
            self.sessionId = sessionId
            self.timeMs = timeMs
            self.lapNum = lapNum
            self.reason = reason
        }

        public enum CodingKeys: String, CodingKey {
            case sessionId = "session_id"
            case timeMs = "time_ms"
            case lapNum = "lap_num"
            case reason
        }
    }

    public enum CodingKeys: String, CodingKey {
        case jobs
        case failedCuts = "failed_cuts"
    }
}

/// The clip uploader's state machine (NS-45), pure so it is tested without a
/// network, a file or a clock — and so Android's `:core` ports it, tests and
/// all, under the same names.
///
/// A job goes **create → parts → complete**: `POST /sessions/:id/clip` answers a
/// clip id, the part size and (on a resume) the parts already held; each part
/// is `PUT /clips/:id/parts/:n`, exactly `partBytes` long but the last; `POST
/// /clips/:id/complete` stitches them. The driver loop is the app's:
///
/// ```
/// loop:
///   action = nextAction(job, session: sessionState(...), nowMs)
///   perform action            // the app's HTTP, file and timer work
///   outcome = apply(job, action, response, nowMs)
///   persist / delete the file per outcome
/// ```
///
/// The transitions, which the tests pin one by one:
///
/// | Step | Answer | Then |
/// |---|---|---|
/// | any | session id still temp, its create still queued | wait for the offline queue |
/// | any | session id temp, create gone (the server refused it) | **drop** |
/// | any | `notBeforeMs` in the future | wait until then |
/// | create | 2xx | take `clip_id`, `part_bytes`, `parts`, `uploaded` |
/// | create | 409 *clip storage full* / *lap already has a clip* | **drop** — neither changes on retry |
/// | create | 402, 404, 400, any other 4xx | **drop** |
/// | part | 2xx | mark the part uploaded |
/// | part | 409 (*clip already uploaded*) | treat every part as held; complete |
/// | part | 404 | **restart** from create (the server lost the upload) |
/// | part | 400 / 411 (sizes disagree) | **drop** |
/// | complete | 2xx | **finished** — delete the file |
/// | complete | 409 with `missing` | forget those parts; send them again |
/// | complete | 404 | **restart** |
/// | any | transport, 401, 408, 429, 5xx | **back off**: `failures + 1`, wait `backoffMs` |
///
/// A restart past `MAX_RESTARTS` drops the job, so a clip that keeps vanishing
/// can't upload forever. Nothing is dropped for being offline, however long.
public enum ClipUploadQueue {
    /// The first retry's wait, doubled per consecutive failure up to the cap.
    public static let BACKOFF_BASE_MS = 30_000
    public static let BACKOFF_MAX_MS = 60 * 60 * 1000
    public static let MAX_RESTARTS = 3

    /// Where a job's session stands.
    public enum SessionState: Hashable, Sendable {
        /// A server id the routes can use.
        case real(Int)
        /// A temp id whose create is still in the offline queue.
        case waiting
        /// A temp id with no create behind it and no mapping: the server
        /// refused the session, so the clip has nowhere to go.
        case lost
    }

    /// Resolve a job's session id through the offline store's id map.
    public static func sessionState(_ sessionId: Int, mapped: Int?, queued: Bool) -> SessionState {
        if !OfflineStore.isTemp(sessionId) { return .real(sessionId) }
        if let mapped { return .real(mapped) }
        return queued ? .waiting : .lost
    }

    /// What to do next.
    public enum Action: Hashable, Sendable {
        case waitForSession
        case waitUntil(ms: Int)
        case create(sessionId: Int, body: ClipCreateBody)
        case uploadPart(clipId: Int, part: Int, offset: Int, length: Int)
        case complete(clipId: Int)
        case drop(reason: DropReason)
    }

    public enum DropReason: String, Hashable, Sendable {
        /// The session the clip belongs to never reached the server.
        case sessionLost = "session lost"
        /// `clip storage full`.
        case storageFull = "clip storage full"
        /// `lap already has a clip`.
        case alreadyHasClip = "lap already has a clip"
        /// 402: the account isn't Pro (any more) when the upload started.
        case proRequired = "pro required"
        /// 404 on create: the session or its lap is gone.
        case notFound = "not found"
        /// Any other refusal the server won't change its mind about.
        case refused = "refused"
        /// The server lost the upload more than `MAX_RESTARTS` times.
        case tooManyRestarts = "too many restarts"
    }

    /// What the step got back.
    public enum Response: Hashable, Sendable {
        /// The create's 2xx.
        case created(ClipUploadStart)
        /// A part's or `complete`'s 2xx.
        case ok
        /// `complete`'s 409 with the parts the server is missing.
        case missingParts([Int])
        /// Any other non-2xx, with the server's `{ error }`.
        case status(Int, error: String?)
        /// No answer at all.
        case transport
    }

    /// The result of applying a response.
    public enum Outcome: Hashable, Sendable {
        /// Keep going with the updated job (persist it).
        case `continue`(ClipUploadJob)
        /// `complete` answered: delete the local file and the job.
        case finished
        /// Give up: delete the local file and the job.
        case dropped(DropReason)
    }

    public static func nextAction(_ job: ClipUploadJob, session: SessionState, nowMs: Int) -> Action {
        let sessionId: Int
        switch session {
        case .lost: return .drop(reason: .sessionLost)
        case .waiting: return .waitForSession
        case .real(let id): sessionId = id
        }
        if let notBefore = job.notBeforeMs, notBefore > nowMs { return .waitUntil(ms: notBefore) }
        guard let clipId = job.clipId, let partBytes = job.partBytes, let parts = job.parts else {
            return .create(sessionId: sessionId, body: job.createBody)
        }
        if let part = nextPart(job) {
            let range = partRange(sizeBytes: job.sizeBytes, partBytes: partBytes, parts: parts, part: part)
            return .uploadPart(clipId: clipId, part: part, offset: range.offset, length: range.length)
        }
        return .complete(clipId: clipId)
    }

    /// The lowest part the server doesn't hold, or nil when it holds them all.
    public static func nextPart(_ job: ClipUploadJob) -> Int? {
        guard let parts = job.parts, parts > 0 else { return nil }
        let held = Set(job.uploaded)
        return (1...parts).first { !held.contains($0) }
    }

    /// Byte range of part `part` (1-based): every part `partBytes` long but the
    /// last, which is the remainder — `partSize` in `src/lib/clips.ts`.
    public static func partRange(sizeBytes: Int, partBytes: Int, parts: Int, part: Int) -> (offset: Int, length: Int) {
        let offset = (part - 1) * partBytes
        let length = part < parts ? partBytes : sizeBytes - partBytes * (parts - 1)
        return (offset, length)
    }

    /// The wait after `failures` consecutive failures: 30 s, 1 min, 2 min … 1 h.
    public static func backoffMs(_ failures: Int) -> Int {
        guard failures > 0 else { return 0 }
        let exponent = min(failures - 1, 20)
        return min(BACKOFF_BASE_MS << exponent, BACKOFF_MAX_MS)
    }

    public static func apply(_ job: ClipUploadJob, _ action: Action, _ response: Response, nowMs: Int) -> Outcome {
        var job = job
        // Retryable everywhere: no answer, or an answer that says "later".
        if isRetryable(response) {
            job.failures += 1
            job.notBeforeMs = nowMs + backoffMs(job.failures)
            return .continue(job)
        }
        switch action {
        case .create:
            switch response {
            case .created(let start):
                guard start.partBytes > 0, start.parts > 0 else { return .dropped(.refused) }
                job.clipId = start.clipId
                job.partBytes = start.partBytes
                job.parts = start.parts
                job.uploaded = start.uploaded.filter { (1...start.parts).contains($0) }.sorted()
                return succeeded(job)
            case .status(409, let error):
                if error == DropReason.storageFull.rawValue { return .dropped(.storageFull) }
                if error == DropReason.alreadyHasClip.rawValue { return .dropped(.alreadyHasClip) }
                return .dropped(.refused)
            case .status(402, _): return .dropped(.proRequired)
            case .status(404, _): return .dropped(.notFound)
            default: return .dropped(.refused)
            }
        case .uploadPart(_, let part, _, _):
            switch response {
            case .ok:
                if !job.uploaded.contains(part) { job.uploaded = (job.uploaded + [part]).sorted() }
                return succeeded(job)
            case .status(409, _):
                // The clip is already ready (a complete whose answer was lost):
                // `complete` answers it, so go straight there.
                if let parts = job.parts, parts > 0 { job.uploaded = Array(1...parts) }
                return succeeded(job)
            case .status(404, _): return restart(job)
            default: return .dropped(.refused)
            }
        case .complete:
            switch response {
            case .ok: return .finished
            case .missingParts(let missing):
                let gone = Set(missing)
                job.uploaded = job.uploaded.filter { !gone.contains($0) }
                return succeeded(job)
            case .status(404, _): return restart(job)
            default: return .dropped(.refused)
            }
        case .waitForSession, .waitUntil, .drop:
            return .continue(job)
        }
    }

    /// Which answers mean "try again later": nothing came back, the session
    /// token was refused (the app re-authenticates, and the job waits), the
    /// server was busy, or it failed.
    public static func isRetryable(_ response: Response) -> Bool {
        switch response {
        case .transport: true
        case .status(let status, _): status == 401 || status == 408 || status == 429 || status >= 500
        case .created, .ok, .missingParts: false
        }
    }

    private static func succeeded(_ job: ClipUploadJob) -> Outcome {
        var job = job
        job.failures = 0
        job.notBeforeMs = nil
        return .continue(job)
    }

    private static func restart(_ job: ClipUploadJob) -> Outcome {
        var job = job
        job.restarts += 1
        if job.restarts > MAX_RESTARTS { return .dropped(.tooManyRestarts) }
        job.clipId = nil
        job.partBytes = nil
        job.parts = nil
        job.uploaded = []
        return succeeded(job)
    }

    // MARK: - What the lap page reads

    /// Whether a job (or a failed cut) is for this lap: the same session —
    /// matched on either its temp or its real id — and the same time, and then
    /// (NS-50) the same lap number when the job has one. A job from before lap
    /// numbers falls back to the time alone, and so is for this lap only when it
    /// is the lap the server attached such a clip to — `isClipLap`, the lowest
    /// lap number with that time (`clipLap` without a number).
    public static func isFor(
        sessionId jobSession: Int, timeMs jobTime: Int, lapNum jobLap: Int?,
        sessionId: Int, resolved: Int?, timeMs: Int, lapNum: Int, isClipLap: Bool
    ) -> Bool {
        guard jobTime == timeMs, jobSession == sessionId || (resolved != nil && resolved == sessionId) else { return false }
        if let jobLap { return jobLap == lapNum }
        return isClipLap
    }

    /// The lap a clip lands on. With a lap number (NS-50), the lap with that
    /// number and time — the server's rule when `lap_num` is sent. Without one,
    /// the lowest lap number among the session's laps with that time, the rule
    /// for a create without it; a second lap tied on time never shows the first
    /// one's pending upload.
    public static func clipLap(_ laps: [Lap], timeMs: Int, lapNum: Int? = nil) -> Lap? {
        if let lapNum { return laps.first { $0.lapNum == lapNum && $0.timeMs == timeMs } }
        return laps.filter { $0.timeMs == timeMs }.min { $0.lapNum < $1.lapNum }
    }
}
