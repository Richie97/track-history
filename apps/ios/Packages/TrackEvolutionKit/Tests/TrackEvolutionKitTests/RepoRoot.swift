import Foundation

/// Locates the repository root by walking up from this source file.
///
/// The contract fixtures (`contracts/golden/`, `contracts/logic/`) are read from
/// the repo rather than copied into the package as bundled resources: a copy
/// would go stale exactly when it mattered, which is the opposite of what those
/// fixtures are for.
enum RepoRoot {
    static let url: URL = {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appending(path: "package.json").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        fatalError("repository root not found above \(#filePath)")
    }()

    static func path(_ relative: String) -> URL {
        url.appending(path: relative)
    }
}
