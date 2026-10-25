import Foundation
import Testing

@testable import TrackEvolutionKit

/// Best-lap video metadata (NS-45) as the goldens pin it: a lap's `clip` as an
/// object and as a null on the same event, the coach's cut without
/// `size_bytes`, and `user.clips` on `/me` — plus the clip's YouTube upload
/// (NS-46) as an object and as a null, and never on a coach's cut.
struct LapClipGoldenTests {
    @Test func theEventDetailCarriesTwoClipsAndNulls() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        let laps = detail.sessions.flatMap(\.laps)
        let clipped = laps.filter { $0.clip != nil }
        #expect(clipped.count == 2, "the fixture saves two clips: the rich event's best lap and another session's")
        #expect(laps.count > clipped.count, "and the other laps carry null")
        let best = try #require(laps.min { $0.timeMs < $1.timeMs })
        #expect(best.clip?.lapOffsetMs == 3000)
        #expect(best.clip?.sizeBytes == 2048)
        // The best lap's clip is on YouTube; the other's is not.
        let youtube = try #require(best.clip?.youtube)
        #expect(youtube.status == "done")
        #expect(youtube.privacy == "unlisted")
        #expect(youtube.url == "https://youtu.be/\(youtube.videoId ?? "")")
        // Ids are normalized to 1 in the goldens, so the other clip is told apart by its lap time.
        let other = try #require(clipped.first { $0.timeMs != best.timeMs }?.clip)
        #expect(other.youtube == nil)
    }

    @Test func aCoachSeesTheClipWithoutItsSizeOrItsYouTubeLink() throws {
        let detail = try Goldens.decode(EventDetail.self, "student-event-detail")
        let clip = try #require(detail.sessions.flatMap(\.laps).compactMap(\.clip).first)
        #expect(clip.sizeBytes == nil, "size_bytes is the student's bookkeeping (COACH_CLIP_FIELDS)")
        #expect(clip.youtube == nil, "the YouTube link is the driver's to hand out (NS-46)")
        #expect(clip.durationMs > clip.lapOffsetMs)
    }

    @Test func meCarriesTheYouTubeConnection() throws {
        let fresh = try #require(try Goldens.decode(Me.self, "me").user.youtube)
        #expect(fresh.available && !fresh.connected && fresh.account == nil)
        let connected = try #require(try Goldens.decode(Me.self, "me-pro-legacy").user.youtube)
        #expect(connected.connected && connected.account != nil && connected.channelTitle != nil)
    }

    @Test func meCarriesStorage() throws {
        let me = try Goldens.decode(Me.self, "me-pro-legacy")
        let clips = try #require(me.user.clips)
        #expect(clips.usedBytes == 2048)
        #expect(clips.quotaBytes == 20 * 1024 * 1024 * 1024)
        #expect(clips.coachCount == 0)
    }
}
