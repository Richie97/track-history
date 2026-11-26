import Foundation
import Testing

@testable import TrackEvolutionKit

/// The AI Coach's pure half (#320) against `contracts/logic/ai-coach.json` —
/// reference output captured from `public/js/ai-coach.js` — and the event-stream
/// parser against the recorded `contracts/streams/ai-coach.sse`. Asserted
/// against the web, never against Android's port.
struct AICoachTests {
    private let fixture: AICoachFixture

    init() throws {
        fixture = try AICoachFixture.load()
    }

    // MARK: - Words

    @Test func theWordsAreTheWebs() {
        #expect(AICoach.COACH_NAME == fixture.name)
        #expect(AICoach.COACH_PRO_WHAT == fixture.proWhat)
        #expect(AICoach.COACH_OFFLINE == fixture.offline)
        #expect(AICoach.COACH_DISCLAIMER == fixture.disclaimer)
        #expect(AICoach.COACH_PROVIDERS == fixture.providers)
        for row in fixture.providerNames {
            #expect(AICoach.providerName(row.id) == row.name, Comment(rawValue: row.id))
        }
        #expect(fixture.entries.count == AICoach.Entry.allCases.count)
        for (key, info) in fixture.entries {
            let entry = try! #require(AICoach.Entry(rawValue: key))
            #expect(AICoach.entry(entry) == info, Comment(rawValue: key))
        }
        for row in fixture.saveLabels {
            #expect(AICoach.coachSaveLabel(AICoach.Entry(rawValue: row.entry)!) == row.label)
        }
    }

    // MARK: - Context

    /// The fixture's ids are what the web passes: numbers, numeric strings, and
    /// "tmp-…" strings for a row created offline. Here a temp id is negative.
    private func nativeId(_ v: AICoachJSON?) -> Int? {
        switch v {
        case .number(let n)?: n == n.rounded() ? Int(n) : -1
        case .string(let s)?: Int(s) ?? -1
        default: nil
        }
    }

    @Test func theContextIsTheWebsForEveryEntryPoint() throws {
        for row in fixture.contexts {
            let ids = AICoach.Ids(
                eventId: nativeId(row.ids["eventId"]),
                sessionId: nativeId(row.ids["sessionId"]),
                lapId: nativeId(row.ids["lapId"]),
                compareLapId: nativeId(row.ids["compareLapId"]),
                trackId: nativeId(row.ids["trackId"])
            )
            let label = Comment(rawValue: "\(row.entry) \(row.ids)")
            guard let entry = AICoach.Entry(rawValue: row.entry) else {
                // The web's unknown entry point is a nil context; Swift has no
                // unknown case to pass.
                #expect(row.context == nil, label)
                continue
            }
            let context = AICoach.coachContext(entry, ids)
            #expect(context == row.context, label)
            if let context {
                // …and it encodes to the very keys the server reads, nothing else.
                let encoded = try JSONDecoder().decode([String: Int].self, from: JSONEncoder().encode(context))
                let expected = try JSONDecoder().decode([String: Int].self, from: JSONEncoder().encode(row.context))
                #expect(encoded == expected, label)
            }
        }
        #expect(fixture.contexts.count >= 10)
    }

    // MARK: - Errors and the model field

    @Test func errorSentencesAreTheWebs() {
        for row in fixture.errorTexts {
            #expect(AICoach.coachErrorText(row.status, row.error, row.provider) == row.text, Comment(rawValue: row.error))
        }
    }

    @Test func theModelFieldResolvesAsTheWebDoes() {
        for row in fixture.modelInputs {
            #expect(AICoach.resolveModelInput(row.text, fixture.models) == row.model, Comment(rawValue: row.text))
        }
        for row in fixture.placeholders {
            #expect(AICoach.modelPlaceholder(row.defaultModel) == row.text)
        }
    }

    // MARK: - Drawing and keeping a reply

    @Test func repliesBreakIntoTheWebsBlocks() {
        for row in fixture.markdown {
            #expect(AICoach.coachMarkdownBlocks(row.text) == row.blocks.map(\.block), Comment(rawValue: row.text))
        }
        for row in fixture.boldRuns {
            #expect(AICoach.coachBoldRuns(row.text) == row.runs.map { .init(text: $0.text, bold: $0.bold) }, Comment(rawValue: row.text))
        }
    }

    @Test func aKeptReplyIsTheWebsPlainTextUnderTheWebsLabel() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Pacific/Kiritimati"))
        func day(_ d: AICoachFixture.Day) -> Date {
            calendar.date(from: DateComponents(year: d.year, month: d.month, day: d.day, hour: 0))!
        }
        for row in fixture.plainText {
            #expect(AICoach.coachPlainText(row.text) == row.plain, Comment(rawValue: row.text))
        }
        for row in fixture.labels {
            #expect(AICoach.coachNotesLabel(day(row.date), calendar: calendar) == row.label)
        }
        for row in fixture.notes {
            #expect(AICoach.appendCoachNote(row.existing, row.reply, day(row.date), calendar: calendar) == row.notes)
        }
    }

    // MARK: - The event stream

    @Test func theParserEmitsTheWebsEventsForEveryWayAStreamArrives() {
        for row in fixture.sse {
            var parser = AICoach.createSseParser()
            var events: [SseEvent] = []
            for chunk in row.chunks { events += parser.push(chunk) }
            events += parser.end()
            #expect(events == row.events.map { SseEvent(event: $0.event, data: $0.data) }, Comment(rawValue: "\(row.chunks)"))
        }
    }

    private static func recorded() throws -> [UInt8] {
        Array(try Data(contentsOf: RepoRoot.path("contracts/streams/ai-coach.sse")))
    }

    /// The recorded stream: one `tool`, six `text` whose deltas join into the
    /// reply, then `done` with `stop: "end"` — whatever the chunking, including
    /// cuts inside a multi-byte character (the stream has "…" and "—").
    @Test func theRecordedStreamParsesTheSameWhereverItIsCut() throws {
        let bytes = try Self.recorded()
        #expect(bytes.contains(0xE2), "the recording must carry a multi-byte character to cut")

        func parse(_ chunks: [ArraySlice<UInt8>]) -> [SseEvent] {
            var parser = AICoach.createSseParser()
            var events: [SseEvent] = []
            for c in chunks { events += parser.push(c) }
            return events + parser.end()
        }

        let whole = parse([bytes[...]])
        #expect(whole.map(\.event) == ["tool", "text", "text", "text", "text", "text", "text", "done"])
        #expect(whole.first?.data["label"]?.string == "Analysing the session…")
        #expect(whole.last?.data["stop"]?.string == "end")
        let reply = whole.compactMap { $0.event == "text" ? $0.data["delta"]?.string : nil }.joined()
        #expect(reply.hasPrefix("**Where the time is.**"))
        #expect(reply.hasSuffix("whether the car is ready for it."))

        // Every single cut point, then byte by byte, then CRLF line endings.
        for cut in 1..<bytes.count {
            #expect(parse([bytes[..<cut], bytes[cut...]]) == whole, "cut at \(cut)")
        }
        #expect(parse(bytes.indices.map { bytes[$0...$0] }) == whole)
        var crlf: [UInt8] = []
        for b in bytes { if b == 10 { crlf.append(13) }; crlf.append(b) }
        for cut in stride(from: 1, to: crlf.count, by: 7) {
            #expect(parse([crlf[..<cut], crlf[cut...]]) == whole, "CRLF cut at \(cut)")
        }
    }

    @Test func streamEventsFoldTheWayTheWebsStreamCoachDoes() {
        func e(_ name: String, _ json: String) -> AICoachStreamEvent? {
            let data = try! JSONDecoder().decode(AICoachJSON.self, from: Data(json.utf8))
            return AICoach.streamEvent(SseEvent(event: name, data: data))
        }
        #expect(e("text", #"{"delta":"hi"}"#) == .text("hi"))
        #expect(e("text", #"{"delta":3}"#) == nil)
        #expect(e("tool", #"{"name":"get_laps","label":"Reading…","extra":1}"#) == .tool(name: "get_laps", label: "Reading…"))
        #expect(e("done", #"{"stop":"end","model":"m"}"#) == .finished(.done(stop: "end", message: nil)))
        #expect(e("done", #"{"stop":"tool_limit","model":"m","message":"Stopped."}"#) == .finished(.done(stop: "tool_limit", message: "Stopped.")))
        #expect(e("error", #"{"error":"boom","status":429}"#) == .finished(.error(status: 429, error: "boom")))
        #expect(e("error", #"{}"#) == .finished(.error(status: 502, error: "")))
        #expect(e("mystery", #"{"delta":"x"}"#) == nil)
    }
}

// MARK: - The API client

/// `POST /api/ai/coach` and its verify on the client: the two headers, the
/// stream read as it arrives, every refusal — and never through the offline
/// layer, as the item-share routes.
struct AICoachAPITests {
    private struct Offline: Error {}

    private func client(
        offline: OfflineStore? = nil,
        respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)
    ) -> APIClient {
        APIClient(
            baseURL: URL(string: "https://example.test")!,
            tokens: StaticToken("tok"),
            session: StubProtocol.session(respond),
            offline: offline
        )
    }

    private let request = AICoachRequest(
        context: AICoach.coachContext(.session, .init(eventId: 3, sessionId: 9))!,
        messages: [.init(role: .user, content: AICoach.entry(.session).question)],
        model: "claude-sonnet-5-5"
    )
    private let key = AICoachCredential(provider: "anthropic", key: "sk-ant-secret")

    private func collect(_ stream: AsyncStream<AICoachStreamEvent>) async -> [AICoachStreamEvent] {
        var out: [AICoachStreamEvent] = []
        for await e in stream { out.append(e) }
        return out
    }

    @Test func aDebriefSendsTheHeadersAndBodyAndStreamsTheReply() async throws {
        let seen = Recorder()
        let sse = try Data(contentsOf: RepoRoot.path("contracts/streams/ai-coach.sse"))
        let api = client { request in
            seen.record(request)
            return (200, sse)
        }
        let events = await collect(await api.aiCoach(request, credential: key))
        let sent = try #require(seen.last)
        #expect(sent.httpMethod == "POST")
        #expect(sent.url?.path == "/api/ai/coach")
        #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(sent.value(forHTTPHeaderField: "X-TE-AI-Provider") == "anthropic")
        #expect(sent.value(forHTTPHeaderField: "X-TE-AI-Key") == "sk-ant-secret")
        let body = try JSONSerialization.jsonObject(with: try #require(seen.lastBody)) as? [String: Any]
        #expect((body?["context"] as? [String: Int]) == ["event_id": 3, "session_id": 9])
        #expect((body?["model"] as? String) == "claude-sonnet-5-5")
        #expect((body?["messages"] as? [[String: String]])?.first?["role"] == "user")

        #expect(events.first == .tool(name: "get_session_insights", label: "Analysing the session…"))
        let text = events.compactMap { if case .text(let t) = $0 { t } else { nil } }
        #expect(text.count == 6)
        #expect(events.last == .finished(.done(stop: "end", message: nil)))
    }

    @Test func aFakeProviderSendsNoKeyHeader() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, Data("event: done\ndata: {\"stop\":\"end\",\"model\":\"fake-1\"}\n\n".utf8))
        }
        _ = await collect(await api.aiCoach(request, credential: .init(provider: "fake", key: nil)))
        #expect(seen.last?.value(forHTTPHeaderField: "X-TE-AI-Provider") == "fake")
        #expect(seen.last?.value(forHTTPHeaderField: "X-TE-AI-Key") == nil)
    }

    @Test func everyRefusalEndsTheWayTheWebsDoes() async throws {
        func outcome(_ status: Int, _ body: String) async -> AICoachStreamEvent? {
            let api = client { _ in (status, Data(body.utf8)) }
            return await collect(await api.aiCoach(request, credential: key)).last
        }
        #expect(await outcome(402, #"{"error":"pro required"}"#) == .finished(.paywall))
        #expect(await outcome(401, #"{"error":"unauthorized"}"#) == .finished(.unauthorized))
        #expect(await outcome(424, #"{"error":"provider rejected the key"}"#) == .finished(.error(status: 424, error: "provider rejected the key")))
        #expect(await outcome(429, "not json") == .finished(.error(status: 429, error: "Request failed (429)")))
        // Opened, then failed.
        #expect(await outcome(200, "event: text\ndata: {\"delta\":\"a\"}\n\nevent: error\ndata: {\"error\":\"OpenAI is unavailable\",\"status\":502}\n\n")
            == .finished(.error(status: 502, error: "OpenAI is unavailable")))
        // Cut off: neither done nor error.
        #expect(await outcome(200, "event: text\ndata: {\"delta\":\"a\"}\n\n") == .finished(.error(status: 502, error: AICoach.DROPPED)))
        // Nothing reached the server.
        let offline = client { _ in throw Offline() }
        #expect(await collect(await offline.aiCoach(request, credential: key)).last == .finished(.offline))
    }

    @Test func theAICoachIsNeverQueuedNorCached() async throws {
        for (method, path) in [("POST", "/ai/coach"), ("POST", "/ai/coach/verify")] {
            #expect(!OfflineStore.isQueueable(method: method, path: path), "\(method) \(path)")
        }
        // Offline behind the owner's own queued write: the request fails as
        // offline, nothing joins the queue, and nothing is cached on success.
        let store = try OfflineStore()
        try await store.cachePut("/events", body: try JSONEncoder().encode([Event]()))
        _ = try await store.enqueue(
            method: "POST", path: "/events",
            body: try JSONSerialization.data(withJSONObject: ["track_name": "VIR", "start_date": "2026-05-01"])
        )
        let down = client(offline: store) { _ in throw Offline() }
        #expect(await collect(await down.aiCoach(request, credential: key)).last == .finished(.offline))
        #expect(await down.verifyAICoachKey(provider: "anthropic", key: "k") == .failed(status: 0, error: "Checking a key needs a connection."))
        #expect(try await store.pendingCount() == 1, "only the owner's own event create is queued")

        let fresh = try OfflineStore()
        let up = client(offline: fresh) { request in
            request.url?.path.hasSuffix("/verify") == true
                ? (200, try Goldens.body("ai-coach-verify"))
                : (200, Data("event: done\ndata: {\"stop\":\"end\",\"model\":\"m\"}\n\n".utf8))
        }
        _ = await collect(await up.aiCoach(request, credential: key))
        _ = await up.verifyAICoachKey(provider: "anthropic", key: "k")
        #expect(try await fresh.cachedKeys().isEmpty, "an AI Coach answer must never be cached")
    }

    @Test func verifyReturnsTheModelsOrTheSentenceToShow() async throws {
        let seen = Recorder()
        let ok = client { request in
            seen.record(request)
            return (200, try Goldens.body("ai-coach-verify"))
        }
        guard case .ok(let verify) = await ok.verifyAICoachKey(provider: "anthropic", key: "sk-ant-x") else {
            Issue.record("a 200 is a verified key")
            return
        }
        #expect(seen.last?.url?.path == "/api/ai/coach/verify")
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.value(forHTTPHeaderField: "X-TE-AI-Key") == "sk-ant-x")
        #expect(!verify.models.isEmpty)

        let rejected = client { _ in (424, Data(#"{"error":"provider rejected the key"}"#.utf8)) }
        #expect(await rejected.verifyAICoachKey(provider: "openai", key: "sk-bad")
            == .failed(status: 424, error: "OpenAI rejected the key. Check it in Settings → AI assistants."))
    }

    @Test func aStudentsClientNeverReachesTheAICoach() async throws {
        let seen = Recorder()
        let student = client { request in
            seen.record(request)
            return (200, Data())
        }.scoped(toStudent: 7)
        let events = await collect(await student.aiCoach(request, credential: key))
        #expect(events.count == 1)
        #expect(await student.verifyAICoachKey(provider: "anthropic", key: "k") != .ok(.init(ok: true, provider: "", defaultModel: "", models: [])))
        #expect(seen.last == nil, "nothing reached the transport")
    }
}

/// `contracts/logic/ai-coach.json`.
struct AICoachFixture: Decodable {
    struct Named: Decodable { let id: String; let name: String }
    struct SaveLabel: Decodable { let entry: String; let label: String }
    struct ContextCase: Decodable {
        let entry: String
        let ids: [String: AICoachJSON]
        let context: AICoach.Context?
    }
    struct ErrorCase: Decodable { let status: Int; let error: String; let provider: String; let text: String }
    struct ModelInput: Decodable { let text: String; let model: String? }
    struct Placeholder: Decodable { let defaultModel: String?; let text: String }
    struct BlockJSON: Decodable {
        let type: String
        let lines: [String]?
        let items: [String]?
        let text: String?
        var block: AICoach.Block {
            switch type {
            case "p": .p(lines: lines ?? [])
            case "ul": .ul(items: items ?? [])
            case "ol": .ol(items: items ?? [])
            default: .h(text: text ?? "")
            }
        }
    }
    struct MarkdownCase: Decodable { let text: String; let blocks: [BlockJSON] }
    struct RunJSON: Decodable { let text: String; let bold: Bool }
    struct BoldCase: Decodable { let text: String; let runs: [RunJSON] }
    struct PlainCase: Decodable { let text: String; let plain: String }
    struct Day: Decodable { let year: Int; let month: Int; let day: Int }
    struct LabelCase: Decodable { let date: Day; let label: String }
    struct NotesCase: Decodable { let existing: String?; let reply: String; let date: Day; let notes: String }
    struct EventJSON: Decodable { let event: String; let data: AICoachJSON }
    struct SseCase: Decodable { let chunks: [String]; let events: [EventJSON] }

    let name: String
    let proWhat: String
    let offline: String
    let disclaimer: String
    let providers: [AICoach.Provider]
    let providerNames: [Named]
    let entries: [String: AICoach.EntryInfo]
    let saveLabels: [SaveLabel]
    let contexts: [ContextCase]
    let errorTexts: [ErrorCase]
    let models: [AICoachModel]
    let modelInputs: [ModelInput]
    let placeholders: [Placeholder]
    let markdown: [MarkdownCase]
    let boldRuns: [BoldCase]
    let plainText: [PlainCase]
    let labels: [LabelCase]
    let notes: [NotesCase]
    let sse: [SseCase]

    static func load() throws -> AICoachFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/ai-coach.json"))
        return try JSONDecoder().decode(AICoachFixture.self, from: data)
    }
}
