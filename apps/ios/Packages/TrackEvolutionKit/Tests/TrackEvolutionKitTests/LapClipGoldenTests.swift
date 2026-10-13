import Foundation
import Testing

@testable import TrackEvolutionKit

/// Best-lap video metadata (NS-45) as the goldens pin it: a lap's `clip` as an
/// object and as a null on the same event, the coach's cut without
/// `size_bytes`, and `user.clips` on `/me`.
struct LapClipGoldenTests {
    @Test func theEventDetailCarriesOneClipAndNulls() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        let laps = detail.sessions.flatMap(\.laps)
        let clipped = laps.filter { $0.clip != nil }
        #expect(clipped.count == 1, "the fixture saves one clip, on the rich event's best lap")
        #expect(laps.count > clipped.count, "and the other laps carry null")
        let best = try #require(laps.min { $0.timeMs < $1.timeMs })
        #expect(best.clip?.lapOffsetMs == 3000)
        #expect(best.clip?.sizeBytes == 2048)
    }

    @Test func aCoachSeesTheClipWithoutItsSize() throws {
        let detail = try Goldens.decode(EventDetail.self, "student-event-detail")
        let clip = try #require(detail.sessions.flatMap(\.laps).compactMap(\.clip).first)
        #expect(clip.sizeBytes == nil, "size_bytes is the student's bookkeeping (COACH_CLIP_FIELDS)")
        #expect(clip.durationMs > clip.lapOffsetMs)
    }

    @Test func meCarriesStorage() throws {
        let me = try Goldens.decode(Me.self, "me-pro-legacy")
        let clips = try #require(me.user.clips)
        #expect(clips.usedBytes == 2048)
        #expect(clips.quotaBytes == 20 * 1024 * 1024 * 1024)
        #expect(clips.coachCount == 0)
    }
}
