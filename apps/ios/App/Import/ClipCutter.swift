import AVFoundation
import CoreMedia
import Foundation
import TrackEvolutionKit

/// Cuts a session's best lap out of the source video, on the device and without
/// re-encoding (NS-45).
///
/// An `AVMutableComposition` holding **only the first real video track and the
/// first audio track** over the requested `LapClips.clipWindow`, exported with
/// `AVAssetExportPresetPassthrough` to `.mp4` in the clips directory. Three
/// things about that are load-bearing:
///
/// - **Only those two tracks.** The telemetry track (PDR's `marl`, PDR 2.5's
///   `adco`, GoPro's `gpmd`) stays behind, and so does everything else: a
///   Cadillac PDR 2.5 file carries an MJPEG cover image as a *second video
///   track*, so "every video track" would ship it, and "the first video track"
///   has to mean the first one that is moving picture — `isCoverImage` skips a
///   JPEG one.
/// - **No file-level metadata.** `metadata = []` plus the sharing filter, so the
///   GPS location atoms a GoPro or a phone writes never reach the server.
/// - **The offset is measured, not assumed.** A passthrough cut can only start
///   on a keyframe; the Corvette's PDR writes one every 1.475 s. AVFoundation
///   writes an edit list that hides the frames before the requested start, but
///   a player that ignores edit lists — and the cut that ffmpeg makes — starts
///   at the keyframe, so `lapOffsetMs` is read back from the exported file's
///   own presentation timeline: where its first presented frame sits on the
///   source's clock, against where the lap starts.
///
/// Runs after the session `POST` is issued and is never awaited by the save: a
/// cut that fails costs the clip, never the session.
enum ClipCutter {
    struct Cut: Sendable, Equatable {
        var url: URL
        var sizeBytes: Int
        var durationMs: Int
        var lapOffsetMs: Int
    }

    enum Failure: Error, Equatable {
        case noVideoTrack
        case exportUnavailable
        case exportFailed(String)
        case emptyOutput
    }

    /// Where cut clips and the upload manifest live: app-private, never backed
    /// up (a restored manifest pointing at a missing file is a dead job), and
    /// out of the user's sight in Files.
    static func directory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        var dir = base.appending(path: "clips", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }

    /// Cut `window` out of `source` into `output`.
    ///
    /// `lapStartS` is the lap's start on the telemetry clock — the file's media
    /// timeline, which ticket 1 verified for PDR and PDR 2.5 to within about a
    /// quarter second.
    static func cut(source: URL, window: LapClips.Window, lapStartS: Double, to output: URL) async throws -> Cut {
        let asset = AVURLAsset(url: source, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let video = try await firstPictureTrack(videoTracks) else { throw Failure.noVideoTrack }
        let audio = try await asset.loadTracks(withMediaType: .audio).first

        let timescale: CMTimeScale = 90_000
        let range = CMTimeRange(
            start: CMTime(seconds: window.startS, preferredTimescale: timescale),
            end: CMTime(seconds: window.endS, preferredTimescale: timescale)
        )
        try? FileManager.default.removeItem(at: output)

        // The Corvette's PDR writes an AAC track AVFoundation won't expose (its
        // media timescale is 440,988 against a 44.1 kHz rate) while AudioToolbox
        // reads it fine. A composition can only copy what AVFoundation sees, so
        // that file goes through `ClipRemux` — the same passthrough cut, written
        // by an `AVAssetWriter` with the audio packets read by AudioToolbox —
        // rather than losing its sound.
        if audio == nil, let packets = try? AACPacketFile(url: source) {
            do {
                try await ClipRemux.write(asset: asset, video: video, audio: packets, range: range, to: output)
            } catch {
                try? FileManager.default.removeItem(at: output)
                throw Failure.exportFailed(error.localizedDescription)
            }
            return try await finish(output: output, source: video, requestedStart: range.start, lapStartS: lapStartS)
        }

        let composition = AVMutableComposition()
        guard let compVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw Failure.noVideoTrack
        }
        try compVideo.insertTimeRange(range, of: video, at: .zero)
        compVideo.preferredTransform = try await video.load(.preferredTransform)
        if let audio, let compAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            // A clip without sound is still a clip: an audio track that won't
            // insert is left out rather than failing the cut.
            do {
                try compAudio.insertTimeRange(range, of: audio, at: .zero)
            } catch {
                composition.removeTrack(compAudio)
            }
        }

        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw Failure.exportUnavailable
        }
        // File-level metadata — location atoms, the camera's identity — stays
        // behind; the filter catches what an empty list might not.
        export.metadata = []
        export.metadataItemFilter = .forSharing()
        // The index at the front, so the signed URL starts playing before the
        // whole clip has downloaded.
        export.shouldOptimizeForNetworkUse = true
        do {
            try await run(export, to: output)
        } catch {
            try? FileManager.default.removeItem(at: output)
            throw Failure.exportFailed(error.localizedDescription)
        }
        return try await finish(output: output, source: video, requestedStart: range.start, lapStartS: lapStartS)
    }

    /// The cut as the upload declares it, read back from the file.
    private static func finish(output: URL, source video: AVAssetTrack, requestedStart: CMTime, lapStartS: Double) async throws -> Cut {
        let size = (try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else {
            try? FileManager.default.removeItem(at: output)
            throw Failure.emptyOutput
        }
        let measured = try await measure(output: output, source: video, requestedStart: requestedStart)
        let durationMs = Int((measured.durationS * 1000).rounded())
        let offsetMs = Int(((lapStartS - measured.firstFrameSourceS) * 1000).rounded())
        return Cut(
            url: output,
            sizeBytes: size,
            durationMs: durationMs,
            lapOffsetMs: min(max(0, offsetMs), max(0, durationMs - 1))
        )
    }

    /// The export, through whichever API the OS has: iOS 18 replaced the
    /// status-polling one with a throwing `export(to:as:)`.
    private static func run(_ export: AVAssetExportSession, to output: URL) async throws {
        if #available(iOS 18, macOS 15, *) {
            try await export.export(to: output, as: .mp4)
        } else {
            export.outputURL = output
            export.outputFileType = .mp4
            await export.export()
            if export.status != .completed {
                throw export.error ?? Failure.exportFailed("status \(export.status.rawValue)")
            }
        }
    }

    /// The first video track that is moving picture: a JPEG track is a cover
    /// image (PDR 2.5's fourth stream), whatever its position.
    static func firstPictureTrack(_ tracks: [AVAssetTrack]) async throws -> AVAssetTrack? {
        for track in tracks {
            let formats = try await track.load(.formatDescriptions)
            if formats.contains(where: isCoverImage) { continue }
            return track
        }
        return nil
    }

    static func isCoverImage(_ format: CMFormatDescription) -> Bool {
        let subtype = CMFormatDescriptionGetMediaSubType(format)
        return subtype == kCMVideoCodecType_JPEG || subtype == kCMVideoCodecType_JPEG_OpenDML
    }

    /// Where the exported file's first presented frame sits on the source's
    /// clock, and how long the file plays.
    ///
    /// The output's video track maps its own media onto presentation through an
    /// edit list; its media begins with the keyframe the passthrough cut had to
    /// start on, which is the source's last sync sample at or before the
    /// requested start. So the first presented frame is that keyframe's source
    /// time plus however far into its own media the edit list starts — the
    /// requested start when the list is honoured, the keyframe when it isn't.
    private static func measure(
        output: URL, source: AVAssetTrack, requestedStart: CMTime
    ) async throws -> (firstFrameSourceS: Double, durationS: Double) {
        let asset = AVURLAsset(url: output, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration = try await asset.load(.duration).seconds
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw Failure.noVideoTrack
        }
        let keyframe = try await sourceKeyframe(at: requestedStart, in: source)
        let segments = try await track.load(.segments)
        // The first segment that shows media (an empty edit is a gap, not a frame).
        let mediaStart = segments.first(where: { !$0.isEmpty })?.timeMapping.source.start ?? .zero
        // The keyframe the output's media begins with, read the same way as the
        // source's: the sync sample a decode of its first presented frame starts
        // from. (Not "the first sample's time": with B-frames the first sample in
        // decode order isn't presented first, and the difference is a frame.)
        let firstMedia = try await syncSampleTime(at: mediaStart, in: track) ?? .zero
        let skipped = CMTimeSubtract(mediaStart, firstMedia).seconds
        return (keyframe.seconds + max(0, skipped), duration)
    }

    /// The source's keyframe a cut at `trackTime` has to start on, in the
    /// source *track's* time — the clock the composition was cut on.
    ///
    /// A sample cursor works in the track's *media* time, which an edit list can
    /// offset from the track's own: an encoder that writes B-frames shifts its
    /// media a frame or so and hides the shift behind the list. So the requested
    /// time goes into media time through the track's segments, the keyframe is
    /// found there, and it comes back out the same way. (The PDR files carry no
    /// such shift; a phone's or GoPro's encoder may.)
    static func sourceKeyframe(at trackTime: CMTime, in track: AVAssetTrack) async throws -> CMTime {
        let segments = try await track.load(.segments).filter { !$0.isEmpty }
        let segment = segments.first { $0.timeMapping.target.containsTime(trackTime) } ?? segments.first
        guard let mapping = segment?.timeMapping else {
            return try await syncSampleTime(at: trackTime, in: track) ?? trackTime
        }
        let shift = CMTimeSubtract(mapping.source.start, mapping.target.start)
        let media = CMTimeAdd(trackTime, shift)
        guard let keyframe = try await syncSampleTime(at: media, in: track) else { return trackTime }
        return CMTimeSubtract(keyframe, shift)
    }

    /// The presentation time of a track's last sync sample at or before `time`
    /// (by decode order), or nil where the track can't say.
    static func syncSampleTime(at time: CMTime, in track: AVAssetTrack) async throws -> CMTime? {
        guard try await track.load(.canProvideSampleCursors),
              let cursor = track.makeSampleCursor(presentationTimeStamp: time)
        else { return nil }
        // The cursor lands on the sample presented at `time`; walk back to the
        // sync sample a decode has to begin from.
        var steps = 0
        while !cursor.currentSampleSyncInfo.sampleIsFullSync.boolValue, steps < 10_000 {
            if cursor.stepInDecodeOrder(byCount: -1) == 0 { break }
            steps += 1
        }
        return cursor.presentationTimeStamp
    }
}
