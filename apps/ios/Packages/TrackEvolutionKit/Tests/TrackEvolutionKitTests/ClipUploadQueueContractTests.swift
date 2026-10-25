import Foundation
import Testing

@testable import TrackEvolutionKit

/// The clip uploader's state machine against `contracts/logic/clip-upload.json`,
/// generated from `public/js/import/clip-upload.js` — the reference both phones'
/// `ClipUploadQueue` ports assert against. Every `nextAction` and `apply` row
/// the phones share is run here; a `webOnly` row (an unreadable source, which a
/// phone's own cut file can't be) is skipped.
struct ClipUploadQueueContractTests {
    @Test func theConstantsMatchTheReference() throws {
        let f = try ClipUploadFixture.load()
        #expect(ClipUploadQueue.BACKOFF_BASE_MS == f.BACKOFF_BASE_MS)
        #expect(ClipUploadQueue.BACKOFF_MAX_MS == f.BACKOFF_MAX_MS)
        #expect(ClipUploadQueue.MAX_RESTARTS == f.MAX_RESTARTS)
        for (name, value) in f.DropReason where name != "sourceUnreadable" {
            let reason = try #require(ClipUploadQueue.DropReason(rawValue: value), "DropReason.\(name)")
            #expect(String(describing: reason) == name)
        }
    }

    @Test func sessionStateMatchesTheReference() throws {
        let f = try ClipUploadFixture.load()
        #expect(!f.sessionState.isEmpty)
        for row in f.sessionState {
            #expect(ClipUploadQueue.sessionState(row.sessionId.value, mapped: row.mapped, queued: row.queued) == row.state.value)
        }
    }

    @Test func backoffAndPartRangesMatchTheReference() throws {
        let f = try ClipUploadFixture.load()
        for row in f.backoffMs { #expect(ClipUploadQueue.backoffMs(row[0]) == row[1], "backoffMs(\(row[0]))") }
        for row in f.partRange {
            let range = ClipUploadQueue.partRange(sizeBytes: row.sizeBytes, partBytes: row.partBytes, parts: row.parts, part: row.part)
            #expect(range.offset == row.offset && range.length == row.length)
        }
    }

    @Test func everyNextActionRowMatchesTheReference() throws {
        let f = try ClipUploadFixture.load()
        #expect(f.nextAction.contains { $0.name == "a job from before lap numbers posts without lap_num" })
        for row in f.nextAction where row.webOnly != true {
            #expect(
                ClipUploadQueue.nextAction(row.job.value, session: row.session.value, nowMs: row.nowMs) == row.action.value,
                Comment(rawValue: row.name)
            )
        }
    }

    @Test func everyApplyRowMatchesTheReference() throws {
        let f = try ClipUploadFixture.load()
        var ran = 0
        for row in f.apply where row.webOnly != true {
            guard let response = row.response.value, let outcome = row.outcome.value else {
                Issue.record("\(row.name): a response or outcome the phones don't have")
                continue
            }
            #expect(
                ClipUploadQueue.apply(row.job.value, row.action.value, response, nowMs: row.nowMs) == outcome,
                Comment(rawValue: row.name)
            )
            ran += 1
        }
        #expect(ran > 20)
    }

    @Test func theCreateBodyCarriesLapNumOnlyWhenTheJobHasOne() throws {
        let f = try ClipUploadFixture.load()
        var checked = 0
        for row in f.nextAction where row.webOnly != true {
            guard case .create(_, let body) = row.action.value, let raw = row.rawBody else { continue }
            let ours = try JSONDecoder().decode([String: Int].self, from: JSONEncoder().encode(body))
            #expect(ours == raw, Comment(rawValue: row.name))
            checked += 1
        }
        #expect(checked >= 3)
    }
}

/// `contracts/logic/clip-upload.json`. Jobs, actions, responses and outcomes are
/// written as the JS objects: camelCase, with a `kind` tag. A temp session id is
/// `"tmp-N"`, read as the Kit's temp id for N (`-N`).
struct ClipUploadFixture: Decodable {
    let BACKOFF_BASE_MS: Int
    let BACKOFF_MAX_MS: Int
    let MAX_RESTARTS: Int
    let DropReason: [String: String]
    let sessionState: [SessionStateRow]
    let backoffMs: [[Int]]
    let partRange: [PartRangeRow]
    let nextAction: [NextActionRow]
    let apply: [ApplyRow]

    static func load() throws -> ClipUploadFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/clip-upload.json"))
        return try JSONDecoder().decode(ClipUploadFixture.self, from: data)
    }

    struct SessionStateRow: Decodable {
        let sessionId: SessionId
        let mapped: Int?
        let queued: Bool
        let state: State
    }

    struct PartRangeRow: Decodable {
        let sizeBytes: Int
        let partBytes: Int
        let parts: Int
        let part: Int
        let offset: Int
        let length: Int
    }

    struct NextActionRow: Decodable {
        let name: String
        let webOnly: Bool?
        let job: Job
        let session: State
        let nowMs: Int
        let action: Action
        /// The create's body exactly as the JS wrote it, to compare keys.
        let rawBody: [String: Int]?

        enum CodingKeys: String, CodingKey { case name, webOnly, job, session, nowMs, action }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            webOnly = try c.decodeIfPresent(Bool.self, forKey: .webOnly)
            job = try c.decode(Job.self, forKey: .job)
            session = try c.decode(State.self, forKey: .session)
            nowMs = try c.decode(Int.self, forKey: .nowMs)
            action = try c.decode(Action.self, forKey: .action)
            rawBody = action.rawBody
        }
    }

    struct ApplyRow: Decodable {
        let name: String
        let webOnly: Bool?
        let job: Job
        let action: Action
        let response: Response
        let nowMs: Int
        let outcome: Outcome
    }

    /// `42` or `"tmp-3"`.
    struct SessionId: Decodable {
        let value: Int

        init(from decoder: any Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let id = try? c.decode(Int.self) {
                value = id
            } else {
                let text = try c.decode(String.self)
                guard text.hasPrefix("tmp-"), let n = Int(text.dropFirst(4)) else {
                    throw DecodingError.dataCorruptedError(in: c, debugDescription: "session id \(text)")
                }
                value = -n
            }
        }
    }

    struct Job: Decodable {
        let value: ClipUploadJob

        private struct Raw: Decodable {
            let id: String
            let sessionId: SessionId
            let timeMs: Int
            let lapNum: Int?
            let sizeBytes: Int
            let durationMs: Int
            let lapOffsetMs: Int
            let clipId: Int?
            let partBytes: Int?
            let parts: Int?
            let uploaded: [Int]
            let failures: Int
            let restarts: Int
            let notBeforeMs: Int?
            let createdAtMs: Int
        }

        init(from decoder: any Decoder) throws {
            let raw = try Raw(from: decoder)
            var job = ClipUploadJob(
                id: raw.id, sessionId: raw.sessionId.value, timeMs: raw.timeMs, lapNum: raw.lapNum,
                file: "\(raw.id).mp4", sizeBytes: raw.sizeBytes, durationMs: raw.durationMs,
                lapOffsetMs: raw.lapOffsetMs, createdAtMs: raw.createdAtMs
            )
            job.clipId = raw.clipId
            job.partBytes = raw.partBytes
            job.parts = raw.parts
            job.uploaded = raw.uploaded
            job.failures = raw.failures
            job.restarts = raw.restarts
            job.notBeforeMs = raw.notBeforeMs
            value = job
        }
    }

    struct State: Decodable {
        let value: ClipUploadQueue.SessionState

        private enum Keys: String, CodingKey { case kind, id }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "real": value = .real(try c.decode(Int.self, forKey: .id))
            case "waiting": value = .waiting
            case "lost": value = .lost
            case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: kind)
            }
        }
    }

    struct Action: Decodable {
        let value: ClipUploadQueue.Action
        let rawBody: [String: Int]?

        private enum Keys: String, CodingKey { case kind, ms, sessionId, body, clipId, part, offset, length, reason }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            var raw: [String: Int]?
            switch try c.decode(String.self, forKey: .kind) {
            case "waitForSession": value = .waitForSession
            case "waitUntil": value = .waitUntil(ms: try c.decode(Int.self, forKey: .ms))
            case "create":
                let body = try c.decode(ClipCreateBody.self, forKey: .body)
                let keys = try c.decode(AnyKeys.self, forKey: .body)
                raw = keys.dictionary
                value = .create(sessionId: try c.decode(Int.self, forKey: .sessionId), body: body)
            case "uploadPart":
                value = .uploadPart(
                    clipId: try c.decode(Int.self, forKey: .clipId), part: try c.decode(Int.self, forKey: .part),
                    offset: try c.decode(Int.self, forKey: .offset), length: try c.decode(Int.self, forKey: .length)
                )
            case "complete": value = .complete(clipId: try c.decode(Int.self, forKey: .clipId))
            case "drop": value = .drop(reason: try Self.reason(c, .reason))
            case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: kind)
            }
            rawBody = raw
        }

        fileprivate static func reason<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws -> ClipUploadQueue.DropReason {
            let text = try c.decode(String.self, forKey: key)
            guard let reason = ClipUploadQueue.DropReason(rawValue: text) else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: text)
            }
            return reason
        }
    }

    /// nil for a response only the web has (`unreadable`).
    struct Response: Decodable {
        let value: ClipUploadQueue.Response?

        private enum Keys: String, CodingKey { case kind, start, missing, status, error }

        private struct Start: Decodable {
            let clipId: Int
            let partBytes: Int
            let parts: Int
            let uploaded: [Int]
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "created":
                let s = try c.decode(Start.self, forKey: .start)
                value = .created(ClipUploadStart(clipId: s.clipId, partBytes: s.partBytes, parts: s.parts, uploaded: s.uploaded))
            case "ok": value = .ok
            case "missingParts": value = .missingParts(try c.decode([Int].self, forKey: .missing))
            case "status":
                value = .status(try c.decode(Int.self, forKey: .status), error: try c.decodeIfPresent(String.self, forKey: .error))
            case "transport": value = .transport
            default: value = nil
            }
        }
    }

    /// nil for an outcome only the web has (a `sourceUnreadable` drop).
    struct Outcome: Decodable {
        let value: ClipUploadQueue.Outcome?

        private enum Keys: String, CodingKey { case kind, job, reason }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "continue": value = .continue(try c.decode(Job.self, forKey: .job).value)
            case "finished": value = .finished
            case "dropped":
                value = ClipUploadQueue.DropReason(rawValue: try c.decode(String.self, forKey: .reason)).map { .dropped($0) }
            case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: kind)
            }
        }
    }

    /// A flat JSON object of numbers, kept whole for comparing keys.
    private struct AnyKeys: Decodable {
        let dictionary: [String: Int]

        private struct Key: CodingKey {
            var stringValue: String
            var intValue: Int? { nil }
            init(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { nil }
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            var out: [String: Int] = [:]
            for key in c.allKeys { out[key.stringValue] = try c.decode(Int.self, forKey: key) }
            dictionary = out
        }
    }
}
