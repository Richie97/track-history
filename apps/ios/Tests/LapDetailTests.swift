import XCTest
import TrackEvolutionKit

@testable import TrackEvolution

/// The rules behind the lap detail (#267), without a view: which lap gets the
/// racing line, what the gap reads, what the compare lights first, and what an
/// absent lap yields. The screen is layout over `LapDetailScreen.Detail`.
///
/// Fixtures are decoded from JSON in the wire shape rather than built with
/// initialisers: the Kit's models are decoded-only from outside the module,
/// and the wire shape is the one thing the server and this screen agree on.
@MainActor
final class LapDetailTests: XCTestCase {

    /// One session (id 10) with the given laps as `(id, lapNum, timeMs)`, optional
    /// channel entries as `(n, timeMs)` carrying a speed trace, and an optional
    /// trace of `tracePoints` points. Twelve is above `TrackMapView`'s floor of ten.
    private func detail(
        laps: [(Int, Int, Int)], channels: [(Int, Int)]? = nil, tracePoints: Int = 0
    ) -> EventDetail {
        let lapsJson = laps
            .map { "{\"id\": \($0.0), \"session_id\": 10, \"lap_num\": \($0.1), \"time_ms\": \($0.2)}" }
            .joined(separator: ",")
        let speed = (0..<40).map { String(100 + $0 % 7) }.joined(separator: ",")
        let channelsJson = channels.map { entries in
            "{\"v\": 1, \"dStepM\": 20, \"laps\": ["
                + entries.map { "{\"n\": \($0.0), \"timeMs\": \($0.1), \"speed\": [\(speed)]}" }.joined(separator: ",")
                + "]}"
        } ?? "null"
        let traceJson = tracePoints > 0
            ? "[" + (0..<tracePoints).map { "[\($0), \($0 * 2), 30]" }.joined(separator: ",") + "]"
            : "null"
        let json = """
        {"id": 1, "track_id": 1, "track_name": "VIR (Full)", "start_date": "2026-04-10", "days": 1,
         "updated_at": 0, "lap_count": \(laps.count), "session_count": 1, "hours": 0, "setups": [],
         "sessions": [{"id": 10, "label": "Session 2", "notes": null, "sort": 1, "trace": \(traceJson),
                       "channels": \(channelsJson), "ambient_c": null, "elevation_m": null, "laps": [\(lapsJson)]}]}
        """
        return try! JSONDecoder().decode(EventDetail.self, from: Data(json.utf8))
    }

    func testTheBestLapGetsTheRacingLineAndTheOthersDoNot() {
        let d = detail(laps: [(1, 1, 125_000), (2, 2, 121_500), (3, 3, 123_000)], tracePoints: 12)

        let best = LapDetailScreen.build(d, sessionId: 10, lapId: 2)!
        XCTAssertTrue(best.isBest)
        XCTAssertEqual(best.gapMs, 0)
        XCTAssertEqual(best.trace?.count, 12, "the stored trace is the best lap's")
        XCTAssertEqual(LapDetailScreen.subtitle(best), "Lap 2 of 3 · Session 2 · ★ best of the session")

        let other = LapDetailScreen.build(d, sessionId: 10, lapId: 3)!
        XCTAssertFalse(other.isBest)
        XCTAssertEqual(other.gapMs, 1_500)
        XCTAssertNil(other.trace, "a slower lap was never on the stored line")
        XCTAssertEqual(
            LapDetailScreen.subtitle(other),
            "Lap 3 of 3 · Session 2 · \(LapTime.fmtDelta(1_500)) vs best"
        )
    }

    func testAShortTraceDrawsNoMap() {
        let d = detail(laps: [(1, 1, 121_500)], tracePoints: 5)
        XCTAssertNil(LapDetailScreen.build(d, sessionId: 10, lapId: 1)!.trace)
    }

    func testTheLapsOwnEntryIsCarvedOutAloneAndTheCompareLightsItBesideTheBest() {
        // Lap 2 was added by hand after the import, so it has no entry.
        let d = detail(
            laps: [(1, 1, 125_000), (2, 2, 130_000), (3, 3, 121_500)],
            channels: [(1, 125_000), (3, 121_500)]
        )

        let first = LapDetailScreen.build(d, sessionId: 10, lapId: 1)!
        XCTAssertEqual(first.chIdx, 0)
        XCTAssertEqual(first.channels?.laps.map(\.timeMs), [125_000], "one entry, this lap's")
        XCTAssertEqual(first.channels?.dStepM, 20)
        XCTAssertEqual(LapDetailScreen.comparePreselect(first), [0, 1], "this lap first, the best beside it")
        XCTAssertTrue(LapDetailScreen.canCompare(first))

        let best = LapDetailScreen.build(d, sessionId: 10, lapId: 3)!
        XCTAssertEqual(LapDetailScreen.comparePreselect(best), [1], "the best alone: nothing to put beside it")

        let handAdded = LapDetailScreen.build(d, sessionId: 10, lapId: 2)!
        XCTAssertNil(handAdded.channels)
        XCTAssertNil(handAdded.chIdx)
        XCTAssertNil(LapDetailScreen.comparePreselect(handAdded), "nothing of its own to light; the panel picks the fastest")
        XCTAssertTrue(LapDetailScreen.canCompare(handAdded), "the session still has an overlay to open")
    }

    func testAHandEnteredSessionHasNothingToCompare() {
        let d = detail(laps: [(1, 1, 125_000)])
        let view = LapDetailScreen.build(d, sessionId: 10, lapId: 1)!
        XCTAssertNil(view.channels)
        XCTAssertNil(view.trace)
        XCTAssertFalse(LapDetailScreen.canCompare(view))
    }

    func testAMissingSessionOrLapIsNil() {
        let d = detail(laps: [(1, 1, 125_000)])
        XCTAssertNil(LapDetailScreen.build(d, sessionId: 10, lapId: 99))
        XCTAssertNil(LapDetailScreen.build(d, sessionId: 99, lapId: 1))
    }
}
