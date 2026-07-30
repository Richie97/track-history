import CoreLocation
import Foundation
import OSLog
import TrackEvolutionKit

/// The app-global lap recorder: one recording at a time, owned above the view
/// tree so navigating away can't end it.
///
/// `public/js/record/ui.js` is the behavioral reference — start/stop, the
/// forgot-to-stop auto-stop, and the "here's a recording you didn't save" prompt
/// on next launch. The mechanics are native, though: fixes come from
/// `LocationService` and land on disk one at a time (`FixJournal`) instead of
/// being checkpointed every ~10 s.
@MainActor
@Observable
final class RecordingController {
    private static let log = Logger(subsystem: "app.trackevolution", category: "recorder")

    enum Phase: Equatable {
        case idle
        /// Fixes are arriving.
        case recording
        /// Stopped, and waiting to be reviewed and saved — or discarded. The
        /// recording stays on disk until one of those happens.
        case stopped(StopReason)
    }

    enum StopReason: Equatable {
        case user
        /// 15 minutes stationary after being driven at track pace: the driver
        /// forgot to stop.
        case forgotToStop
        /// The four-hour hard cap.
        case durationCap
        /// CoreLocation gave up mid-recording; what was captured is kept.
        case locationFailure(RecorderError)
    }

    private(set) var phase: Phase = .idle
    /// The live recording, or the stopped one awaiting review.
    private(set) var recording: Recording?
    /// Surfaced by the UI, cleared when acknowledged.
    var error: RecorderError?
    /// A recording found on disk at launch that was never saved.
    private(set) var recovered: Recording?
    /// When the last fix arrived, so the UI can say the stream has stalled.
    /// Silence during a session is the worst outcome — it has to be visible.
    private(set) var lastFixAt: Date?

    let location: LocationService
    private let journal: FixJournal
    private let now: @MainActor () -> Double

    init(
        location: LocationService = LocationService(),
        journal: FixJournal = FixJournal(),
        now: @MainActor @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.location = location
        self.journal = journal
        self.now = now
        location.onFix = { [weak self] fix in self?.ingest(fix) }
    }

    // MARK: - Derived state

    var isRecording: Bool { phase == .recording }
    var fixCount: Int { recording?.fixes.count ?? 0 }
    /// Seconds since the recording started, for the elapsed readout.
    var elapsedS: Double { recording.map { $0.elapsedS(nowMs: now()) } ?? 0 }
    /// The best speed we can show: the newest fix's, when it reported one.
    var lastSpeedMps: Double? { recording?.fixes.last?.v }
    /// Reported horizontal accuracy of the newest fix, in metres.
    var lastAccuracyM: Double? { recording?.fixes.last?.acc }
    /// Accuracy bad enough that lap timing will suffer, though fixes above
    /// MAX_ACC_M are dropped outright by `addFix`.
    var isAccuracyPoor: Bool { (lastAccuracyM ?? 0) > 25 }

    /// No fix for a while: a stalled stream, not just a slow one. Recording at
    /// track pace delivers ~1 Hz or better, so ten seconds of nothing is wrong.
    var isStalled: Bool {
        guard phase == .recording else { return false }
        guard let lastFixAt else { return true }
        return Date().timeIntervalSince(lastFixAt) > 10
    }

    // MARK: - Lifecycle

    /// Ask for permission ahead of the first recording, so the system prompt
    /// doesn't land in the middle of starting one.
    func prepare() {
        location.requestWhenInUse()
    }

    /// Start recording. `eventId` is nil for a recording started before its event
    /// exists — from CarPlay, say — which is adopted later by `attach(eventId:)`.
    func start(eventId: Int?) throws {
        guard phase != .recording else { throw RecorderError.alreadyRecording }
        if let blocker = location.blocker {
            error = blocker
            throw blocker
        }
        guard location.isAuthorized else {
            // Not yet answered: ask, and let the user start again once granted.
            location.requestWhenInUse()
            return
        }
        // Recording works on when-in-use plus the background mode; always is
        // better, so ask once. Declining changes nothing.
        location.requestAlways()

        let fresh = Recording(eventId: eventId, startedAtMs: now())
        do {
            try journal.begin(fresh)
        } catch {
            // Durability is gone, but the recording itself still works — better a
            // recording that can't survive a kill than no recording at all.
            Self.log.error("could not open the fix journal: \(error.localizedDescription, privacy: .public)")
        }
        recording = fresh
        lastFixAt = nil
        phase = .recording
        location.start()
        Self.log.notice("recording started for event \(eventId ?? -1, privacy: .public)")
    }

    /// Stop recording and hold the result for review. Nothing is deleted here.
    func stop(reason: StopReason = .user) {
        guard phase == .recording else { return }
        location.stop()
        journal.close()
        phase = .stopped(reason)
        Self.log.notice("recording stopped: \(String(describing: reason), privacy: .public) with \(self.fixCount) fixes")
    }

    /// Throw away the stopped recording, on disk and in memory.
    func discard() {
        location.stop()
        journal.clear()
        recording = nil
        recovered = nil
        phase = .idle
    }

    /// The recording has been saved to a session — forget it.
    func finishSaving() {
        journal.clear()
        recording = nil
        recovered = nil
        phase = .idle
    }

    /// Adopt an event-less recording into an event, mirroring the web app's
    /// `bindRecorder`: the event can be created after the session was driven.
    func attach(eventId: Int) {
        guard var current = recording, current.eventId == nil else { return }
        current.eventId = String(eventId)
        recording = current
        if phase == .recording {
            // Re-checkpoint so a crash after attaching doesn't lose the link.
            try? journal.rewrite(current)
        }
    }

    /// The parsed recording for the review flow, or nil when there's too little
    /// to time.
    func parsed() -> ParsedRecording? {
        recording?.toParsed()
    }

    // MARK: - Recovery

    /// Look for a recording the app died on. Called once at launch.
    func recoverIfNeeded() {
        #if DEBUG
        // Test hook, the counterpart to -resetAuth: an unsaved recording survives
        // on disk by design, which makes a UI test that records non-idempotent.
        //   xcrun simctl launch <device> app.trackevolution -resetRecording
        if ProcessInfo.processInfo.arguments.contains("-resetRecording") {
            journal.clear()
            return
        }
        #endif
        guard phase == .idle, recording == nil else { return }
        guard let found = journal.recover() else { return }
        recovered = found
        recording = found
        phase = .stopped(.user)
        Self.log.notice("recovered an unsaved recording with \(found.fixes.count) fixes")
    }

    // MARK: - Fix ingestion

    private func ingest(_ fix: Recording.RawFix) {
        guard phase == .recording, var current = recording else { return }
        guard current.addFix(fix), let stored = current.fixes.last else { return }
        recording = current
        lastFixAt = Date()
        journal.append(stored)

        if let failure = location.failure {
            stop(reason: .locationFailure(failure))
            error = failure
            return
        }
        // Both triggers: the hard cap, and stationary-after-driven. A grid wait
        // never trips the second one because nothing fast has been seen yet.
        let nowMs = now()
        if current.shouldAutoStop(nowMs: nowMs) {
            stop(reason: current.elapsedS(nowMs: nowMs) > RecorderCore.MAX_DURATION_S ? .durationCap : .forgotToStop)
        }
    }
}
