import Foundation
import OSLog
import TrackEvolutionKit

/// A `TelemetryByteSource` over a video that stays exactly where it is.
///
/// This is the load-bearing half of NS-30's first requirement: **the video is
/// never uploaded and never copied whole.** Both parsers read the MP4 index plus
/// the telemetry track's own samples — a few MB for PDR, tens for a long GoPro
/// `gpmd` track — against an essence one to two orders of magnitude larger that is
/// never touched. A temp copy of a 4 GB clip would take minutes and may not fit in
/// the sandbox at all, so anything that materialises the file first is the wrong
/// design here.
///
/// That is why the picking paths are `.fileImporter` (a security-scoped URL) and
/// `PHAsset` → `requestAVAsset` → `AVURLAsset.url`, and why `PhotosPicker`'s
/// `loadTransferable` is not used: it copies the whole clip before handing
/// anything back.
///
/// Not `Sendable`, deliberately: a `FileHandle` is not, and a parse is a single
/// sequential walk confined to one task.
final class FileTelemetryByteSource: TelemetryByteSource {
    private static let log = Logger(subsystem: "app.trackevolution", category: "import")

    private let handle: FileHandle
    private let url: URL
    /// Whether this URL came with a security scope we have to release.
    private let scoped: Bool
    let size: Int

    init(url: URL) throws {
        self.url = url
        // A document from Files or the share sheet arrives security-scoped;
        // one from Photos does not, and asking is harmless either way.
        scoped = url.startAccessingSecurityScopedResource()
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey])
            size = values.fileSize ?? 0
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    deinit {
        try? handle.close()
        if scoped { url.stopAccessingSecurityScopedResource() }
    }

    func read(at offset: Int, count: Int) throws -> Data {
        guard offset >= 0, offset < size, count > 0 else { return Data() }
        try handle.seek(toOffset: UInt64(offset))
        return try handle.read(upToCount: count) ?? Data()
    }
}
