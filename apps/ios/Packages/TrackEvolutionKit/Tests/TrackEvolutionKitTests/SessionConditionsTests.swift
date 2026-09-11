import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/conditions.test.js`, ported with the code they
/// cover, plus the cross-language pin against `contracts/logic/conditions.json`.
struct SessionConditionsTests {
    /// An event in four fields — the shape the rules actually need.
    private struct Ev: SessionConditions.AmbientEvent {
        var ambientLoC: Double?
        var ambientHiC: Double?
        var elevationM: Double?
        var tempF: Int?

        init(lo: Double? = nil, hi: Double? = nil, elevation: Double? = nil, tempF: Int? = nil) {
            ambientLoC = lo
            ambientHiC = hi
            elevationM = elevation
            self.tempF = tempF
        }
    }

    private struct Sess: SessionConditions.AmbientSession {
        var ambientC: Double?
        var elevationM: Double?
        var channelMeta: ChannelMeta?
    }

    private func close(_ a: Double?, _ b: Double?, _ what: String = "") -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return abs(a - b) <= 1e-9
    }

    // MARK: - units

    @Test func convertsBothWays() {
        #expect(SessionConditions.cToF(0) == 32)
        #expect(SessionConditions.cToF(100) == 212)
        #expect(SessionConditions.fToC(32) == 0)
        #expect(SessionConditions.roundHalfUp(SessionConditions.fToC(72)) == 22)
    }

    @Test func wordsATemperatureInEitherSystem() {
        #expect(SessionConditions.tempText(21.4, .us) == "71 °F")
        #expect(SessionConditions.tempText(21.4) == "21 °C")
    }

    /// The port trap the fixture probes: JS rounds a tie *up*, so -12.5 °C is
    /// -12 °C. Swift's own `rounded()` would say -13.
    @Test func roundsTiesTowardPlusInfinityLikeJavaScript() {
        #expect(SessionConditions.tempText(-12.5) == "-12 °C")
        #expect(SessionConditions.tempText(-0.5) == "0 °C") // and never "-0"
        #expect(SessionConditions.tempText(21.5) == "22 °C")
    }

    // MARK: - reading a session

    @Test func prefersTheColumnAndFallsBackToTheChannelMeta() {
        #expect(SessionConditions.sessionAmbientC(Sess(ambientC: 18.5, channelMeta: ChannelMeta(ambientC: 99))) == 18.5)
        // A free account's channels are stripped and the column is not; a
        // response cached before migration 0020 is the other way round.
        #expect(SessionConditions.sessionAmbientC(Sess(channelMeta: ChannelMeta(ambientC: 24))) == 24)
        #expect(SessionConditions.sessionElevationM(Sess(channelMeta: ChannelMeta(elevationM: 38))) == 38)
    }

    @Test func hasNothingForAHandEnteredOrRecordedSession() {
        #expect(SessionConditions.sessionAmbientC(Sess()) == nil)
        #expect(SessionConditions.sessionElevationM(Sess(channelMeta: ChannelMeta())) == nil)
    }

    // MARK: - eventAmbient

    @Test func usesTheRecordedRangeWhenThereIsOne() {
        let a = SessionConditions.eventAmbient(Ev(lo: 14.2, hi: 31.8, tempF: 61))
        #expect(a == SessionConditions.Ambient(loC: 14.2, hiC: 31.8, source: .recorded))
    }

    @Test func fallsBackToTheTypedFahrenheit() {
        let a = SessionConditions.eventAmbient(Ev(tempF: 68))
        #expect(a?.source == .manual)
        #expect(close(a?.loC, 20))
        #expect(a?.loC == a?.hiC)
    }

    @Test func hasNothingWhenNeitherExists() {
        #expect(SessionConditions.eventAmbient(Ev()) == nil)
        #expect(SessionConditions.eventAmbient(Ev?.none) == nil)
    }

    @Test func ordersAReversedRangeRatherThanTrustingTheColumnOrder() {
        let a = SessionConditions.eventAmbient(Ev(lo: 30, hi: 12))
        #expect(a?.loC == 12)
        #expect(a?.hiC == 30)
    }

    // MARK: - words

    @Test func saysOneFigureOrTheDaysRange() {
        let range = SessionConditions.Ambient(loC: 14.2, hiC: 31.8, source: .recorded)
        #expect(SessionConditions.ambientText(SessionConditions.Ambient(loC: 20, hiC: 20, source: .recorded), .us) == "68 °F")
        #expect(SessionConditions.ambientText(range, .us) == "58–89 °F")
        #expect(SessionConditions.ambientText(range) == "14–32 °C")
        #expect(SessionConditions.ambientText(nil, .us) == "")
    }

    @Test func collapsesARangeThatRoundsToOneNumber() {
        // 21.4 and 21.8 °C are 70.5 and 71.2 °F: one number, not "71–71 °F".
        let a = SessionConditions.Ambient(loC: 21.4, hiC: 21.8, source: .recorded)
        #expect(SessionConditions.ambientText(a, .us) == "71 °F")
    }

    @Test func takesTheLargestElevationRangeAndWordsItInOneLine() {
        #expect(SessionConditions.trackElevationM([Ev(elevation: 38), Ev(elevation: 41), Ev()]) == 41)
        #expect(SessionConditions.trackElevationM([Ev(), Ev()]) == nil)
        #expect(SessionConditions.trackElevationM([Ev]()) == nil)
        #expect(SessionConditions.elevationText(41, .us) == "135 ft of elevation change")
        #expect(SessionConditions.elevationText(41) == "41 m of elevation change")
        #expect(SessionConditions.elevationText(nil, .us) == "")
    }

    // MARK: - the band

    private let cool = Ev(lo: 10, hi: 10)
    private let hot = Ev(lo: 30, hi: 30)

    @Test func normalizesOverTheEventsInView() {
        let band = SessionConditions.conditionsBand([cool, Ev(lo: 20, hi: 20), hot])
        #expect(band?.loC == 10)
        #expect(band?.hiC == 30)
        #expect(band?.cells.map { $0?.intensity } == [0, 0.5, 1])
        #expect(close(band?.cells[0]?.alpha, SessionConditions.BAND_MIN_ALPHA))
        #expect(close(band?.cells[2]?.alpha, SessionConditions.BAND_MAX_ALPHA))
    }

    @Test func shadesByTheMidpointOfADayThatWarmedUp() {
        let band = SessionConditions.conditionsBand([cool, Ev(lo: 14, hi: 26), hot])
        #expect(band?.cells[1]?.c == 20)
        #expect(band?.cells[1]?.intensity == 0.5)
    }

    @Test func drawsNothingForAnEventWithNoReading() {
        let band = SessionConditions.conditionsBand([cool, Ev(), hot])
        #expect(band?.cells[1] == .some(nil))
        #expect(band?.cells[0] != .some(nil))
    }

    @Test func countsATypedTemperatureToo() {
        // Most logbooks have no telemetry and must still get a band.
        let band = SessionConditions.conditionsBand([Ev(tempF: 50), Ev(tempF: 90)])
        #expect(band?.cells.allSatisfy { $0 != nil } == true)
    }

    @Test func refusesASpreadTooSmallToMeanAnything() {
        let atLimit = Ev(lo: 10 + SessionConditions.BAND_MIN_SPAN_C, hi: 10 + SessionConditions.BAND_MIN_SPAN_C)
        #expect(SessionConditions.conditionsBand([cool, Ev(lo: 12.9, hi: 12.9)]) == nil)
        #expect(SessionConditions.conditionsBand([cool, atLimit]) != nil)
    }

    @Test func refusesASingleKnownEventAndAnEmptyList() {
        #expect(SessionConditions.conditionsBand([cool, Ev(), Ev()]) == nil)
        #expect(SessionConditions.conditionsBand([Ev]()) == nil)
    }

    @Test func clampsTheWashToItsRange() {
        #expect(SessionConditions.bandAlpha(-1) == SessionConditions.BAND_MIN_ALPHA)
        #expect(SessionConditions.bandAlpha(2) == SessionConditions.BAND_MAX_ALPHA)
    }

    @Test func speaksTheShadingForAScreenReader() {
        let band = SessionConditions.conditionsBand([cool, hot])
        #expect(SessionConditions.bandLabel(band, .us) == "shaded by ambient temperature, 50 °F to 86 °F")
        #expect(SessionConditions.bandLabel(nil, .us) == "")
    }

    // MARK: - the cross-language fixture

    private struct FixtureEvent: Decodable, SessionConditions.AmbientEvent {
        var ambientLoC: Double?
        var ambientHiC: Double?
        var elevationM: Double?
        var tempF: Int?

        enum CodingKeys: String, CodingKey {
            case ambientLoC = "ambient_lo_c"
            case ambientHiC = "ambient_hi_c"
            case elevationM = "elevation_m"
            case tempF = "temp_f"
        }
    }

    private struct FixtureSession: Decodable, SessionConditions.AmbientSession {
        struct Channels: Decodable { let meta: ChannelMeta? }
        var ambientC: Double?
        var elevationM: Double?
        var channels: Channels?
        var channelMeta: ChannelMeta? { channels?.meta }

        enum CodingKeys: String, CodingKey {
            case ambientC = "ambient_c"
            case elevationM = "elevation_m"
            case channels
        }
    }

    private struct ConditionsFixture: Decodable {
        struct Input: Decodable {
            let events: [FixtureEvent]
            let spanAtLimit: [FixtureEvent]
            let spanUnder: [FixtureEvent]
            let oneKnown: [FixtureEvent]
            let sessions: [FixtureSession]
            let tempProbes: [Double]
            let elevProbes: [Double]
            let alphaProbes: [Double]
            let constants: Constants
        }
        struct Constants: Decodable {
            let BAND_MIN_EVENTS: Int
            let BAND_MIN_SPAN_C: Double
            let BAND_MIN_ALPHA: Double
            let BAND_MAX_ALPHA: Double
        }
        struct Convert: Decodable {
            let cToF: [Double]
            let fToC: [Double]
            let mToFt: [Double]
        }
        struct Expected: Decodable {
            let convert: Convert
            let sessionAmbientC: [Double?]
            let sessionElevationM: [Double?]
            let eventAmbient: [SessionConditions.Ambient?]
            let reversedRange: SessionConditions.Ambient
            let ambientMidC: [Double?]
            let trackElevationM: [Double?]
            let tempTextMetric: [String]
            let tempTextUs: [String]
            let ambientText: [String]
            let elevationTextMetric: [String]
            let elevationTextUs: [String]
            let noElevationText: String
            let band: SessionConditions.Band
            let bandAtLimit: SessionConditions.Band?
            let bandUnder: SessionConditions.Band?
            let bandOneKnown: SessionConditions.Band?
            let bandEmpty: SessionConditions.Band?
            let bandAlpha: [Double]
            let bandLabel: [String]
        }
        let input: Input
        let expected: Expected
    }

    /// The JS implementation's own output for a shared input has to come back
    /// out of this port: the wording exactly, the doubles to 1e-9.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let url = RepoRoot.path("contracts/logic/conditions.json")
        let fixture = try JSONDecoder().decode(ConditionsFixture.self, from: try Data(contentsOf: url))
        let input = fixture.input
        let want = fixture.expected

        // The constants themselves, so a port that quietly retunes one fails
        // here rather than by drawing a band nobody asked for.
        #expect(SessionConditions.BAND_MIN_EVENTS == input.constants.BAND_MIN_EVENTS)
        #expect(SessionConditions.BAND_MIN_SPAN_C == input.constants.BAND_MIN_SPAN_C)
        #expect(SessionConditions.BAND_MIN_ALPHA == input.constants.BAND_MIN_ALPHA)
        #expect(SessionConditions.BAND_MAX_ALPHA == input.constants.BAND_MAX_ALPHA)

        #expect(close(SessionConditions.cToF(0), want.convert.cToF[0]))
        #expect(close(SessionConditions.cToF(21.4), want.convert.cToF[1]))
        #expect(close(SessionConditions.cToF(-40), want.convert.cToF[2]))
        #expect(close(SessionConditions.fToC(32), want.convert.fToC[0]))
        #expect(close(SessionConditions.fToC(86), want.convert.fToC[1]))
        #expect(close(SessionConditions.fToC(-40), want.convert.fToC[2]))
        #expect(close(SessionConditions.mToFt(41.4), want.convert.mToFt[0]))
        #expect(close(SessionConditions.mToFt(1), want.convert.mToFt[1]))

        for (i, session) in input.sessions.enumerated() {
            #expect(close(SessionConditions.sessionAmbientC(session), want.sessionAmbientC[i]), "session \(i) ambient")
            #expect(close(SessionConditions.sessionElevationM(session), want.sessionElevationM[i]), "session \(i) elevation")
        }

        for (i, event) in input.events.enumerated() {
            let got = SessionConditions.eventAmbient(event)
            let expected = want.eventAmbient[i]
            #expect(got?.source == expected?.source, "event \(i) source")
            #expect(close(got?.loC, expected?.loC), "event \(i) lo")
            #expect(close(got?.hiC, expected?.hiC), "event \(i) hi")
            #expect(close(SessionConditions.ambientMidC(got), want.ambientMidC[i]), "event \(i) midpoint")
        }
        let reversed = SessionConditions.eventAmbient(
            FixtureEvent(ambientLoC: 30, ambientHiC: 12, elevationM: nil, tempF: nil)
        )
        #expect(reversed == want.reversedRange)

        #expect(close(SessionConditions.trackElevationM(input.events), want.trackElevationM[0]))
        #expect(SessionConditions.trackElevationM([FixtureEvent]()) == want.trackElevationM[2])

        #expect(input.tempProbes.map { SessionConditions.tempText($0, .metric) } == want.tempTextMetric)
        #expect(input.tempProbes.map { SessionConditions.tempText($0, .us) } == want.tempTextUs)
        #expect(input.elevProbes.map { SessionConditions.elevationText($0, .metric) } == want.elevationTextMetric)
        #expect(input.elevProbes.map { SessionConditions.elevationText($0, .us) } == want.elevationTextUs)
        #expect(SessionConditions.elevationText(nil, .us) == want.noElevationText)

        let warmDay = SessionConditions.eventAmbient(input.events[1])
        #expect(SessionConditions.ambientText(warmDay, .us) == want.ambientText[0])
        #expect(SessionConditions.ambientText(warmDay, .metric) == want.ambientText[1])
        #expect(SessionConditions.ambientText(SessionConditions.eventAmbient(input.events[2]), .us) == want.ambientText[2])
        #expect(SessionConditions.ambientText(nil, .us) == want.ambientText[3])
        #expect(SessionConditions.ambientText(SessionConditions.Ambient(loC: 21.4, hiC: 21.8, source: .recorded), .us) == want.ambientText[4])

        let band = try #require(SessionConditions.conditionsBand(input.events))
        #expect(close(band.loC, want.band.loC))
        #expect(close(band.hiC, want.band.hiC))
        #expect(band.cells.count == want.band.cells.count)
        for (i, cell) in band.cells.enumerated() {
            let expected = want.band.cells[i]
            #expect((cell == nil) == (expected == nil), "cell \(i) presence")
            #expect(close(cell?.c, expected?.c), "cell \(i) midpoint")
            #expect(close(cell?.intensity, expected?.intensity), "cell \(i) intensity")
            #expect(close(cell?.alpha, expected?.alpha), "cell \(i) alpha")
        }
        // Inclusive at the limit, nothing under it, nothing on one event.
        #expect((SessionConditions.conditionsBand(input.spanAtLimit) != nil) == (want.bandAtLimit != nil))
        #expect(SessionConditions.conditionsBand(input.spanUnder) == nil)
        #expect(want.bandUnder == nil)
        #expect(SessionConditions.conditionsBand(input.oneKnown) == nil)
        #expect(want.bandOneKnown == nil)
        #expect(SessionConditions.conditionsBand([FixtureEvent]()) == nil)
        #expect(want.bandEmpty == nil)

        for (i, probe) in input.alphaProbes.enumerated() {
            #expect(close(SessionConditions.bandAlpha(probe), want.bandAlpha[i]), "alpha probe \(probe)")
        }
        #expect(SessionConditions.bandLabel(band, .us) == want.bandLabel[0])
        #expect(SessionConditions.bandLabel(band, .metric) == want.bandLabel[1])
        #expect(SessionConditions.bandLabel(nil, .us) == want.bandLabel[2])
    }
}
