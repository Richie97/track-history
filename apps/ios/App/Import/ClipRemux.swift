import AudioToolbox
import AVFoundation
import CoreMedia
import Foundation

/// An AAC track read by AudioToolbox, for the file whose audio AVFoundation
/// won't expose (`ClipCutter`): the Corvette's Marlin PDR writes its AAC with a
/// media timescale of 440,988, and `AVURLAsset` lists the video and the
/// telemetry track and no audio at all, while `AudioFileOpenURL` reads the same
/// track packet for packet.
///
/// Raw packets, never decoded — the clip keeps the source's audio bit for bit,
/// as the passthrough cut keeps its video.
final class AACPacketFile: @unchecked Sendable {
    private let file: AudioFileID
    let format: AudioStreamBasicDescription
    let formatDescription: CMAudioFormatDescription
    let packetCount: Int64
    let maxPacketSize: UInt32

    enum Failure: Error {
        case notAAC
        case status(String, OSStatus)
    }

    init(url: URL) throws {
        var id: AudioFileID?
        var status = AudioFileOpenURL(url as CFURL, .readPermission, 0, &id)
        guard status == noErr, let id else { throw Failure.status("open", status) }
        file = id
        do {
            var asbd = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            status = AudioFileGetProperty(id, kAudioFilePropertyDataFormat, &size, &asbd)
            guard status == noErr else { throw Failure.status("format", status) }
            guard asbd.mFormatID == kAudioFormatMPEG4AAC, asbd.mSampleRate > 0, asbd.mFramesPerPacket > 0 else {
                throw Failure.notAAC
            }
            format = asbd

            var count: Int64 = 0
            size = UInt32(MemoryLayout<Int64>.size)
            status = AudioFileGetProperty(id, kAudioFilePropertyAudioDataPacketCount, &size, &count)
            guard status == noErr, count > 0 else { throw Failure.status("packets", status) }
            packetCount = count

            var maxSize: UInt32 = 0
            size = UInt32(MemoryLayout<UInt32>.size)
            status = AudioFileGetProperty(id, kAudioFilePropertyMaximumPacketSize, &size, &maxSize)
            guard status == noErr, maxSize > 0 else { throw Failure.status("max packet", status) }
            maxPacketSize = maxSize

            // The decoder configuration (the esds's AudioSpecificConfig): a
            // format description without it can't be decoded by a player.
            var cookieSize: UInt32 = 0
            status = AudioFileGetPropertyInfo(id, kAudioFilePropertyMagicCookieData, &cookieSize, nil)
            var cookie = [UInt8](repeating: 0, count: Int(cookieSize))
            if status == noErr, cookieSize > 0 {
                status = AudioFileGetProperty(id, kAudioFilePropertyMagicCookieData, &cookieSize, &cookie)
                guard status == noErr else { throw Failure.status("cookie", status) }
            }
            var description: CMAudioFormatDescription?
            status = cookie.withUnsafeBytes { raw in
                CMAudioFormatDescriptionCreate(
                    allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                    magicCookieSize: raw.count, magicCookie: raw.count > 0 ? raw.baseAddress : nil,
                    extensions: nil, formatDescriptionOut: &description
                )
            }
            guard status == noErr, let description else { throw Failure.status("description", status) }
            formatDescription = description
        } catch {
            AudioFileClose(id)
            throw error
        }
    }

    deinit {
        AudioFileClose(file)
    }

    /// The seconds one packet plays for.
    var packetSeconds: Double { Double(format.mFramesPerPacket) / format.mSampleRate }

    /// Packets `[first, first + count)` as one ready sample buffer, timed on the
    /// source's clock, or nil past the end.
    func sampleBuffer(first: Int64, count: Int) throws -> CMSampleBuffer? {
        guard first < packetCount, count > 0 else { return nil }
        var packets = UInt32(min(Int64(count), packetCount - first))
        var bytes = packets * maxPacketSize
        var data = [UInt8](repeating: 0, count: Int(bytes))
        var descriptions = [AudioStreamPacketDescription](repeating: .init(), count: Int(packets))
        let status = AudioFileReadPacketData(file, false, &bytes, &descriptions, first, &packets, &data)
        guard status == noErr || status == kAudioFileEndOfFileError, packets > 0 else {
            if packets == 0 { return nil }
            throw Failure.status("read", status)
        }

        var block: CMBlockBuffer?
        var result = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: Int(bytes),
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: Int(bytes), flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
        )
        guard result == noErr, let block else { throw Failure.status("block", result) }
        result = data.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: Int(bytes))
        }
        guard result == noErr else { throw Failure.status("copy", result) }

        let frames = Int64(format.mFramesPerPacket)
        let pts = CMTime(value: first * frames, timescale: CMTimeScale(format.mSampleRate))
        var buffer: CMSampleBuffer?
        result = descriptions.withUnsafeBufferPointer { descs in
            CMAudioSampleBufferCreateReadyWithPacketDescriptions(
                allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: formatDescription,
                sampleCount: Int(packets), presentationTimeStamp: pts, packetDescriptions: descs.baseAddress,
                sampleBufferOut: &buffer
            )
        }
        guard result == noErr, let buffer else { throw Failure.status("sample buffer", result) }
        return buffer
    }
}

/// The same passthrough cut `ClipCutter`'s composition makes, written by an
/// `AVAssetWriter` instead, for a file whose audio only AudioToolbox can read.
///
/// The video is read by an `AVAssetReader` with no output settings — samples
/// as stored, from the keyframe at or before the window — and the audio is the
/// AAC packets that cover it. The session starts at the window's start, so the
/// writer hides what comes before it behind an edit list exactly as the
/// export session does; `ClipCutter.measure` reads the offset back either way.
/// No metadata is written.
enum ClipRemux {
    enum Failure: Error {
        case cannotRead(String)
        case cannotWrite(String)
    }

    static func write(asset: AVURLAsset, video: AVAssetTrack, audio: AACPacketFile, range: CMTimeRange, to output: URL) async throws {
        let keyframe = try await ClipCutter.sourceKeyframe(at: range.start, in: video)
        let videoFormat = try await video.load(.formatDescriptions).first
        let transform = try await video.load(.preferredTransform)

        let reader = try AVAssetReader(asset: asset)
        let videoOut = AVAssetReaderTrackOutput(track: video, outputSettings: nil)
        videoOut.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOut) else { throw Failure.cannotRead("video output") }
        reader.add(videoOut)
        reader.timeRange = CMTimeRange(start: keyframe, end: range.end)

        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        writer.metadata = []
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: videoFormat)
        videoIn.expectsMediaDataInRealTime = false
        videoIn.transform = transform
        let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: audio.formatDescription)
        audioIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(videoIn), writer.canAdd(audioIn) else { throw Failure.cannotWrite("inputs") }
        writer.add(videoIn)
        writer.add(audioIn)

        guard reader.startReading() else { throw Failure.cannotRead(reader.error?.localizedDescription ?? "start") }
        guard writer.startWriting() else { throw Failure.cannotWrite(writer.error?.localizedDescription ?? "start") }
        writer.startSession(atSourceTime: range.start)

        // The audio packets that cover the window: from the one playing at its
        // start to the one playing at its end.
        let firstPacket = Int64(max(0, (range.start.seconds / audio.packetSeconds).rounded(.down)))
        let endPacket = min(audio.packetCount, Int64((range.end.seconds / audio.packetSeconds).rounded(.up)))

        let pump = Pump(reader: reader, videoOut: videoOut, videoIn: videoIn, audioIn: audioIn, audio: audio,
                        nextPacket: firstPacket, endPacket: endPacket)
        try await pump.run()

        writer.endSession(atSourceTime: range.end)
        await writer.finishWriting()
        if writer.status != .completed {
            throw Failure.cannotWrite(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")
        }
        if reader.status == .failed {
            throw Failure.cannotRead(reader.error?.localizedDescription ?? "read")
        }
    }

    /// Feeds both inputs as each asks for more, on one serial queue: the writer
    /// interleaves the two tracks itself and holds back whichever input runs
    /// ahead, so each is fed only when it says it's ready.
    private final class Pump: @unchecked Sendable {
        private let queue = DispatchQueue(label: "app.trackevolution.clip-remux")
        private let reader: AVAssetReader
        private let videoOut: AVAssetReaderTrackOutput
        private let videoIn: AVAssetWriterInput
        private let audioIn: AVAssetWriterInput
        private let audio: AACPacketFile
        private var nextPacket: Int64
        private let endPacket: Int64
        private var videoDone = false
        private var audioDone = false
        private var failure: (any Error)?
        private var continuation: CheckedContinuation<Void, any Error>?

        /// About a second of audio per buffer.
        private let packetsPerBuffer = 43

        init(
            reader: AVAssetReader, videoOut: AVAssetReaderTrackOutput, videoIn: AVAssetWriterInput,
            audioIn: AVAssetWriterInput, audio: AACPacketFile, nextPacket: Int64, endPacket: Int64
        ) {
            self.reader = reader
            self.videoOut = videoOut
            self.videoIn = videoIn
            self.audioIn = audioIn
            self.audio = audio
            self.nextPacket = nextPacket
            self.endPacket = endPacket
        }

        func run() async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                queue.async {
                    self.continuation = continuation
                    self.videoIn.requestMediaDataWhenReady(on: self.queue) { self.feedVideo() }
                    self.audioIn.requestMediaDataWhenReady(on: self.queue) { self.feedAudio() }
                }
            }
        }

        private func feedVideo() {
            while !videoDone, videoIn.isReadyForMoreMediaData {
                guard let sample = videoOut.copyNextSampleBuffer() else {
                    videoDone = true
                    videoIn.markAsFinished()
                    break
                }
                if !videoIn.append(sample) {
                    fail(Failure.cannotWrite("video append"))
                    return
                }
            }
            finishIfDone()
        }

        private func feedAudio() {
            while !audioDone, audioIn.isReadyForMoreMediaData {
                let count = Int(min(Int64(packetsPerBuffer), endPacket - nextPacket))
                let buffer: CMSampleBuffer?
                do {
                    buffer = count > 0 ? try audio.sampleBuffer(first: nextPacket, count: count) : nil
                } catch {
                    fail(error)
                    return
                }
                guard let buffer else {
                    audioDone = true
                    audioIn.markAsFinished()
                    break
                }
                nextPacket += Int64(CMSampleBufferGetNumSamples(buffer))
                if !audioIn.append(buffer) {
                    fail(Failure.cannotWrite("audio append"))
                    return
                }
            }
            finishIfDone()
        }

        private func fail(_ error: any Error) {
            guard failure == nil else { return }
            failure = error
            reader.cancelReading()
            if !videoDone { videoDone = true; videoIn.markAsFinished() }
            if !audioDone { audioDone = true; audioIn.markAsFinished() }
            finishIfDone()
        }

        private func finishIfDone() {
            guard videoDone, audioDone, let continuation else { return }
            self.continuation = nil
            if let failure { continuation.resume(throwing: failure) } else { continuation.resume() }
        }
    }
}
