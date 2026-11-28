import Foundation

/// The AI Coach's pure half on iOS (#320): the port of `public/js/ai-coach.js`,
/// keeping its function and constant names so the two diff by eye, pinned case
/// for case by `contracts/logic/ai-coach.json` (`AICoachTests`) and the parser by
/// the recorded `contracts/streams/ai-coach.sse`. Android's `:core` carries the
/// same port; both are checked against the web, never against each other.
///
/// The wire format is `docs/specs/native/NS-58-ai-coach.md`. Always the
/// "AI Coach": a bare "coach" is a person in this app (NS-38).
public enum AICoach {
    public static let COACH_NAME = "AI Coach"

    public struct Provider: Hashable, Sendable, Decodable {
        public let id: String
        public let name: String
        public let keyUrl: String
        public let placeholder: String
    }

    public static let COACH_PROVIDERS: [Provider] = [
        Provider(id: "anthropic", name: "Anthropic", keyUrl: "https://platform.claude.com/settings/keys", placeholder: "sk-ant-…"),
        Provider(id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys", placeholder: "sk-…"),
        Provider(id: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/app/apikey", placeholder: "AIza…"),
    ]

    /// "provider" for the dev-only fake, which has no name to show.
    public static func providerName(_ id: String?) -> String {
        COACH_PROVIDERS.first { $0.id == id }?.name ?? "provider"
    }

    public static let COACH_PRO_WHAT =
        "A debrief of a session, an explanation of the gap between two laps, or a plan for your next visit — " +
        "written from your own telemetry and history, on your own Anthropic, OpenAI or Google Gemini account."
    /// Shown where the keys are entered: Google sign-in grants nothing on the Gemini API.
    public static let COACH_GEMINI_NOTE =
        "Signing in to Track Evolution with Google does not connect Gemini — it needs its own key. " +
        "A Gemini key can be used free, within low limits Google sets."
    public static let COACH_OFFLINE = "needs a connection"
    public static let COACH_DISCLAIMER = "For the paddock, not the car — and not a substitute for an instructor."

    // MARK: - Entry points

    /// The three places the AI Coach opens from.
    public enum Entry: String, CaseIterable, Hashable, Sendable {
        case session, compare, event
    }

    public struct EntryInfo: Hashable, Sendable, Decodable {
        /// The button's words.
        public let button: String
        /// The sheet's subtitle.
        public let title: String
        /// The question the conversation opens with.
        public let question: String
        /// Whose notes a kept reply is appended to: "session" or "event".
        public let saveTo: String
    }

    public static let COACH_ENTRIES: [Entry: EntryInfo] = [
        .session: EntryInfo(
            button: "Debrief this session",
            title: "Session debrief",
            question: "Debrief this session: what went well, where the time is, and one or two specific things to try next session.",
            saveTo: "session"
        ),
        .compare: EntryInfo(
            button: "Explain the difference",
            title: "Two laps compared",
            question: "Explain the difference between these two laps: where the time went, corner by corner, and what I would change.",
            saveTo: "event"
        ),
        .event: EntryInfo(
            button: "What should I work on next time?",
            title: "Next time",
            question: "What should I work on next time I'm at this track?",
            saveTo: "event"
        ),
    ]

    public static func entry(_ entry: Entry) -> EntryInfo { COACH_ENTRIES[entry]! }

    public static func coachSaveLabel(_ entry: Entry) -> String {
        COACH_ENTRIES[entry]?.saveTo == "session" ? "Save to session notes" : "Save to event notes"
    }

    // MARK: - The request's context

    /// The ids an entry point knows about. A row created offline has a negative
    /// temp id the server has never heard of.
    public struct Ids: Hashable, Sendable {
        public var eventId: Int?
        public var sessionId: Int?
        public var lapId: Int?
        public var compareLapId: Int?
        public var trackId: Int?

        public init(eventId: Int? = nil, sessionId: Int? = nil, lapId: Int? = nil, compareLapId: Int? = nil, trackId: Int? = nil) {
            self.eventId = eventId
            self.sessionId = sessionId
            self.lapId = lapId
            self.compareLapId = compareLapId
            self.trackId = trackId
        }
    }

    /// The request body's `context`.
    public struct Context: Codable, Hashable, Sendable {
        public var eventId: Int?
        public var sessionId: Int?
        public var lapId: Int?
        public var compareLapId: Int?
        public var trackId: Int?

        public enum CodingKeys: String, CodingKey {
            case eventId = "event_id", sessionId = "session_id", lapId = "lap_id"
            case compareLapId = "compare_lap_id", trackId = "track_id"
        }
    }

    /// A server id as the API wants it: a positive integer.
    private static func serverId(_ v: Int?) -> Int? {
        guard let v, v > 0 else { return nil }
        return v
    }

    /// The request's `context` for an entry point, or nil when a row it needs
    /// has no server id yet (the entry point is then not offered).
    ///   session: eventId, sessionId
    ///   compare: lapId (A, the reference), compareLapId (B), trackId?
    ///   event:   eventId, trackId?
    public static func coachContext(_ entry: Entry, _ ids: Ids) -> Context? {
        let track = serverId(ids.trackId)
        switch entry {
        case .session:
            guard let e = serverId(ids.eventId), let s = serverId(ids.sessionId) else { return nil }
            return Context(eventId: e, sessionId: s)
        case .compare:
            guard let a = serverId(ids.lapId), let b = serverId(ids.compareLapId), a != b else { return nil }
            return Context(lapId: a, compareLapId: b, trackId: track)
        case .event:
            guard let e = serverId(ids.eventId) else { return nil }
            return Context(eventId: e, trackId: track)
        }
    }

    // MARK: - Errors

    private static func sentence(_ s: String) -> String {
        guard let first = s.first else { return "." }
        let up = String(first).uppercased() + s.dropFirst()
        let last = s.last!
        return ".!?…".contains(last) ? up : up + "."
    }

    /// What the sheet says for a refusal: the server's own `{ error }`, made
    /// into a sentence a driver can act on.
    public static func coachErrorText(_ status: Int, _ error: String?, _ provider: String?) -> String {
        if status == 424, error == "provider rejected the key" {
            return sentence("\(providerName(provider)) rejected the key. Check it in Settings → AI assistants")
        }
        if status == 400, error == "no AI provider set up" {
            return "No AI provider is set up yet. Add a key in Settings → AI assistants."
        }
        guard let error, !error.isEmpty else { return "The \(COACH_NAME) couldn't answer. Try again." }
        return sentence(error)
    }

    // MARK: - The model field

    /// What the driver typed, as the id to send: a listed model's name picks its
    /// id, anything else is taken as an id, and nothing is the default (nil).
    public static func resolveModelInput(_ text: String?, _ models: [AICoachModel]) -> String? {
        let typed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return nil }
        let lower = typed.lowercased()
        let hit = models.first { $0.id.lowercased() == lower } ?? models.first { $0.label.lowercased() == lower }
        return hit?.id ?? typed
    }

    /// The field's placeholder: which model an empty field means.
    public static func modelPlaceholder(_ defaultModel: String?) -> String {
        guard let defaultModel, !defaultModel.isEmpty else { return "Default" }
        return "Default (\(defaultModel))"
    }

    // MARK: - Drawing a reply

    /// One block of a reply. Headings are drawn as a bold line; nothing else
    /// Markdown can say is interpreted — no HTML, no link, no image, no code.
    public enum Block: Hashable, Sendable {
        case p(lines: [String])
        case ul(items: [String])
        case ol(items: [String])
        case h(text: String)
    }

    private static func re(_ pattern: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern)
    }

    private static let bulletRe = re(#"^[-*•]\s+(.*)$"#)
    private static let numberedRe = re(#"^[0-9]{1,3}[.)]\s+(.*)$"#)
    private static let headingRe = re(#"^#{1,6}\s+(.*)$"#)
    private static let continuationRe = re(#"^\s+\S"#)
    private static let boldRe = re(#"\*\*(.+?)\*\*"#)

    /// The first capture of `regex` over the whole of `s`, or nil.
    private static func capture(_ regex: NSRegularExpression, _ s: String) -> String? {
        let ns = s as NSString
        guard let m = regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    private static func matches(_ regex: NSRegularExpression, _ s: String) -> Bool {
        regex.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// JS `trim()`: whitespace and line terminators off both ends.
    private static func jsTrim(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func lines(_ text: String) -> [String] {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
    }

    /// A model's reply as blocks: paragraphs, bulleted and numbered lists, and
    /// headings (drawn as a bold line).
    public static func coachMarkdownBlocks(_ text: String?) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var list: (ordered: Bool, items: [String])?
        func endPara() {
            if !para.isEmpty { out.append(.p(lines: para)) }
            para = []
        }
        func endList() {
            if let list { out.append(list.ordered ? .ol(items: list.items) : .ul(items: list.items)) }
            list = nil
        }
        for raw in lines(text ?? "") {
            let line = jsTrim(raw)
            if line.isEmpty {
                endPara()
                endList()
                continue
            }
            let bullet = capture(bulletRe, line)
            let numbered = bullet == nil ? capture(numberedRe, line) : nil
            if let item = bullet ?? numbered {
                endPara()
                let ordered = bullet == nil
                if let current = list, current.ordered != ordered { endList() }
                if list == nil { list = (ordered, []) }
                list!.items.append(item)
            } else if let heading = capture(headingRe, line) {
                endPara()
                endList()
                out.append(.h(text: heading.replacingOccurrences(of: "**", with: "")))
            } else if list != nil, matches(continuationRe, raw) {
                // An indented line under a list item continues it.
                list!.items[list!.items.count - 1] += " \(line)"
            } else {
                endList()
                para.append(line)
            }
        }
        endPara()
        endList()
        return out
    }

    public struct Run: Hashable, Sendable {
        public let text: String
        public let bold: Bool
        public init(text: String, bold: Bool) {
            self.text = text
            self.bold = bold
        }
    }

    /// A line split at its bold marks — the one inline mark — into runs. An
    /// unclosed ** stays as the text it is.
    public static func coachBoldRuns(_ s: String?) -> [Run] {
        let str = s ?? ""
        let ns = str as NSString
        var runs: [Run] = []
        var at = 0
        for m in boldRe.matches(in: str, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > at {
                runs.append(Run(text: ns.substring(with: NSRange(location: at, length: m.range.location - at)), bold: false))
            }
            runs.append(Run(text: ns.substring(with: m.range(at: 1)), bold: true))
            at = m.range.location + m.range.length
        }
        if at < ns.length { runs.append(Run(text: ns.substring(from: at), bold: false)) }
        return runs
    }

    // MARK: - Keeping a reply

    private static let MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "AI Coach, 26 Nov" — notes travel to a human coach the driver has shared
    /// with (NS-38), who should be able to tell this from the driver's own words.
    public static func coachNotesLabel(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.day, .month], from: date)
        return "\(COACH_NAME), \(c.day ?? 1) \(MONTHS[(c.month ?? 1) - 1])"
    }

    private static func replace(_ regex: NSRegularExpression, in s: String, with template: String) -> String {
        regex.stringByReplacingMatches(
            in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template
        )
    }

    private static let plainHeadingRe = re(#"^(\s*)#{1,6}\s+"#)
    private static let plainBulletRe = re(#"^(\s*)[*•]\s+"#)
    private static let manyBlankRe = re(#"\n{3,}"#)

    /// Notes are plain text, so the reply loses its marks: bold and heading
    /// markers go, list items keep a dash.
    public static func coachPlainText(_ text: String?) -> String {
        let joined = lines(text ?? "").map { line -> String in
            var l = replace(plainHeadingRe, in: line, with: "$1")
            l = replace(plainBulletRe, in: l, with: "$1- ")
            l = replace(boldRe, in: l, with: "$1")
            // trimEnd
            while let last = l.last, last.isWhitespace { l.removeLast() }
            return l
        }.joined(separator: "\n")
        return jsTrim(replace(manyBlankRe, in: joined, with: "\n\n"))
    }

    /// The notes after keeping a reply: what was there, a blank line, the label
    /// on its own line, then the reply.
    public static func appendCoachNote(_ existing: String?, _ reply: String, _ date: Date, calendar: Calendar = .current) -> String {
        let kept = "\(coachNotesLabel(date, calendar: calendar)):\n\(coachPlainText(reply))"
        let before = jsTrim(existing ?? "")
        return before.isEmpty ? kept : "\(before)\n\n\(kept)"
    }
}

// MARK: - The event stream

/// A JSON value, for an event's `data`: the stream's events carry small
/// objects whose unknown keys must be ignored, not refused.
public enum AICoachJSON: Hashable, Sendable, Decodable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AICoachJSON])
    case object([String: AICoachJSON])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([AICoachJSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: AICoachJSON].self)) }
    }

    public subscript(_ key: String) -> AICoachJSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var int: Int? {
        if case .number(let n) = self, n == n.rounded() { return Int(n) }
        return nil
    }
}

/// One server-sent event: its name ("message" when the block had none) and its
/// data parsed as JSON.
public struct SseEvent: Hashable, Sendable {
    public let event: String
    public let data: AICoachJSON
    public init(event: String, data: AICoachJSON) {
        self.event = event
        self.data = data
    }
}

/// `createSseParser` (``AICoach/createSseParser()``): an incremental
/// server-sent-events parser over **bytes**,
/// so a chunk may end anywhere — inside a CRLF, or inside a multi-byte
/// character. `push` returns each complete block, with its data parsed as JSON;
/// comment lines (the server's keepalive) and blocks whose data is not JSON are
/// skipped. `end` flushes whatever is left.
public struct SseParser: Sendable {
    private var buf: [UInt8] = []

    public init() {}

    public mutating func push<Bytes: Sequence>(_ bytes: Bytes) -> [SseEvent] where Bytes.Element == UInt8 {
        buf.append(contentsOf: bytes)
        return drain(final: false)
    }

    public mutating func push(_ text: String) -> [SseEvent] { push(Array(text.utf8)) }

    public mutating func end() -> [SseEvent] { drain(final: true) }

    private static let CR: UInt8 = 13
    private static let LF: UInt8 = 10

    private mutating func drain(final: Bool) -> [SseEvent] {
        // A trailing CR may be half of a CRLF whose LF is in the next chunk.
        let held = !final && buf.last == Self.CR
        if held { buf.removeLast() }
        var normalized: [UInt8] = []
        normalized.reserveCapacity(buf.count)
        var i = 0
        while i < buf.count {
            let b = buf[i]
            if b == Self.CR {
                normalized.append(Self.LF)
                if i + 1 < buf.count, buf[i + 1] == Self.LF { i += 1 }
            } else {
                normalized.append(b)
            }
            i += 1
        }
        if held { normalized.append(Self.CR) }
        buf = normalized

        var events: [SseEvent] = []
        var start = 0
        var j = 0
        while j + 1 < buf.count {
            if buf[j] == Self.LF, buf[j + 1] == Self.LF {
                if let e = Self.flush(buf[start..<j]) { events.append(e) }
                start = j + 2
                j = start
            } else {
                j += 1
            }
        }
        buf.removeFirst(start)
        if final {
            let rest = String(decoding: buf, as: UTF8.self)
            if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let e = Self.flush(buf[...]) {
                events.append(e)
            }
            buf = []
        }
        return events
    }

    private static func flush(_ block: ArraySlice<UInt8>) -> SseEvent? {
        let text = String(decoding: block, as: UTF8.self)
        var event = "message"
        var data: [String] = []
        for line in text.components(separatedBy: "\n") {
            if line.isEmpty || line.hasPrefix(":") { continue }
            let field: String
            var value: String
            if let colon = line.firstIndex(of: ":") {
                field = String(line[..<colon])
                value = String(line[line.index(after: colon)...])
                if value.hasPrefix(" ") { value.removeFirst() }
            } else {
                field = line
                value = ""
            }
            if field == "event" { event = value } else if field == "data" { data.append(value) }
        }
        guard !data.isEmpty,
              let parsed = try? JSONDecoder().decode(AICoachJSON.self, from: Data(data.joined(separator: "\n").utf8))
        else { return nil }
        return SseEvent(event: event, data: parsed)
    }
}

// MARK: - The request

/// One turn of the conversation, as the request sends it.
public struct AICoachMessage: Codable, Hashable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public var role: Role
    public var content: String
    public init(role: Role, content: String) {
        self.role = role
        self.content = content
    }
}

/// `POST /api/ai/coach`'s body.
public struct AICoachRequest: Encodable, Hashable, Sendable {
    public var context: AICoach.Context
    public var messages: [AICoachMessage]
    public var model: String?
    public init(context: AICoach.Context, messages: [AICoachMessage], model: String? = nil) {
        self.context = context
        self.messages = messages
        self.model = model
    }
}

/// The credential a request is sent with: which provider, and the driver's key
/// for it (nil for a connected provider, ticket 7, or the dev-only fake).
public struct AICoachCredential: Hashable, Sendable {
    public var provider: String
    public var key: String?
    public var model: String?
    public init(provider: String, key: String?, model: String? = nil) {
        self.provider = provider
        self.key = key
        self.model = model
    }
}

/// What the stream delivers, in order.
public enum AICoachStreamEvent: Hashable, Sendable {
    /// The next piece of the reply.
    case text(String)
    /// A tool is running: its id, and the progress label to show.
    case tool(name: String, label: String?)
    /// How the reply ended — always the last element.
    case finished(AICoachOutcome)
}

/// How an AI Coach request ended — the web's `streamCoach` result.
public enum AICoachOutcome: Hashable, Sendable {
    /// The reply is complete; `message` when it stopped short.
    case done(stop: String, message: String?)
    /// 402: draw the Pro offer in place.
    case paywall
    /// 401: the session is gone.
    case unauthorized
    /// The server's `{ error }`, before or after the stream opened.
    case error(status: Int, error: String)
    /// The request never reached the server.
    case offline
}

/// `POST /api/ai/coach/verify`'s answer, or why the key was refused.
public enum AICoachVerifyResult: Hashable, Sendable {
    case ok(AICoachVerify)
    case failed(status: Int, error: String)
}

public extension AICoach {
    /// The JS module's `createSseParser(onEvent)`; here a value whose `push`
    /// and `end` return the events instead of calling back.
    static func createSseParser() -> SseParser { SseParser() }

    /// The text a cut-off stream ends with.
    static let DROPPED = "the connection dropped before the reply finished"

    /// Fold stream events into an outcome: the web's `streamCoach` handler.
    /// Returns the stream element for an event, or nil for one to ignore.
    static func streamEvent(_ e: SseEvent) -> AICoachStreamEvent? {
        switch e.event {
        case "text":
            guard let delta = e.data["delta"]?.string else { return nil }
            return .text(delta)
        case "tool":
            return .tool(name: e.data["name"]?.string ?? "", label: e.data["label"]?.string)
        case "done":
            let message = e.data["message"]?.string
            return .finished(.done(stop: e.data["stop"]?.string ?? "end", message: (message?.isEmpty ?? true) ? nil : message))
        case "error":
            return .finished(.error(status: e.data["status"]?.int ?? 502, error: e.data["error"]?.string ?? ""))
        default:
            return nil
        }
    }
}
