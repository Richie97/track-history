import Foundation

// Publish a best-lap video to YouTube (NS-46): the client's pure half — the
// port of `public/js/youtube.js` under the same names, pinned by
// `contracts/logic/youtube.json`. Which control a lap's video offers, the
// status line under it, and every sentence the feature says. The draft's title
// and description are the server's, so nothing here builds them.
//
// The statics hang off `YouTubeUpload`, the model, because that is the name the
// JS module ports under and Swift has one namespace for both.

/// The control a lap's video offers — `youtubeOffer`'s answer.
public enum YouTubeOffer: String, Codable, Hashable, Sendable {
    /// Nothing: the feature is off for this account, there's no ready clip, or
    /// it's a coach's read-only view (whatever the upload's state).
    case none
    /// Nothing beyond NS-45's locked player (a free account).
    case locked
    /// *Connect YouTube…* — no live grant; a revoked one too.
    case connect
    /// *Upload to YouTube…*
    case upload
    /// The status line, polled.
    case pending
    /// *On YouTube · <privacy>*, and Open.
    case done
    /// The error, and *Try again*.
    case failed
}

public extension YouTubeUpload {
    struct Privacy: Hashable, Sendable {
        public let value: String
        public let label: String
    }

    struct Link: Hashable, Sendable {
        public let label: String
        public let url: URL
    }

    static let YOUTUBE_PRIVACY: [Privacy] = [
        Privacy(value: "private", label: "Private"),
        Privacy(value: "unlisted", label: "Unlisted"),
        Privacy(value: "public", label: "Public"),
    ]
    /// Unlisted: the setting that matches sharing a link with a club or an
    /// instructor. Public is a choice the driver makes.
    static let YOUTUBE_DEFAULT_PRIVACY = "unlisted"

    /// The consent explanation, above Connect on every client, word for word.
    /// Its last sentence names two documents that are links (`YOUTUBE_LINKS`) —
    /// Google's API terms require both.
    static let YOUTUBE_CONNECT_TEXT =
        "Track Evolution will ask Google for permission to upload videos to your YouTube channel. "
        + "It uploads only the videos you choose, and can't see, change or delete anything else on your channel. "
        + "Uses YouTube API Services: YouTube Terms of Service · Google Privacy Policy."
    static let YOUTUBE_LINKS: [Link] = [
        Link(label: "YouTube Terms of Service", url: URL(string: "https://www.youtube.com/t/terms")!),
        Link(label: "Google Privacy Policy", url: URL(string: "https://policies.google.com/privacy")!),
    ]
    /// Where a driver revokes the grant at Google's end.
    static let GOOGLE_PERMISSIONS_URL = URL(string: "https://myaccount.google.com/permissions")!

    /// Fixed on the form rather than asked: in-car track footage isn't directed
    /// at children, and the uploader is responsible for saying so.
    static let YOUTUBE_KIDS_TEXT = "Not made for kids"
    static let YOUTUBE_DELETE_NOTE = "The copy on YouTube stays. Delete it in YouTube Studio."
    static let YOUTUBE_DISCONNECT_NOTE = "Videos you've uploaded stay on YouTube."
    static let YOUTUBE_OFFLINE = "Uploading to YouTube needs a connection."
    static let YOUTUBE_RESULT_TEXT: [String: String] = [
        "connected": "YouTube is connected.",
        "denied": "YouTube wasn't connected — Google's permission was declined.",
        "error": "Couldn't connect YouTube. Try again.",
    ]

    /// A lapsed owner keeps `done` (the link isn't Pro) and `pending` (a lapse
    /// doesn't stop an upload already queued); everything that starts one is
    /// Pro, through `canSaveLapVideo` — the same decision about the same clip
    /// as downloading it.
    static func youtubeOffer(
        _ clip: LapClip?, _ entitlement: Entitlement?, _ youtube: YouTubeAccount?, _ readOnly: Bool
    ) -> YouTubeOffer {
        if readOnly { return .none }
        guard let youtube, youtube.available else { return .none }
        guard let clip else { return .none }
        let status = clip.youtube?.status
        if status == "done" { return .done }
        if status == "queued" || status == "uploading" { return .pending }
        if !Entitlement.canSaveLapVideo(entitlement) { return .locked }
        if !youtube.connected { return .connect }
        if status == "failed" { return .failed }
        return .upload
    }

    static func youtubePrivacyLabel(_ value: String?) -> String {
        YOUTUBE_PRIVACY.first { $0.value == value }?.label ?? "Private"
    }

    private static let GENERIC_FAILURE = "YouTube didn't accept the upload. Try again."

    /// The line under the player. A queued or uploading row's `error` is a
    /// waiting note ("…uploads continue tomorrow") and wins. The percentage is
    /// floored and held under 100, so it never says 100% before YouTube has
    /// said done.
    static func youtubeStatusLine(
        status: String?, progress: Double? = nil, privacy: String? = nil, error: String? = nil
    ) -> String {
        let error = (error?.isEmpty ?? true) ? nil : error
        switch status {
        case "done": return "On YouTube · \(youtubePrivacyLabel(privacy))"
        case "failed": return error ?? GENERIC_FAILURE
        case "queued": return error ?? "Waiting to upload to YouTube"
        case "uploading":
            if let error { return error }
            let raw = progress ?? 0
            let pct = min(99, max(0, Int(((raw.isFinite ? raw : 0) * 100).rounded(.down))))
            return "Uploading to YouTube · \(pct)%"
        default: return ""
        }
    }

    static func youtubeStatusLine(_ upload: YouTubeUpload?) -> String {
        guard let upload else { return "" }
        return youtubeStatusLine(
            status: upload.status, progress: upload.progress, privacy: upload.privacy, error: upload.error
        )
    }

    /// The event detail's `clip.youtube`, which carries no progress.
    static func youtubeStatusLine(_ upload: LapClipYouTube?) -> String {
        guard let upload else { return "" }
        return youtubeStatusLine(status: upload.status, privacy: upload.privacy)
    }

    /// Keep polling while this is true (every 5 s, while the page is visible).
    static func youtubeIsPending(_ status: String?) -> Bool {
        status == "queued" || status == "uploading"
    }

    /// The server's refusals of `POST /api/clips/:id/youtube`, said as the form
    /// says them. Anything else (a 400's named rule) is shown as the server
    /// worded it.
    static func youtubeRequestError(_ message: String?) -> String {
        switch message {
        case "youtube upload limit": "You can upload 10 videos to YouTube a day."
        case "youtube not connected": "Connect YouTube in Settings first."
        case "already on youtube": "This video is already on YouTube."
        case "youtube upload in progress": "This video is already uploading to YouTube."
        case "clip not ready": "This video is still uploading to Track Evolution."
        case "pro required": "Uploading to YouTube is part of Pro."
        default: (message?.isEmpty ?? true) ? GENERIC_FAILURE : message!
        }
    }

    /// Settings' line for the connection on `GET /api/me`'s `user.youtube`.
    static func youtubeAccountLine(_ yt: YouTubeAccount?) -> String {
        guard let yt, yt.available else { return "" }
        let account = (yt.account?.isEmpty ?? true) ? nil : yt.account
        if !yt.connected {
            return account.map { "YouTube access for \($0) was removed. Reconnect to upload again." }
                ?? "Not connected."
        }
        let who = account.map { "Connected as \($0)" } ?? "Connected"
        if let title = yt.channelTitle, !title.isEmpty { return "\(who) · \(title)" }
        return who
    }

    /// The form's title counter and limit, counted the server's way: code
    /// points, not grapheme clusters.
    static let YOUTUBE_TITLE_MAX = 100
    static func titleLength(_ title: String) -> Int { title.unicodeScalars.count }

    /// `trackevolution://youtube?result=connected|denied|error` — where the
    /// connect round trip comes back to. Read from the web-auth session's
    /// completion, never routed (`DeepLink` refuses it). Anything unrecognised
    /// is `error`.
    static func connectResult(_ callback: URL) -> String {
        let result = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "result" }?.value
        return result.flatMap { YOUTUBE_RESULT_TEXT[$0] == nil ? nil : $0 } ?? "error"
    }
}
