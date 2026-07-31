import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/pdr-laps.test.js`, ported with the code.
struct PDRLapsTests {
    // Synthetic real-firmware channels: latitude at 2 Hz, cumulative odometer at
    // ~7 Hz, car lapping the 300 m-radius reference circle at 40 m/s.
    private static let RADIUS = 300.0
    private static let SPEED = 40.0
    private static let LAP_M = 2 * Double.pi * RADIUS  // 1884.96 m
    private static let LAP_MS = (LAP_M / SPEED) * 1000  // 47124 ms

    static func circleChannels(
        revolutions: Double = 3.3, startAngle: Double = 0, lat0: Double = 36.56
    ) -> ParsedTelemetry.RawChannels {
        let totalS = (LAP_M * revolutions) / SPEED
        var latPts: [ChannelPoint] = []
        var odoPts: [ChannelPoint] = []
        var t = 0.0
        while t <= totalS {
            let lat = lat0 + (RADIUS * sin(startAngle + (SPEED * t) / RADIUS)) / 110_540
            latPts.append(ChannelPoint(t: t, v: (lat * 1e7).rounded()))
            t += 0.5
        }
        t = 0
        while t <= totalS {
            odoPts.append(ChannelPoint(t: t, v: (SPEED * t).rounded()))
            t += 0.15
        }
        return ParsedTelemetry.RawChannels(latPts: latPts, odoPts: odoPts)
    }

    // MARK: - findLapLength

    @Test func recoversTheLapLengthFromLatDistancePeriodicity() throws {
        let channels = Self.circleChannels()
        let profile = try #require(PDRLaps.latDistanceProfile(channels.latPts, channels.odoPts))
        let found = try #require(PDRLaps.findLapLength(profile))
        #expect(abs(found.lapM - Self.LAP_M) < 10)
        #expect(found.r > 0.95)
    }

    @Test func prefersTheTrueLapLengthOverItsMultiples() throws {
        let channels = Self.circleChannels(revolutions: 5)
        let profile = try #require(PDRLaps.latDistanceProfile(channels.latPts, channels.odoPts))
        let found = try #require(PDRLaps.findLapLength(profile))
        // with 5 laps of data, 2x the lap length correlates just as well —
        // the smallest strong peak must win
        #expect(abs(found.lapM - Self.LAP_M) < 10)
    }

    @Test func rejectsStraightLineDriving() throws {
        var latPts: [ChannelPoint] = []
        var odoPts: [ChannelPoint] = []
        var t = 0.0
        while t <= 200 {
            latPts.append(ChannelPoint(t: t, v: ((36.56 + (Self.SPEED * t) / 110_540) * 1e7).rounded()))
            t += 0.5
        }
        t = 0
        while t <= 200 {
            odoPts.append(ChannelPoint(t: t, v: (Self.SPEED * t).rounded()))
            t += 0.15
        }
        // 8 km of driving — plenty of distance…
        let profile = try #require(PDRLaps.latDistanceProfile(latPts, odoPts))
        // …but no lap periodicity (linear lat correlates at every lag)
        #expect(PDRLaps.findLapLength(profile) == nil)
    }

    // MARK: - latDistanceProfile

    @Test func refusesPaddockFootage() {
        var latPts: [ChannelPoint] = []
        var odoPts: [ChannelPoint] = []
        var t = 0.0
        while t <= 600 {
            latPts.append(ChannelPoint(t: t, v: ((36.56 + (8 * sin(t / 45)) / 110_540) * 1e7).rounded()))
            t += 0.5
        }
        t = 0
        while t <= 600 {
            odoPts.append(ChannelPoint(t: t, v: (t * 1.2).rounded()))  // 720 m crawled
            t += 0.15
        }
        #expect(PDRLaps.latDistanceProfile(latPts, odoPts) == nil)
    }

    @Test func refusesThinChannels() {
        #expect(PDRLaps.latDistanceProfile([], []) == nil)
        #expect(PDRLaps.latDistanceProfile(nil, nil) == nil)
    }

    // MARK: - matchPhase + cutLapsAtDistance

    @Test func locatesTheTemplatesStartFinishInASessionThatBeganElsewhere() throws {
        // Template: one lap of lat(distance) starting at angle 4.0 rad.
        let theta = 4.0
        var tmpl: [Double] = []
        var d = 0.0
        while d < Self.LAP_M {
            tmpl.append(36.56 + (Self.RADIUS * sin(theta + d / Self.RADIUS)) / 110_540)
            d += 5
        }
        // Session: same circle, pit-out at angle 1.0 rad.
        let channels = Self.circleChannels(startAngle: 1.0)
        let profile = try #require(PDRLaps.latDistanceProfile(channels.latPts, channels.odoPts))
        let phase = try #require(PDRLaps.matchPhase(profile, tmpl, Self.LAP_M))
        #expect(phase.r > 0.95)
        // start/finish is (4.0 - 1.0) rad ahead of the session start
        #expect(abs(phase.offsetM - 3.0 * Self.RADIUS) < 15)

        let laps = PDRLaps.cutLapsAtDistance(channels.odoPts, profile.d0 + phase.offsetM, Self.LAP_M)
        #expect(laps.count >= 2)
        for lap in laps {
            #expect(lap.estimated)
            #expect(abs(Double(lap.timeMs) - Self.LAP_MS) < 300)
        }
        // first boundary lands when the car reaches the start/finish angle
        #expect(abs((laps[0].startT ?? 0) - (3.0 * Self.RADIUS) / Self.SPEED) < 0.5)
    }

    // MARK: - recoverPdrLaps

    @Test func cutsRollingLapsOfTheRightLengthWithoutAnyTemplate() throws {
        let recovered = try #require(PDRLaps.recoverPdrLaps(Self.circleChannels()))
        #expect(!recovered.anchored)
        #expect(recovered.laps.count == 3)  // 3.3 revolutions
        for lap in recovered.laps {
            #expect(lap.estimated)
            #expect(abs(Double(lap.timeMs) - Self.LAP_MS) < 300)
        }
    }

    @Test func returnsNilWhenThereIsNothingLapLike() {
        #expect(PDRLaps.recoverPdrLaps(nil) == nil)
        #expect(PDRLaps.recoverPdrLaps(ParsedTelemetry.RawChannels(latPts: [], odoPts: [])) == nil)
    }
}
