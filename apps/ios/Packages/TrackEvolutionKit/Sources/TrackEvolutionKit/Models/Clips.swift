import Foundation

// The best-lap video routes' bodies and answers (NS-45, `src/routes/clips.ts`).
// `LapClip` — what a ready clip answers as, and what the event detail carries on
// its lap — lives beside `Lap` in Session.swift.

/// `POST /api/sessions/:id/clip`: keyed on the session and the lap's time
/// rather than a lap id, because a session `POST` answers only the session's
/// id. `lapNum` (NS-50) is the lap's place in the session, sent beside the time
/// so a tie on time reaches the right lap; nil — and absent from the body — for
/// a job made before it existed, which the server matches on time alone.
/// `lapOffsetMs` is where the lap starts inside the cut, measured from the file
/// the cutter made rather than assumed.
public struct ClipCreateBody: Codable, Hashable, Sendable {
    public var timeMs: Int
    public var lapNum: Int?
    public var sizeBytes: Int
    public var durationMs: Int
    public var lapOffsetMs: Int

    public init(timeMs: Int, lapNum: Int? = nil, sizeBytes: Int, durationMs: Int, lapOffsetMs: Int) {
        self.timeMs = timeMs
        self.lapNum = lapNum
        self.sizeBytes = sizeBytes
        self.durationMs = durationMs
        self.lapOffsetMs = lapOffsetMs
    }

    public enum CodingKeys: String, CodingKey {
        case timeMs = "time_ms"
        case lapNum = "lap_num"
        case sizeBytes = "size_bytes"
        case durationMs = "duration_ms"
        case lapOffsetMs = "lap_offset_ms"
    }
}

/// The create's answer: where to put the parts, and — on a resume, when an
/// `uploading` row for the same lap and size already exists — which parts the
/// server already holds.
public struct ClipUploadStart: Codable, Hashable, Sendable {
    public var clipId: Int
    public var partBytes: Int
    public var parts: Int
    public var uploaded: [Int]

    public init(clipId: Int, partBytes: Int, parts: Int, uploaded: [Int]) {
        self.clipId = clipId
        self.partBytes = partBytes
        self.parts = parts
        self.uploaded = uploaded
    }

    public enum CodingKeys: String, CodingKey {
        case clipId = "clip_id"
        case partBytes = "part_bytes"
        case parts, uploaded
    }
}

/// `GET /api/clips/:id/url`: a plain URL that plays for an hour, signed rather
/// than authenticated, so AVPlayer and AirPlay need no header. `expiresAt` is
/// epoch ms, like every other timestamp the API answers.
public struct ClipURL: Codable, Hashable, Sendable {
    public var url: URL
    public var expiresAt: Int

    public enum CodingKeys: String, CodingKey {
        case url
        case expiresAt = "expires_at"
    }
}

/// `POST /api/clips/:id/complete` answered 409 because parts are missing —
/// thrown with the server's list, so the upload sends exactly those again.
public struct ClipMissingParts: Error, Hashable, Sendable {
    public var missing: [Int]

    public init(missing: [Int]) {
        self.missing = missing
    }
}

struct ClipMissingPartsBody: Decodable {
    var error: String
    var missing: [Int]?
}
