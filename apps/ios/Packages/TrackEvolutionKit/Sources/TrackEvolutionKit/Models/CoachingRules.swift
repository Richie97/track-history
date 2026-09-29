import Foundation

// Share with a coach (NS-38): the port of `public/js/coaching.js` and
// `public/js/profile.js` under the same names, pinned against the web
// implementation by `contracts/logic/coaching.json` (`CoachingTests`). Android's
// `:core` carries the same port; both are checked against the JS, never against
// each other.
//
// Pure and dateless in the way ported logic here is — anything that says a
// calendar date takes the client's own formatter.

private let HOUR_MS = 60 * 60 * 1000
private let DAY_MS = 24 * HOUR_MS

private func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? one : (many ?? "\(one)s"))"
}

public extension Coaching {
    /// A student row's one line: how much there is to read, and when they were
    /// last out. `fmtDate` turns the ISO date into the client's own wording.
    static func studentLine(eventCount: Int, lastEventDate: String?, fmtDate: (String) -> String) -> String {
        guard eventCount > 0 else { return "No track days yet" }
        let count = plural(eventCount, "event")
        guard let lastEventDate, !lastEventDate.isEmpty else { return count }
        return "\(count) · last out \(fmtDate(lastEventDate))"
    }

    static func studentLine(_ student: Student, fmtDate: (String) -> String) -> String {
        studentLine(eventCount: student.eventCount, lastEventDate: student.lastEventDate, fmtDate: fmtDate)
    }

    /// When a coach last read the logbook, for the student's list of coaches.
    /// The server touches it at most once an hour, so nothing finer is said.
    static func lastViewedText(_ lastViewedAt: Int?, now: Int) -> String {
        guard let lastViewedAt else { return "hasn't looked yet" }
        let ago = max(0, now - lastViewedAt)
        if ago < HOUR_MS { return "viewed in the last hour" }
        if ago < DAY_MS { return "viewed \(plural(ago / HOUR_MS, "hour")) ago" }
        if ago < 14 * DAY_MS { return "viewed \(plural(ago / DAY_MS, "day")) ago" }
        if ago < 60 * DAY_MS { return "viewed \(plural(ago / (7 * DAY_MS), "week")) ago" }
        return "not viewed for over two months"
    }

    /// An open invite's remaining life. Days round rather than floor, so a link
    /// minted a second ago reads "7 days", not "6" — `Math.round`, which for a
    /// positive value is half away from zero.
    static func inviteExpiryText(_ expiresAt: Int, now: Int) -> String {
        let left = expiresAt - now
        if left <= 0 { return "expired" }
        if left < HOUR_MS { return "expires within the hour" }
        if left < DAY_MS { return "expires in \(plural(left / HOUR_MS, "hour"))" }
        let days = Int((Double(left) / Double(DAY_MS)).rounded(.toNearestOrAwayFromZero))
        return "expires in \(plural(days, "day"))"
    }
}

// MARK: - The driver profile form

public extension DriverProfile {
    /// One field of the form: `kind` is text (one line, 200 chars), long (a
    /// box, 1,000), year, select or bool. `max` is the server's cap, so the form
    /// can stop a save before it is refused.
    struct Field: Hashable, Sendable {
        public enum Kind: String, Hashable, Sendable {
            case text, long, year, select, bool
        }

        public var key: String
        public var label: String
        public var kind: Kind
        public var max: Int?
        public var placeholder: String?
        /// `[value, label]` pairs, for a select.
        public var options: [[String]]?

        public init(
            key: String, label: String, kind: Kind, max: Int? = nil,
            placeholder: String? = nil, options: [[String]]? = nil
        ) {
            self.key = key
            self.label = label
            self.kind = kind
            self.max = max
            self.placeholder = placeholder
            self.options = options
        }
    }

    struct Group: Hashable, Sendable {
        public var title: String
        public var fields: [Field]
    }

    static let HELMET_RATINGS: [[String]] = [
        ["SA2020", "Snell SA2020"],
        ["SA2025", "Snell SA2025"],
        ["SAH2020", "Snell SAH2020"],
        ["FIA8859", "FIA 8859"],
        ["M", "Snell M (motorcycle)"],
        ["other", "Other"]
    ]

    static let HEAD_NECK: [[String]] = [
        ["none", "None"],
        ["hans", "HANS"],
        ["hybrid", "Hybrid-style"],
        ["other", "Other"]
    ]

    /// Mirrors `sanitizeProfile` in `src/lib/profile.ts` — the server is the one
    /// that validates, so a field added here without it is dropped on save.
    /// Deliberately no birth date and no emergency contact.
    static let PROFILE_GROUPS: [Group] = [
        Group(title: "About you", fields: [
            Field(key: "occupation", label: "Occupation", kind: .text, max: 200, placeholder: "Engineer, nurse, pilot…")
        ]),
        Group(title: "Experience", fields: [
            Field(key: "first_track_year", label: "First track day (year)", kind: .year, placeholder: "2019"),
            Field(key: "experience", label: "Other driving", kind: .long, max: 1000,
                  placeholder: "Karting since 2012, autocross, sim racing…"),
            Field(key: "license", label: "Competition licence", kind: .text, max: 200,
                  placeholder: "NASA HPDE4, SCCA novice…"),
            Field(key: "instruction", label: "Instruction so far", kind: .long, max: 1000,
                  placeholder: "Two schools, signed off to solo in 2024…")
        ]),
        Group(title: "Safety gear", fields: [
            Field(key: "helmet", label: "Helmet", kind: .text, max: 200, placeholder: "Make and model"),
            Field(key: "helmet_rating", label: "Helmet rating", kind: .select, options: HELMET_RATINGS),
            Field(key: "head_neck", label: "Head & neck restraint", kind: .select, options: HEAD_NECK),
            Field(key: "suit", label: "Suit", kind: .text, max: 200, placeholder: "Single-layer SFI 3.2A/1…"),
            Field(key: "gloves", label: "Driving gloves", kind: .bool),
            Field(key: "shoes", label: "Driving shoes", kind: .bool),
            Field(key: "gear_notes", label: "Anything else about your gear", kind: .long, max: 1000,
                  placeholder: "Wears glasses, arm restraints…")
        ]),
        Group(title: "Coaching", fields: [
            Field(key: "goals", label: "What I want to work on", kind: .long, max: 1000,
                  placeholder: "Trail braking into T1, carrying speed through the esses…"),
            Field(key: "for_instructor", label: "Anything your instructor should know", kind: .long, max: 1000,
                  placeholder: "An old injury, nerves in traffic, first time in this car…")
        ])
    ]

    static let PROFILE_FIELDS: [Field] = PROFILE_GROUPS.flatMap(\.fields)

    /// A stored value, as the JS reads `profile[key]`.
    enum Value: Hashable, Sendable {
        case text(String)
        case number(Int)
        case bool(Bool)
    }

    /// The value stored under a field's wire key — the JS's `profile[f.key]`.
    func value(for key: String) -> Value? {
        switch key {
        case "occupation": occupation.map(Value.text)
        case "first_track_year": firstTrackYear.map(Value.number)
        case "experience": experience.map(Value.text)
        case "license": license.map(Value.text)
        case "instruction": instruction.map(Value.text)
        case "helmet": helmet.map(Value.text)
        case "helmet_rating": helmetRating.map(Value.text)
        case "head_neck": headNeck.map(Value.text)
        case "suit": suit.map(Value.text)
        case "gloves": gloves.map(Value.bool)
        case "shoes": shoes.map(Value.bool)
        case "gear_notes": gearNotes.map(Value.text)
        case "goals": goals.map(Value.text)
        case "for_instructor": forInstructor.map(Value.text)
        default: nil
        }
    }

    /// Write a value under a field's wire key; nil clears it. A value of the
    /// wrong kind for the key is ignored.
    mutating func set(_ value: Value?, for key: String) {
        let text: String? = if case .text(let s) = value { s } else { nil }
        switch key {
        case "occupation": occupation = text
        case "first_track_year": firstTrackYear = if case .number(let n) = value { n } else { nil }
        case "experience": experience = text
        case "license": license = text
        case "instruction": instruction = text
        case "helmet": helmet = text
        case "helmet_rating": helmetRating = text
        case "head_neck": headNeck = text
        case "suit": suit = text
        case "gloves": gloves = if case .bool(let b) = value { b } else { nil }
        case "shoes": shoes = if case .bool(let b) = value { b } else { nil }
        case "gear_notes": gearNotes = text
        case "goals": goals = text
        case "for_instructor": forInstructor = text
        default: break
        }
    }

    /// One field's value as a coach reads it, or nil when there is nothing to
    /// say. A boolean is said either way — "No" driving gloves is something an
    /// instructor wants to know before the first session.
    static func profileValueText(_ field: Field, _ value: Value?) -> String? {
        guard let value else { return nil }
        switch (field.kind, value) {
        case (_, .bool(let b)):
            return b ? "Yes" : "No"
        case (_, .number(let n)):
            return String(n)
        case (.select, .text(let s)):
            if s.isEmpty { return nil }
            return field.options?.first { $0.first == s }?.last ?? s
        case (_, .text(let s)):
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    struct SectionRow: Hashable, Sendable {
        public var key: String
        public var label: String
        public var value: String
    }

    struct Section: Hashable, Sendable {
        public var title: String
        public var rows: [SectionRow]
    }

    /// The profile as grouped lines, with empty fields and then empty groups left
    /// out, so a half-filled profile reads as what it says rather than as a form
    /// full of blanks.
    static func profileSections(_ profile: DriverProfile?) -> [Section] {
        guard let profile else { return [] }
        return PROFILE_GROUPS.map { group in
            Section(
                title: group.title,
                rows: group.fields.compactMap { field in
                    profileValueText(field, profile.value(for: field.key))
                        .map { SectionRow(key: field.key, label: field.label, value: $0) }
                }
            )
        }
        .filter { !$0.rows.isEmpty }
    }

    /// A raw form value: a string from a field or a select, or a boolean.
    enum FormValue: Hashable, Sendable {
        case string(String)
        case bool(Bool)
    }

    /// The request body from a form's raw values: blanks become nil — which the
    /// server reads as "not set" — and the year becomes a number. Each yes/no is a
    /// three-way choice ("" / "yes" / "no"), because an unticked box would say
    /// "No" about something the driver never answered. Validation stays the
    /// server's.
    static func profileBody(_ values: [String: FormValue]) -> DriverProfile {
        var out = DriverProfile()
        for field in PROFILE_FIELDS {
            let raw = values[field.key]
            switch field.kind {
            case .bool:
                let answer: Bool? = switch raw {
                case .bool(let b): b
                case .string("yes"): true
                case .string("no"): false
                default: nil
                }
                out.set(answer.map(Value.bool), for: field.key)
            case .year:
                let s = Self.string(raw).trimmingCharacters(in: .whitespacesAndNewlines)
                // `Number(s)`: nil where the JS would send NaN (→ null), and the
                // server refuses anything that isn't a whole year anyway.
                out.set(s.isEmpty ? nil : Int(s).map(Value.number), for: field.key)
            case .text, .long, .select:
                let s = Self.string(raw).trimmingCharacters(in: .whitespacesAndNewlines)
                out.set(s.isEmpty ? nil : .text(s), for: field.key)
            }
        }
        return out
    }

    /// `String(raw ?? "")`.
    private static func string(_ raw: FormValue?) -> String {
        switch raw {
        case .string(let s): s
        case .bool(let b): b ? "true" : "false"
        case nil: ""
        }
    }
}
