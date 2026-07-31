import Foundation
import OSLog
import TrackEvolutionKit

/// One picked clip after parsing: either telemetry, or the reason there wasn't
/// any. Both are shown — a file that yielded nothing has to say so by name.
struct ImportedClip: Sendable, Identifiable {
    let id = UUID()
    var file: String
    var parsed: ParsedTelemetry?
    var error: String?
}

/// Parsing a selection of videos, off the main actor.
///
/// The `importFiles` half of `public/js/import/ui.js`: parse each file, sort by
/// the clock the recorder wrote, then run the batch pass that re-anchors a
/// beacon-less PDR recording against a beacon-timed one of the same track (and
/// re-cuts its per-lap channels, because anchoring moves the lap boundaries).
enum TelemetryImporter {
    private static let log = Logger(subsystem: "app.trackevolution", category: "import")

    /// Parse every picked clip. Never throws for a bad file — that becomes a
    /// per-clip error the review screen shows — but does propagate cancellation,
    /// so backing out of a 4 GB clip actually stops the read.
    nonisolated static func parse(_ picks: [PickedVideo]) async throws -> [ImportedClip] {
        var clips: [ImportedClip] = []
        for pick in picks {
            try Task.checkCancellation()
            clips.append(parseOne(pick))
        }
        // Sorted by the file's own start time, so a batch reads in the order it
        // was driven rather than the order it was tapped.
        clips.sort { ($0.parsed?.time ?? "") < ($1.parsed?.time ?? "") }

        var parsed: [ParsedTelemetry?] = clips.map(\.parsed)
        PDRLaps.anchorPdrBatch(&parsed)
        for i in parsed.indices {
            guard var p = parsed[i], p.kind == .pdr, p.lapRecovery != nil else { continue }
            TelemetryChannels.attachLapChannels(&p)
            parsed[i] = p
            clips[i].parsed = p
        }
        return clips
    }

    private nonisolated static func parseOne(_ pick: PickedVideo) -> ImportedClip {
        do {
            let source = try FileTelemetryByteSource(url: pick.url)
            let parsed = try Telemetry.parseTelemetryFile(source)
            return ImportedClip(file: pick.name, parsed: parsed)
        } catch let error as TelemetryParseError {
            return ImportedClip(file: pick.name, error: error.message)
        } catch let error as CancellationError {
            // Rethrown by the caller's checkCancellation on the next iteration;
            // recording it as this clip's error keeps the loop honest either way.
            _ = error
            return ImportedClip(file: pick.name, error: "Import cancelled.")
        } catch {
            log.error("could not read \(pick.name, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return ImportedClip(file: pick.name, error: "Couldn't read this video: \(error.localizedDescription)")
        }
    }
}
