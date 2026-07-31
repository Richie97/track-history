import Foundation
import Testing

@testable import TrackEvolutionKit

/// The lap-overlay maths. The first two cases are `test/unit/channel-graphs.test.js`
/// ported with the code, as the porting convention requires; the rest cover what the
/// JS asserts through the SVG string (which laps draw, which channels appear at all)
/// and the selection rules the web UI keeps in its own closure.
struct ChannelGraphsTests {
    /// The fixture from the JS tests: two laps, only the first carrying RPM, neither
    /// carrying lateral G.
    private func mkChannels() -> SessionChannels {
        SessionChannels(
            v: 1,
            dStepM: 20,
            laps: [
                LapChannels(
                    n: 1,
                    timeMs: 48_000,
                    speed: (0..<90).map { 120 + 40 * sin(Double($0) / 6) },
                    rpm: Array(repeating: 5000, count: 90),
                    latG: nil
                ),
                LapChannels(
                    n: 2,
                    timeMs: 47_000,
                    speed: (0..<90).map { 125 + 40 * sin(Double($0) / 6) },
                    rpm: nil,
                    latG: nil
                )
            ]
        )
    }

    private func lap(_ num: Int, _ ms: Int) -> Lap {
        Lap(id: num, sessionId: 1, lapNum: num, timeMs: ms)
    }

    @Test func pairsLapRowsToChannelEntriesByExactTime() {
        let chLaps = [
            LapChannels(n: 1, timeMs: 48_000, speed: nil, rpm: nil, latG: nil),
            LapChannels(n: 2, timeMs: 47_000, speed: nil, rpm: nil, latG: nil)
        ]
        // Lap 3 was hand-added after the import, so it has no channel data.
        let laps = [lap(1, 48_000), lap(2, 47_000), lap(3, 49_000)]
        #expect(ChannelGraphs.matchLapsToChannels(laps, chLaps).map(\.chIdx) == [0, 1, -1])
    }

    @Test func matchesDuplicateTimesOneToOneInOrder() {
        let chLaps = [
            LapChannels(n: 1, timeMs: 47_000, speed: nil, rpm: nil, latG: nil),
            LapChannels(n: 2, timeMs: 47_000, speed: nil, rpm: nil, latG: nil)
        ]
        let laps = [lap(1, 47_000), lap(2, 47_000)]
        #expect(ChannelGraphs.matchLapsToChannels(laps, chLaps).map(\.chIdx) == [0, 1])
    }

    @Test func onlyChannelsSomeLapRecordedAreCharted() {
        // Speed on both laps, RPM on one, lateral G on neither — the JS asserts the
        // same through the path count and the empty string.
        #expect(ChannelGraphs.presentChannels(mkChannels()) == [.speed, .rpm])
        #expect(ChannelGraphs.valueDomain(.latG, in: mkChannels()) == nil)
        let empty = SessionChannels(v: 1, dStepM: 20, laps: [])
        #expect(ChannelGraphs.presentChannels(empty).isEmpty)
    }

    @Test func speedReadsInMilesPerHour() throws {
        let channels = mkChannels()
        // 120 km/h stored is what the axis has to show as ~74.6 mph.
        let value = try #require(ChannelGraphs.value(.speed, lapIndex: 0, gridIndex: 0, in: channels))
        #expect(abs(value - 120 * 0.621371) < 1e-9)
        #expect(ChannelGraphs.value(.rpm, lapIndex: 1, gridIndex: 0, in: channels) == nil)
        #expect(ChannelGraphs.value(.speed, lapIndex: 0, gridIndex: 999, in: channels) == nil)
    }

    @Test func theDomainBracketsEveryLapOfTheChannel() throws {
        let domain = try #require(ChannelGraphs.valueDomain(.speed, in: mkChannels()))
        let all = mkChannels().laps.flatMap { $0.speed ?? [] }.map { $0 * 0.621371 }
        #expect(domain.low < all.min()!)
        #expect(domain.high > all.max()!)
    }

    @Test func lateralGKeepsItsZero() throws {
        let channels = SessionChannels(
            v: 1,
            dStepM: 20,
            laps: [LapChannels(n: 1, timeMs: 47_000, speed: nil, rpm: nil, latG: [0.4, 1.1, 0.9])]
        )
        let domain = try #require(ChannelGraphs.valueDomain(.latG, in: channels))
        // An axis starting at 0.4 G would read as if the car never went straight.
        #expect(domain.low == 0)
        #expect(domain.high > 1.1)
    }

    @Test func aConstantChannelStillGetsAWindow() throws {
        let channels = SessionChannels(
            v: 1,
            dStepM: 20,
            laps: [LapChannels(n: 1, timeMs: 47_000, speed: nil, rpm: [5000, 5000], latG: nil)]
        )
        let domain = try #require(ChannelGraphs.valueDomain(.rpm, in: channels))
        #expect(domain.high > domain.low, "a flat lap draws a line, it doesn't divide by zero")
    }

    @Test func theFastestLapWithChannelsStartsHighlighted() {
        let chLaps = [
            LapChannels(n: 1, timeMs: 48_000, speed: [1], rpm: nil, latG: nil),
            LapChannels(n: 2, timeMs: 47_000, speed: [1], rpm: nil, latG: nil)
        ]
        let matches = ChannelGraphs.matchLapsToChannels([lap(1, 48_000), lap(2, 47_000)], chLaps)
        #expect(ChannelGraphs.initialSelection(matches) == [1])
        // A lap without channel data can't be the pre-selection even when it's the
        // fastest lap of the session.
        let unmatched = ChannelGraphs.matchLapsToChannels([lap(1, 40_000)], [])
        #expect(ChannelGraphs.initialSelection(unmatched).isEmpty)
    }

    @Test func highlightingIsThreeSlotsDeepAndEvictsTheOldest() {
        var lit: [Int] = []
        for i in 0..<3 { lit = ChannelGraphs.toggle(i, in: lit) }
        #expect(lit == [0, 1, 2])
        lit = ChannelGraphs.toggle(3, in: lit)
        #expect(lit == [1, 2, 3], "a fourth lap shows rather than doing nothing")
        lit = ChannelGraphs.toggle(2, in: lit)
        #expect(lit == [1, 3], "tapping a highlighted lap turns it off")
    }

    @Test func theDistanceAxisIsSharedAndLabelled() {
        let channels = mkChannels()
        #expect(ChannelGraphs.gridCount(.speed, in: channels) == 90)
        #expect(ChannelGraphs.distanceSpan(.speed, in: channels) == 89 * 20)
        #expect(ChannelGraphs.gridIndex(atDistance: 190, .speed, in: channels) == 10)
        // Clamped to the axis rather than reading off the end of a lap.
        #expect(ChannelGraphs.gridIndex(atDistance: 99_999, .speed, in: channels) == 89)
        #expect(ChannelGraphs.gridIndex(atDistance: -50, .speed, in: channels) == 0)
        #expect(ChannelGraphs.fmtDist(940) == "940 m")
        #expect(ChannelGraphs.fmtDist(2000) == "2 km")
        #expect(ChannelGraphs.fmtDist(2400) == "2.4 km")
    }

    /// Cross-language agreement, the same way NS-13 does it: the JS implementation's
    /// own output for a shared input (`contracts/logic/channels.json`, generated by
    /// `npm run contracts:logic`) has to come back out of this port unchanged — the
    /// duplicate lap times and the unmatched lap included.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/channels.json")
        let fixture = try JSONDecoder().decode(ChannelsFixture.self, from: try Data(contentsOf: url))
        let sessionLaps = fixture.input.sessionLaps.enumerated().map {
            Lap(id: $0.offset + 1, sessionId: 1, lapNum: $0.element.lapNum, timeMs: $0.element.timeMs)
        }
        let chLaps = fixture.input.channelLaps.map {
            LapChannels(n: $0.n, timeMs: $0.timeMs, speed: nil, rpm: nil, latG: nil)
        }
        #expect(ChannelGraphs.matchLapsToChannels(sessionLaps, chLaps).map(\.chIdx) == fixture.expected.chIdx)
    }

    /// The real thing: the golden event's imported session decodes and charts.
    @Test func theGoldenSessionsChannelsChart() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        let session = try #require(detail.sessions.first { $0.channels != nil })
        let channels = try #require(session.channels)
        #expect(ChannelGraphs.presentChannels(channels) == [.speed, .rpm, .latG])
        let matches = ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)
        #expect(matches.filter(\.hasChannels).count == matches.count)
        #expect(ChannelGraphs.initialSelection(matches) == [0])
        for channel in ChannelGraphs.presentChannels(channels) {
            #expect(ChannelGraphs.valueDomain(channel, in: channels) != nil)
        }
    }
}

/// `contracts/logic/channels.json` — reference output captured from
/// `public/js/channel-graphs.js`. The wire names are the JS ones on purpose: this
/// decodes the reference, not our models.
struct ChannelsFixture: Decodable {
    struct SessionLap: Decodable {
        var lapNum: Int
        var timeMs: Int

        enum CodingKeys: String, CodingKey {
            case lapNum = "lap_num"
            case timeMs = "time_ms"
        }
    }

    struct ChannelLap: Decodable {
        var n: Int
        var timeMs: Int
    }

    struct Input: Decodable {
        var sessionLaps: [SessionLap]
        var channelLaps: [ChannelLap]
    }

    struct Expected: Decodable {
        var chIdx: [Int]
    }

    var input: Input
    var expected: Expected
}
