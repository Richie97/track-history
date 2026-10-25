import Foundation

// Publishing a best-lap video to YouTube (NS-46,
// docs/specs/native/NS-46-youtube-upload.md). The upload runs on the server; a
// client is a form and a status line, so these are the shapes it reads. The
// status and privacy are strings rather than enums so a value the server adds
// later degrades to "say nothing" instead of failing the whole event detail.

/// A clip's upload as the event detail carries it (`lap.clip.youtube`). `url`
/// is `https://youtu.be/<id>` once `status` is `done`. Not on a coach's view:
/// `COACH_CLIP_FIELDS` leaves it out.
public struct LapClipYouTube: Codable, Hashable, Sendable {
    public var status: String
    public var videoId: String?
    public var url: String?
    public var privacy: String

    public enum CodingKeys: String, CodingKey {
        case status
        case videoId = "video_id"
        case url, privacy
    }

    public init(status: String, videoId: String? = nil, url: String? = nil, privacy: String) {
        self.status = status
        self.videoId = videoId
        self.url = url
        self.privacy = privacy
    }
}

/// `user.youtube` on `GET /api/me`. `available` is the one switch: false draws
/// nothing at all. `connected` is false for a revoked grant, whose `account`
/// stays so Settings can say which one to reconnect.
public struct YouTubeAccount: Codable, Hashable, Sendable {
    public var available: Bool
    public var connected: Bool
    public var account: String?
    public var channelTitle: String?

    public enum CodingKeys: String, CodingKey {
        case available, connected, account
        case channelTitle = "channel_title"
    }
}

/// `GET /api/clips/:id/youtube/draft`: the form's pre-filled words (Pro).
public struct YouTubeDraft: Codable, Hashable, Sendable {
    public var title: String
    public var description: String
    public var privacy: String
    public var account: String?
}

/// `GET /api/clips/:id/youtube` (and the 202 from starting one): what the lap
/// page's status line draws. `progress` is 0…1 of the bytes YouTube has
/// acknowledged; `error` is the failure — or, while queued, a wait — in words.
public struct YouTubeUpload: Codable, Hashable, Sendable {
    public var status: String
    public var progress: Double
    public var privacy: String
    public var url: String?
    public var error: String?
}
