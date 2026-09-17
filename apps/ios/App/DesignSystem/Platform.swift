import Foundation

/// What kind of machine the process is on — one fact, read once (epic #230).
///
/// The iPad build is offered on Apple silicon Macs as a *Designed for iPad* app:
/// no second target, no Catalyst, the same bundle id and App Store record. Almost
/// everything runs there unchanged. The one thing that must not is the lap
/// recorder — a Mac has Wi-Fi location and no GPS, so a recording made on one is
/// noise, and the record screen is a phone-in-a-mount layout that makes no sense
/// in a window — and this is the value every one of its doors reads.
///
/// `isiOSAppOnMac` is the only signal that answers the question. The idiom does
/// not: `userInterfaceIdiom` reports `.pad` on a Mac, because a Designed-for-iPad
/// app *is* the iPad build. Window width does not either: that is NS-34's job, a
/// 13-inch iPad and a Mac window are both expanded, and only one of them has a
/// GPS — the NS-34 epic keeps the route reachable on the iPad on purpose.
///
/// Deliberately **not** in the Kit (it is a fact about the process, read from an
/// app framework, and the Kit forbids exactly that) and deliberately not an
/// environment value: it cannot change while the app runs, and the decisions
/// built on it are pure functions the app-target tests call with both values.
enum Platform {
    /// True when the iPad build is running on a Mac.
    static let runsOnMac: Bool = ProcessInfo.processInfo.isiOSAppOnMac

    // MARK: - The recorder's doors

    /// Whether the dashboard offers its *Record laps* button.
    ///
    /// Two conditions, and the second is the one the dashboard always had: a live
    /// recording has the always-visible banner and an unsaved one has the card, so
    /// the button is for an idle recorder only. On a Mac there is no recorder to be
    /// idle, and nothing takes the button's place — `+ Add event` alone is the web
    /// dashboard's shape.
    static func dashboardOffersRecorder(runsOnMac: Bool, recorderIdle: Bool) -> Bool {
        !runsOnMac && recorderIdle
    }

    /// Whether the event page's *Add a session* card offers the recorder.
    ///
    /// On a Mac its slot carries a sentence instead — record on the iPhone, the
    /// laps land here — because a card that silently lost one of its three doors
    /// would leave the reader wondering where recording went. Import stays: Finder
    /// is a better import door than a phone.
    static func eventPageOffersRecorder(runsOnMac: Bool) -> Bool {
        !runsOnMac
    }
}
