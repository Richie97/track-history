import Foundation

/// Best-lap video clips (NS-45): which lap of an imported video gets saved, the
/// window cut around it, and what the import review's *Save best-lap video* row
/// and Settings' storage line say.
///
/// The port of `public/js/import/clip.js` under the **same names**, pinned to
/// `contracts/logic/lap-clips.json` by `LapClipsTests`. Times are seconds on the
/// telemetry clock (a lap's `startT`/`endT`), which the spec takes to be — and
/// ticket 1 verified on PDR and PDR 2.5 footage to be — the file's media
/// timeline. The window is the *requested* cut: a passthrough cut starts at the
/// keyframe before it, so `ClipCutter` in the app reports the lap's real offset
/// inside the clip it made.
public enum LapClips {
    /// Seconds kept before the lap starts and after it ends, clamped to the file.
    public static let PRE_ROLL_S: Double = 3
    public static let POST_ROLL_S: Double = 2
    /// A lap longer than this gets no clip (inclusive: exactly 600 s still does).
    public static let MAX_CLIP_S: Double = 600

    /// The parsers whose source is a video file. A phone recording (`live`), a
    /// `.vbo` and a Track Precision `.csv` have no video to cut.
    public static let VIDEO_KINDS: [ParsedTelemetry.Kind] = [.pdr, .gopro]

    /// The padded window around one lap.
    public struct Window: Hashable, Sendable {
        public var startS: Double
        public var endS: Double
        /// Where the lap starts inside the window.
        public var lapOffsetS: Double

        public init(startS: Double, endS: Double, lapOffsetS: Double) {
            self.startS = startS
            self.endS = endS
            self.lapOffsetS = lapOffsetS
        }
    }

    /// The lap to save from one parsed video, and its index into `parsed.laps`.
    public struct Candidate: Hashable, Sendable {
        public var lap: ParsedLap
        public var index: Int
    }

    /// One review item as the offer reads it — the native `ReviewItem`'s names
    /// plus the source file's size, `{ parsed, include, fileBytes }` in the JS.
    public struct Item: Sendable {
        public var parsed: ParsedTelemetry?
        public var include: Bool
        public var fileBytes: Int?

        public init(parsed: ParsedTelemetry?, include: Bool, fileBytes: Int?) {
            self.parsed = parsed
            self.include = include
            self.fileBytes = fileBytes
        }
    }

    /// Which state the review row is in.
    public enum Offer: String, Hashable, Sendable {
        /// No included item has a clip candidate — the row isn't drawn.
        case none
        /// A free account: drawn as the Pro offer, never hidden.
        case locked
        /// The candidates' estimates would take storage over the quota.
        case full
        /// Offered (the switch itself starts on, every review).
        case on
    }

    /// The padded window around one lap, clamped to `[0, durationS]`, or nil when
    /// the lap has no usable window: no `startT`/`endT`, one outside the file, or
    /// a lap longer than `MAX_CLIP_S`.
    public static func clipWindow(_ lap: ParsedLap?, _ durationS: Double) -> Window? {
        guard let lap, let startT = lap.startT, let endT = lap.endT,
              startT.isFinite, endT.isFinite, durationS.isFinite
        else { return nil }
        if startT < 0 || endT <= startT || endT > durationS { return nil }
        if endT - startT > MAX_CLIP_S { return nil }
        let startS = max(0, startT - PRE_ROLL_S)
        let endS = min(durationS, endT + POST_ROLL_S)
        return Window(startS: startS, endS: endS, lapOffsetS: startT - startS)
    }

    /// The best lap that has a usable window; a tie on time goes to the lower
    /// lap number (the earlier index), which is also the lap the server attaches
    /// the clip to (`POST /sessions/:id/clip` keys on the time, lowest `lap_num`
    /// first). An `estimated` lap still counts: an estimated boundary is still a
    /// boundary, and the padding absorbs the error.
    public static func clipCandidate(_ parsed: ParsedTelemetry?) -> Candidate? {
        guard let parsed, VIDEO_KINDS.contains(parsed.kind) else { return nil }
        var best: Candidate?
        for (index, lap) in parsed.laps.enumerated() {
            guard clipWindow(lap, parsed.durationS) != nil else { continue }
            if best == nil || lap.timeMs < best!.lap.timeMs { best = Candidate(lap: lap, index: index) }
        }
        return best
    }

    /// Roughly how big the cut will be: the file's average bitrate over the
    /// window. nil when there's nothing to estimate from.
    public static func estimateClipBytes(_ lap: ParsedLap?, _ fileBytes: Int?, _ durationS: Double) -> Int? {
        guard let w = clipWindow(lap, durationS), let fileBytes, fileBytes > 0, durationS > 0 else { return nil }
        return JSMath.roundToInt((Double(fileBytes) / durationS) * (w.endS - w.startS))
    }

    /// Which state the review row is in, over the review's items. `clips` is
    /// `user.clips` from `GET /api/me`, nil on a cached `/me` older than the field
    /// — in which case nothing is known to be full.
    public static func clipOffer(_ items: [Item], _ entitlement: Entitlement?, _ clips: ClipStorage?) -> Offer {
        let candidates: [(item: Item, candidate: Candidate)] = items.compactMap { item in
            guard item.include, let c = clipCandidate(item.parsed) else { return nil }
            return (item, c)
        }
        if candidates.isEmpty { return .none }
        if !Entitlement.canSaveLapVideo(entitlement) { return .locked }
        if let clips {
            let adding = candidates.reduce(0) { sum, x in
                sum + (estimateClipBytes(x.candidate.lap, x.item.fileBytes, x.item.parsed?.durationS ?? 0) ?? 0)
            }
            if clips.usedBytes + adding > clips.quotaBytes { return .full }
        }
        return .on
    }

    /// The row's second sentence: who else will see the video. One sentence for
    /// any number of coaches.
    public static func clipOfferNote(_ clips: ClipStorage?) -> String {
        if let clips, clips.coachCount >= 1 { return "Your coaches can watch it too." }
        return ""
    }

    private static let MiB = 1024 * 1024
    private static let GiB = 1024 * MiB

    /// "150 MB", "3.2 GB", "20 GB": binary units, GB to one decimal with a whole
    /// number left whole.
    ///
    /// Integer arithmetic rather than `%.1f`: `bytes / GiB` is exact in a double
    /// (a power-of-two divisor), so JavaScript's `toFixed(1)` rounds its *exact*
    /// value half up — 3.25 GiB is "3.3" — and the same rule over the integers is
    /// that answer with no binary representation in the way. The fixture's
    /// 3.25 GiB and 3.35 GiB rows are the two ties a `%.1f` port gets wrong.
    public static func fmtClipBytes(_ bytes: Int?) -> String {
        guard let bytes, bytes > 0 else { return "0 MB" }
        // Math.round(bytes / MiB), ties up — positive, so (b + MiB/2) / MiB.
        let mb = max(1, (bytes + MiB / 2) / MiB)
        if mb < 1024 { return "\(mb) MB" }
        let scaled = bytes * 10
        var tenths = scaled / GiB
        if (scaled % GiB) * 2 >= GiB { tenths += 1 }
        let whole = tenths / 10
        let decimal = tenths % 10
        return decimal == 0 ? "\(whole) GB" : "\(whole).\(decimal) GB"
    }

    /// The row's first sentence, with the size estimate when there is one.
    public static func clipOfferText(_ estimateBytes: Int?) -> String {
        let size = (estimateBytes ?? 0) > 0 ? ", about \(fmtClipBytes(estimateBytes)) each" : ""
        return "A clip of each session's fastest lap\(size). Uploads on Wi-Fi."
    }

    /// What the row says, switched off and disabled, once storage is full.
    public static func clipFullText(_ clips: ClipStorage?) -> String {
        let quota = clips.map { " (\(fmtClipBytes($0.quotaBytes)))" } ?? ""
        return "Your lap video storage is full\(quota). Delete old clips from a lap's page."
    }

    /// Settings' storage line: "Lap videos: 3.2 GB of 20 GB".
    public static func clipStorageLine(_ clips: ClipStorage?) -> String? {
        guard let clips else { return nil }
        return "Lap videos: \(fmtClipBytes(clips.usedBytes)) of \(fmtClipBytes(clips.quotaBytes))"
    }
}
