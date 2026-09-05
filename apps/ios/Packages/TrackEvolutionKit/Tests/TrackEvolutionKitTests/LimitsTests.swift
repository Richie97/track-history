import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/limits.test.js`, ported with the code they cover,
/// plus the cross-language pin against `contracts/logic/limits.json`.
struct LimitsTests {
    private static let ABS = Double(Limits.FLAG_ABS)
    private static let TC = Double(Limits.FLAG_TC)
    private static let VSC = Double(Limits.FLAG_VSC)

    /// 20 grid points: ABS pulses across a braking zone (k 2–5, with a one-point
    /// gap), TC once on an exit (k 9–10), VSC never; wheelspin on that same exit
    /// and a lockup at k 3.
    private let flags: [Double] = [0, 0, ABS, 0, ABS, ABS, 0, 0, 0, TC, TC, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    private let slip: [Double] = [0, 0, 0, -3, -1, 0, 0, 0, 0.5, 3, 4.5, 1, 0, 0, 0, 0, 0, 0, 0, 0]

    private var lap: LapChannels {
        LapChannels(
            n: 1, timeMs: 90_000, speed: Array(repeating: 100, count: 20),
            wheelSlip: slip, flags: flags
        )
    }

    // MARK: - limitAt / hasLimitData

    @Test func readsTheFlagBitsAndTheSlipThresholds() {
        #expect(Limits.limitAt(lap, "abs", 2) == true)
        #expect(Limits.limitAt(lap, "abs", 3) == false)
        #expect(Limits.limitAt(lap, "tc", 9) == true)
        #expect(Limits.limitAt(lap, "vsc", 9) == false)
        #expect(Limits.limitAt(lap, "wheelspin", 10) == true)
        #expect(Limits.limitAt(lap, "wheelspin", 8) == false) // 0.5 % is noise
        #expect(Limits.limitAt(lap, "lockup", 3) == true)
        #expect(Limits.limitAt(LapChannels(n: 1, timeMs: 0, flags: flags), "wheelspin", 3) == nil)
        #expect(Limits.limitAt(LapChannels(n: 1, timeMs: 0, wheelSlip: slip), "abs", 3) == nil)
        #expect(Limits.limitAt(lap, "abs", 99) == nil)
        #expect(Limits.hasLimitData(lap))
        #expect(!Limits.hasLimitData(LapChannels(n: 1, timeMs: 0, speed: [1, 2])))
    }

    @Test func vscIsBitTwo() {
        let both = LapChannels(n: 1, timeMs: 0, flags: [Self.VSC + Self.ABS])
        #expect(Limits.limitAt(both, "vsc", 0) == true)
        #expect(Limits.limitAt(both, "tc", 0) == false)
    }

    // MARK: - booleanRuns

    @Test func mergesRunsAcrossShortGapsAndKeepsLongerOnesApart() {
        let s = [false, true, true, false, true, false, false, false, true, true]
        #expect(
            Limits.booleanRuns(s, 2) == [
                Limits.Run(k0: 1, k1: 4), // one clear point between: merged
                Limits.Run(k0: 8, k1: 9), // three clear points: separate
            ]
        )
        #expect(
            Limits.booleanRuns(s, 0) == [
                Limits.Run(k0: 1, k1: 2), Limits.Run(k0: 4, k1: 4), Limits.Run(k0: 8, k1: 9),
            ]
        )
        #expect(Limits.booleanRuns([], 2) == [])
        #expect(Limits.MERGE_GAP_POINTS == 2)
    }

    // MARK: - limitRuns

    @Test func listsEveryKindsRunsInKindOrderTheAbsPulseTrainAsOneRun() {
        #expect(
            Limits.limitRuns(lap) == [
                Limits.LimitRun(kind: "abs", k0: 2, k1: 5),
                Limits.LimitRun(kind: "lockup", k0: 3, k1: 3),
                Limits.LimitRun(kind: "tc", k0: 9, k1: 10),
                Limits.LimitRun(kind: "wheelspin", k0: 9, k1: 10),
            ]
        )
    }

    @Test func skipsTheKindsWhoseChannelIsMissing() {
        #expect(Limits.limitRuns(LapChannels(n: 1, timeMs: 0, flags: flags)).map(\.kind) == ["abs", "tc"])
        #expect(Limits.limitRuns(LapChannels(n: 1, timeMs: 0, speed: [1, 2])) == [])
    }

    // MARK: - activeLimitLabels

    @Test func namesWhatIsActiveAtAGridPoint() {
        #expect(Limits.activeLimitLabels(lap, 3) == ["Lockup"])
        #expect(Limits.activeLimitLabels(lap, 10) == ["Traction control", "Wheelspin"])
        #expect(Limits.activeLimitLabels(lap, 0) == [])
    }

    // MARK: - sessionLimits / limitSummary

    /// ABS in the same zone, plus a second zone at k 15–16; no slip channel.
    private var lap2: LapChannels {
        LapChannels(
            n: 2, timeMs: 91_000, speed: Array(repeating: 100, count: 20),
            flags: flags.enumerated().map { k, f in
                k == 15 || k == 16 ? Self.ABS : Double(Int(f) & Limits.FLAG_ABS)
            }
        )
    }

    @Test func countsDistinctPlacesAcrossLapsAndTheLapsInvolved() throws {
        let sl = try #require(
            Limits.sessionLimits(
                SessionChannels(
                    v: 1, dStepM: 20,
                    laps: [lap, lap2, LapChannels(n: 3, timeMs: 0, speed: [1, 2])]
                )
            )
        )
        #expect(sl.hasFlags)
        #expect(sl.hasSlip)
        #expect(
            sl.kinds == [
                Limits.KindTally(kind: "abs", places: 2, laps: 2),
                Limits.KindTally(kind: "lockup", places: 1, laps: 1),
                Limits.KindTally(kind: "tc", places: 1, laps: 1),
                Limits.KindTally(kind: "wheelspin", places: 1, laps: 1),
                Limits.KindTally(kind: "vsc", places: 0, laps: 0),
            ]
        )
        #expect(
            Limits.limitSummary(SessionChannels(v: 1, dStepM: 20, laps: [lap, lap2]))
                == "ABS in 2 braking zones, lockup in 1 braking zone, traction control in 1 acceleration zone, wheelspin in 1 acceleration zone"
        )
    }

    @Test func saysNoInterventionsWhenTheSystemsNeverFired() throws {
        let quiet = SessionChannels(
            v: 1, dStepM: 20,
            laps: [LapChannels(n: 1, timeMs: 0, flags: Array(repeating: 0, count: 20))]
        )
        #expect(Limits.limitSummary(quiet) == "no interventions")
        // No slip channel: those kinds are absent rather than reported as zero.
        #expect(try #require(Limits.sessionLimits(quiet)).kinds.map(\.kind) == ["abs", "tc", "vsc"])
        #expect(
            Limits.limitSummary(
                SessionChannels(v: 1, dStepM: 20, laps: [LapChannels(n: 1, timeMs: 0, speed: [1, 2])])
            ) == nil
        )
        #expect(Limits.limitSummary(SessionChannels(v: 1, dStepM: 20, laps: [])) == nil)
    }

    // MARK: - limitMarkers

    /// A 380 m straight-line trace sampled every 10 m, so distance fractions map
    /// to indexes directly.
    private let trace: [TracePoint] = (0..<39).map { TracePoint(x: Double($0) * 10, y: 0, v: 50) }

    @Test func placesEachRunsMidPointOnTheTraceByDrivenDistanceFraction() {
        let m = Limits.limitMarkers(lap, 20, trace)
        #expect(m.map(\.kind) == ["abs", "lockup", "tc", "wheelspin"])
        // ABS mid-point k=3.5 of 19 → 70 m of 380 → index 7 on the 10 m trace.
        #expect(m[0] == Limits.Marker(kind: "abs", k0: 2, k1: 5, idx: 7))
        #expect(m[2].idx == 19) // k=9.5 → 190 m
    }

    @Test func scalesToTheTracesOwnLengthWhenItDiffersFromTheGridLength() {
        let shortTrace: [TracePoint] = (0..<20).map { TracePoint(x: Double($0) * 10, y: 0, v: 50) } // 190 m
        // 70/380 · 190 = 35 m → the first point at or past 35 m.
        #expect(Limits.limitMarkers(lap, 20, shortTrace)[0].idx == 4)
    }

    @Test func markersAreEmptyWithoutATraceOrWithoutRuns() {
        #expect(Limits.limitMarkers(lap, 20, nil) == [])
        #expect(
            Limits.limitMarkers(
                LapChannels(
                    n: 1, timeMs: 0, speed: Array(repeating: 100, count: 20),
                    flags: Array(repeating: 0, count: 20)
                ),
                20, trace
            ) == []
        )
    }

    // MARK: - LIMIT_KINDS

    @Test func coloursBySideAndNeverLeavesTwoKindsOfOneSideColourAlone() {
        for side in [Limits.Side.brake, .power] {
            let kinds = Limits.LIMIT_KINDS.filter { $0.side == side }
            #expect(kinds.count == 2)
            #expect(kinds[0].filled != kinds[1].filled)
        }
    }

    // MARK: - Cross-language pin

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port integer for integer and string for string.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/limits.json")
        let fixture = try JSONDecoder().decode(LimitsFixture.self, from: try Data(contentsOf: url))
        let channels = fixture.input.channels

        #expect(channels.laps.map { Limits.limitRuns($0) } == fixture.expected.runs)
        #expect(Limits.sessionLimits(channels) == fixture.expected.session)
        #expect(Limits.limitSummary(channels) == fixture.expected.summary)
        #expect(
            Limits.limitSummary(
                SessionChannels(
                    v: 1, dStepM: 20,
                    laps: [LapChannels(n: 1, timeMs: 0, flags: Array(repeating: 0, count: 20))]
                )
            ) == fixture.expected.quietSummary
        )
        #expect(
            Limits.limitSummary(SessionChannels(v: 1, dStepM: 20, laps: [channels.laps[2]]))
                == fixture.expected.noData
        )
        #expect([0, 3, 10].map { Limits.activeLimitLabels(channels.laps[0], $0) } == fixture.expected.labelsAt)
        #expect(
            Limits.limitMarkers(channels.laps[0], channels.dStepM, fixture.input.trace)
                == fixture.expected.markers
        )
        #expect(Limits.limitMarkers(channels.laps[0], channels.dStepM, nil) == fixture.expected.noTrace)
    }
}

/// `contracts/logic/limits.json` — reference output captured from
/// `public/js/limits.js`.
struct LimitsFixture: Decodable {
    struct Input: Decodable {
        var channels: SessionChannels
        var trace: [TracePoint]
    }

    struct Expected: Decodable {
        var runs: [[Limits.LimitRun]]
        var session: Limits.SessionLimits
        var summary: String
        var quietSummary: String
        var noData: String?
        var labelsAt: [[String]]
        var markers: [Limits.Marker]
        var noTrace: [Limits.Marker]
    }

    var input: Input
    var expected: Expected
}
