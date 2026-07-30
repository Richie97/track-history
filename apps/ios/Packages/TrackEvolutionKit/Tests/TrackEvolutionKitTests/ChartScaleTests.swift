import Foundation
import Testing

@testable import TrackEvolutionKit

/// The chart convention, asserted rather than assumed.
struct ChartScaleTests {
    @Test func lowerLapTimesPlotLower() throws {
        // The whole point of the progress chart: getting faster must trend *down*.
        let domain = try #require(ChartScale.lapTimeDomain([121_500, 120_900, 122_100]))
        let fast = ChartScale.plottedFraction(120_900, in: domain)
        let slow = ChartScale.plottedFraction(122_100, in: domain)
        #expect(fast < slow, "a faster lap is drawn lower")
    }

    @Test func theDomainBracketsTheDataWithPadding() throws {
        let domain = try #require(ChartScale.lapTimeDomain([100_000, 110_000]))
        #expect(domain.low < 100_000)
        #expect(domain.high > 110_000)
        // Padding is proportional, not a fixed slab.
        #expect(abs((domain.high - domain.low) - 10_000 * 1.08) < 1)
    }

    @Test func degenerateDataDoesNotCollapseTheAxis() throws {
        // One lap, and several identical laps: a zero-height axis would draw the
        // line on the frame edge.
        for values in [[121_000], [121_000, 121_000, 121_000]] {
            let domain = try #require(ChartScale.lapTimeDomain(values))
            #expect(domain.high > domain.low)
            let fraction = ChartScale.plottedFraction(121_000, in: domain)
            #expect(abs(fraction - 0.5) < 0.001, "the point sits mid-plot, not on an edge")
        }
        #expect(ChartScale.lapTimeDomain([]) == nil)
    }

    @Test func theSpeedRampSpansSlowestToFastest() {
        #expect(ChartScale.speedFraction(10, slowest: 10, fastest: 50) == 0)
        #expect(ChartScale.speedFraction(50, slowest: 10, fastest: 50) == 1)
        #expect(abs(ChartScale.speedFraction(30, slowest: 10, fastest: 50) - 0.5) < 0.001)
        // Out-of-range values clamp rather than running off the ramp.
        #expect(ChartScale.speedFraction(99, slowest: 10, fastest: 50) == 1)
        // A constant-speed lap has nothing to ramp over.
        #expect(ChartScale.speedFraction(30, slowest: 30, fastest: 30) == 1)
    }

    @Test func theSpeedRangeComesFromTheTrace() throws {
        let trace = [
            TracePoint(x: 0, y: 0, v: 30), TracePoint(x: 1, y: 1, v: 45), TracePoint(x: 2, y: 2, v: 12)
        ]
        let range = try #require(ChartScale.speedRange(trace))
        #expect(range.slowest == 12)
        #expect(range.fastest == 45)
        #expect(ChartScale.speedRange([]) == nil)
    }

    /// The real thing, end to end: the fastest lap of the golden event must plot
    /// below the slowest.
    @Test func aRealEventsBestLapPlotsBelowItsWorst() throws {
        let detail = try Goldens.decode(EventDetail.self, "event-detail")
        let laps = detail.sessions.flatMap { $0.laps.map(\.timeMs) }
        let domain = try #require(ChartScale.lapTimeDomain(laps))
        let best = try #require(laps.min())
        let worst = try #require(laps.max())
        #expect(
            ChartScale.plottedFraction(Double(best), in: domain)
                < ChartScale.plottedFraction(Double(worst), in: domain)
        )
    }
}
