import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/pdr.test.js`, ported with the code.
///
/// Where the JS builds its MP4 in the test (`buildPdrDeltaMp4`), the Swift side
/// reads the *same bytes* from `contracts/logic/video/` — reimplementing the
/// fixture builder in Swift would only prove the two builders agree.
struct PDRTests {
    // MARK: - series

    struct SeriesTests {
        let s = series([
            ChannelPoint(t: 0, v: 0),
            ChannelPoint(t: 10, v: 100),
            ChannelPoint(t: 20, v: 300),
        ])

        @Test func interpolatesValuesAtATime() {
            #expect(s.at(5) == 50)
            #expect(s.at(15) == 200)
            #expect(s.at(10) == 100)
        }

        @Test func invertsMonotonicSeriesWithTimeAt() {
            #expect(s.timeAt(50) == 5)
            #expect(s.timeAt(200) == 15)
        }

        @Test func computesACentralDifferenceRate() {
            // between t=10 and t=20 the slope is 20 v/t
            #expect(s.rate(15, 2) == 20)
        }

        @Test func exposesFirstLastAndLength() {
            #expect(s.n == 3)
            #expect(s.first == ChannelPoint(t: 0, v: 0))
            #expect(s.last == ChannelPoint(t: 20, v: 300))
        }
    }

    // MARK: - gpsFromChannels

    struct GPSFromChannelsTests {
        private func t(_ i: Int) -> Double { Double(i) * 0.15 }

        private func chan(_ n: Int, _ deg: (Int) -> Double) -> [ChannelPoint] {
            (0..<n).map { ChannelPoint(t: t($0), v: (deg($0) * 1e7).rounded()) }
        }

        @Test func decodesScaledIntegerLatLonChannelsIntoADegreesTrace() throws {
            let lat = chan(40) { 36.56 + Double($0) * 1e-4 }
            let lon = chan(40) { -79.2 + Double($0) * 1e-4 }
            let gps = try #require(PDR.gpsFromChannels(lat, lon))
            #expect(gps.count == 40)
            #expect(abs(gps[10].lat - 36.561) < 1e-6)
            #expect(abs(gps[10].lon - (-79.199)) < 1e-6)
            #expect(gps[10].v == nil)
        }

        @Test func takesSpeedFromTheOdometerSeriesWhenGiven() throws {
            let lat = chan(40) { 36.56 + Double($0) * 1e-4 }
            let lon = chan(40) { -79.2 + Double($0) * 1e-4 }
            // 6 m per 0.15 s = 40 m/s
            let odo = series((0..<40).map { ChannelPoint(t: t($0), v: Double($0) * 6) })
            let gps = try #require(PDR.gpsFromChannels(lat, lon, odo))
            #expect(abs((gps[20].v ?? 0) - 40) < 1e-6)
        }

        @Test func decodesFloat32BitLatLonChannelsViaTheFallbackInterpretation() throws {
            func asBits(_ deg: Double) -> Double {
                Double(Int32(bitPattern: Float(deg).bitPattern))
            }
            let lat = (0..<40).map { ChannelPoint(t: t($0), v: asBits(36.56 + Double($0) * 1e-4)) }
            let lon = (0..<40).map { ChannelPoint(t: t($0), v: asBits(-79.2 + Double($0) * 1e-4)) }
            let gps = try #require(PDR.gpsFromChannels(lat, lon))
            #expect(abs(gps[10].lat - 36.561) < 1e-4)
            #expect(abs(gps[10].lon - (-79.199)) < 1e-4)
        }

        @Test func returnsNilRatherThanAGarbageTrace() {
            // parked car: zero extent
            let stuck = (0..<40).map { ChannelPoint(t: t($0), v: 365_600_000) }
            #expect(PDR.gpsFromChannels(stuck, stuck) == nil)
            // values plausible under neither interpretation
            let noise = (0..<40).map { ChannelPoint(t: t($0), v: 2_000_000_000 - Double($0) * 55_555_555) }
            #expect(PDR.gpsFromChannels(noise, noise) == nil)
            // too few samples
            #expect(PDR.gpsFromChannels([], []) == nil)
        }
    }

    // MARK: - parsePdrFile with a delta-encoded stream (real firmware shape)

    struct DeltaStreamTests {
        /// `buildPdrDeltaMp4()` — the beacon-less delta fixture the JS tests parse.
        private func parse() throws -> ParsedTelemetry {
            try PDR.parsePdrFile(try VideoFixtures.source("pdr-delta-nobeacon.mp4"))
        }

        @Test func decodesTheDeltaEncodedGPSChannelsIntoADictionaryScaledTrace() throws {
            let out = try parse()
            let gps = try #require(out.gps)
            #expect(gps.count > 100)
            // ~2Hz stream around the reference circle at lat0/lon0
            let lats = gps.map(\.lat)
            let lons = gps.map(\.lon)
            #expect((lats.min() ?? 0) > 36.5545)
            #expect((lats.max() ?? 0) < 36.5655)
            #expect(abs(((lons.min() ?? 0) + (lons.max() ?? 0)) / 2 - (-79.2)) < 0.005)
            // racing-line speed comes from the Speed channel (m/s), modulated ±5% around 40
            let vs = gps.compactMap(\.v)
            #expect((vs.max() ?? 0) > 40)
            #expect((vs.max() ?? 0) < 42.5)
        }

        @Test func keepsDecoderStateAcrossSampleBoundaries() throws {
            // the fixture splits records into 250-record samples; a state reset
            // would orphan every delta at a sample start and thin or corrupt the trace
            let out = try parse()
            let gps = try #require(out.gps)
            let dt = zip(gps.dropFirst(), gps).map { $0.t - $1.t }
            #expect((dt.max() ?? 0) < 1.5)  // no holes
            #expect(out.durationS > 150)
        }

        @Test func timesLapsFromDeltaStreamBeaconsAndReadsMrlvDateTime() throws {
            // `buildPdrDeltaMp4({ beaconTimes: [30, 30 + lapS, 30 + 2 * lapS] })`
            let out = try PDR.parsePdrFile(try VideoFixtures.source("pdr-delta.mp4"))
            let ms = 47124  // Math.round(LAP_S() * 1000)
            #expect(out.laps.map(\.timeMs) == [ms, ms])
            #expect(out.laps.allSatisfy { !$0.estimated })
            #expect(out.date == "2026-06-20")
            #expect(out.time == "09:15:00")
        }

        @Test func reportsTopSpeedMaxRPMAndMaxLateralGFromTheCarChannels() throws {
            let out = try parse()
            let metrics = try #require(out.metrics)
            // speed peaks at 42 m/s = 151.2 km/h; rpm at 6000; latAcc at v²/r ≈ 0.6 G
            #expect((metrics.topSpeedKph ?? 0) > 148)
            #expect((metrics.topSpeedKph ?? 0) < 152)
            #expect((metrics.maxRpm ?? 0) > 5900)
            #expect((metrics.maxRpm ?? 0) <= 6000)
            #expect((metrics.maxLatG ?? 0) > 0.5)
            #expect((metrics.maxLatG ?? 0) < 0.65)
        }

        @Test func decodesThrottleBrakeAndSteeringCarChannels() throws {
            let out = try parse()
            // pedals are raw 0-255 scaled by the dictionary's "%" units to 0-100,
            // alternating (throttle on the sine's positive half, brake the negative)
            let th = try #require(out.carChannels.throttle).map(\.v)
            let br = try #require(out.carChannels.brake).map(\.v)
            #expect(th.min() == 0)
            #expect((th.max() ?? 0) > 99)
            #expect((th.max() ?? 0) <= 100)
            #expect((br.max() ?? 0) > 99)
            // steering is stored in radians with an empty units string (the real
            // firmware shape); the parser converts to degrees itself: ±0.5 rad = ±28.6°
            let st = try #require(out.carChannels.steering).map(\.v)
            #expect((st.max() ?? 0) > 28)
            #expect((st.max() ?? 0) < 29.2)
            #expect((st.min() ?? 0) < -28)
        }
    }

    // MARK: - boxes

    struct BoxesTests {
        /// A buffer holding two MP4 boxes: "ftyp" (12 bytes) and "free" (8 bytes).
        private func buildBoxes(secondSize: Int = 8) -> ByteView {
            var bytes = [UInt8](repeating: 0, count: 20)
            func put(_ off: Int, _ size: Int, _ type: String) {
                bytes[off] = UInt8((size >> 24) & 0xff)
                bytes[off + 1] = UInt8((size >> 16) & 0xff)
                bytes[off + 2] = UInt8((size >> 8) & 0xff)
                bytes[off + 3] = UInt8(size & 0xff)
                for (i, ch) in type.utf8.enumerated() { bytes[off + 4 + i] = ch }
            }
            put(0, 12, "ftyp")
            put(12, secondSize, "free")
            return ByteView(bytes)
        }

        @Test func parsesConsecutiveBoxHeaders() {
            let out = MP4.boxes(buildBoxes(), 0, 20)
            #expect(
                out == [
                    MP4.Box(type: "ftyp", start: 0, body: 8, size: 12),
                    MP4.Box(type: "free", start: 12, body: 20, size: 8),
                ]
            )
        }

        @Test func stopsAtGarbageInsteadOfRunningAway() {
            // invalid size < 8
            #expect(MP4.boxes(buildBoxes(secondSize: 3), 0, 20).count == 1)
        }
    }

    // MARK: - Dispatch

    struct DispatchTests {
        /// A structurally-valid MP4 with an ftyp and an empty moov, no tracks —
        /// `emptyMp4()` in `test/unit/gpmf.test.js`.
        static func emptyMp4() -> DataByteSource {
            var bytes = [UInt8](repeating: 0, count: 32)
            bytes[3] = 16
            bytes.replaceSubrange(4..<8, with: Array("ftyp".utf8))
            bytes[19] = 16
            bytes.replaceSubrange(20..<24, with: Array("moov".utf8))
            return DataByteSource(Data(bytes))
        }

        @Test func reportsAVideoNeitherParserRecognises() {
            #expect(throws: TelemetryParseError(message: "No PDR or GoPro telemetry in this video")) {
                try Telemetry.parseTelemetryFile(Self.emptyMp4())
            }
        }

        @Test func picksTheParserWhoseTrackIsPresent() throws {
            #expect(try Telemetry.parseTelemetryFile(VideoFixtures.source("gopro.mp4")).kind == .gopro)
            #expect(try Telemetry.parseTelemetryFile(VideoFixtures.source("pdr-delta.mp4")).kind == .pdr)
        }

        @Test func aBeaconTimedPDRFileSkipsTheLinePicker() throws {
            let parsed = try Telemetry.parseTelemetryFile(VideoFixtures.source("pdr-delta.mp4"))
            #expect(!parsed.needsLine)
            #expect(parsed.laps.count == 2)
            // Channels are attached at parse time, so the lap overlay works on a
            // clip imported from the phone.
            #expect(parsed.lapChannels?.laps.count == 2)
        }
    }
}
