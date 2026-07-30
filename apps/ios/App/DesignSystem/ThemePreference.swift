import SwiftUI

/// The theme override, mirroring the web app's `<html data-theme>` setting
/// (`public/js/theme.js`): follow the device, or force light or dark. Persisted,
/// so a forced theme survives relaunch.
enum ThemePreference: String, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// nil follows the device, which is what `preferredColorScheme` wants.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// Reads and writes the stored preference.
///
/// `@Observable` rather than `@AppStorage` at the call site so the setting has
/// one owner: the theme is read by the root scene and written from Settings, and
/// later by the CarPlay scene, which has no SwiftUI environment.
@Observable
final class ThemeStore {
    /// Matches the web app's localStorage key, so the two are recognizable —
    /// they don't share storage.
    static let storageKey = "theme"

    private let defaults: UserDefaults

    var preference: ThemePreference {
        didSet { defaults.set(preference.rawValue, forKey: Self.storageKey) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: Self.storageKey)
        preference = stored.flatMap(ThemePreference.init(rawValue:)) ?? .system
    }
}
