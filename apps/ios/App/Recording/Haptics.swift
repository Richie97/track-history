import UIKit

/// Feedback you can feel through gloves.
///
/// The web app has `platform.hapticPB` for the personal-best celebration; this is
/// the native equivalent plus start/stop confirmation. In a loud car with gloves
/// on, haptics are the only reliable channel — the driver isn't reading the
/// screen, and may not be able to hear anything.
@MainActor
enum Haptics {
    /// Recording started or stopped: firm, unambiguous.
    static func confirm() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// A personal best.
    static func personalBest() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Something didn't work — a stationary pick, a failed save.
    static func warn() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    /// The lighter tick for a line pick, so repeated taps don't feel like alarms.
    static func select() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}
