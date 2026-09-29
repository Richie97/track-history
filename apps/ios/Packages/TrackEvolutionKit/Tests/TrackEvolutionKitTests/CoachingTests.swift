import Foundation
import Testing

@testable import TrackEvolutionKit

/// Share with a coach (NS-38): the JS cases from `test/unit/coaching-client.test.js`
/// ported with the code, plus agreement with `contracts/logic/coaching.json` —
/// the fixture the Android port asserts against too.
struct CoachingTests {
    private static let HOUR = 3_600_000
    private static let DAY = 24 * HOUR
    /// `Date.UTC(2026, 8, 29, 12)`.
    private static let NOW = 1_790_683_200_000

    // MARK: - The JS cases

    @Test func profileBodyTurnsBlanksIntoNilTheYearIntoANumberAndYesNoIntoBooleans() {
        let body = DriverProfile.profileBody([
            "occupation": .string("  Pilot "), "first_track_year": .string("2019"), "helmet_rating": .string(""),
            "gloves": .string("yes"), "shoes": .string("no"), "goals": .string("")
        ])
        #expect(body.occupation == "Pilot")
        #expect(body.firstTrackYear == 2019)
        #expect(body.helmetRating == nil)
        #expect(body.gloves == true)
        #expect(body.shoes == false)
        #expect(body.goals == nil)
        #expect(body.experience == nil)
    }

    @Test func anUnansweredYesNoStaysUnanswered() {
        #expect(DriverProfile.profileBody(["gloves": .string("")]).gloves == nil)
        #expect(DriverProfile.profileBody([:]).shoes == nil)
    }

    @Test func profileSectionsSaysNothingForNoProfile() {
        #expect(DriverProfile.profileSections(nil).isEmpty)
        #expect(DriverProfile.profileSections(DriverProfile()).isEmpty)
    }

    @Test func profileSectionsKeepsOnlyGroupsAndRowsWithSomethingToSayInFormOrder() {
        var profile = DriverProfile()
        profile.goals = "Trail braking"
        profile.helmetRating = "SA2020"
        profile.gloves = false
        profile.occupation = " "
        #expect(DriverProfile.profileSections(profile) == [
            .init(title: "Safety gear", rows: [
                .init(key: "helmet_rating", label: "Helmet rating", value: "Snell SA2020"),
                .init(key: "gloves", label: "Driving gloves", value: "No")
            ]),
            .init(title: "Coaching", rows: [.init(key: "goals", label: "What I want to work on", value: "Trail braking")])
        ])
    }

    @Test func studentLineCountsEventsAndSaysWhenTheyWereLastOut() {
        let iso: (String) -> String = { $0 }
        #expect(Coaching.studentLine(eventCount: 0, lastEventDate: nil, fmtDate: iso) == "No track days yet")
        #expect(Coaching.studentLine(eventCount: 1, lastEventDate: "2026-04-10", fmtDate: iso) == "1 event · last out 2026-04-10")
        #expect(Coaching.studentLine(eventCount: 12, lastEventDate: "2026-04-10", fmtDate: iso) == "12 events · last out 2026-04-10")
    }

    @Test func lastViewedTextStepsFromHoursToDaysToWeeks() {
        let now = Self.NOW, h = Self.HOUR, d = Self.DAY
        #expect(Coaching.lastViewedText(nil, now: now) == "hasn't looked yet")
        #expect(Coaching.lastViewedText(now - 10 * 60_000, now: now) == "viewed in the last hour")
        #expect(Coaching.lastViewedText(now - h, now: now) == "viewed 1 hour ago")
        #expect(Coaching.lastViewedText(now - Int(23.9 * Double(h)), now: now) == "viewed 23 hours ago")
        #expect(Coaching.lastViewedText(now - d, now: now) == "viewed 1 day ago")
        #expect(Coaching.lastViewedText(now - Int(13.9 * Double(d)), now: now) == "viewed 13 days ago")
        #expect(Coaching.lastViewedText(now - 14 * d, now: now) == "viewed 2 weeks ago")
        #expect(Coaching.lastViewedText(now - 60 * d, now: now) == "not viewed for over two months")
        // A clock a little behind the server's never reads as the future.
        #expect(Coaching.lastViewedText(now + 5_000, now: now) == "viewed in the last hour")
    }

    @Test func inviteExpiryTextRoundsDaysSoAFreshLinkReadsSeven() {
        let now = Self.NOW, h = Self.HOUR, d = Self.DAY
        #expect(Coaching.inviteExpiryText(now + 7 * d - 1_000, now: now) == "expires in 7 days")
        #expect(Coaching.inviteExpiryText(now + 36 * h, now: now) == "expires in 2 days")
        #expect(Coaching.inviteExpiryText(now + 25 * h, now: now) == "expires in 1 day")
        #expect(Coaching.inviteExpiryText(now + Int(23.5 * Double(h)), now: now) == "expires in 23 hours")
        #expect(Coaching.inviteExpiryText(now + h, now: now) == "expires in 1 hour")
        #expect(Coaching.inviteExpiryText(now + 59 * 60_000, now: now) == "expires within the hour")
        #expect(Coaching.inviteExpiryText(now, now: now) == "expired")
    }

    // MARK: - The fixture

    private struct Fixture: Decodable {
        var now: Int
        var groups: [FixtureGroup]
        var sections: [SectionCase]
        var bodies: [BodyCase]
        var studentLines: [StudentLineCase]
        var lastViewed: [LastViewedCase]
        var inviteExpiry: [InviteExpiryCase]
    }

    private struct FixtureGroup: Decodable {
        var title: String
        var fields: [FixtureField]
    }

    private struct FixtureField: Decodable {
        var key: String
        var label: String
        var kind: String
        var max: Int?
        var placeholder: String?
        var options: [[String]]?
    }

    private struct FixtureRow: Decodable, Equatable {
        var key: String
        var label: String
        var value: String
    }

    private struct FixtureSection: Decodable, Equatable {
        var title: String
        var rows: [FixtureRow]
    }

    private struct SectionCase: Decodable {
        var profile: DriverProfile?
        var sections: [FixtureSection]
    }

    private struct BodyCase: Decodable {
        var values: [String: FormValueJSON]
        var body: DriverProfile
        var bodyKeys: [String]

        enum CodingKeys: String, CodingKey { case values, body }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            values = try c.decode([String: FormValueJSON].self, forKey: .values)
            body = try c.decode(DriverProfile.self, forKey: .body)
            bodyKeys = try c.decode([String: JSONScalar?].self, forKey: .body).keys.sorted()
        }
    }

    /// A value the JS form handed `profileBody`: a string or a boolean.
    private struct FormValueJSON: Decodable {
        var value: DriverProfile.FormValue

        init(from decoder: any Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let b = try? c.decode(Bool.self) {
                value = .bool(b)
            } else {
                value = .string(try c.decode(String.self))
            }
        }
    }

    /// Any JSON scalar, null included — only its key is read.
    private struct JSONScalar: Decodable {
        init(from decoder: any Decoder) throws {}
    }

    private struct StudentLineCase: Decodable {
        struct Student: Decodable {
            var eventCount: Int
            var lastEventDate: String?
            enum CodingKeys: String, CodingKey {
                case eventCount = "event_count"
                case lastEventDate = "last_event_date"
            }
        }

        var student: Student
        var line: String
    }

    private struct LastViewedCase: Decodable {
        var lastViewedAt: Int?
        var text: String
        enum CodingKeys: String, CodingKey {
            case lastViewedAt = "last_viewed_at"
            case text
        }
    }

    private struct InviteExpiryCase: Decodable {
        var expiresAt: Int
        var text: String
        enum CodingKeys: String, CodingKey {
            case expiresAt = "expires_at"
            case text
        }
    }

    private static func fixture() throws -> Fixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/coaching.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    @Test func theFormSpecIsTheWebsFieldForField() throws {
        let fixture = try Self.fixture()
        #expect(fixture.groups.map(\.title) == DriverProfile.PROFILE_GROUPS.map(\.title))
        for (theirs, ours) in zip(fixture.groups, DriverProfile.PROFILE_GROUPS) {
            #expect(theirs.fields.count == ours.fields.count, "\(ours.title)")
            for (f, g) in zip(theirs.fields, ours.fields) {
                #expect(f.key == g.key)
                #expect(f.label == g.label)
                #expect(f.kind == g.kind.rawValue, "\(g.key)")
                #expect(f.max == g.max, "\(g.key)")
                #expect(f.placeholder == g.placeholder, "\(g.key)")
                #expect(f.options == g.options, "\(g.key)")
            }
        }
    }

    @Test func profileSectionsMatchTheWeb() throws {
        for (index, row) in try Self.fixture().sections.enumerated() {
            let ours = DriverProfile.profileSections(row.profile).map { section in
                FixtureSection(
                    title: section.title,
                    rows: section.rows.map { FixtureRow(key: $0.key, label: $0.label, value: $0.value) }
                )
            }
            #expect(ours == row.sections, "profile #\(index)")
        }
    }

    @Test func profileBodyMatchesTheWeb() throws {
        for (index, row) in try Self.fixture().bodies.enumerated() {
            let ours = DriverProfile.profileBody(row.values.mapValues(\.value))
            #expect(ours == row.body, "values #\(index)")
            // The JS body names every field, null or not; the port writes every
            // field the form has, so the two cover the same keys.
            #expect(row.bodyKeys == DriverProfile.PROFILE_FIELDS.map(\.key).sorted())
        }
    }

    @Test func theGrantsWordingMatchesTheWeb() throws {
        let fixture = try Self.fixture()
        for row in fixture.studentLines {
            #expect(
                Coaching.studentLine(
                    eventCount: row.student.eventCount, lastEventDate: row.student.lastEventDate, fmtDate: { $0 }
                ) == row.line
            )
        }
        for row in fixture.lastViewed {
            #expect(Coaching.lastViewedText(row.lastViewedAt, now: fixture.now) == row.text, "\(String(describing: row.lastViewedAt))")
        }
        for row in fixture.inviteExpiry {
            #expect(Coaching.inviteExpiryText(row.expiresAt, now: fixture.now) == row.text, "\(row.expiresAt)")
        }
    }

    // MARK: - Whose tier the panel opens by

    @Test func aFreeCoachViewingAProStudentSeesTheWholePanel() {
        let student = LogbookOwner.student(id: 7, name: "Alex", pro: true)
        // The coach is free — the student's tier is what counts.
        #expect(student.canViewChannels(viewer: .free))
        #expect(Entitlement.canViewChannel(student.channelEntitlement(viewer: .free), "latG"))
        #expect(Entitlement.canViewChannel(student.channelEntitlement(viewer: nil), "yaw"))
    }

    @Test func aProCoachViewingAFreeStudentSeesTheFreeHalf() {
        let student = LogbookOwner.student(id: 7, name: nil, pro: false)
        let proCoach = Entitlement(tier: .pro, source: .apple)
        #expect(!student.canViewChannels(viewer: proCoach))
        #expect(!Entitlement.canViewChannel(student.channelEntitlement(viewer: proCoach), "latG"))
        #expect(Entitlement.canViewChannel(student.channelEntitlement(viewer: proCoach), "speed"))
        #expect(student.studentFreeNote.hasPrefix("This driver is on the free plan"))
    }

    @Test func yourOwnLogbookReadsYourOwnTier() {
        #expect(LogbookOwner.me.canViewChannels(viewer: Entitlement(tier: .pro)))
        #expect(!LogbookOwner.me.canViewChannels(viewer: .free))
        #expect(!LogbookOwner.me.isReadOnly)
        #expect(LogbookOwner.me.apiPrefix == "")
        #expect(LogbookOwner.student(id: 3, name: nil, pro: true).apiPrefix == "/students/3")
    }
}
