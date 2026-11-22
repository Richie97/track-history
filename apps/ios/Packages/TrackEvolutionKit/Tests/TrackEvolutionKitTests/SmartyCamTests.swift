import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases in `test/unit/smartycam.test.js`. Where the JS builds a file with
/// `buildSmartyCamMov(opts)`, these read the committed one built with the same
/// options: `smartycam-laps.mov` is `buildSmartyCamMov()` and
/// `smartycam-midsession.mov` is `buildSmartyCamMov({ startCount: 3,
/// resetAtS: 80, badGear: true, dropped: [], meta: null })`.
/// `SmartyCamContractTests` pins the whole output to the JS; these say what each
/// part of it means.
struct SmartyCamTests {
    /// `Math.round(LAP_S() * 100) * 10` — the logger reports to 10 ms.
    private static let LAP_MS = 47120
    private static let SMARTYCAM_FPS = 30.0

    private static func mov(_ file: String = "smartycam-laps.mov") throws -> DataByteSource {
        try SmartyCamFixtures.source(file)
    }

    // MARK: - ecefToGeodetic

    @Test func landsOnTheEquatorThePoleAndAKnownPoint() {
        #expect(SmartyCam.ecefToGeodetic(6378137, 0, 0) == SmartyCam.Geodetic(lat: 0, lon: 0))
        #expect(abs(SmartyCam.ecefToGeodetic(0, 0, 6356752.314245).lat - 90) < 0.5e-9)
        // VIR's start/finish, from a real record: X 960562.82 m, Y -5037961.28 m, Z 3779118.22 m
        let p = SmartyCam.ecefToGeodetic(960562.82, -5037961.28, 3779118.22)
        #expect(abs(p.lat - 36.5688) < 0.5e-3)
        #expect(abs(p.lon - -79.2051) < 0.5e-3)
    }

    // MARK: - readRecord

    private static func record(_ fill: (inout [UInt8]) -> Void) -> SmartyCam.Record {
        var bytes = [UInt8](repeating: 0, count: SmartyCam.RECORD_BYTES)
        fill(&bytes)
        return SmartyCam.readRecord(ByteView(bytes))
    }

    /// `dv.setInt32(o, v, true)` / `dv.setUint32(o, v, true)`.
    private static func set(_ bytes: inout [UInt8], _ o: Int, _ v: Int) {
        let u = UInt32(truncatingIfNeeded: v)
        for i in 0..<4 { bytes[o + i] = UInt8((u >> (8 * UInt32(i))) & 0xff) }
    }

    private static func withFix(_ bytes: inout [UInt8]) {
        set(&bytes, 60, 96_056_282)
        set(&bytes, 64, -503_796_128)
        set(&bytes, 68, 377_911_822)
    }

    @Test func readsTheFieldsLittleEndian() throws {
        let r = Self.record { b in
            Self.set(&b, 0, 135)
            Self.set(&b, 8, 204_329)
            Self.set(&b, 32, 4)
            Self.set(&b, 40, 198_330)
            Self.withFix(&b)
            Self.set(&b, 76, 2489)
            Self.set(&b, 80, 485)
            Self.set(&b, 84, 18)
            Self.set(&b, 104, 5544)
            Self.set(&b, 108, 17)
            Self.set(&b, 120, 2)
        }
        #expect(r.frame == 135 && r.tsMs == 204_329 && r.lapCount == 4 && r.lapMs == 198_330)
        #expect(r.rpm == 5544 && r.throttle == 17 && r.gear == 2)
        #expect(r.ecef == SmartyCam.ECEF(x: 960562.82, y: -5037961.28, z: 3779118.22))
        #expect(abs(try #require(r.speedMs) - 25.36) < 0.5e-2)
    }

    @Test func turnsNoValueIntoNilAndNeverIntoAReading() {
        let r = Self.record { b in
            Self.withFix(&b)
            for o in [32, 40, 104, 108, 120] { Self.set(&b, o, SmartyCam.NO_VALUE) }
        }
        #expect(r.lapCount == nil && r.lapMs == nil && r.rpm == nil && r.throttle == nil && r.gear == nil)
    }

    @Test func hasNoPositionWithoutAFix() {
        #expect(Self.record { _ in }.ecef == nil)  // all zero
        #expect(Self.record { b in for o in [60, 64, 68] { Self.set(&b, o, -1) } }.ecef == nil)
        #expect(Self.record { _ in }.speedMs == nil)
    }

    // MARK: - lapsFromCounter

    /// Records 1 s apart on both clocks unless `ts` says otherwise.
    private static func recs(
        _ counts: [Int?], lapMs: [Int: Int] = [:], ts: (Int) -> Int = { $0 * 1000 }
    ) -> [SmartyCam.Record] {
        counts.enumerated().map { i, c in
            SmartyCam.Record(tsMs: ts(i), lapCount: c, lapMs: lapMs[i], t: Double(i))
        }
    }

    private static func lap(_ n: Int, _ ms: Int, _ startT: Double, _ endT: Double) -> ParsedLap {
        ParsedLap(lapNumber: n, timeMs: ms, estimated: false, startT: startT, endT: endT)
    }

    @Test func needsTwoConsecutiveStepsAndPutsEachBoundaryOneRecordBeforeItsStep() {
        let laps = SmartyCam.lapsFromCounter(
            Self.recs([0, 0, 1, 1, 1, 1, 2, 2, 3], lapMs: [2: 99000, 6: 4000, 8: 2000]))
        #expect(laps == [Self.lap(1, 4000, 1, 5), Self.lap(2, 2000, 5, 7)])
    }

    @Test func dropsTheFirstLapAFileClosesItBeganBeforeTheVideoDid() {
        #expect(SmartyCam.lapsFromCounter(Self.recs([3, 3, 4, 4], lapMs: [2: 120_000])).isEmpty)
    }

    @Test func opensNothingAcrossAJumpAResetOrAMissingCounter() {
        #expect(SmartyCam.lapsFromCounter(Self.recs([0, 1, 1, 3, 3], lapMs: [1: 5000, 3: 2000])).isEmpty)
        #expect(SmartyCam.lapsFromCounter(Self.recs([4, 5, 5, 0, 0, 1], lapMs: [1: 5000, 5: 4000])).isEmpty)
        #expect(SmartyCam.lapsFromCounter(Self.recs([0, 1, 1, nil, 1, 2], lapMs: [1: 5000, 5: 4000])).isEmpty)
    }

    @Test func refusesALapWhoseLoggerClockDisagreesWithItsReportedTime() {
        func at(_ ms: Int) -> [SmartyCam.Record] { Self.recs([0, 1, 1, 1, 1, 2], lapMs: [1: 9000, 5: ms]) }
        #expect(SmartyCam.lapsFromCounter(at(4000 + SmartyCam.LAP_CLOCK_TOLERANCE_MS)).count == 1)
        #expect(SmartyCam.lapsFromCounter(at(4000 + SmartyCam.LAP_CLOCK_TOLERANCE_MS + 10)).isEmpty)
    }

    @Test func takesTheLapTimeFromTheLoggerNotFromTheVideoClock() {
        // 4 s of video, 4.5 s on the logger: frames were dropped.
        let laps = SmartyCam.lapsFromCounter(
            Self.recs([0, 1, 1, 1, 1, 2], lapMs: [1: 9000, 5: 4500], ts: { $0 * 1125 }))
        #expect(laps == [Self.lap(1, 4500, 0, 4)])
    }

    // MARK: - plausibleChannels

    private static func carRecs(
        _ f: (Int, inout SmartyCam.Record) -> Void = { _, _ in }
    ) -> [SmartyCam.Record] {
        (0..<40).map { i in
            var r = SmartyCam.Record(rpm: 3000 + i * 100, throttle: i * 2, gear: 2 + (i % 4))
            f(i, &r)
            return r
        }
    }

    @Test func keepsFieldsThatLookLikeWhatTheyClaim() {
        #expect(
            SmartyCam.plausibleChannels(Self.carRecs())
                == SmartyCam.Plausible(rpm: true, throttle: true, gear: true))
    }

    @Test func dropsEachFieldOnItsOwn() {
        let lowRpm = SmartyCam.plausibleChannels(Self.carRecs { _, r in r.rpm = 40 })
        #expect(lowRpm == SmartyCam.Plausible(rpm: false, throttle: true, gear: true))
        // never moves
        #expect(!SmartyCam.plausibleChannels(Self.carRecs { _, r in r.throttle = 20 }).throttle)
        // past 100
        #expect(!SmartyCam.plausibleChannels(Self.carRecs { i, r in r.throttle = i * 5 }).throttle)
        let badGear = SmartyCam.plausibleChannels(Self.carRecs { i, r in r.gear = i })
        #expect(!badGear.gear && badGear.rpm)
        let none = SmartyCam.plausibleChannels(
            Self.carRecs { _, r in
                r.rpm = nil
                r.throttle = nil
                r.gear = nil
            })
        #expect(none == SmartyCam.Plausible(rpm: false, throttle: false, gear: false))
    }

    // MARK: - parseAimMeta

    @Test func readsTheDateAndTheTimeAndNothingElse() {
        let xml =
            #"<p n="racer_name">Somebody</p><p n="date">21/11/2026</p><p n="hour">08:58.16</p><p n="nlap">4</p>"#
        #expect(SmartyCam.parseAimMeta(xml) == SmartyCam.Stamp(date: "2026-11-21", time: "08:58:16"))
    }

    @Test func answersNilsForAFileWithoutTheBlock() {
        #expect(SmartyCam.parseAimMeta("") == SmartyCam.Stamp())
        #expect(SmartyCam.parseAimMeta(nil) == SmartyCam.Stamp())
        #expect(SmartyCam.parseAimMeta(#"<p n="date">2026-11-21</p>"#) == SmartyCam.Stamp())
    }

    // MARK: - parseSmartyCamFile

    @Test func readsTheLoggersLapsTheTraceAndTheCarChannels() throws {
        let out = try SmartyCam.parseSmartyCamFile(try Self.mov())
        #expect(out.kind == .smartycam)
        #expect(out.kind.label == "SmartyCam")
        #expect(!out.needsLine)
        #expect(out.date == "2026-06-20")
        #expect(out.time == "09:15:00")
        // Four steps of the counter: the first closes the out-lap, three laps follow.
        #expect(out.laps.map(\.timeMs) == [Self.LAP_MS, Self.LAP_MS, Self.LAP_MS])
        #expect(out.laps.allSatisfy { !$0.estimated })
        let present = TelemetryChannels.CHANNEL_NAMES.map(\.0).filter { out.carChannels[$0] != nil }
        #expect(Set(present) == ["rpm", "throttle", "gear"])
        #expect(abs(try #require(out.metrics?.topSpeedKph) - 144) < 1)
        #expect(try #require(out.metrics?.maxRpm) > 6900)
        #expect(try #require(out.bestLapTrace).count > 100)
        #expect(abs(try #require(out.traceGeo).lat - 36.56) < 0.5e-2)
    }

    @Test func runsOnVideoTimeALapThatLostFramesIsShorterInTheFileThanOnTheClock() throws {
        let out = try SmartyCam.parseSmartyCamFile(try Self.mov())
        let videoS = out.laps.map { ($0.endT ?? 0) - ($0.startT ?? 0) }
        let lapS = Double(Self.LAP_MS) / 1000
        // The second lap (58.9 s → 106.0 s) holds the 12 s stretch that lost a third of its frames.
        #expect(abs(videoS[0] - lapS) < 0.5)
        #expect(abs(videoS[1] - (lapS - 4)) < 0.5)
        #expect(out.laps[1].timeMs == Self.LAP_MS)
        // Every record is five frames on from the last, whatever the clock did.
        let gps = try #require(out.gps)
        #expect(abs(gps[101].t - gps[100].t - 5 / Self.SMARTYCAM_FPS) < 0.5e-9)
        #expect(abs(out.durationS - Double(gps.count) / 6) < 0.05)
    }

    @Test func takesPositionFromTheECEFFixNotTheStaleE7Pair() throws {
        let gps = try #require(try SmartyCam.parseSmartyCamFile(try Self.mov()).gps)
        // The circle's centre is (36.56, -79.2) and the car starts due east of it.
        #expect(abs(gps[0].lat - 36.56) < 0.5e-6)
        // Speed is the ECEF velocity's magnitude, real however many frames were lost
        // (the fixture's circle is laid out with flat-earth constants, hence the slack).
        #expect(gps.allSatisfy { abs(($0.v ?? .nan) - 40) < 0.3 })
    }

    @Test func skipsNoValueReadingsInsteadOfChartingThem() throws {
        let out = try SmartyCam.parseSmartyCamFile(try Self.mov())
        let rpm = try #require(out.carChannels.rpm)
        #expect(rpm.count < (out.gps?.count ?? 0))
        #expect(rpm.allSatisfy { $0.v > 0 })
    }

    @Test func startsMidSessionSurvivesACounterResetAndDropsAnImplausibleGear() throws {
        let out = try SmartyCam.parseSmartyCamFile(try Self.mov("smartycam-midsession.mov"))
        #expect(out.laps.map(\.timeMs) == [Self.LAP_MS, Self.LAP_MS])
        let present = TelemetryChannels.CHANNEL_NAMES.map(\.0).filter { out.carChannels[$0] != nil }
        #expect(Set(present) == ["rpm", "throttle"])
        // No XML: the date falls back to the file's own creation time (UTC).
        #expect(out.date == "2026-06-20")
        #expect(out.time == "13:15:00")
    }

    @Test func isNotFooledBySomebodyElsesVideo() throws {
        #expect(
            throws: TelemetryParseError(message: "No SmartyCam telemetry track in this video", isNoTrack: true)
        ) {
            try SmartyCam.parseSmartyCamFile(try VideoFixtures.source("gopro.mp4"))
        }
    }

    // MARK: - parseTelemetryFile with a SmartyCam .MOV

    @Test func dispatchesItAndCutsPerLapChannelsOnTheDistanceGrid() throws {
        let out = try Telemetry.parseTelemetryFile(try Self.mov(), name: "SCHD0001.MOV")
        #expect(out.kind == .smartycam)
        let laps = try #require(out.lapChannels?.laps)
        #expect(laps.count == 3)
        let lap = laps[1]
        for name in ["speed", "rpm", "throttle", "gear"] { #expect(lap[channel: name] != nil, "\(name)") }
        // The lap that lost frames still measures a full lap of distance and speed.
        let speed = try #require(lap[channel: "speed"])
        #expect(abs(speed.count - (laps[0][channel: "speed"]?.count ?? 0)) <= 1)
        #expect(speed.allSatisfy { abs($0 - 144) < 1.5 })
    }

    /// The same file under an `.mp4` name, and with no name at all: the chain is
    /// one chain, whatever the extension.
    @Test func dispatchesItWhateverTheFileIsCalled() throws {
        #expect(try Telemetry.parseTelemetryFile(try Self.mov(), name: "clip.mp4").kind == .smartycam)
        #expect(try Telemetry.parseTelemetryFile(try Self.mov()).kind == .smartycam)
        #expect(Telemetry.SUPPORTED_EXTENSIONS.contains("mov"))
    }

    /// `importSessionBody`'s half that lives in the Kit: the laps, the notes line
    /// and the anchor. (The JS case also runs the server's `sanitizeChannels`;
    /// the channel blob is pinned element for element by the contract test.)
    @Test func buildsTheSessionTheWebImporterWould() throws {
        let parsed = try Telemetry.parseTelemetryFile(try Self.mov(), name: "SCHD0001.MOV")
        #expect(parsed.laps.map(\.timeMs) == [Self.LAP_MS, Self.LAP_MS, Self.LAP_MS])
        let notes = Telemetry.importNotes(parsed, file: "SCHD0001.MOV", units: .imperial)
        #expect(notes.hasPrefix("Imported from SCHD0001.MOV — "))
        #expect(!notes.contains("Test Driver") && !notes.contains("Test Car"))
        // No lap is estimated, so there is no `~` note.
        #expect(Telemetry.estimatedNote(parsed, estCount: 0).isEmpty)
        #expect(parsed.traceGeo != nil)
        #expect(Telemetry.defaultLabel(parsed, file: "SCHD0001.MOV") == "SmartyCam 09:15:00")
        var untimed = parsed
        untimed.time = nil
        #expect(Telemetry.defaultLabel(untimed, file: "SCHD0001.MOV") == "SmartyCam SCHD0001")
    }

    /// The laps are the logger's own: a line pick changes nothing.
    @Test func neverNeedsALine() throws {
        var parsed = try Telemetry.parseTelemetryFile(try Self.mov(), name: "SCHD0001.MOV")
        let before = parsed.laps
        let gps = try #require(parsed.gps)
        let trace = Geo.projectTrace(gps)
        let gate = try #require(Geo.buildGate(trace, idx: 60))
        Telemetry.applyGate(&parsed, origin: gps[0], gate: gate)
        #expect(parsed.laps == before)
        #expect(!parsed.needsLine)
    }

    @Test func stillReadsAGoProFileRenamedMov() throws {
        let out = try Telemetry.parseTelemetryFile(try VideoFixtures.source("gopro.mp4"), name: "GX010042.MOV")
        #expect(out.kind == .gopro)
    }

    @Test func saysSoWhenTheCameraNeverFinishedTheFile() throws {
        let bytes = try SmartyCamFixtures.data("smartycam-laps.mov")
        let noIndex = DataByteSource(bytes.prefix(5000))  // ftyp and the start of mdat, no moov
        #expect(
            throws: TelemetryParseError(
                message: "This recording wasn't finished by the camera and can't be read.")
        ) {
            try Telemetry.parseTelemetryFile(noIndex, name: "SCHD0157.MOV")
        }
        // The same bytes called .mp4 keep the PDR parser's own words, as in the JS.
        #expect(throws: TelemetryParseError(message: "No moov box found — is this an MP4?")) {
            try Telemetry.parseTelemetryFile(noIndex, name: "SCHD0157.mp4")
        }
    }

    @Test func offersNoClipYetTheCuttersRuleForTheseFilesIsALaterTicket() throws {
        let parsed = try Telemetry.parseTelemetryFile(try Self.mov(), name: "SCHD0001.MOV")
        #expect(LapClips.clipCandidate(parsed) == nil)
        #expect(LapClips.clipCandidates(parsed, .every).isEmpty)
    }
}
