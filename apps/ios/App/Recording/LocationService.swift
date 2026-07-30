import CoreLocation
import Foundation
import OSLog
import TrackEvolutionKit

/// What can stop a recording before it starts. The messages are what the UI
/// shows — a recording that can't produce usable fixes must fail loudly and
/// immediately rather than quietly recording an empty trace.
enum RecorderError: LocalizedError, Equatable {
    case permissionDenied
    case permissionRestricted
    case locationServicesOff
    case reducedAccuracy
    case alreadyRecording

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            "Location access is off for Track Evolution. Turn it on in Settings to record laps."
        case .permissionRestricted:
            "Location access is restricted on this device, so laps can't be recorded."
        case .locationServicesOff:
            "Location Services are switched off. Turn them on in Settings to record laps."
        case .reducedAccuracy:
            "Precise Location is off. Lap timing needs it — allow precise location to record."
        case .alreadyRecording:
            "A recording is already running."
        }
    }
}

/// CoreLocation, configured for a track day and feeding the recorder.
///
/// Deliberately `CLLocationManager` rather than iOS 17's
/// `CLLocationUpdate.liveUpdates()`: the settings below — above all
/// `pausesLocationUpdatesAutomatically = false` — are the whole point of this
/// spec, and the newer API doesn't expose them.
///
/// `@MainActor` because the manager is created on the main thread, so its
/// delegate callbacks arrive there; the `assumeIsolated` calls state that fact
/// rather than papering over it with `@unchecked Sendable`.
@MainActor
@Observable
final class LocationService {
    private static let log = Logger(subsystem: "app.trackevolution", category: "location")

    /// The purpose key in `NSLocationTemporaryUsageDescriptionDictionary`.
    static let temporaryAccuracyPurposeKey = "recordLaps"

    @ObservationIgnored private let manager = CLLocationManager()
    /// Retained here because `CLLocationManager.delegate` is weak.
    @ObservationIgnored private var delegate: Delegate?

    private(set) var authorizationStatus: CLAuthorizationStatus
    private(set) var accuracyAuthorization: CLAccuracyAuthorization
    /// Set when CoreLocation itself fails mid-recording (denied, services off).
    private(set) var failure: RecorderError?

    /// Called for every delivered fix, already shaped for `Recording.addFix`.
    @ObservationIgnored var onFix: ((Recording.RawFix) -> Void)?

    @ObservationIgnored private var isUpdating = false

    init() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        let delegate = Delegate(owner: self)
        self.delegate = delegate
        manager.delegate = delegate
        configure()
    }

    private func configure() {
        // A track session is a car on a circuit: highest accuracy, every fix.
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        // Critical. Left on, iOS pauses updates when it decides you've stopped —
        // which happens in pit lane, and silently ends the recording.
        manager.pausesLocationUpdatesAutomatically = false
        // Be honest that GPS is live.
        manager.showsBackgroundLocationIndicator = true
    }

    // MARK: - Permissions

    /// Ask for *when in use* — enough to record, including in the background,
    /// alongside the location background mode and the visible indicator.
    func requestWhenInUse() {
        guard authorizationStatus == .notDetermined else { return }
        manager.requestWhenInUseAuthorization()
    }

    /// Escalate to *always*, so a recording survives more aggressively. Only
    /// meaningful once *when in use* has been granted; the system shows this at
    /// most once, and declining it is fine — recording still works.
    func requestAlways() {
        guard authorizationStatus == .authorizedWhenInUse else { return }
        manager.requestAlwaysAuthorization()
    }

    /// Precise Location off means fixes land hundreds of metres out, which no
    /// amount of gate math can rescue. Ask for it for this session.
    func requestTemporaryFullAccuracy() async {
        guard accuracyAuthorization == .reducedAccuracy else { return }
        try? await manager.requestTemporaryFullAccuracyAuthorization(
            withPurposeKey: Self.temporaryAccuracyPurposeKey
        )
        accuracyAuthorization = manager.accuracyAuthorization
    }

    /// Why a recording can't start right now, or nil when it can.
    var blocker: RecorderError? {
        if !CLLocationManager.locationServicesEnabled() { return .locationServicesOff }
        switch authorizationStatus {
        case .denied: return .permissionDenied
        case .restricted: return .permissionRestricted
        case .notDetermined: return nil  // the prompt hasn't been answered yet
        default: break
        }
        if accuracyAuthorization == .reducedAccuracy { return .reducedAccuracy }
        return nil
    }

    var isAuthorized: Bool {
        authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse
    }

    // MARK: - Updates

    func start() {
        guard !isUpdating else { return }
        failure = nil
        // Only legal once authorized, and only useful with the background mode
        // declared in Info.plist.
        manager.allowsBackgroundLocationUpdates = true
        manager.startUpdatingLocation()
        isUpdating = true
        Self.log.notice("location updates started")
    }

    func stop() {
        guard isUpdating else { return }
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        isUpdating = false
        Self.log.notice("location updates stopped")
    }

    // MARK: - Delegate

    fileprivate func deliver(_ fixes: [Recording.RawFix]) {
        for fix in fixes {
            onFix?(fix)
        }
    }

    /// A `CLLocation` in the shape `Recording.addFix` wants.
    ///
    /// Two traps: the timestamp must be the **fix's own** — a batched delivery
    /// stamped with the delivery time would collapse to one instant and be
    /// rejected as non-monotonic — and CoreLocation reports `-1` for an unknown
    /// speed or accuracy, which must become nil rather than a bogus zero.
    nonisolated static func rawFix(from location: CLLocation) -> Recording.RawFix {
        Recording.RawFix(
            timeMs: location.timestamp.timeIntervalSince1970 * 1000,
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            speed: location.speed >= 0 ? location.speed : nil,
            accuracy: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil
        )
    }

    fileprivate func handle(_ code: CLError.Code) {
        switch code {
        case .denied:
            // Either the permission was revoked or Location Services went off
            // mid-recording. Stop cleanly; what's captured is kept.
            failure = CLLocationManager.locationServicesEnabled() ? .permissionDenied : .locationServicesOff
            stop()
        case .locationUnknown:
            // Transient — a tunnel, a cold start. Keep going.
            break
        default:
            Self.log.error("location error: \(code.rawValue, privacy: .public)")
        }
    }

    fileprivate func authorizationChanged() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        if isUpdating, !isAuthorized {
            failure = authorizationStatus == .restricted ? .permissionRestricted : .permissionDenied
            stop()
        }
    }

    /// The delegate is a separate object so `LocationService` can stay
    /// `@MainActor` without the protocol conformance fighting it.
    ///
    /// The manager is created on the main thread, so these callbacks arrive there
    /// — which is what `assumeIsolated` asserts. Nothing non-`Sendable` crosses:
    /// `CLLocation` is turned into a `RawFix` value first, and the error into its
    /// code, so the closures capture only the (`@MainActor`, therefore `Sendable`)
    /// owner and plain values.
    private final class Delegate: NSObject, CLLocationManagerDelegate {
        private weak var owner: LocationService?

        init(owner: LocationService) {
            self.owner = owner
        }

        func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            let owner = self.owner
            let fixes = locations.map(LocationService.rawFix(from:))
            MainActor.assumeIsolated { owner?.deliver(fixes) }
        }

        func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
            guard let code = (error as? CLError)?.code else { return }
            let owner = self.owner
            MainActor.assumeIsolated { owner?.handle(code) }
        }

        func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
            let owner = self.owner
            MainActor.assumeIsolated { owner?.authorizationChanged() }
        }
    }
}
