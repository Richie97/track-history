import Foundation
import Testing

@testable import TrackEvolutionKit

/// The mirrors, checked against the server's own answers.
///
/// `recomputeDetail` exists so an offline read looks like a server read, which is
/// only true if it computes what the server computed. The golden captures are real
/// responses from a real Worker, so recomputing over one and comparing to what it
/// sent is the strongest check available without running the server.
struct OfflineMirrorsTests {
    /// Blank the derived fields, so a passing test can't be the fixture answering
    /// itself.
    private func stripComputed(_ detail: EventDetail) -> EventDetail {
        var stripped = detail
        stripped.event.lapCount = -1
        stripped.event.sessionCount = -1
        stripped.event.lapBestMs = 999_999
        stripped.event.bestMs = 999_999
        stripped.event.consistency = 0
        stripped.event.hours = -1
        return stripped
    }

    @Test(arguments: ["event-detail", "event-detail-no-laps"])
    func recomputesWhatTheServerComputed(golden: String) throws {
        let server = try Goldens.decode(EventDetail.self, golden)
        var mine = stripComputed(server)
        OfflineMirrors.recomputeDetail(&mine)

        #expect(mine.event.lapCount == server.event.lapCount)
        #expect(mine.event.sessionCount == server.event.sessionCount)
        #expect(mine.event.lapBestMs == server.event.lapBestMs)
        #expect(mine.event.bestMs == server.event.bestMs)
        #expect(mine.event.hours == server.event.hours)

        switch (mine.event.consistency, server.event.consistency) {
        case (nil, nil):
            break
        case (let mine?, let theirs?):
            // The server computes this from SQL AVG aggregates and we compute it
            // from the laps themselves, so agreement is to floating-point noise, not
            // to the bit.
            #expect(abs(mine - theirs) < 1e-12)
        default:
            Issue.record("consistency disagrees: \(String(describing: mine.event.consistency)) vs \(String(describing: server.event.consistency))")
        }
    }

    @Test func consistencyIsNilBelowThreeLapsNeverZero() throws {
        var detail = try Goldens.decode(EventDetail.self, "event-detail")
        // Keep the first two laps of the first session only.
        var session = detail.sessions[0]
        session.laps = Array(session.laps.prefix(2))
        detail.sessions = [session]
        OfflineMirrors.recomputeDetail(&detail)

        #expect(detail.event.lapCount == 2)
        #expect(detail.event.consistency == nil, "two laps say nothing about consistency")

        session.laps = Array(detail.sessions[0].laps.prefix(1))
        detail.sessions = [session]
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.consistency == nil)
    }

    @Test func bestMsPrefersWhicheverOfTheManualBestAndTheLoggedBestIsFaster() throws {
        var detail = try Goldens.decode(EventDetail.self, "event-detail")
        let loggedBest = try #require(detail.sessions.flatMap { $0.laps.map(\.timeMs) }.min())

        detail.event.bestTimeMs = loggedBest + 5_000
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.bestMs == loggedBest, "a slower manual best doesn't win")

        detail.event.bestTimeMs = loggedBest - 5_000
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.bestMs == loggedBest - 5_000)

        detail.event.bestTimeMs = nil
        detail.sessions = []
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.bestMs == nil, "neither a manual best nor any laps")
    }

    @Test func hoursTakesTheOverrideElseTheGreaterOfTwoPerDayAndTimeOnTrack() throws {
        var detail = try Goldens.decode(EventDetail.self, "event-detail-no-laps")

        detail.event.trackHours = 3.5
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.hours == 3.5, "the override wins")

        detail.event.trackHours = nil
        detail.event.days = 2
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.hours == 4, "2 days × 2h with no laps")

        // Six hours of logged laps beats the 2h/day estimate.
        detail.sessions = [
            Session(
                id: 1, label: nil, notes: nil, sort: 1, trace: nil, channels: nil,
                laps: (1...6).map { Lap(id: $0, sessionId: 1, lapNum: $0, timeMs: 3_600_000) }
            )
        ]
        OfflineMirrors.recomputeDetail(&detail)
        #expect(detail.event.hours == 6)
        #expect(detail.event.trackHours == nil, "the override is not invented")
    }

    @Test func cleanLapsMatchesSanitizeLaps() {
        // Rounded to whole milliseconds, non-positive and non-finite dropped.
        #expect(OfflineMirrors.cleanLaps([121_500.4, 120_900.6]) == [121_500, 120_901])
        #expect(OfflineMirrors.cleanLaps([0, -1, 121_000]) == [121_000])
        #expect(OfflineMirrors.cleanLaps([.nan, .infinity, 95_000]) == [95_000])
        #expect(OfflineMirrors.cleanLaps([]).isEmpty)
    }
}
