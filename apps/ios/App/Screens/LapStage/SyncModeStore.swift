import Foundation
import TrackEvolutionKit

/// The two-lap stage's sync mode, remembered per device (NS-51): the last mode
/// picked is the next compare's mode. `ThemeStore`'s shape — one owner, injected
/// at the root — and like the theme, not an account setting: nothing else about
/// viewing a chart is.
///
/// `UserDefaults` key `syncMode`, the web's `th-sync-mode` without the web's
/// prefix (`ThemeStore` keeps the web's `theme` the same way). Being a defaults
/// key, a UI test forces it from the launch arguments: `-syncMode time`.
@MainActor
@Observable
final class SyncModeStore {
    static let storageKey = "syncMode"

    private let defaults: UserDefaults

    var mode: VideoSync.SyncMode {
        didSet { defaults.set(mode.rawValue, forKey: Self.storageKey) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // An unknown value — a later version's third mode, a hand-edited
        // default — falls back to the default rather than failing.
        mode = defaults.string(forKey: Self.storageKey).flatMap(VideoSync.SyncMode.init(rawValue:))
            ?? VideoSync.DEFAULT_SYNC_MODE
    }
}
