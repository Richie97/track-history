import Foundation
import Testing

@testable import TrackEvolutionKit

/// The prep checklist a new event starts from, and the per-user list that
/// replaces it.
struct ChecklistTemplateTests {
    /// The built-in list is product copy carried in two clients, so it is pinned
    /// to the web's rather than trusted to stay in step by hand.
    @Test func defaultListMatchesTheWebImplementation() throws {
        struct Fixture: Decodable {
            // swiftlint:disable:next identifier_name
            var DEFAULT_CHECKLIST: [String]
        }
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/checklist.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        #expect(EventDates.DEFAULT_CHECKLIST == fixture.DEFAULT_CHECKLIST)
    }

    @Test func aUserWithoutATemplateFallsBackToTheDefault() throws {
        let user = try Goldens.decode(Me.self, "me").user
        #expect(user.checklistTemplate == nil)
        #expect(user.effectiveChecklistTemplate == EventDates.DEFAULT_CHECKLIST)
    }

    @Test func aCustomizedTemplateWins() throws {
        let user = try Goldens.decode(Me.self, "me-checklist-template").user
        #expect(user.checklistTemplate == ["Purchase Track insurance", "Torque lug nuts", "Set tire pressures"])
        #expect(user.effectiveChecklistTemplate == user.checklistTemplate)
    }

    /// An empty list is how the client clears the template — the field has to be
    /// on the wire as an explicit null, not omitted, or the server would keep it.
    @Test func clearingEncodesAnExplicitNull() throws {
        let cleared = try String(
            decoding: JSONEncoder().encode(ChecklistTemplateDraft(checklistTemplate: nil)), as: UTF8.self
        )
        #expect(cleared.contains("\"checklist_template\":null"))

        let set = try String(
            decoding: JSONEncoder().encode(ChecklistTemplateDraft(checklistTemplate: ["Tech inspection"])),
            as: UTF8.self
        )
        #expect(set.contains("Tech inspection"))
    }
}
