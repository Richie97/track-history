import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/video-sync.test.js`, ported with the code they
/// cover, plus the cross-language pin against `contracts/logic/video-sync.json`
/// — every row, numbers to 1e-9 and strings exactly.
struct VideoSyncTests {
    // Two laps on the same 20 m grid: A is quick, B a touch slower everywhere
    // and much slower through the corner at k 10–14, so "place" and "time"
    // disagree.
    private static let N = 30
    private static let latG: [Double] = (0..<N).map { k in
        (10...14).contains(k) ? 1.1 : (22...25).contains(k) ? 0.8 : 0.05
    }
    private static let speedA: [Double] = (0..<N).map { (10...14).contains($0) ? 90 : 160 }
    private static let speedB: [Double] = speedA.enumerated().map { k, v in (10...14).contains(k) ? v - 20 : v - 4 }
    private static let entryA = LapChannels(
        n: 3, timeMs: 15_000, speed: speedA, latG: latG,
        throttle: speedA.map { $0 > 100 ? 100 : 20 },
        brake: speedA.indices.map { $0 == 9 ? 70 : 0 },
        gear: speedA.map { $0 > 100 ? 4 : 3 }
    )
    private static let entryB = LapChannels(n: 5, timeMs: 16_200, speed: speedB, latG: latG)
    private let A = VideoSync.makeSide(.A, entryA, 20, .init(lapOffsetMs: 3_000, durationMs: 22_000))!
    private let B = VideoSync.makeSide(.B, entryB, 20, .init(lapOffsetMs: 3_400, durationMs: 23_600))!
    private let corners = Corners.sessionCorners(SessionChannels(v: 1, dStepM: 20, laps: [entryA, entryB]))

    private var AB: VideoSync.Sides { .init(a: A, b: B) }

    private func close(_ a: Double?, _ b: Double?, _ eps: Double = 1e-9) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return abs(a - b) <= eps
    }

    // MARK: - gridAtElapsed / valueAt

    @Test func clampsBeforeTheLineAndPastTheEnd() {
        let t: [Double] = [0, 1, 3, 6]
        #expect(VideoSync.gridAtElapsed(t, -1) == 0)
        #expect(VideoSync.gridAtElapsed(t, 0) == 0)
        #expect(VideoSync.gridAtElapsed(t, 6) == 3)
        #expect(VideoSync.gridAtElapsed(t, 9) == 3)
    }

    @Test func interpolatesBetweenPointsAndLandsExactlyOnOne() {
        let t: [Double] = [0, 1, 3, 6]
        #expect(VideoSync.gridAtElapsed(t, 2) == 1.5)
        #expect(VideoSync.gridAtElapsed(t, 3) == 2)
        #expect(VideoSync.gridAtElapsed(t, 4.5) == 2.5)
    }

    @Test func isTheInverseOfValueAtOnTheTimeCurve() {
        for k in [0, 0.25, 7.5, 13.2, Double(Self.N - 1)] {
            #expect(close(VideoSync.gridAtElapsed(A.t, VideoSync.valueAt(A.t, k)!), k))
        }
    }

    @Test func valueAtClampsKAndIsNilForAMissingSeries() {
        #expect(VideoSync.valueAt([1, 3], 0.5) == 2)
        #expect(VideoSync.valueAt([1, 3], -4) == 1)
        #expect(VideoSync.valueAt([1, 3], 9) == 3)
        #expect(VideoSync.valueAt(nil, 1) == nil)
        #expect(VideoSync.valueAt([], 1) == nil)
    }

    @Test func lapTimeSeriesStaysStrictlyIncreasingThroughAStandstill() {
        let t = ChannelGraphs.lapTimeSeries([0, 0, 0, 40, 80, 0, 0, 60], 20, 30_000)
        for k in 1..<t.count { #expect(t[k] > t[k - 1]) }
    }

    // MARK: - makeSide

    @Test func integratesTheTimeCurveOnceAndTakesAStoredOneInstead() {
        #expect(close(A.t.last, 15))
        let stored = (0..<Self.N).map { Double($0) / 2 }
        #expect(VideoSync.makeSide(.A, Self.entryA, 20, nil, t: stored)?.t == stored)
    }

    @Test func isNilWithoutASpeedTraceAndDropsAClipWithNoOffset() {
        #expect(VideoSync.makeSide(.A, LapChannels(n: 1, timeMs: 1), 20, nil) == nil)
        let nanOffset = VideoSync.Clip(lapOffsetMs: .nan, durationMs: 1)
        #expect(VideoSync.makeSide(.A, Self.entryA, 20, nanOffset)?.clip == nil)
    }

    // MARK: - sideAtClipTime / clipTimeAtGrid

    @Test func roundTripsAtTheLineMidLapAndTheEnd() {
        for k in [0, 12.5, Double(Self.N - 1)] {
            let c = VideoSync.clipTimeAtGrid(A, k)
            let s = VideoSync.sideAtClipTime(A, c)
            #expect(close(s.k, k))
            #expect(s.inLap)
        }
        #expect(VideoSync.clipTimeAtGrid(A, 0) == 3_000)
        #expect(close(VideoSync.clipTimeAtGrid(A, Double(Self.N - 1)), 18_000, 1e-6))
    }

    @Test func isOutOfTheLapInThePreAndPostRoll() {
        #expect(VideoSync.sideAtClipTime(A, 1_000) == .init(e: -2, k: 0, inLap: false))
        let post = VideoSync.sideAtClipTime(A, 20_000)
        #expect(!post.inLap)
        #expect(post.k == Double(Self.N - 1))
    }

    @Test func scrubsFromTwoSecondsBeforeTheLineToTwoAfter() {
        #expect(VideoSync.scrubRange(A).min == -2)
        #expect(close(VideoSync.scrubRange(A).max, 17))
    }

    // MARK: - playheadAt

    @Test func holdsBothCarsAtOneDistanceInPlaceMode() throws {
        let s = VideoSync.playheadAt(AB, .A, 8, .place)
        let b = try #require(s.b)
        #expect(close(b.k, s.a.k))
        #expect(b.e > 8) // B is slower, so later at the same place
        #expect(close(s.deltaS, s.a.e - b.e))
        #expect(try #require(s.deltaS) < 0)
        #expect(s.gapM == nil)
        #expect(close(b.clipMs, 3_400 + 1000 * b.e, 1e-6))
    }

    @Test func holdsBothAtOneTimeInTimeModeTheGapNegativeWhenBIsBehind() throws {
        let s = VideoSync.playheadAt(AB, .A, 8, .time)
        let b = try #require(s.b)
        #expect(b.e == 8)
        #expect(b.k < s.a.k)
        #expect(close(s.gapM, (b.k - s.a.k) * 20))
        #expect(try #require(s.gapM) < 0)
    }

    @Test func followsASwappedMasterAndStillReportsAsDelta() throws {
        let s = VideoSync.playheadAt(AB, .B, 8, .place)
        #expect(s.masterKey == .B)
        #expect(try #require(s.b).e == 8)
        #expect(close(s.a.k, s.b?.k))
        #expect(try #require(s.deltaS) < 0)
    }

    @Test func isOutOfTheLapBeforeTheLineWithBothCarsTheSameTimeShortOfIt() {
        let s = VideoSync.playheadAt(AB, .A, -1.5, .place)
        #expect(!s.inLap)
        #expect(s.b?.e == -1.5)
        #expect(!s.a.inLap)
        #expect(s.deltaS == nil)
        #expect(s.a.clipMs == 1_500)
    }

    @Test func rollsBothOutTheSameTimePastTheLineInPlaceMode() {
        let s = VideoSync.playheadAt(AB, .A, 15.5, .place)
        #expect(!s.inLap)
        #expect(close(s.b?.e, 16.7))
    }

    @Test func matchesLapsByFractionWhenTheirLengthsDifferPastTheWarning() throws {
        var e = Self.entryB
        e.speed = Array(Self.speedB.prefix(25))
        let short = try #require(VideoSync.makeSide(.B, e, 20, nil))
        #expect(VideoSync.matchByFraction(A, short))
        let s = VideoSync.playheadAt(.init(a: A, b: short), .A, 7, .place)
        #expect(s.byFraction)
        #expect(close(s.b?.k, s.a.k * 24 / 29))
        #expect(s.b?.clipMs == nil)
        #expect(s.b?.inClip == false)
    }

    @Test func isOneSidedWithoutB() {
        let s = VideoSync.playheadAt(.init(a: A, b: nil), .A, 4)
        #expect(s.mode == VideoSync.DEFAULT_SYNC_MODE)
        #expect(s.b == nil)
        #expect(s.deltaS == nil)
        #expect(s.a.now.speedKph == 160)
        #expect(s.a.now.gear == 4)
    }

    @Test func saysWhenASidesClipDoesntHoldTheMoment() throws {
        let late = try #require(VideoSync.makeSide(.A, Self.entryA, 20, .init(lapOffsetMs: 500, durationMs: 9_000)))
        #expect(!VideoSync.playheadAt(.init(a: late, b: nil), .A, -1).a.inClip)
        #expect(VideoSync.playheadAt(.init(a: late, b: nil), .A, 4).a.inClip)
        #expect(!VideoSync.playheadAt(.init(a: late, b: nil), .A, 10).a.inClip)
    }

    // MARK: - followRate / needsResync

    @Test func isTheMastersSpeedOverTheFollowersClamped() throws {
        #expect(close(VideoSync.followRate(AB, .A, 12), 90.0 / 70.0))
        #expect(VideoSync.followRate(.init(a: A, b: nil), .A, 12) == 1)
        var e = Self.entryB
        e.speed = Self.speedB.map { _ in 10 }
        let crawl = try #require(VideoSync.makeSide(.B, e, 20, nil))
        #expect(VideoSync.followRate(.init(a: A, b: crawl), .A, 2) == VideoSync.FOLLOW_RATE_MAX)
        #expect(VideoSync.followRate(.init(a: A, b: crawl), .B, 2) == VideoSync.FOLLOW_RATE_MIN)
    }

    @Test func reSeeksOnlyPastResyncMs() {
        #expect(VideoSync.RESYNC_MS == 150)
        #expect(!VideoSync.needsResync(1000, 1149))
        #expect(!VideoSync.needsResync(1000, 1150))
        #expect(VideoSync.needsResync(1000, 1151))
        #expect(VideoSync.needsResync(1000, 849))
    }

    // MARK: - Words

    @Test func formatsTheClockTheDeltaAndTheGap() {
        #expect(VideoSync.fmtStageTime(36) == "0:36.0")
        #expect(VideoSync.fmtStageTime(139.84) == "2:19.8")
        #expect(VideoSync.fmtStageTime(-1.5) == "\u{2212}0:01.5")
        #expect(VideoSync.fmtStageTime(-0.01) == "0:00.0")
        #expect(VideoSync.fmtStageTime(59.96) == "1:00.0")
        #expect(VideoSync.fmtDeltaS(0.314) == "+0.31 s")
        #expect(VideoSync.fmtDeltaS(-0.12) == "\u{2212}0.12 s")
        #expect(VideoSync.fmtDeltaS(0.004) == "0.00 s")
        #expect(VideoSync.fmtGap(26.2, .metric) == "B ahead 26 m")
        #expect(VideoSync.fmtGap(-26.2, .imperial) == "A ahead 86 ft")
        #expect(VideoSync.fmtGap(0.1, .metric) == "Level")
    }

    @Test func placesKAmongTheCorners() {
        #expect(corners.map { [$0.k0, $0.k1] } == [[10, 14], [22, 25]])
        #expect(VideoSync.cornerPlace(corners, 3) == "before T1")
        #expect(VideoSync.cornerPlace(corners, 12) == "in T1")
        #expect(VideoSync.cornerPlace(corners, 18) == "after T1")
        #expect(VideoSync.cornerPlace(corners, 28) == "after T2")
        #expect(VideoSync.cornerPlace([], 5) == nil)
    }

    @Test func wordsACornerAStraightAndTheRunUpInBothSystems() throws {
        let inCorner = VideoSync.playheadAt(AB, .A, VideoSync.valueAt(A.t, 12)!, .place)
        let d = VideoSync.fmtDeltaS(inCorner.deltaS)
        #expect(
            VideoSync.playheadText(inCorner, corners, .metric)
                == .init(
                    place: "240 m · in T1",
                    value: "\(VideoSync.fmtStageTime(inCorner.a.e)), 240 m, in T1, 90 km/h, throttle 20 %, \(d!)",
                    delta: d
                )
        )
        let braking = VideoSync.playheadAt(.init(a: A, b: nil), .A, VideoSync.valueAt(A.t, 9)!, .place)
        #expect(
            VideoSync.playheadText(braking, corners, .imperial).value
                == "\(VideoSync.fmtStageTime(braking.a.e)), 591 ft, before T1, 99 mph, braking 70 %"
        )
        let time = VideoSync.playheadAt(AB, .A, 12, .time)
        #expect(VideoSync.playheadText(time, corners, .metric).delta == VideoSync.fmtGap(time.gapM, .metric))
        #expect(
            VideoSync.playheadText(VideoSync.playheadAt(AB, .A, -1, .place), corners, .metric)
                == .init(place: "Before the line", value: "\u{2212}0:01.0, Before the line", delta: nil)
        )
        #expect(VideoSync.playheadText(VideoSync.playheadAt(AB, .A, 16, .place), corners, .metric).place == "After the line")
    }

    @Test func stopsAtEachCornersStart() {
        #expect(
            VideoSync.cornerStops(corners, A.t)
                == [.init(label: "T1", e: VideoSync.valueAt(A.t, 10)!), .init(label: "T2", e: VideoSync.valueAt(A.t, 22)!)]
        )
    }

    // MARK: - referenceLap / stageSides

    private static let refLaps = [
        Lap(id: 1, sessionId: 1, lapNum: 1, timeMs: 95_000),
        Lap(id: 2, sessionId: 1, lapNum: 2, timeMs: 91_000),
        Lap(id: 3, sessionId: 1, lapNum: 3, timeMs: 92_000),
        Lap(id: 4, sessionId: 1, lapNum: 4, timeMs: 90_500), // typed in: no channels
    ]
    private static let refCh = [95_000, 91_000, 92_000].enumerated().map { LapChannels(n: $0 + 1, timeMs: $1) }

    @Test func referenceIsTheSessionBestTheNextBestForTheBestOrNothingAlone() {
        let matched = ChannelGraphs.matchLapsToChannels(Self.refLaps, Self.refCh)
        #expect(VideoSync.referenceLap(matched, 0)?.chIdx == 1)
        #expect(VideoSync.referenceLap(matched, 1)?.chIdx == 2)
        #expect(VideoSync.referenceLap(ChannelGraphs.matchLapsToChannels([Self.refLaps[0]], [Self.refCh[0]]), 0) == nil)
    }

    @Test func putsTheOpenedLapOnAWhenLitElseTheNewestAndTheFastestOtherOnB() {
        let ch = Self.refCh
        #expect(VideoSync.stageSides([0, 2, 1], ch, 2).map { [$0.a, $0.b] } == [2, 1])
        #expect(VideoSync.stageSides([0, 2], ch, 1).map { [$0.a, $0.b] } == [2, 0])
        #expect(VideoSync.stageSides([1], ch, 1).map { [$0.a, $0.b] } == [1, nil])
        #expect(VideoSync.stageSides([], ch, 1) == nil)
    }

    @Test func namesTheTwoModesPlaceFirst() {
        #expect(VideoSync.SYNC_MODES == [.place, .time])
        #expect(VideoSync.DEFAULT_SYNC_MODE == .place)
    }

    // MARK: - The pin

    @Test func matchesTheWebImplementation() throws {
        let fx = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: RepoRoot.path("contracts/logic/video-sync.json")))
        let c = fx.constants
        #expect(VideoSync.SYNC_MODES.map(\.rawValue) == c.syncModes)
        #expect(VideoSync.DEFAULT_SYNC_MODE.rawValue == c.defaultSyncMode)
        #expect(VideoSync.RESYNC_MS == c.resyncMs)
        #expect(VideoSync.FOLLOW_RATE_MIN == c.followRateMin)
        #expect(VideoSync.FOLLOW_RATE_MAX == c.followRateMax)
        #expect(VideoSync.BRAKING_WORD_PCT == c.brakingWordPct)

        let i = fx.input
        let a = try #require(VideoSync.makeSide(.A, i.entryA, i.dStepM, i.clipA.clip))
        let b = try #require(VideoSync.makeSide(.B, i.entryB, i.dStepM, i.clipB.clip))
        let short = try #require(VideoSync.makeSide(.B, i.entryShort, i.dStepM, nil))
        let late = try #require(VideoSync.makeSide(.A, i.entryA, i.dStepM, i.clipLate.clip))
        var crawlEntry = i.entryB
        crawlEntry.speed = crawlEntry.speed?.map { _ in 10 }
        let crawl = try #require(VideoSync.makeSide(.B, crawlEntry, i.dStepM, nil))
        let sidesNamed: [String: VideoSync.Sides] = [
            "AB": .init(a: a, b: b), "AShort": .init(a: a, b: short), "A": .init(a: a, b: nil),
            "Late": .init(a: late, b: nil), "ACrawl": .init(a: a, b: crawl),
        ]
        let x = fx.expected

        expectSame(a.t, x.timeCurveA, "timeCurveA")
        expectSame(b.t, x.timeCurveB, "timeCurveB")
        let corners = Corners.sessionCorners(SessionChannels(v: 1, dStepM: i.dStepM, laps: [i.entryA, i.entryB]))
        #expect(corners == x.corners)

        for r in x.gridAtElapsed {
            #expect(close(VideoSync.gridAtElapsed(r.t, r.e), r.k), "gridAtElapsed(\(r.e))")
        }
        for r in x.valueAt {
            #expect(close(VideoSync.valueAt(r.series, r.k), r.value), "valueAt(\(r.series), \(r.k))")
        }
        for r in x.sideAtClipTime {
            let at = VideoSync.sideAtClipTime(a, r.clipMs)
            #expect(close(at.e, r.at.e) && close(at.k, r.at.k) && at.inLap == r.at.inLap, "sideAtClipTime(\(r.clipMs))")
        }
        for r in x.clipTimeAtGrid {
            #expect(close(VideoSync.clipTimeAtGrid(a, r.k), r.clipMs), "clipTimeAtGrid(\(r.k))")
        }
        #expect(close(VideoSync.scrubRange(a).min, x.scrubRange.min))
        #expect(close(VideoSync.scrubRange(a).max, x.scrubRange.max))
        #expect(VideoSync.matchByFraction(a, b) == x.matchByFraction.ab)
        #expect(VideoSync.matchByFraction(a, short) == x.matchByFraction.aShort)

        for r in x.playheadAt {
            let sides = try #require(sidesNamed[r.sides])
            let got = VideoSync.playheadAt(sides, try key(r.masterKey), r.eMaster, try mode(r.mode))
            expectSame(got, r.state, r.name)
        }
        for r in x.followRate {
            let sides = try #require(sidesNamed[r.sides])
            #expect(close(VideoSync.followRate(sides, try key(r.masterKey), r.k), r.rate), "followRate \(r.sides) \(r.masterKey)")
        }
        for r in x.needsResync {
            #expect(VideoSync.needsResync(r.targetMs, r.actualMs) == r.resync)
        }
        for r in x.fmtStageTime { #expect(VideoSync.fmtStageTime(r.s) == r.text, "fmtStageTime(\(r.s))") }
        for r in x.fmtDeltaS { #expect(VideoSync.fmtDeltaS(r.d) == r.text, "fmtDeltaS(\(r.d))") }
        for r in x.fmtGap {
            #expect(VideoSync.fmtGap(r.gapM, try units(r.units)) == r.text, "fmtGap(\(r.gapM), \(r.units))")
        }
        for r in x.cornerPlace { #expect(VideoSync.cornerPlace(corners, r.k) == r.text, "cornerPlace(\(r.k))") }
        for r in x.playheadText {
            let sides = try #require(sidesNamed[r.sides])
            let state = VideoSync.playheadAt(sides, .A, r.eMaster, try mode(r.mode))
            let got = VideoSync.playheadText(state, corners, try units(r.units))
            #expect(got.place == r.text.place, "\(r.name) \(r.units) place")
            #expect(got.value == r.text.value, "\(r.name) \(r.units) value")
            #expect(got.delta == r.text.delta, "\(r.name) \(r.units) delta")
        }
        let stops = VideoSync.cornerStops(corners, a.t)
        #expect(stops.map(\.label) == x.cornerStops.map(\.label))
        for (s, e) in zip(stops, x.cornerStops) { #expect(close(s.e, e.e)) }

        let refLaps = [95_000, 91_000, 92_000, 90_500].enumerated().map {
            Lap(id: $0 + 1, sessionId: 1, lapNum: $0 + 1, timeMs: $1)
        }
        let refCh = [95_000, 91_000, 92_000].enumerated().map { LapChannels(n: $0 + 1, timeMs: $1) }
        let matched = ChannelGraphs.matchLapsToChannels(refLaps, refCh)
        for r in x.referenceLap {
            let m = r.alone == true ? ChannelGraphs.matchLapsToChannels([refLaps[0]], [refCh[0]]) : matched
            #expect(VideoSync.referenceLap(m, r.chIdx)?.chIdx == r.ref, "referenceLap(\(r.chIdx))")
        }
        for r in x.stageSides {
            let got = VideoSync.stageSides(r.lit, refCh, r.opened)
            #expect(got?.a == r.sides?.a && got?.b == r.sides?.b, "stageSides(\(r.lit), \(r.opened))")
        }
    }

    private func key(_ s: String) throws -> VideoSync.SideKey { try #require(VideoSync.SideKey(rawValue: s)) }
    private func mode(_ s: String) throws -> VideoSync.SyncMode { try #require(VideoSync.SyncMode(rawValue: s)) }
    private func units(_ s: String) throws -> UnitSystem { try #require(UnitSystem(rawValue: s)) }

    private func expectSame(_ got: [Double], _ want: [Double], _ label: String) {
        #expect(got.count == want.count, "\(label) length")
        for (k, (g, w)) in zip(got, want).enumerated() { #expect(close(g, w), "\(label)[\(k)]") }
    }

    private func expectSame(_ got: VideoSync.SideState?, _ want: Fixture.SideState?, _ label: String) {
        guard let got, let want else {
            #expect(got == nil && want == nil, "\(label): one side missing")
            return
        }
        #expect(close(got.e, want.e), "\(label) e")
        #expect(close(got.k, want.k), "\(label) k")
        #expect(close(got.distM, want.distM), "\(label) distM")
        #expect(got.inLap == want.inLap, "\(label) inLap")
        #expect(close(got.clipMs, want.clipMs), "\(label) clipMs")
        #expect(got.inClip == want.inClip, "\(label) inClip")
        #expect(close(got.now.speedKph, want.now.speedKph), "\(label) speedKph")
        #expect(close(got.now.throttle, want.now.throttle), "\(label) throttle")
        #expect(close(got.now.brake, want.now.brake), "\(label) brake")
        #expect(close(got.now.gear, want.now.gear), "\(label) gear")
    }

    private func expectSame(_ got: VideoSync.Playhead, _ want: Fixture.Playhead, _ label: String) {
        #expect(got.mode.rawValue == want.mode, "\(label) mode")
        #expect(got.masterKey.rawValue == want.masterKey, "\(label) masterKey")
        #expect(got.inLap == want.inLap, "\(label) inLap")
        #expect(got.byFraction == want.byFraction, "\(label) byFraction")
        expectSame(got.a, want.a, "\(label) a")
        expectSame(got.b, want.b, "\(label) b")
        #expect(close(got.deltaS, want.deltaS), "\(label) deltaS")
        #expect(close(got.gapM, want.gapM), "\(label) gapM")
    }

    // MARK: - Fixture shape

    private struct Fixture: Decodable {
        struct Constants: Decodable {
            var syncModes: [String]
            var defaultSyncMode: String
            var resyncMs, followRateMin, followRateMax, brakingWordPct: Double
        }
        struct ClipIn: Decodable {
            var lapOffsetMs: Double
            var durationMs: Double?
            var clip: VideoSync.Clip { .init(lapOffsetMs: lapOffsetMs, durationMs: durationMs) }
        }
        struct Input: Decodable {
            var dStepM: Double
            var entryA, entryB, entryShort: LapChannels
            var clipA, clipB, clipLate: ClipIn
        }
        struct Now: Decodable { var speedKph, throttle, brake, gear: Double? }
        struct SideState: Decodable {
            var e, k, distM: Double
            var inLap, inClip: Bool
            var clipMs: Double?
            var now: Now
        }
        struct Playhead: Decodable {
            var mode, masterKey: String
            var inLap, byFraction: Bool
            var a: SideState
            var b: SideState?
            var deltaS, gapM: Double?
        }
        struct Grid: Decodable { var t: [Double]; var e, k: Double }
        struct ValueAtRow: Decodable { var series: [Double]; var k: Double; var value: Double? }
        struct At: Decodable { var e, k: Double; var inLap: Bool }
        struct ClipAtRow: Decodable { var clipMs: Double; var at: At }
        struct ClipTimeRow: Decodable { var k, clipMs: Double }
        struct Range: Decodable { var min, max: Double }
        struct Match: Decodable { var ab, aShort: Bool }
        struct PlayheadRow: Decodable {
            var name, sides, masterKey, mode: String
            var eMaster: Double
            var state: Playhead
        }
        struct RateRow: Decodable { var sides, masterKey: String; var k, rate: Double }
        struct ResyncRow: Decodable { var targetMs, actualMs: Double; var resync: Bool }
        struct TimeRow: Decodable { var s: Double; var text: String }
        struct DeltaRow: Decodable { var d: Double; var text: String? }
        struct GapRow: Decodable { var gapM: Double; var units: String; var text: String? }
        struct PlaceRow: Decodable { var k: Double; var text: String? }
        struct TextOut: Decodable { var place, value: String; var delta: String? }
        struct TextRow: Decodable {
            var name, units, sides, mode: String
            var eMaster: Double
            var text: TextOut
        }
        struct StopRow: Decodable { var label: String; var e: Double }
        struct RefRow: Decodable { var chIdx: Int; var alone: Bool?; var ref: Int? }
        struct AB: Decodable { var a: Int; var b: Int? }
        struct SidesRow: Decodable { var lit: [Int]; var opened: Int; var sides: AB? }
        struct Expected: Decodable {
            var timeCurveA, timeCurveB: [Double]
            var corners: [Corners.Corner]
            var gridAtElapsed: [Grid]
            var valueAt: [ValueAtRow]
            var sideAtClipTime: [ClipAtRow]
            var clipTimeAtGrid: [ClipTimeRow]
            var scrubRange: Range
            var matchByFraction: Match
            var playheadAt: [PlayheadRow]
            var followRate: [RateRow]
            var needsResync: [ResyncRow]
            var fmtStageTime: [TimeRow]
            var fmtDeltaS: [DeltaRow]
            var fmtGap: [GapRow]
            var cornerPlace: [PlaceRow]
            var playheadText: [TextRow]
            var cornerStops: [StopRow]
            var referenceLap: [RefRow]
            var stageSides: [SidesRow]
        }
        var constants: Constants
        var input: Input
        var expected: Expected
    }
}
