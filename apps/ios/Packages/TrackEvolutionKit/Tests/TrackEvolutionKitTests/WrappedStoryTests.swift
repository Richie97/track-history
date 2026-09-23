import Foundation
import Testing

@testable import TrackEvolutionKit

/// Season Wrapped's presentation rules, pinned to `public/js/wrapped.js`
/// through `contracts/logic/wrapped.json` — the same fixture Android's `:core`
/// asserts against, so the two ports are checked against the web rather than
/// against each other.
struct WrappedStoryTests {
    struct SeasonCase: Decodable {
        var today: String
        var expected: Int?
    }

    struct CardCase: Decodable, Equatable {
        var kind: String
        var locked: Bool?
    }

    struct PosterCase: Decodable, Equatable {
        var title: String
        var headline: [String]
        var rows: [[String]]
    }

    struct Posters: Decodable {
        var imperial: PosterCase
        var metric: PosterCase
        var shared: PosterCase
    }

    struct Season: Decodable {
        var name: String
        var data: Wrapped
        var cards: [CardCase]
        var poster: Posters
    }

    struct DaysCase: Decodable { var d: Double; var expected: String }
    struct GainCase: Decodable { var ms: Int; var expected: String }
    struct DistanceCase: Decodable {
        struct Expected: Decodable { var value: String; var unit: String }
        var miles: Double
        var units: UnitSystem
        var expected: Expected
    }

    struct Format: Decodable {
        var fmtDays: [DaysCase]
        var fmtGain: [GainCase]
        var trackDistance: [DistanceCase]
    }

    struct Fixture: Decodable {
        var season: [SeasonCase]
        var seasons: [Season]
        var format: Format
    }

    private func fixture() throws -> Fixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/wrapped.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private func poster(_ p: WrappedStory.Poster) -> PosterCase {
        PosterCase(title: p.title, headline: p.headline, rows: p.rows)
    }

    @Test func wrappedSeasonMatchesTheRevealWindow() throws {
        for c in try fixture().season {
            #expect(WrappedStory.wrappedSeason(c.today) == c.expected, "\(c.today)")
        }
    }

    @Test func wrappedCardsMatchTheWebImplementationSeasonForSeason() throws {
        for s in try fixture().seasons {
            let cards = WrappedStory.wrappedCards(s.data, shared: s.name == "shared")
            let actual = cards.map { CardCase(kind: $0.kind.rawValue, locked: $0.locked ? true : nil) }
            #expect(actual == s.cards, "\(s.name)")
        }
    }

    @Test func posterLinesMatchTheWebImplementation() throws {
        for s in try fixture().seasons {
            #expect(poster(WrappedStory.posterLines(s.data, .imperial)) == s.poster.imperial, "\(s.name) imperial")
            #expect(poster(WrappedStory.posterLines(s.data, .metric)) == s.poster.metric, "\(s.name) metric")
            #expect(poster(WrappedStory.posterLines(s.data, .imperial, share: true)) == s.poster.shared, "\(s.name) shared")
        }
    }

    @Test func formattingMatchesTheWebImplementation() throws {
        let f = try fixture().format
        for c in f.fmtDays { #expect(WrappedStory.fmtDays(c.d) == c.expected, "\(c.d)") }
        for c in f.fmtGain { #expect(WrappedStory.fmtGain(c.ms) == c.expected, "\(c.ms)") }
        for c in f.trackDistance {
            let d = WrappedStory.trackDistance(c.miles, c.units)
            #expect(d.value == c.expected.value && d.unit == c.expected.unit, "\(c.miles) \(c.units)")
        }
    }

    // ---- the JS test cases, ported ----------------------------------------

    @Test func theRevealWindowReadsTheLocalDay() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        let nov1 = cal.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 0, minute: 5))!
        let jan31 = cal.date(from: DateComponents(year: 2027, month: 1, day: 31, hour: 23, minute: 55))!
        #expect(WrappedStory.wrappedSeason(nov1, calendar: cal) == 2026)
        #expect(WrappedStory.wrappedSeason(jan31, calendar: cal) == 2026)
    }

    @Test func halfDaysShowAsHalvesAndGainsToTheHundredth() {
        #expect(WrappedStory.fmtDays(14) == "14")
        #expect(WrappedStory.fmtDays(2.5) == "2.5")
        #expect(WrappedStory.fmtGain(4830) == "4.83 s")
    }
}
