import Foundation
import OSLog
import TrackEvolutionKit

/// Start and stop a recording with nobody looking at the phone.
///
/// The native counterpart to `platform.recorderRemote` in `public/js/record/remote.js`,
/// and the behavior is that file's, deliberately:
///
/// - It attaches to the event happening **today** when the logbook has one, using
///   `RemoteRecording.pickRecordingEvent` — ported and pinned against the web
///   implementation case for case in `contracts/logic/remote-attach.json`.
/// - Fetching the event list is **best effort only**. Signed out, offline, or no event
///   today must all still record. The GPS trace is the irreplaceable part; the event
///   is not, and an unattached recording is adopted later by the first event whose
///   record screen it's opened from.
/// - The only refusal is `gps`: the recorder wouldn't start. That reads as "No GPS
///   signal" on the head unit rather than a silent no-op.
///
/// One behavior of the web version is **not** carried over. `remote.js` sets
/// `location.hash` on start, to land the phone UI somewhere the recording is reachable
/// when next opened. Natively that's unnecessary: `RecordingBanner` is a
/// `safeAreaInset` on every screen, so a running recording is always one tap away
/// wherever the phone happens to be — and silently moving someone's screen while they
/// drive is worse than not doing it.
@MainActor
@Observable
final class RemoteRecorder {
    private static let log = Logger(subsystem: "app.trackevolution", category: "carplay")

    /// What a remote command answers with — `{ ok, eventId }` / `{ ok: false, reason }`
    /// in the JS.
    struct Outcome: Equatable {
        var ok: Bool
        var eventId: Int?
        var reason: Reason?

        static func started(eventId: Int?) -> Outcome { Outcome(ok: true, eventId: eventId, reason: nil) }
        static let stopped = Outcome(ok: true, eventId: nil, reason: nil)
        static func refused(_ reason: Reason) -> Outcome { Outcome(ok: false, eventId: nil, reason: reason) }
    }

    enum Reason: String, Equatable {
        /// The recorder wouldn't start — no permission, or CoreLocation refused.
        case gps
        /// The account is free and the recorder is gated (NS-32). A head unit can't
        /// show a paywall, so the refusal says where to subscribe instead — and
        /// the gate is decided from the cached entitlement, so a Pro driver with
        /// no signal in the paddock still records.
        case pro

        var carPlayMessage: String {
            switch self {
            case .gps: "No GPS signal — check location permission on the phone."
            case .pro: "Recording laps needs Track Evolution Pro — subscribe in the app on your phone."
            }
        }
    }

    private let recorder: RecordingController
    private let auth: AuthController

    /// Track names by event id, from the last successful fetch. Kept so the head unit
    /// can name the event for a recording the **phone** started too, not only one it
    /// started itself.
    private var knownEventNames: [Int: String] = [:]

    init(recorder: RecordingController, auth: AuthController) {
        self.recorder = recorder
        self.auth = auth
    }

    /// The event the live recording is attached to, named — or nil when it is waiting
    /// to be adopted, which the car screen says out loud.
    var attachedEventLabel: String? {
        guard let id = recorder.recording?.eventIdValue else { return nil }
        return knownEventNames[id]
    }

    // MARK: - Commands

    @discardableResult
    func start() async -> Outcome {
        // Already running is success, not an error: the head unit and the phone can
        // race, and a second tap must not read as a failure.
        if recorder.isRecording {
            return .started(eventId: recorder.recording?.eventIdValue)
        }
        // The same gate the phone's Start button applies, from the same cached
        // entitlement — so the two doors can't disagree about who may record.
        if ProGate.decide(.record, entitlement: auth.entitlement) == .paywall {
            Self.log.notice("remote start refused: pro required")
            return .refused(.pro)
        }

        let event = await todaysEvent()
        do {
            try recorder.start(eventId: event?.id)
        } catch {
            Self.log.notice("remote start refused: \(error.localizedDescription, privacy: .public)")
        }
        // `start` also returns without recording when permission hasn't been granted —
        // it asks instead. Either way, what matters is whether fixes are flowing.
        guard recorder.isRecording else { return .refused(.gps) }

        Self.log.notice("remote start, event \(event?.id ?? -1, privacy: .public)")
        return .started(eventId: event?.id)
    }

    @discardableResult
    func stop() -> Outcome {
        recorder.stop()
        Self.log.notice("remote stop with \(self.recorder.fixCount, privacy: .public) fixes")
        return .stopped
    }

    // MARK: - Event lookup

    /// The event covering today, or nil. **Never throws** — every failure here means
    /// "record unattached", which is the whole point.
    private func todaysEvent() async -> Event? {
        guard let events = try? await auth.api.events() else {
            Self.log.notice("event list unavailable; recording unattached")
            return nil
        }
        knownEventNames = Dictionary(events.map { ($0.id, $0.trackName) }, uniquingKeysWith: { first, _ in first })
        return RemoteRecording.pickRecordingEvent(events, todayIso: RemoteRecording.localTodayIso())
    }

    /// Warm the id → name map without starting anything, so a head unit connecting
    /// mid-recording can still name the event. Best effort, like everything else here.
    func refreshEventNames() async {
        guard let events = try? await auth.api.events() else { return }
        knownEventNames = Dictionary(events.map { ($0.id, $0.trackName) }, uniquingKeysWith: { first, _ in first })
    }
}
