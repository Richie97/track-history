#if DEBUG
import AVFoundation
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

    /// `-syntheticClipVideo YES`: the committed fixtures carry telemetry and no
    /// picture (they are kilobytes on purpose), so a best-lap cut (NS-45) of one
    /// has nothing to cut. With this set, the cut is made from a small generated
    /// H.264 file as long as the fixture instead — the real `ClipCutter`, upload
    /// and player, on a clip a UI test can afford. The cutter itself is checked
    /// on real footage; see NS-45's *As built*.
    static var synthesizesClipVideo: Bool {
        UserDefaults.standard.bool(forKey: "syntheticClipVideo")
    }

    /// A silent 160×90, 4 fps H.264 MP4 of `durationS` seconds, a different
    /// shade each second so a player visibly moves.
    static func syntheticVideo(durationS: Double) async throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "synthetic-clip-source.mp4")
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let width = 160, height = 90, fps: Int32 = 4
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)
        let frames = Int((durationS * Double(fps)).rounded(.up)) + 1
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            guard let pool = adaptor.pixelBufferPool else { throw CocoaError(.fileWriteUnknown) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw CocoaError(.fileWriteUnknown) }
            CVPixelBufferLockBaseAddress(buffer, [])
            let shade = UInt8(40 + (frame / Int(fps)) % 8 * 25)
            if let base = CVPixelBufferGetBaseAddress(buffer) {
                memset(base, Int32(shade), CVPixelBufferGetBytesPerRow(buffer) * height)
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps))
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        return url
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
