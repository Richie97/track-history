import Foundation
import Testing

@testable import TrackEvolutionKit

/// The New Event form's posting rule, pinned to `public/js/event-form.js`
/// through `contracts/logic/event-form.json` — the same fixture Android's
/// `:core` asserts against, so the two ports are checked against the web
/// rather than against each other.
struct EventFormSessionsTests {
    struct Body: Decodable, Equatable {
        var label: String?
        var notes: String?
        var laps: [Int]
    }

    struct Hand: Decodable {
        var label: String
        var laps: String
        var notes: String
    }

    struct Case: Decodable {
        var name: String
        var staged: [Body]
        var hand: Hand?
        var expected: [Body]
    }

    struct Summary: Decodable {
        var laps: [Int]
        var expected: String
    }

    struct Fixture: Decodable {
        var cases: [Case]
        var summaries: [Summary]
    }

    private func fixture() throws -> Fixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/event-form.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private func body(_ draft: SessionDraft) -> Body {
        Body(label: draft.label, notes: draft.notes, laps: draft.laps ?? [])
    }

    @Test func sessionsToCreateMatchesTheWebImplementationCaseForCase() throws {
        for c in try fixture().cases {
            let staged = c.staged.map { SessionDraft(label: $0.label, notes: $0.notes, laps: $0.laps) }
            let actual = EventFormSessions.sessionsToCreate(
                staged: staged, label: c.hand?.label, laps: c.hand?.laps, notes: c.hand?.notes
            )
            #expect(actual.map(body) == c.expected, "\(c.name)")
        }
    }

    @Test func stagedSummaryMatchesTheWebImplementation() throws {
        for s in try fixture().summaries {
            #expect(EventFormSessions.stagedSummary(laps: s.laps) == s.expected)
        }
    }

    // MARK: - The JS test cases, ported

    @Test func postsStagedImportsFirstInOrderThenTheHandTypedSession() {
        let a = SessionDraft(label: "PDR 09:15:00", laps: [121240, 120100])
        let b = SessionDraft(label: "GoPro 10:30:00", laps: [119900])
        let out = EventFormSessions.sessionsToCreate(
            staged: [a, b], label: " Day 1 — Session 2 ", laps: "2:03.55\n2:01.24", notes: "traffic"
        )
        #expect(out.map(\.label) == ["PDR 09:15:00", "GoPro 10:30:00", "Day 1 — Session 2"])
        #expect(out[2] == SessionDraft(label: "Day 1 — Session 2", notes: "traffic", laps: [123550, 121240]))
    }

    @Test func dropsAHandEntryWithNoParseableLaps() {
        #expect(EventFormSessions.sessionsToCreate(staged: [], label: "Morning", laps: "", notes: "").isEmpty)
        #expect(EventFormSessions.sessionsToCreate(staged: [], label: "", laps: "nonsense", notes: "").isEmpty)
    }

    @Test func sendsBlankLabelAndNotesAsNil() {
        let out = EventFormSessions.sessionsToCreate(staged: [], label: "  ", laps: "121.24", notes: "  ")
        #expect(out == [SessionDraft(label: nil, notes: nil, laps: [121240])])
    }
}
