import Foundation
import OSLog
import TrackEvolutionKit

/// Durable, per-fix storage for an in-progress recording.
///
/// The web recorder checkpoints the whole recording every ~10 s, driven by fix
/// arrival because `setInterval` throttles with the screen off — so a WebView
/// death costs up to 10 s of track time. Here every accepted fix is appended to
/// disk as it arrives, so the worst case is zero.
///
/// **Deviation from NS-15 worth knowing about:** the spec calls for SQLite via
/// GRDB, shared with NS-21's offline store. This is an append-only journal
/// instead — no dependency, and better suited to a write-per-fix hot path where
/// the only query is "read it all back". The requirement it exists to satisfy
/// (durable per fix, not per interval) is met either way, and NS-21 can swap the
/// implementation behind this type if it wants one database for both.
///
/// Format — one line each, so a half-written final line costs one fix and not the
/// recording:
///
///     {"v":1,"eventId":"3","startedAtMs":1750000000000}
///     [0.1,36.56,-79.2,25.4,4.2]
///     [0.2,36.560002,-79.199998,25.5,4.2]
///
/// No `fsync`: a force-quit or a crash leaves the writes in the page cache and
/// they survive. Only losing power mid-session could drop the tail, and paying
/// an fsync at 10 Hz to cover that isn't worth the battery.
@MainActor
final class FixJournal {
    private static let log = Logger(subsystem: "app.trackevolution", category: "recorder")

    private let url: URL
    private var handle: FileHandle?

    init(url: URL? = nil) {
        self.url = url ?? Self.defaultURL()
    }

    private static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL.temporaryDirectory
        let directory = base.appending(path: "Recorder", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: "in-progress.jsonl")
    }

    /// Start a new journal, replacing anything already there.
    func begin(_ recording: Recording) throws {
        close()
        let header = Header(v: recording.v, eventId: recording.eventId, startedAtMs: recording.startedAtMs)
        var line = try JSONEncoder().encode(header)
        line.append(0x0A)
        try line.write(to: url, options: .atomic)
        handle = try FileHandle(forWritingTo: url)
        try handle?.seekToEnd()
    }

    /// Append one accepted fix. Called from the location callback.
    func append(_ fix: Recording.Fix) {
        guard let handle else { return }
        do {
            var line = try JSONEncoder().encode(fix)
            line.append(0x0A)
            try handle.write(contentsOf: line)
        } catch {
            // A failed append must never take the recording down: the in-memory
            // recording is still intact and still saveable.
            Self.log.error("fix journal append failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Rewrite the journal from a recording — used when the event id is attached
    /// after the fact (a CarPlay recording adopted by an event).
    func rewrite(_ recording: Recording) throws {
        try begin(recording)
        for fix in recording.fixes { append(fix) }
    }

    /// The recording left behind by a previous launch, if any. A truncated or
    /// unreadable line ends the read rather than failing it — the fixes before it
    /// are still a recording.
    func recover() -> Recording? {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        let decoder = JSONDecoder()
        var lines = data.split(separator: 0x0A, omittingEmptySubsequences: true).makeIterator()
        guard let headerLine = lines.next(),
              let header = try? decoder.decode(Header.self, from: Data(headerLine)),
              header.v == RecorderCore.RECORDING_V,
              header.startedAtMs.isFinite
        else { return nil }

        var recording = Recording(eventId: header.eventId, startedAtMs: header.startedAtMs)
        while let line = lines.next() {
            guard let fix = try? decoder.decode(Recording.Fix.self, from: Data(line)) else { break }
            recording.fixes.append(fix)
        }
        return recording.fixes.isEmpty ? nil : recording
    }

    /// Forget the in-progress recording — after it is saved, or discarded.
    func clear() {
        close()
        try? FileManager.default.removeItem(at: url)
    }

    func close() {
        try? handle?.close()
        handle = nil
    }

    private struct Header: Codable {
        var v: Int
        var eventId: String?
        var startedAtMs: Double
    }
}
