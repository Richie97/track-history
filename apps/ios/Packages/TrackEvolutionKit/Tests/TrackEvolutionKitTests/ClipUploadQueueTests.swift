import Foundation
import Testing

@testable import TrackEvolutionKit

/// The clip uploader's state machine (NS-45). Every row of the transition table
/// on `ClipUploadQueue` is a test here, and Android's `ClipUploadQueueTest` ports
/// them one for one.
struct ClipUploadQueueTests {
    private static let MiB = 1024 * 1024
    private static let now = 1_800_000_000_000

    /// A 120 MiB clip: three parts of 50, 50 and 20 MiB.
    private static func job(sessionId: Int = 42, lapNum: Int? = 4) -> ClipUploadJob {
        ClipUploadJob(
            id: "job-1", sessionId: sessionId, timeMs: 121_345, lapNum: lapNum, file: "job-1.mp4",
            sizeBytes: 120 * MiB, durationMs: 126_400, lapOffsetMs: 3_317, createdAtMs: now
        )
    }

    private static let start = ClipUploadStart(clipId: 7, partBytes: 50 * MiB, parts: 3, uploaded: [])

    /// The job once its create answered.
    private static func started(uploaded: [Int] = []) -> ClipUploadJob {
        guard case .continue(let job) = ClipUploadQueue.apply(
            job(), .create(sessionId: 42, body: job().createBody),
            .created(ClipUploadStart(clipId: 7, partBytes: 50 * MiB, parts: 3, uploaded: uploaded)), nowMs: now
        ) else { fatalError("create should continue") }
        return job
    }

    // MARK: - The session

    @Test func aRealSessionIdIsUsedAsIs() {
        #expect(ClipUploadQueue.sessionState(42, mapped: nil, queued: false) == .real(42))
    }

    @Test func aTempSessionIdWaitsWhileItsCreateIsQueued() {
        #expect(ClipUploadQueue.sessionState(-3, mapped: nil, queued: true) == .waiting)
        #expect(ClipUploadQueue.nextAction(Self.job(sessionId: -3), session: .waiting, nowMs: Self.now) == .waitForSession)
    }

    @Test func aTempSessionIdMapsToTheRealOneOnceFlushed() {
        #expect(ClipUploadQueue.sessionState(-3, mapped: 42, queued: false) == .real(42))
        #expect(
            ClipUploadQueue.nextAction(Self.job(sessionId: -3), session: .real(42), nowMs: Self.now)
                == .create(sessionId: 42, body: Self.job().createBody)
        )
    }

    @Test func aTempSessionTheServerRefusedDropsTheJob() {
        #expect(ClipUploadQueue.sessionState(-3, mapped: nil, queued: false) == .lost)
        #expect(ClipUploadQueue.nextAction(Self.job(sessionId: -3), session: .lost, nowMs: Self.now) == .drop(reason: .sessionLost))
    }

    // MARK: - Create

    @Test func aFreshJobStartsWithTheCreate() {
        let body = Self.job().createBody
        #expect(body == ClipCreateBody(timeMs: 121_345, lapNum: 4, sizeBytes: 120 * Self.MiB, durationMs: 126_400, lapOffsetMs: 3_317))
        #expect(ClipUploadQueue.nextAction(Self.job(), session: .real(42), nowMs: Self.now) == .create(sessionId: 42, body: body))
    }

    @Test func theCreateBodySendsLapNumOnlyWhenTheJobHasOne() throws {
        let withNum = try JSONDecoder().decode([String: Int].self, from: JSONEncoder().encode(Self.job().createBody))
        #expect(withNum == ["time_ms": 121_345, "lap_num": 4, "size_bytes": 120 * Self.MiB, "duration_ms": 126_400, "lap_offset_ms": 3_317])
        let old = try JSONDecoder().decode([String: Int].self, from: JSONEncoder().encode(Self.job(lapNum: nil).createBody))
        #expect(old == ["time_ms": 121_345, "size_bytes": 120 * Self.MiB, "duration_ms": 126_400, "lap_offset_ms": 3_317])
    }

    @Test func theCreateAnswerSetsUpThePartsAndTheFirstPartFollows() {
        let job = Self.started()
        #expect(job.clipId == 7)
        #expect(job.partBytes == 50 * Self.MiB)
        #expect(job.parts == 3)
        #expect(job.uploaded == [])
        #expect(
            ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now)
                == .uploadPart(clipId: 7, part: 1, offset: 0, length: 50 * Self.MiB)
        )
    }

    @Test func aResumedCreatePicksUpAfterThePartsTheServerHolds() {
        let job = Self.started(uploaded: [2, 1, 9])
        #expect(job.uploaded == [1, 2], "a part number past the count is ignored")
        #expect(
            ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now)
                == .uploadPart(clipId: 7, part: 3, offset: 100 * Self.MiB, length: 20 * Self.MiB)
        )
    }

    @Test func storageFullAndAlreadyHasAClipDropTheJob() {
        let create = ClipUploadQueue.Action.create(sessionId: 42, body: Self.job().createBody)
        #expect(
            ClipUploadQueue.apply(Self.job(), create, .status(409, error: "clip storage full"), nowMs: Self.now)
                == .dropped(.storageFull)
        )
        #expect(
            ClipUploadQueue.apply(Self.job(), create, .status(409, error: "lap already has a clip"), nowMs: Self.now)
                == .dropped(.alreadyHasClip)
        )
    }

    @Test func aCreateRefusedForAnyOtherReasonDropsTheJob() {
        let create = ClipUploadQueue.Action.create(sessionId: 42, body: Self.job().createBody)
        #expect(ClipUploadQueue.apply(Self.job(), create, .status(402, error: "pro required"), nowMs: Self.now) == .dropped(.proRequired))
        #expect(ClipUploadQueue.apply(Self.job(), create, .status(404, error: "not found"), nowMs: Self.now) == .dropped(.notFound))
        #expect(ClipUploadQueue.apply(Self.job(), create, .status(400, error: "clip too long"), nowMs: Self.now) == .dropped(.refused))
    }

    // MARK: - Parts

    @Test func aPartUploadedMovesToTheNext() {
        let action = ClipUploadQueue.Action.uploadPart(clipId: 7, part: 1, offset: 0, length: 50 * Self.MiB)
        guard case .continue(let job) = ClipUploadQueue.apply(Self.started(), action, .ok, nowMs: Self.now) else {
            Issue.record("should continue")
            return
        }
        #expect(job.uploaded == [1])
        #expect(
            ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now)
                == .uploadPart(clipId: 7, part: 2, offset: 50 * Self.MiB, length: 50 * Self.MiB)
        )
    }

    @Test func everyPartHeldMeansComplete() {
        #expect(ClipUploadQueue.nextAction(Self.started(uploaded: [1, 2, 3]), session: .real(42), nowMs: Self.now) == .complete(clipId: 7))
    }

    @Test func aPartRefusedBecauseTheClipIsAlreadyReadyGoesToComplete() {
        let action = ClipUploadQueue.Action.uploadPart(clipId: 7, part: 1, offset: 0, length: 50 * Self.MiB)
        guard case .continue(let job) = ClipUploadQueue.apply(
            Self.started(), action, .status(409, error: "clip already uploaded"), nowMs: Self.now
        ) else {
            Issue.record("should continue")
            return
        }
        #expect(ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now) == .complete(clipId: 7))
    }

    @Test func aPartOfTheWrongSizeDropsTheJob() {
        let action = ClipUploadQueue.Action.uploadPart(clipId: 7, part: 1, offset: 0, length: 50 * Self.MiB)
        #expect(ClipUploadQueue.apply(Self.started(), action, .status(400, error: "part 1 must be …"), nowMs: Self.now) == .dropped(.refused))
        #expect(ClipUploadQueue.apply(Self.started(), action, .status(411, error: nil), nowMs: Self.now) == .dropped(.refused))
    }

    @Test func aPartTheServerLostRestartsFromTheCreateAndGivesUpEventually() {
        let action = ClipUploadQueue.Action.uploadPart(clipId: 7, part: 2, offset: 50 * Self.MiB, length: 50 * Self.MiB)
        var job = Self.started(uploaded: [1])
        for restart in 1...ClipUploadQueue.MAX_RESTARTS {
            guard case .continue(let next) = ClipUploadQueue.apply(job, action, .status(404, error: "not found"), nowMs: Self.now) else {
                Issue.record("restart \(restart) should continue")
                return
            }
            #expect(next.clipId == nil && next.uploaded.isEmpty && next.restarts == restart)
            #expect(ClipUploadQueue.nextAction(next, session: .real(42), nowMs: Self.now) == .create(sessionId: 42, body: next.createBody))
            job = next
            job.clipId = 7
            job.partBytes = 50 * Self.MiB
            job.parts = 3
        }
        #expect(ClipUploadQueue.apply(job, action, .status(404, error: "not found"), nowMs: Self.now) == .dropped(.tooManyRestarts))
    }

    // MARK: - Complete

    @Test func completeFinishesTheJob() {
        #expect(ClipUploadQueue.apply(Self.started(uploaded: [1, 2, 3]), .complete(clipId: 7), .ok, nowMs: Self.now) == .finished)
    }

    @Test func completeMissingPartsSendsExactlyThoseAgain() {
        guard case .continue(let job) = ClipUploadQueue.apply(
            Self.started(uploaded: [1, 2, 3]), .complete(clipId: 7), .missingParts([2]), nowMs: Self.now
        ) else {
            Issue.record("should continue")
            return
        }
        #expect(job.uploaded == [1, 3])
        #expect(
            ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now)
                == .uploadPart(clipId: 7, part: 2, offset: 50 * Self.MiB, length: 50 * Self.MiB)
        )
    }

    @Test func completeOnALostUploadRestarts() {
        guard case .continue(let job) = ClipUploadQueue.apply(
            Self.started(uploaded: [1, 2, 3]), .complete(clipId: 7), .status(404, error: "not found"), nowMs: Self.now
        ) else {
            Issue.record("should continue")
            return
        }
        #expect(job.clipId == nil && job.restarts == 1)
    }

    // MARK: - Backoff

    @Test func transportFailuresAndServerErrorsBackOffAndNeverDrop() {
        let action = ClipUploadQueue.Action.uploadPart(clipId: 7, part: 1, offset: 0, length: 50 * Self.MiB)
        var job = Self.started()
        var waits: [Int] = []
        for response in [ClipUploadQueue.Response.transport, .status(503, error: nil), .status(429, error: nil), .status(401, error: nil), .transport] {
            guard case .continue(let next) = ClipUploadQueue.apply(job, action, response, nowMs: Self.now) else {
                Issue.record("\(response) should continue")
                return
            }
            waits.append(next.notBeforeMs! - Self.now)
            job = next
        }
        #expect(waits == [30_000, 60_000, 120_000, 240_000, 480_000])
        #expect(ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now) == .waitUntil(ms: Self.now + 480_000))
        #expect(
            ClipUploadQueue.nextAction(job, session: .real(42), nowMs: Self.now + 480_000)
                == .uploadPart(clipId: 7, part: 1, offset: 0, length: 50 * Self.MiB)
        )
        guard case .continue(let recovered) = ClipUploadQueue.apply(job, action, .ok, nowMs: Self.now + 480_000) else {
            Issue.record("should continue")
            return
        }
        #expect(recovered.failures == 0 && recovered.notBeforeMs == nil)
    }

    @Test func theBackoffIsCappedAtAnHour() {
        #expect(ClipUploadQueue.backoffMs(0) == 0)
        #expect(ClipUploadQueue.backoffMs(1) == 30_000)
        #expect(ClipUploadQueue.backoffMs(8) == 3_600_000)
        #expect(ClipUploadQueue.backoffMs(500) == 3_600_000)
    }

    @Test func aTempSessionWaitsEvenDuringABackoff() {
        var job = Self.job(sessionId: -3)
        job.notBeforeMs = Self.now + 10_000
        #expect(ClipUploadQueue.nextAction(job, session: .waiting, nowMs: Self.now) == .waitForSession)
    }

    // MARK: - Part geometry

    @Test func partRangesMatchTheServersPartSize() {
        let size = 120 * Self.MiB, part = 50 * Self.MiB
        #expect(ClipUploadQueue.partRange(sizeBytes: size, partBytes: part, parts: 3, part: 1) == (0, part))
        #expect(ClipUploadQueue.partRange(sizeBytes: size, partBytes: part, parts: 3, part: 3) == (100 * Self.MiB, 20 * Self.MiB))
        // A clip smaller than a part is one part of its own size.
        #expect(ClipUploadQueue.partRange(sizeBytes: 2048, partBytes: part, parts: 1, part: 1) == (0, 2048))
    }

    // MARK: - The lap page

    @Test func aJobIsForTheLapOnEitherItsTempOrItsRealSessionId() {
        func isFor(_ jobSession: Int, _ jobTime: Int, _ sessionId: Int, _ resolved: Int?, _ timeMs: Int) -> Bool {
            ClipUploadQueue.isFor(
                sessionId: jobSession, timeMs: jobTime, lapNum: 2,
                sessionId: sessionId, resolved: resolved, timeMs: timeMs, lapNum: 2, isClipLap: false
            )
        }
        #expect(isFor(-3, 100, -3, nil, 100))
        #expect(isFor(-3, 100, 42, 42, 100))
        #expect(!isFor(-3, 100, 42, nil, 100))
        #expect(!isFor(42, 100, 42, nil, 101))
    }

    /// NS-50: a session saving every lap has a job per lap, so the lap number
    /// decides — two laps tied on time each find their own.
    @Test func aJobWithALapNumberIsForThatLapOnly() {
        func isFor(job jobLap: Int?, lap lapNum: Int, isClipLap: Bool) -> Bool {
            ClipUploadQueue.isFor(
                sessionId: 42, timeMs: 100, lapNum: jobLap,
                sessionId: 42, resolved: nil, timeMs: 100, lapNum: lapNum, isClipLap: isClipLap
            )
        }
        #expect(isFor(job: 3, lap: 3, isClipLap: false))
        #expect(!isFor(job: 3, lap: 2, isClipLap: true))
        // A job from before lap numbers: the time alone, on the lap the server
        // attached it to.
        #expect(isFor(job: nil, lap: 2, isClipLap: true))
        #expect(!isFor(job: nil, lap: 3, isClipLap: false))
    }

    @Test func theClipLandsOnTheLowestLapNumberWithItsTime() {
        let laps = [
            Lap(id: 1, sessionId: 42, lapNum: 1, timeMs: 101_000),
            Lap(id: 3, sessionId: 42, lapNum: 3, timeMs: 100_000),
            Lap(id: 2, sessionId: 42, lapNum: 2, timeMs: 100_000),
        ]
        #expect(ClipUploadQueue.clipLap(laps, timeMs: 100_000)?.id == 2)
        #expect(ClipUploadQueue.clipLap(laps, timeMs: 99_000) == nil)
        // With a lap number, that lap — the second of two tied laps included.
        #expect(ClipUploadQueue.clipLap(laps, timeMs: 100_000, lapNum: 3)?.id == 3)
        #expect(ClipUploadQueue.clipLap(laps, timeMs: 101_000, lapNum: 3) == nil, "a number whose time doesn't match lands nowhere")
    }

    @Test func theManifestRoundTripsInSnakeCase() throws {
        var job = Self.started(uploaded: [1])
        job.notBeforeMs = Self.now
        let manifest = ClipUploadManifest(jobs: [job], failedCuts: [.init(sessionId: -3, timeMs: 99_000, lapNum: 5)])
        let data = try JSONEncoder().encode(manifest)
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains("\"session_id\":42") && json.contains("\"failed_cuts\"") && json.contains("\"part_bytes\""))
        #expect(json.contains("\"lap_num\":4") && json.contains("\"lap_num\":5"))
        #expect(try JSONDecoder().decode(ClipUploadManifest.self, from: data) == manifest)
    }

    /// A manifest written before NS-50 has no `lap_num`: its jobs still load,
    /// and post without one.
    @Test func aJobFromBeforeLapNumbersStillLoads() throws {
        let old = Data((
            #"{"jobs":[{"id":"job-1","session_id":42,"time_ms":121345,"file":"job-1.mp4","size_bytes":10,"#
                + #""duration_ms":126400,"lap_offset_ms":3317,"uploaded":[],"failures":0,"restarts":0,"created_at_ms":1}],"#
                + #""failed_cuts":[{"session_id":42,"time_ms":121345}]}"#
        ).utf8)
        let manifest = try JSONDecoder().decode(ClipUploadManifest.self, from: old)
        let job = try #require(manifest.jobs.first)
        #expect(job.lapNum == nil)
        #expect(job.createBody.lapNum == nil)
        #expect(manifest.failedCuts.first?.lapNum == nil)
    }

    @Test func aFailedUploadKeepsItsReasonAndAnOldManifestStillReads() throws {
        let manifest = ClipUploadManifest(failedCuts: [
            .init(sessionId: 7, timeMs: 1, reason: ClipUploadQueue.DropReason.storageFull.rawValue),
        ])
        let data = try JSONEncoder().encode(manifest)
        #expect(try JSONDecoder().decode(ClipUploadManifest.self, from: data) == manifest)
        let old = Data(#"{"jobs":[],"failed_cuts":[{"session_id":7,"time_ms":1}]}"#.utf8)
        let decoded = try JSONDecoder().decode(ClipUploadManifest.self, from: old)
        #expect(decoded.failedCuts == [.init(sessionId: 7, timeMs: 1)])
    }
}
