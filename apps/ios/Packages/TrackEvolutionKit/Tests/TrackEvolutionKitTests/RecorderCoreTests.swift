import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/record.test.js`, ported with the code, plus the
/// grid-wait / forgot-to-stop / negative-rounding coverage NS-11 asks for and a
/// cross-language checkpoint fixture.
struct RecorderCoreTests {
    private let lat0 = 36.56
    private let lon0 = -79.2
    private var kx: Double { 111_320 * cos(lat0 * .pi / 180) }
    private var ky: Double { 110_540.0 }

    // MARK: - addFix

    @Test func keepsPlausibleFixesAndRejectsGarbage() {
        var rec = Recording(eventId: "e", startedAtMs: 1000)
        // `#expect` captures its expression immutably, so each mutating call
        // lands in a local first.
        let kept = rec.addFix(.init(timeMs: 2000, lat: 36.5, lon: -79.2, speed: 3, accuracy: 8))
        let notFinite = rec.addFix(.init(timeMs: 3000, lat: .nan, lon: -79.2))
        let offEarth = rec.addFix(.init(timeMs: 4000, lat: 95, lon: -79.2))
        let hopelessAccuracy = rec.addFix(.init(timeMs: 5000, lat: 36.5, lon: -79.2, accuracy: 500))
        let beforeStart = rec.addFix(.init(timeMs: 500, lat: 36.5, lon: -79.2))
        let notMonotonic = rec.addFix(.init(timeMs: 2000, lat: 36.5, lon: -79.2))
        #expect(kept)
        #expect(!notFinite)
        #expect(!offEarth)
        #expect(!hopelessAccuracy)
        #expect(!beforeStart)
        #expect(!notMonotonic)

        #expect(rec.fixes.count == 1)
        #expect(rec.fixes[0] == Recording.Fix(t: 1, lat: 36.5, lon: -79.2, v: 3, acc: 8))
    }

    @Test func storesNilForMissingSpeedAndAccuracy() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        rec.addFix(.init(timeMs: 1000, lat: 1, lon: 2))
        #expect(rec.fixes[0] == Recording.Fix(t: 1, lat: 1, lon: 2, v: nil, acc: nil))
    }

    @Test func rejectsALongitudePastTheAntimeridianAndNegativeSpeed() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        let pastAntimeridian = rec.addFix(.init(timeMs: 1000, lat: 0, lon: -180.5))
        // A negative reported speed (some receivers emit -1 for "unknown") is
        // dropped to nil rather than rejecting the fix.
        let unknownSpeed = rec.addFix(.init(timeMs: 1000, lat: 0, lon: 0, speed: -1))
        #expect(!pastAntimeridian)
        #expect(unknownSpeed)
        #expect(rec.fixes[0].v == nil)
    }

    @Test func stopsAtTheFixCap() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        // Cheaper than pushing 20,000 real fixes: pre-fill and check the guard.
        rec.fixes = (0..<RecorderCore.MAX_FIXES).map {
            Recording.Fix(t: Double($0), lat: 0, lon: 0)
        }
        let overCap = rec.addFix(.init(timeMs: Double(RecorderCore.MAX_FIXES + 1) * 1000, lat: 0, lon: 0))
        #expect(!overCap)
        #expect(rec.fixes.count == RecorderCore.MAX_FIXES)
    }

    /// The rounding is part of the wire format, and JS rounds halves toward
    /// +infinity while Swift's `rounded()` rounds away from zero. Southern-
    /// hemisphere latitudes and western longitudes reach this.
    @Test func roundsNegativeValuesTheWayJavaScriptDoes() {
        // Math.round(-0.5) === -0 → 0 after normalization, not -1.
        #expect(JSMath.round(-0.005, 100) == 0)
        #expect(JSMath.round(-1.5, 1) == -1)
        #expect(JSMath.round(2.5, 1) == 3)
        #expect(JSMath.round(-2.5, 1) == -2)
        // floor(x + 0.5) would give 1 here; JavaScript gives 0.
        #expect(JSMath.round(0.49999999999999994, 1) == 0)
        #expect(JSMath.round(.nan, 100).isNaN)

        var rec = Recording(eventId: "e", startedAtMs: 0)
        rec.addFix(.init(timeMs: 1000, lat: -36.5000005, lon: -79.2000005, speed: 1.005, accuracy: 0.25))
        let fix = rec.fixes[0]
        #expect(fix.lat == -36.5)      // -36.5000005 → half rounds up toward +∞
        #expect(fix.lon == -79.2)
        // 1.005 × 100 is 100.49999999999999 in binary, so this rounds *down* —
        // and must, because the web and Android clients round it down too.
        #expect(fix.v == 1)
        #expect(fix.acc == 0.3)
    }

    // MARK: - fixSpeeds

    @Test func prefersReportedSpeedAndFallsBackToDisplacementRate() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        rec.addFix(.init(timeMs: 1000, lat: lat0, lon: lon0))
        // 20 m north in 1 s.
        rec.addFix(.init(timeMs: 2000, lat: lat0 + 20 / ky, lon: lon0))
        rec.addFix(.init(timeMs: 3000, lat: lat0 + 40 / ky, lon: lon0, speed: 7))

        let speeds = RecorderCore.fixSpeeds(rec.fixes)
        // 40 m across the 2 s neighbour window.
        #expect(abs(speeds[1] - 20) < 0.5)
        #expect(speeds[2] == 7)
    }

    // MARK: - shouldAutoStop

    @Test func stopsAfterLongStationaryOnceTheCarHasBeenDrivenAtPace() throws {
        let fixture = try RecorderFixture.load()
        let rec = try #require(RecorderCore.deserializeRecording(fixture.input.checkpoint))
        #expect(!rec.shouldAutoStop(nowMs: fixture.input.nowMs.fiveMinutesAfterDriving))
        #expect(rec.shouldAutoStop(nowMs: fixture.input.nowMs.sixteenMinutesAfterDriving))
    }

    @Test func neverStopsDuringASlowSpeedWaitBeforeTheFirstLap() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        // Paddock crawl at 3 m/s, then a 20-minute grid wait — no track pace yet,
        // so auto-stop is never armed.
        for t in 0..<60 {
            rec.addFix(
                .init(timeMs: Double(t) * 1000, lat: lat0 + (3 * Double(t)) / ky, lon: lon0, speed: 3)
            )
        }
        #expect(!rec.shouldAutoStop(nowMs: 60 * 1000 + 20 * 60 * 1000))
        // Still not after an hour of it.
        #expect(!rec.shouldAutoStop(nowMs: 60 * 1000 + 60 * 60 * 1000))
    }

    @Test func armsAutoStopAsSoonAsTrackPaceIsSeen() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        // One flying lap's worth of track pace, then stationary.
        for t in 0..<60 {
            rec.addFix(
                .init(timeMs: Double(t) * 1000, lat: lat0 + (30 * Double(t)) / ky, lon: lon0, speed: 30)
            )
        }
        let idleFrom = 60.0 * 1000
        #expect(!rec.shouldAutoStop(nowMs: idleFrom + 14 * 60 * 1000))
        #expect(rec.shouldAutoStop(nowMs: idleFrom + 16 * 60 * 1000))
    }

    @Test func alwaysStopsAtTheHardDurationCap() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        rec.addFix(.init(timeMs: 1000, lat: lat0, lon: lon0, speed: 0))
        // Never driven, but five hours is five hours.
        #expect(rec.shouldAutoStop(nowMs: 5 * 3600 * 1000))
    }

    // MARK: - trimIdle

    @Test func cutsStationaryTailsButKeepsAMarginAroundTheDriving() throws {
        let fixture = try RecorderFixture.load()
        let rec = try #require(RecorderCore.deserializeRecording(fixture.input.checkpoint))
        let trimmed = RecorderCore.trimIdle(rec.fixes)
        let idleBefore = fixture.input.idleBeforeS
        let driveS = fixture.input.driveS

        #expect(!trimmed.isEmpty)
        let t0 = try #require(trimmed.first).t
        let t1 = try #require(trimmed.last).t
        #expect(t0 >= idleBefore - 31)
        #expect(t0 < idleBefore)
        #expect(t1 > idleBefore + driveS)
        #expect(t1 <= idleBefore + driveS + 31)
    }

    @Test func returnsNothingForARecordingThatNeverMoved() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        for t in 0..<100 {
            rec.addFix(.init(timeMs: Double(t) * 1000, lat: lat0, lon: lon0, speed: 0))
        }
        #expect(RecorderCore.trimIdle(rec.fixes).isEmpty)
    }

    // MARK: - toParsed

    @Test func producesAParserContractObjectWhoseLapsDeriveViaTheLinePickerPath() throws {
        let fixture = try RecorderFixture.load()
        let rec = try #require(RecorderCore.deserializeRecording(fixture.input.checkpoint))
        let parsed = try #require(rec.toParsed())

        #expect(parsed.kind == "live")
        #expect(parsed.needsLine)
        #expect(parsed.laps.isEmpty)
        #expect(parsed.date.count == 10)
        #expect(parsed.time.count == 5)
        #expect(parsed.gps.count > 200)

        // Exactly the flow js/import/ui.js runs after a line pick.
        let trace = Geo.projectTrace(parsed.gps)
        let gate = try #require(Geo.buildGate(trace, idx: trace.count / 2))
        let laps = Geo.deriveLaps(trace, gate: gate)
        #expect(laps.count >= 3)
        for lap in laps {
            #expect(Double(lap.timeMs) / 1000 > fixture.input.lapS - 2)
            #expect(Double(lap.timeMs) / 1000 < fixture.input.lapS + 2)
            #expect(lap.estimated)
        }
    }

    @Test func returnsNilForRecordingsTooShortToTime() {
        var rec = Recording(eventId: "e", startedAtMs: 0)
        for t in 0..<20 {
            rec.addFix(
                .init(timeMs: Double(t) * 1000, lat: lat0 + (25 * Double(t)) / ky, lon: lon0, speed: 25)
            )
        }
        #expect(rec.toParsed() == nil)
    }

    /// `date`/`time` pre-fill a session on the day the driver was at the track,
    /// so they are local, not UTC. 1750000000000 is 15:06 UTC on 2025-06-15.
    @Test func datesAndTimesTheRecordingInLocalTime() throws {
        let fixture = try RecorderFixture.load()
        let rec = try #require(RecorderCore.deserializeRecording(fixture.input.checkpoint))

        let newYork = try #require(TimeZone(identifier: "America/New_York"))
        let parsedNY = try #require(rec.toParsed(timeZone: newYork))
        #expect(parsedNY.date == "2025-06-15")
        #expect(parsedNY.time == "11:06")

        // Across the date line the same instant is the next day — which is the
        // point of using local time.
        let auckland = try #require(TimeZone(identifier: "Pacific/Auckland"))
        let parsedNZ = try #require(rec.toParsed(timeZone: auckland))
        #expect(parsedNZ.date == "2025-06-16")
        #expect(parsedNZ.time == "03:06")
    }

    // MARK: - Checkpoint serialization

    @Test func roundTripsARecording() {
        var rec = Recording(eventId: "ev1", startedAtMs: 1_750_000_000_000)
        for t in 0..<40 {
            rec.addFix(
                .init(
                    timeMs: 1_750_000_000_000 + Double(t) * 1000,
                    lat: lat0 + (25 * Double(t)) / ky, lon: lon0, speed: 25, accuracy: 5
                )
            )
        }
        let back = RecorderCore.deserializeRecording(RecorderCore.serializeRecording(rec))
        #expect(back == rec)
    }

    @Test func roundTripsAnEventlessRecordingWithAnExplicitNull() {
        // CarPlay starts recordings before an event exists; the checkpoint must
        // say so, in the same shape the other clients write.
        let rec = Recording(eventId: nil as String?, startedAtMs: 1000)
        let json = RecorderCore.serializeRecording(rec)
        #expect(json.contains("\"eventId\":null"))
        #expect(RecorderCore.deserializeRecording(json)?.eventId == nil)
    }

    @Test func acceptsANumericEventIdAndOffersItAsAnInt() throws {
        let native = Recording(eventId: 42, startedAtMs: 1000)
        #expect(native.eventId == "42")
        #expect(native.eventIdValue == 42)

        let fromWeb = try #require(
            RecorderCore.deserializeRecording(#"{"v":1,"eventId":42,"startedAtMs":1000,"fixes":[]}"#)
        )
        #expect(fromWeb.eventId == "42")
        #expect(fromWeb.eventIdValue == 42)

        // An event created offline carries a temp id, which is not an integer.
        let offline = try #require(
            RecorderCore.deserializeRecording(#"{"v":1,"eventId":"tmp-4","startedAtMs":1000,"fixes":[]}"#)
        )
        #expect(offline.eventIdValue == nil)
    }

    @Test func rejectsCorruptCheckpointsInsteadOfThrowing() {
        #expect(RecorderCore.deserializeRecording(nil) == nil)
        #expect(RecorderCore.deserializeRecording("") == nil)
        #expect(RecorderCore.deserializeRecording("not json{") == nil)
        #expect(RecorderCore.deserializeRecording(#"{"v":99,"fixes":[]}"#) == nil)
        #expect(RecorderCore.deserializeRecording(#"{"v":1,"startedAtMs":0,"fixes":[["x"]]}"#) == nil)
        // Truncated mid-array, as a checkpoint written when the app was killed
        // could plausibly be.
        #expect(RecorderCore.deserializeRecording(#"{"v":1,"startedAtMs":0,"fixes":[[0,1,2],[3,4"#) == nil)
        // A fix with fewer than three values isn't a fix.
        #expect(RecorderCore.deserializeRecording(#"{"v":1,"startedAtMs":0,"fixes":[[0,1]]}"#) == nil)
        #expect(RecorderCore.deserializeRecording(#"{"v":1,"fixes":[]}"#) == nil)
    }

    @Test func acceptsAThreeElementFixTuple() throws {
        // The trailing speed/accuracy slots are optional in the format.
        let rec = try #require(
            RecorderCore.deserializeRecording(#"{"v":1,"startedAtMs":0,"fixes":[[0,36.5,-79.2]]}"#)
        )
        #expect(rec.fixes.count == 1)
        #expect(rec.fixes[0].v == nil)
        #expect(rec.fixes[0].acc == nil)
    }

    // MARK: - Cross-language agreement

    /// Reads the checkpoint string the **web** implementation wrote
    /// (`contracts/logic/recorder.json`, from `npm run contracts:logic`) and
    /// reproduces every value it derived from it.
    @Test func matchesTheJavaScriptImplementationOnASharedCheckpoint() throws {
        let fixture = try RecorderFixture.load()
        let rec = try #require(
            RecorderCore.deserializeRecording(fixture.input.checkpoint),
            "a checkpoint written by the web app must deserialize here"
        )
        let expected = fixture.expected

        #expect(rec.v == RecorderCore.RECORDING_V)
        #expect(rec.eventId == "ev1")
        #expect(rec.fixes.count == expected.fixCount)
        #expect(rec.fixes.first == expected.firstFix)
        #expect(rec.fixes.last == expected.lastFix)

        let trimmed = RecorderCore.trimIdle(rec.fixes)
        #expect(trimmed.count == expected.trimmedCount)
        #expect(trimmed.first?.t == expected.trimmedFirstT)
        #expect(trimmed.last?.t == expected.trimmedLastT)

        #expect(
            rec.shouldAutoStop(nowMs: fixture.input.nowMs.fiveMinutesAfterDriving)
                == expected.autoStopAtFiveMinutes
        )
        #expect(
            rec.shouldAutoStop(nowMs: fixture.input.nowMs.sixteenMinutesAfterDriving)
                == expected.autoStopAtSixteenMinutes
        )

        let parsed = try #require(rec.toParsed())
        #expect(parsed.kind == expected.parsed.kind)
        #expect(parsed.needsLine == expected.parsed.needsLine)
        #expect(parsed.durationS == expected.parsed.durationS)
        #expect(parsed.gps.count == expected.parsed.gpsCount)
        #expect(parsed.gps.first == expected.parsed.firstGps)
        #expect(parsed.gps.last == expected.parsed.lastGps)

        // …and the laps that recording yields once a line is picked, to the ms.
        let trace = Geo.projectTrace(parsed.gps)
        let gate = try #require(Geo.buildGate(trace, idx: fixture.input.pickedIndex))
        let laps = Geo.deriveLaps(trace, gate: gate)
        #expect(laps.map(\.timeMs) == expected.laps.map(\.timeMs))
        #expect(!laps.isEmpty)

        // Re-serializing must reproduce the web's checkpoint — same keys, same
        // values, same tuple shape — so a recording can move between clients.
        // Key *order* is allowed to differ: JSON.stringify follows declaration
        // order, JSONEncoder is asked for sorted keys.
        let ours = try JSONSerialization.jsonObject(
            with: Data(RecorderCore.serializeRecording(rec).utf8)
        )
        let theirs = try JSONSerialization.jsonObject(with: Data(fixture.input.checkpoint.utf8))
        let difference = JSONShape.difference(JSONShape.normalize(ours), JSONShape.normalize(theirs))
        #expect(difference == nil, "re-serialized checkpoint differs: \(difference ?? "")")
    }
}

/// `contracts/logic/recorder.json` — a synthetic track day recorded and
/// checkpointed by `public/js/record/core.js`.
struct RecorderFixture: Decodable {
    struct NowMs: Decodable {
        var fiveMinutesAfterDriving: Double
        var sixteenMinutesAfterDriving: Double
    }

    struct Input: Decodable {
        /// The literal `localStorage["recording.pending"]` string.
        var checkpoint: String
        var lapS: Double
        var driveS: Double
        var idleBeforeS: Double
        var pickedIndex: Int
        var nowMs: NowMs
    }

    struct Parsed: Decodable {
        var kind: String
        var needsLine: Bool
        var durationS: Double
        var gpsCount: Int
        var firstGps: Geo.Point
        var lastGps: Geo.Point
    }

    struct Expected: Decodable {
        var fixCount: Int
        var firstFix: Recording.Fix
        var lastFix: Recording.Fix
        var trimmedCount: Int
        var trimmedFirstT: Double
        var trimmedLastT: Double
        var autoStopAtFiveMinutes: Bool
        var autoStopAtSixteenMinutes: Bool
        var parsed: Parsed
        var laps: [Geo.DerivedLap]
    }

    var input: Input
    var expected: Expected

    static func load() throws -> RecorderFixture { shared }

    private static let shared: RecorderFixture = {
        let url = RepoRoot.path("contracts/logic/recorder.json")
        guard let data = try? Data(contentsOf: url),
              let fixture = try? JSONDecoder().decode(RecorderFixture.self, from: data)
        else {
            fatalError("contracts/logic/recorder.json missing or stale — run `npm run contracts:logic`")
        }
        return fixture
    }()
}
