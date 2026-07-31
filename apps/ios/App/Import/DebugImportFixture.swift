#if DEBUG
import Foundation

/// Hands the import flow one of the committed contract fixtures, so a UI test can
/// exercise it end to end.
///
/// The system Files and Photos pickers are separate processes with their own view
/// hierarchies, and driving them from `XCUITest` is flaky in a way that would make
/// this suite lie about the feature rather than test it. Everything *after* the
/// pick — the byte source, both parsers, the review, the line picker and the save
/// — is the production path, and that is what this reaches:
///
///     xcrun simctl launch <device> app.trackevolution -importFixture pdr-delta.mp4
///
/// Optionally with `-importFixtureEvent <id>` to pre-select the event the session
/// is saved to, which is how the UI test saves into an event it seeded.
///
/// Same shape as `-channelGraphs`, and for the same reason: some inputs can't be
/// produced from inside the app.
enum DebugImportFixture {
    /// The clip named by `-importFixture`, if the argument is present and the file
    /// is there. Read from `contracts/logic/video/` in the repo — located by
    /// walking up from this source file, exactly as `RepoRoot` does in the Kit's
    /// tests — because a fixture copied into the bundle would go stale.
    static var pendingURL: URL? {
        guard let name = UserDefaults.standard.string(forKey: "importFixture"), !name.isEmpty else {
            return nil
        }
        guard let root = repoRoot else { return nil }
        let url = root.appending(path: "contracts/logic/video").appending(path: name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// The event `-importFixtureEvent` names, so the review saves where the test
    /// can find it again.
    static var pendingEventId: Int? {
        let id = UserDefaults.standard.integer(forKey: "importFixtureEvent")
        return id > 0 ? id : nil
    }

    private static var repoRoot: URL? {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appending(path: "package.json").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }
}
#endif
