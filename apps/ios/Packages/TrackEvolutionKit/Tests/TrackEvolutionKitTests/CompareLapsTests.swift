import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cross-event lap comparison maths — `test/unit/compare-laps.test.js` ported
/// with the code, plus the cross-language pin against
/// `contracts/logic/compare-laps.json`.
struct CompareLapsTests {
    private func lap(_ lapNum: Int, _ timeMs: Int, sessionId: Int = 0) -> Lap {
        Lap(id: 0, sessionId: sessionId, lapNum: lapNum, timeMs: timeMs)
    }

    private func session(
        _ id: Int, laps: [Lap], chLaps: [LapChannels]?, label: String? = nil
    ) -> CompareLaps.SessionLaps {
        CompareLaps.SessionLaps(
            sessionId: id,
            label: label,
            laps: laps,
            channels: chLaps.map { SessionChannels(v: 1, dStepM: 20, laps: $0) }
        )
    }

    @Test func flattensEventDetailsSkippingLapsWithoutChannels() {
        let events = [
            CompareLaps.EventLaps(
                eventId: 7, date: "2026-06-01", club: nil,
                sessions: [
                    session(
                        40,
                        laps: [lap(1, 92_000), lap(2, 91_000), lap(3, 90_500)], // lap 3: hand-added
                        chLaps: [
                            LapChannels(n: 1, timeMs: 92_000, speed: [10, 20]),
                            LapChannels(n: 2, timeMs: 91_000, speed: [10, 20]),
                        ],
                        label: "AM"
                    ),
                    session(41, laps: [lap(1, 95_000)], chLaps: nil), // no channels at all
                ]
            ),
            CompareLaps.EventLaps(
                eventId: 8, date: "2026-07-04", club: nil,
                sessions: [
                    session(50, laps: [lap(1, 89_000)], chLaps: [LapChannels(n: 1, timeMs: 89_000, speed: [10, 20])])
                ]
            ),
        ]
        let rows = CompareLaps.comparableLaps(events)
        #expect(rows == [
            CompareLaps.Row(eventId: 7, date: "2026-06-01", club: nil, sessionId: 40, sessionLabel: "AM", lapNum: 1, timeMs: 92_000, chIdx: 0),
            CompareLaps.Row(eventId: 7, date: "2026-06-01", club: nil, sessionId: 40, sessionLabel: "AM", lapNum: 2, timeMs: 91_000, chIdx: 1),
            CompareLaps.Row(eventId: 8, date: "2026-07-04", club: nil, sessionId: 50, sessionLabel: nil, lapNum: 1, timeMs: 89_000, chIdx: 0),
        ])
    }

    private func row(_ date: String, _ timeMs: Int) -> CompareLaps.Row {
        CompareLaps.Row(eventId: 0, date: date, club: nil, sessionId: 0, sessionLabel: nil, lapNum: 1, timeMs: timeMs, chIdx: 0)
    }

    @Test func picksLatestEventsBestVsOverallBest() {
        let rows = [
            row("2026-05-01", 90_000), // overall best
            row("2026-05-01", 93_000),
            row("2026-07-01", 92_000), // best of latest → side A
            row("2026-07-01", 94_000),
        ]
        let picks = CompareLaps.defaultComparePicks(rows)
        #expect(picks?.a == 2)
        #expect(picks?.b == 0)
    }

    @Test func fallsBackToBestOfTheRestWhenLatestBestIsOverallBest() {
        let rows = [row("2026-05-01", 95_000), row("2026-07-01", 90_000), row("2026-07-01", 91_000)]
        let picks = CompareLaps.defaultComparePicks(rows)
        #expect(picks?.a == 1)
        #expect(picks?.b == 2)
    }

    @Test func needsTwoLaps() {
        #expect(CompareLaps.defaultComparePicks([]) == nil)
        #expect(CompareLaps.defaultComparePicks([row("2026-05-01", 90_000)]) == nil)
    }

    @Test func resampleIsIdentityWhenSpacingsMatch() {
        let entry = LapChannels(n: 1, timeMs: 90_000, speed: [100, 110, 120])
        #expect(CompareLaps.resampleChannelLap(entry, 20, 20) == entry)
    }

    @Test func resampleInterpolatesOntoAFinerGrid() {
        let entry = LapChannels(n: 1, timeMs: 90_000, speed: [100, 110, 120], latG: [0, 1, 0])
        let out = CompareLaps.resampleChannelLap(entry, 20, 10)
        #expect(out.speed == [100, 105, 110, 115, 120])
        #expect(out.latG == [0, 0.5, 1, 0.5, 0])
        #expect(out.n == 1)
        #expect(out.timeMs == 90_000)
    }

    @Test func resampleDropsOntoACoarserGridWithoutReadingPastTheEnd() {
        let entry = LapChannels(n: 2, timeMs: 88_000, speed: [100, 110, 120, 130, 140])
        #expect(CompareLaps.resampleChannelLap(entry, 10, 20).speed == [100, 120, 140])
    }

    @Test func resampleSkipsChannelsTheEntryDoesNotCarry() {
        let out = CompareLaps.resampleChannelLap(LapChannels(n: 1, timeMs: 90_000, speed: [1, 2]), 20, 10)
        #expect(out.throttle == nil)
        #expect(out.rpm == nil)
    }

    @Test func alignPassesBothEntriesThroughWhenGridsAgree() {
        let a = LapChannels(n: 1, timeMs: 90_000, speed: [1, 2])
        let b = LapChannels(n: 2, timeMs: 91_000, speed: [3, 4])
        let pair = CompareLaps.alignLapPair(a, 20, b, 20)
        #expect(pair.dStepM == 20)
        #expect(pair.laps == [a, b])
    }

    @Test func alignResamplesSideBOntoSideAsGrid() {
        let a = LapChannels(n: 1, timeMs: 90_000, speed: [1, 2, 3])
        let b = LapChannels(n: 2, timeMs: 91_000, speed: [100, 120])
        let pair = CompareLaps.alignLapPair(a, 10, b, 20)
        #expect(pair.dStepM == 10)
        #expect(pair.laps[1].speed == [100, 110, 120])
    }

    @Test func measuresDrivenLengthAndMismatch() {
        let a = LapChannels(n: 1, timeMs: 0, speed: [Double](repeating: 1, count: 101)) // 2000 m at 20 m
        let b = LapChannels(n: 2, timeMs: 0, speed: [Double](repeating: 1, count: 91)) // 1800 m
        #expect(CompareLaps.drivenLengthM(a, 20) == 2000)
        #expect(CompareLaps.drivenLengthM(LapChannels(n: 1, timeMs: 0, speed: [1]), 20) == 0)
        #expect(CompareLaps.drivenLengthM(LapChannels(n: 1, timeMs: 0), 20) == 0)
        #expect(CompareLaps.lengthMismatchRatio(a, 20, a, 20) == 0)
        #expect(abs(CompareLaps.lengthMismatchRatio(a, 20, b, 20) - 0.1) < 1e-10)
        // Different grids, same driven length: no mismatch.
        let fine = LapChannels(n: 3, timeMs: 0, speed: [Double](repeating: 1, count: 201))
        #expect(CompareLaps.lengthMismatchRatio(a, 20, fine, 10) == 0)
        #expect(CompareLaps.lengthMismatchRatio(LapChannels(n: 1, timeMs: 0), 20, LapChannels(n: 2, timeMs: 0), 20) == 0)
    }

    @Test func reducesChannelsToMetricsWithInclusiveThresholds() {
        let m = CompareLaps.lapMetrics(
            LapChannels(
                n: 1,
                timeMs: 90_000,
                speed: [80, 120, 100],
                rpm: [5000, 6400, 6000],
                latG: [0.2, 1.05, 0.8],
                throttle: [CompareLaps.FULL_THROTTLE_PCT, 100, 40, 0], // 2 of 4 at/over the cutoff
                brake: [0, CompareLaps.BRAKING_PCT, 80, 0] // 2 of 4
            )
        )
        #expect(m == CompareLaps.Metrics(
            timeMs: 90_000,
            topSpeedKph: 120,
            minSpeedKph: 80,
            avgSpeedKph: 100,
            maxRpm: 6400,
            maxLatG: 1.05,
            fullThrottlePct: 50,
            brakingPct: 50
        ))
    }

    @Test func metricsAreNilForChannelsTheLapDidNotStore() {
        let m = CompareLaps.lapMetrics(LapChannels(n: 1, timeMs: 90_000, speed: [100]))
        #expect(m.maxRpm == nil)
        #expect(m.maxLatG == nil)
        #expect(m.fullThrottlePct == nil)
        #expect(m.brakingPct == nil)
        let none = CompareLaps.lapMetrics(LapChannels(n: 1, timeMs: 90_000))
        #expect(none.topSpeedKph == nil)
        #expect(none.avgSpeedKph == nil)
    }

    // MARK: - Cross-language pin

    /// The JS implementation's own output for a shared input has to come back out
    /// of this port — rows and picks exactly, doubles to within 1e-9.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/compare-laps.json")
        let fixture = try JSONDecoder().decode(CompareLapsFixture.self, from: try Data(contentsOf: url))

        let events = fixture.input.events.map { event in
            CompareLaps.EventLaps(
                eventId: event.id,
                date: event.startDate,
                club: event.club,
                sessions: event.sessions.map { session in
                    CompareLaps.SessionLaps(
                        sessionId: session.id,
                        label: session.label,
                        laps: session.laps.map { Lap(id: 0, sessionId: session.id, lapNum: $0.lapNum, timeMs: $0.timeMs) },
                        channels: session.channels
                    )
                }
            )
        }

        let rows = CompareLaps.comparableLaps(events)
        #expect(rows.count == fixture.expected.comparableLaps.count)
        for (got, want) in zip(rows, fixture.expected.comparableLaps) {
            #expect(got == CompareLaps.Row(
                eventId: want.eventId, date: want.date, club: want.club, sessionId: want.sessionId,
                sessionLabel: want.sessionLabel, lapNum: want.lapNum, timeMs: want.timeMs, chIdx: want.chIdx
            ))
        }

        let picks = CompareLaps.defaultComparePicks(rows)
        #expect(picks?.a == fixture.expected.defaultComparePicks.a)
        #expect(picks?.b == fixture.expected.defaultComparePicks.b)

        let fallback = CompareLaps.defaultComparePicks(fixture.input.fallbackRows.map { row($0.date, $0.timeMs) })
        #expect(fallback?.a == fixture.expected.defaultPicksFallback.a)
        #expect(fallback?.b == fixture.expected.defaultPicksFallback.b)

        func checkArr(_ got: [Double]?, _ want: [Double]?, _ name: String) {
            switch (got, want) {
            case (nil, nil): break
            case let (.some(g), .some(w)):
                #expect(g.count == w.count, "\(name): \(g.count) vs \(w.count) points")
                for (i, pair) in zip(g, w).enumerated() {
                    #expect(abs(pair.0 - pair.1) < 1e-9, "\(name)[\(i)]: \(pair.0) != \(pair.1)")
                }
            default:
                Issue.record("\(name): nil mismatch")
            }
        }

        func checkLap(_ got: LapChannels, _ want: LapChannels, _ name: String) {
            #expect(got.n == want.n, name)
            #expect(got.timeMs == want.timeMs, name)
            checkArr(got.speed, want.speed, "\(name).speed")
            checkArr(got.rpm, want.rpm, "\(name).rpm")
            checkArr(got.latG, want.latG, "\(name).latG")
            checkArr(got.throttle, want.throttle, "\(name).throttle")
            checkArr(got.brake, want.brake, "\(name).brake")
            checkArr(got.steering, want.steering, "\(name).steering")
        }

        let pairA = fixture.input.events[0].sessions[0].channels!.laps[1]
        let pairB = fixture.input.events[1].sessions[0].channels!.laps[1]
        checkLap(CompareLaps.resampleChannelLap(pairB, 25, 20), fixture.expected.resampledTo20, "resampledTo20")
        checkLap(CompareLaps.resampleChannelLap(fixture.input.fullEntry, 20, 50), fixture.expected.resampledTo50, "resampledTo50")

        let aligned = CompareLaps.alignLapPair(pairA, 20, pairB, 25)
        #expect(aligned.dStepM == fixture.expected.alignedPair.dStepM)
        #expect(aligned.laps.count == fixture.expected.alignedPair.laps.count)
        for (i, pair) in zip(aligned.laps, fixture.expected.alignedPair.laps).enumerated() {
            checkLap(pair.0, pair.1, "alignedPair.laps[\(i)]")
        }

        #expect(CompareLaps.drivenLengthM(pairA, 20) == fixture.expected.drivenLengthA)
        #expect(CompareLaps.drivenLengthM(pairB, 25) == fixture.expected.drivenLengthB)
        #expect(abs(CompareLaps.lengthMismatchRatio(pairA, 20, pairB, 25) - fixture.expected.lengthMismatchRatio) < 1e-9)

        func checkOpt(_ got: Double?, _ want: Double?, _ name: String) {
            switch (got, want) {
            case (nil, nil): break
            case let (.some(g), .some(w)): #expect(abs(g - w) < 1e-9, "\(name): \(g) != \(w)")
            default: Issue.record("\(name): nil mismatch")
            }
        }

        func checkMetrics(_ got: CompareLaps.Metrics, _ want: CompareLapsFixture.Metrics, _ name: String) {
            #expect(got.timeMs == want.timeMs, name)
            checkOpt(got.topSpeedKph, want.topSpeedKph, "\(name).topSpeedKph")
            checkOpt(got.minSpeedKph, want.minSpeedKph, "\(name).minSpeedKph")
            checkOpt(got.avgSpeedKph, want.avgSpeedKph, "\(name).avgSpeedKph")
            checkOpt(got.maxRpm, want.maxRpm, "\(name).maxRpm")
            checkOpt(got.maxLatG, want.maxLatG, "\(name).maxLatG")
            checkOpt(got.fullThrottlePct, want.fullThrottlePct, "\(name).fullThrottlePct")
            checkOpt(got.brakingPct, want.brakingPct, "\(name).brakingPct")
        }

        checkMetrics(CompareLaps.lapMetrics(fixture.input.fullEntry), fixture.expected.metricsFull, "metricsFull")
        checkMetrics(CompareLaps.lapMetrics(fixture.input.speedOnlyEntry), fixture.expected.metricsSpeedOnly, "metricsSpeedOnly")
    }
}

/// `contracts/logic/compare-laps.json` — reference output captured from
/// `public/js/compare-laps.js`.
struct CompareLapsFixture: Decodable {
    struct FixtureEvent: Decodable {
        var id: Int
        var startDate: String
        var club: String?
        var sessions: [FixtureSession]

        enum CodingKeys: String, CodingKey {
            case id, club, sessions
            case startDate = "start_date"
        }
    }

    struct FixtureSession: Decodable {
        var id: Int
        var label: String?
        var laps: [FixtureLap]
        var channels: SessionChannels?
    }

    struct FixtureLap: Decodable {
        var lapNum: Int
        var timeMs: Int

        enum CodingKeys: String, CodingKey {
            case lapNum = "lap_num"
            case timeMs = "time_ms"
        }
    }

    struct FixtureRow: Decodable {
        var eventId: Int
        var date: String
        var club: String?
        var sessionId: Int
        var sessionLabel: String?
        var lapNum: Int
        var timeMs: Int
        var chIdx: Int
    }

    struct FallbackRow: Decodable {
        var date: String
        var timeMs: Int
    }

    struct Picks: Decodable {
        var a: Int
        var b: Int
    }

    struct Metrics: Decodable {
        var timeMs: Int
        var topSpeedKph: Double?
        var minSpeedKph: Double?
        var avgSpeedKph: Double?
        var maxRpm: Double?
        var maxLatG: Double?
        var fullThrottlePct: Double?
        var brakingPct: Double?
    }

    struct Input: Decodable {
        var events: [FixtureEvent]
        var fallbackRows: [FallbackRow]
        var fullEntry: LapChannels
        var speedOnlyEntry: LapChannels
    }

    struct Expected: Decodable {
        var comparableLaps: [FixtureRow]
        var defaultComparePicks: Picks
        var defaultPicksFallback: Picks
        var resampledTo20: LapChannels
        var resampledTo50: LapChannels
        var alignedPair: SessionChannels
        var drivenLengthA: Double
        var drivenLengthB: Double
        var lengthMismatchRatio: Double
        var metricsFull: Metrics
        var metricsSpeedOnly: Metrics
    }

    var input: Input
    var expected: Expected
}
