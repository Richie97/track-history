import Foundation
import Testing

@testable import TrackEvolutionKit

/// `TrackMap.traceIndexAtFraction`, pinned against the web implementation
/// (`contracts/logic/trackmap.json`) — the mapping behind "which corner is this
/// dot" (NS-34 ticket 3).
struct TrackMapTests {

    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/trackmap.json")
        let fixture = try JSONDecoder().decode(TrackMapFixture.self, from: try Data(contentsOf: url))
        let trace = fixture.input.trace.map { TracePoint(x: $0[0], y: $0[1], v: $0[2]) }

        for entry in fixture.expected.atFraction {
            #expect(
                TrackMap.traceIndexAtFraction(trace, entry.frac) == entry.idx,
                "fraction \(entry.frac)"
            )
        }
        #expect(fixture.expected.tooShort == nil)
        #expect(fixture.expected.empty == nil)
        #expect(fixture.expected.stationary == nil)
    }

    /// The claim the fixture exists to make: the walk is along **distance**, not
    /// along sample index.
    ///
    /// The fixture's trace spends five of its ten points crawling through one
    /// short straight, so a quarter of the way round by distance is a long way
    /// past a quarter of the way through the samples. A port that indexed by
    /// count would pass a smoke test and be wrong by a corner on every real lap.
    @Test func walksByDistanceRatherThanBySampleCount() throws {
        let url = RepoRoot.path("contracts/logic/trackmap.json")
        let fixture = try JSONDecoder().decode(TrackMapFixture.self, from: try Data(contentsOf: url))
        let trace = fixture.input.trace.map { TracePoint(x: $0[0], y: $0[1], v: $0[2]) }
        let quarter = TrackMap.traceIndexAtFraction(trace, 0.25)
        #expect(quarter != Int((Double(trace.count - 1) * 0.25).rounded()))
    }

    /// Degenerate traces answer nil, never 0: ringing the start line would say
    /// the dot belongs there.
    @Test func degenerateTracesHaveNoPointToRing() {
        #expect(TrackMap.traceIndexAtFraction([], 0.5) == nil)
        #expect(TrackMap.traceIndexAtFraction([TracePoint(x: 0, y: 0, v: 1)], 0.5) == nil)
        let still = Array(repeating: TracePoint(x: 5, y: 5, v: 0), count: 3)
        #expect(TrackMap.traceIndexAtFraction(still, 0.5) == nil)
    }

    /// Out of range is clamped rather than refused — a fraction is a position,
    /// and the ends of the lap are positions.
    @Test func fractionsOutsideTheLapClampToItsEnds() {
        let trace = [
            TracePoint(x: 0, y: 0, v: 10),
            TracePoint(x: 10, y: 0, v: 10),
            TracePoint(x: 20, y: 0, v: 10)
        ]
        #expect(TrackMap.traceIndexAtFraction(trace, -3) == 0)
        #expect(TrackMap.traceIndexAtFraction(trace, 4) == trace.count - 1)
    }
}

/// `contracts/logic/trackmap.json` — reference output captured from
/// `public/js/trackmap.js`.
struct TrackMapFixture: Decodable {
    struct Input: Decodable {
        var trace: [[Double]]
    }

    struct Entry: Decodable {
        var frac: Double
        var idx: Int?
    }

    struct Expected: Decodable {
        var atFraction: [Entry]
        var tooShort: Int?
        var empty: Int?
        var stationary: Int?
    }

    var input: Input
    var expected: Expected
}
