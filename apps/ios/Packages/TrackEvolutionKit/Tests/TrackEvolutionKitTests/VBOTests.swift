import Foundation
import Testing

@testable import TrackEvolutionKit

/// `test/unit/vbo.test.js`, ported. The JS builds its inputs with
/// `buildVboText` from `test/fixtures/build.mjs`; here the same files come from
/// `contracts/logic/vbo/`, which that builder wrote, and the few variants a case
/// needs (a clockwise run, CRLF endings, another velocity unit) are derived from
/// them in place.
struct VBOTests {
    /// `LAP_S()` in the fixture builder: a 300 m circle at 40 m/s.
    private static let lapMs = Int((2 * Double.pi * 300 / 40 * 1000).rounded())

    private func text(_ file: String) throws -> String { try VBOFixtures.text(file) }

    @Test func parsesTheCreatedDateGpsPointsAndDuration() throws {
        let out = try VBO.parseVboText(try text("vbox-noline.vbo"))
        #expect(out.kind == .vbo)
        #expect(out.date == "2026-06-20")
        #expect(out.time == "09:15:00")
        let gps = try #require(out.gps)
        #expect(gps.count == 1556)
        #expect(abs(out.durationS - 155.5) < 0.05)
        // minutes → degrees, and Racelogic's west-positive longitude comes back
        // east-positive like every other source, so the racing line isn't mirrored
        #expect(abs(gps[0].lat - 36.56) < 1e-4)
        #expect(abs(gps[0].lon - -79.19664) < 1e-4)
    }

    @Test func normalizesTheKmhVelocityColumnToMetresPerSecond() throws {
        // The fixture writes 40 m/s as 144 km/h under a "velocity kmh" header.
        let out = try VBO.parseVboText(try text("vbox-noline.vbo"))
        #expect(abs((out.gps?[10].v ?? 0) - 40) < 0.01)
    }

    @Test func readsMphAndKnotsVelocityHeaders() throws {
        let kmh = try text("vbox-noline.vbo")
        let mph = try VBO.parseVboText(kmh.replacingOccurrences(of: "velocity kmh", with: "velocity mph"))
        #expect(abs((mph.gps?[10].v ?? 0) - 144 * 0.44704) < 1e-9)
        let kts = try VBO.parseVboText(kmh.replacingOccurrences(of: "velocity kmh", with: "velocity knots"))
        #expect(abs((kts.gps?[10].v ?? 0) - 144 * 0.514444) < 1e-9)
    }

    @Test func computesLapsFromALaptimingStartLine() throws {
        let out = try VBO.parseVboText(try text("vbox-laptiming.vbo"))
        #expect(out.needsLine == false)
        #expect(out.laps.count == 3)
        for lap in out.laps {
            #expect(abs(lap.timeMs - Self.lapMs) < 200)
            #expect(lap.estimated)
        }
    }

    @Test func readsALatitudeFirstLaptimingLineToo() throws {
        let out = try VBO.parseVboText(try text("vbox-laptiming-latfirst.vbo"))
        #expect(out.laps.count == 3)
    }

    @Test func timesLapsDrivenJustPastTheEndOfAShortStartLine() throws {
        let lap = 2 * Double.pi * 310 / 40
        let out = try VBO.parseVboText(try text("vbox-shortline.vbo"))
        #expect(out.laps.count == 3)
        for l in out.laps { #expect(abs(Double(l.timeMs) - lap * 1000) < 200) }
    }

    @Test func takesTheGateDirectionFromTheTraceSoAClockwiseSessionTimesToo() throws {
        // The same circle driven clockwise crosses the line the other way: keep
        // every row's clock and reverse the order of the positions.
        let source = try text("vbox-laptiming.vbo")
        let lines = source.components(separatedBy: "\n")
        let start = try #require(lines.firstIndex(of: "[data]")) + 1
        let rows = lines[start...].filter { !$0.isEmpty }.map { $0.split(separator: " ").map(String.init) }
        let reversed = rows.enumerated().map { i, row in
            var out = row
            let from = rows[rows.count - 1 - i]
            out[2] = from[2]
            out[3] = from[3]
            return out.joined(separator: " ")
        }
        let cw = (lines[..<start] + reversed).joined(separator: "\n")
        let out = try VBO.parseVboText(cw)
        #expect(out.laps.count == 3)
    }

    @Test func timesTheFirstAndLastLapsOfARecordingStartedAndStoppedAtTheLine() throws {
        let out = try VBO.parseVboText(
            try text("trackprecision-2026-06-06-09-53-45.vbo"),
            fileName: "trackprecision-2026-06-06-09-53-45.vbo")
        #expect(out.laps.count == 3)
        for lap in out.laps { #expect(abs(lap.timeMs - Self.lapMs) < 200) }
    }

    @Test func parsesThePorscheTrackPrecisionLayoutAndItsCarChannels() throws {
        let out = try VBO.parseVboText(
            try text("trackprecision-2026-06-06-09-53-45.vbo"),
            fileName: "recording-2026-06-06-09-53-45.vbo")
        #expect(out.laps.count == 3)
        // the date is the file name's — "created at" is the export time
        #expect(out.date == "2026-06-06")
        #expect(out.time == "09:15:00")
        let ch = out.carChannels
        let present = TelemetryChannels.CHANNEL_NAMES.map(\.0).filter { ch[$0] != nil }.sorted()
        #expect(present == ["brake", "gear", "latG", "rpm", "steering", "throttle"])
        // the pedal fraction becomes a percentage
        #expect(abs((ch.throttle?.map(\.v).max() ?? 0) - 100) < 0.5)
        // brake pressure becomes a percentage of the file's peak
        #expect(abs((ch.brake?.map(\.v).max() ?? 0) - 100) < 1e-5)
        #expect(ch.brake?.map(\.v).min() == 0)
        // true G (LatAcc_PTPA) over the /9.81 `latacc` column, as a magnitude
        #expect(abs((ch.latG?.map(\.v).max() ?? 0) - 0.9) < 0.005)
        #expect(Set(ch.gear?.map(\.v) ?? []) == [3, 4])
        // bar → kPa; the 3276.8 "no reading" sentinel is dropped
        #expect(abs((out.lapScalarChannels["tyreKpaLF"]?.first?.v ?? 0) - 210) < 1e-5)
        #expect(out.lapScalarChannels["tyreKpaRF"] == nil)
    }

    @Test func fallsBackToTheExportDateWhenTheNameHasNone() throws {
        let out = try VBO.parseVboText(
            try text("trackprecision-2026-06-06-09-53-45.vbo"), fileName: "session.vbo")
        #expect(out.date == "2026-09-22")
        // …and the time is the first sample's clock, never the export time
        #expect(out.time == "09:15:00")
    }

    @Test func asksForALineWhenThereIsNoLaptimingSection() throws {
        let out = try VBO.parseVboText(try text("vbox-noline.vbo"))
        #expect(out.needsLine)
        #expect(out.laps.isEmpty)
        // …and the user-picked line then yields the laps
        let gps = try #require(out.gps)
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: gps[0].lat, lon: gps[0].lon))
        let idx = Int((0.25 * Double(Self.lapMs) / 1000 * 10).rounded())
        let gate = try #require(Geo.buildGate(trace, idx: idx))
        #expect(Geo.deriveLaps(trace, gate: gate).count == 3)
    }

    @Test func rejectsFilesWithoutTheExpectedStructure() {
        #expect(throws: TelemetryParseError(message: "Not a valid VBO file (no [column names] section)")) {
            try VBO.parseVboText("not a vbo")
        }
        #expect(throws: TelemetryParseError(message: "VBO file contains no usable GPS data")) {
            try VBO.parseVboText("[column names]\nsats time lat long\n[data]\n008 091500.00 2193.6 4752.0")
        }
        #expect(throws: TelemetryParseError(message: "VBO file is missing time/lat/long columns")) {
            try VBO.parseVboText("[column names]\nsats time lat\n[data]\n008 091500.00 2193.6")
        }
    }

    // MARK: - Port-specific: the JS semantics the Swift has to reproduce

    @Test func readsCrlfLineEndings() throws {
        let lf = try text("vbox-laptiming.vbo")
        let a = try VBO.parseVboText(lf)
        let b = try VBO.parseVboText(lf.replacingOccurrences(of: "\n", with: "\r\n"))
        #expect(a.laps == b.laps)
        #expect(a.gps?.count == b.gps?.count)
    }

    @Test func numberParsingFollowsJavaScript() {
        #expect(VBO.jsNumber("+003.5") == 3.5)
        #expect(VBO.jsNumber("-0") == 0 && VBO.jsNumber("-0").sign == .minus)
        #expect(VBO.jsNumber(".5") == 0.5)
        #expect(VBO.jsNumber("5.") == 5)
        #expect(VBO.jsNumber("1e3") == 1000)
        #expect(VBO.jsNumber("-2.5E-1") == -0.25)
        #expect(VBO.jsNumber("0x10") == 16)
        #expect(VBO.jsNumber("Infinity") == .infinity)
        #expect(VBO.jsNumber("-Infinity") == -.infinity)
        for bad in ["abc", "inf", "nan", "1.2.3", "-", ".", "1e", "0x1p3", "-0x10", "12a"] {
            #expect(VBO.jsNumber(Substring(bad)).isNaN, "\(bad)")
        }
    }

    @Test func timeOfDayParsing() {
        let base: Double = 9 * 3600 + 55 * 60
        #expect(VBO.timeOfDayS("095512.30") == base + 12.3)
        #expect(VBO.timeOfDayS("095512") == base + 12)
        #expect(VBO.timeOfDayS("0955") == nil)
        #expect(VBO.timeOfDayS("095512.") == nil)
        #expect(VBO.timeOfDayS("09:55:12") == nil)
    }

    @Test func dispatchesByNameAndWordsTheSessionAsTheWebDoes() throws {
        let data = try VBOFixtures.data("vbox-laptiming.vbo")
        let parsed = try Telemetry.parseTelemetryFile(DataByteSource(data), name: "Session.VBO")
        #expect(parsed.kind == .vbo)
        #expect(parsed.lapChannels != nil)
        #expect(Telemetry.defaultLabel(parsed, file: "Session.VBO") == "VBO 09:15:00")
        #expect(
            Telemetry.importNotes(parsed, file: "Session.VBO", units: .imperial)
                == "Imported from Session.VBO — lap times derived from GPS start/finish crossings (~±0.1–0.3s)")
        // A UTF-8 byte-order mark is dropped, as `Blob.text()` drops it.
        let bom = Data([0xEF, 0xBB, 0xBF]) + data
        let withBom = try Telemetry.parseTelemetryFile(DataByteSource(bom), name: "a.vbo")
        #expect(withBom.laps == parsed.laps)
    }
}
