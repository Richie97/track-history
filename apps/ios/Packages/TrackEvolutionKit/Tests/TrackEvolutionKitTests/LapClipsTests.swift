import Foundation
import Testing

@testable import TrackEvolutionKit

/// Best-lap video clips (NS-45): the port of `public/js/import/clip.js`,
/// asserted against `contracts/logic/lap-clips.json` (generated from it) and
/// carrying `test/unit/clip.test.js`'s cases.
struct LapClipsTests {
    // MARK: - The fixture

    @Test func theConstantsMatchTheWebs() throws {
        let f = try LapClipsFixture.load()
        #expect(LapClips.PRE_ROLL_S == f.PRE_ROLL_S)
        #expect(LapClips.POST_ROLL_S == f.POST_ROLL_S)
        #expect(LapClips.MAX_CLIP_S == f.MAX_CLIP_S)
        #expect(LapClips.VIDEO_KINDS.map(\.rawValue) == f.VIDEO_KINDS)
    }

    @Test func everyCaseMatchesTheReference() throws {
        let f = try LapClipsFixture.load()
        #expect(!f.cases.isEmpty)
        for c in f.cases {
            let parsed = c.input.parsed
            let candidate = LapClips.clipCandidate(parsed)
            let name = Comment(rawValue: c.input.name)
            #expect(candidate?.index == c.expected.candidateIndex, name)
            Self.expectWindow(candidate.flatMap { LapClips.clipWindow($0.lap, parsed?.durationS ?? 0) }, c.expected.window.window, name)
            #expect(
                candidate.flatMap { LapClips.estimateClipBytes($0.lap, c.input.fileBytes, c.input.durationS) }
                    == c.expected.estimateBytes,
                name
            )
            #expect(c.expected.windows.count == c.input.laps.count, name)
            for (lap, expected) in zip(parsed?.laps ?? [], c.expected.windows) {
                Self.expectWindow(LapClips.clipWindow(lap, c.input.durationS), expected.window, name)
            }
        }
    }

    @Test func everyOfferMatchesTheReference() throws {
        let f = try LapClipsFixture.load()
        #expect(!f.offers.isEmpty)
        for offer in f.offers {
            let items = offer.items.map { ref in
                let input = f.cases.first { $0.input.name == ref.input }!.input
                return LapClips.Item(parsed: input.parsed, include: ref.include, fileBytes: input.fileBytes)
            }
            #expect(
                LapClips.clipOffer(items, offer.entitlement, offer.clips).rawValue == offer.expected,
                Comment(rawValue: offer.name)
            )
        }
    }

    @Test func theWordsMatchTheReference() throws {
        let f = try LapClipsFixture.load()
        for row in f.offerNote {
            let clips = row.input.map { ClipStorage(usedBytes: 0, quotaBytes: 0, coachCount: $0.coach_count) }
            #expect(LapClips.clipOfferNote(clips) == row.output)
        }
        for row in f.offerText { #expect(LapClips.clipOfferText(row.input) == row.output) }
        for row in f.fullText { #expect(LapClips.clipFullText(row.input) == row.output) }
        for row in f.storageLine { #expect(LapClips.clipStorageLine(row.input) == row.output) }
        for row in f.fmtClipBytes {
            #expect(LapClips.fmtClipBytes(row.input) == row.output, "fmtClipBytes(\(String(describing: row.input)))")
        }
    }

    /// Windows to 1e-9, as the fixture says.
    private static func expectWindow(_ actual: LapClips.Window?, _ expected: LapClips.Window?, _ name: Comment) {
        guard let actual, let expected else {
            #expect(actual == nil && expected == nil, name)
            return
        }
        #expect(abs(actual.startS - expected.startS) < 1e-9, name)
        #expect(abs(actual.endS - expected.endS) < 1e-9, name)
        #expect(abs(actual.lapOffsetS - expected.lapOffsetS) < 1e-9, name)
    }

    // MARK: - test/unit/clip.test.js

    private static func lap(_ timeMs: Int, _ startT: Double?, _ endT: Double?, _ estimated: Bool = false) -> ParsedLap {
        ParsedLap(timeMs: timeMs, estimated: estimated, startT: startT, endT: endT)
    }

    private static let PRO = Entitlement(tier: .pro, source: .apple, expiresAt: 1_800_000_000_000, autoRenew: true)
    private static let FREE = Entitlement(tier: .free)
    private static let GiB = 1024 * 1024 * 1024

    @Test func clipWindowPadsByPreAndPostRoll() {
        #expect(
            LapClips.clipWindow(Self.lap(100_000, 50, 150), 1000)
                == LapClips.Window(startS: 50 - LapClips.PRE_ROLL_S, endS: 150 + LapClips.POST_ROLL_S, lapOffsetS: LapClips.PRE_ROLL_S)
        )
    }

    @Test func clipWindowClampsToTheFileKeepingTheOffsetHonest() {
        #expect(LapClips.clipWindow(Self.lap(99_000, 1, 100), 101) == LapClips.Window(startS: 0, endS: 101, lapOffsetS: 1))
    }

    @Test func clipWindowIsInclusiveAtMaxClipS() {
        #expect(LapClips.clipWindow(Self.lap(600_000, 10, 10 + LapClips.MAX_CLIP_S), 2000) != nil)
        #expect(LapClips.clipWindow(Self.lap(600_001, 10, 10 + LapClips.MAX_CLIP_S + 0.001), 2000) == nil)
    }

    @Test func clipWindowIsNilWithoutAWindowInsideTheFile() {
        #expect(LapClips.clipWindow(Self.lap(1, nil, 10), 100) == nil)
        #expect(LapClips.clipWindow(Self.lap(1, 10, 10), 100) == nil)
        #expect(LapClips.clipWindow(Self.lap(1, 20, 10), 100) == nil)
        #expect(LapClips.clipWindow(Self.lap(1, -1, 10), 100) == nil)
        #expect(LapClips.clipWindow(Self.lap(1, 10, 101), 100) == nil)
        #expect(LapClips.clipWindow(nil, 100) == nil)
    }

    @Test func clipCandidateTakesTheBestWithAWindowTheLowerOnATie() {
        let parsed = ParsedTelemetry(
            kind: .pdr, durationS: 500,
            laps: [Self.lap(101_000, 10, 111), Self.lap(100_000, 111, 211), Self.lap(100_000, 211, 311)]
        )
        #expect(LapClips.clipCandidate(parsed)?.index == 1)
    }

    @Test func clipCandidateSkipsAFasterLapWithNoWindow() {
        let parsed = ParsedTelemetry(kind: .gopro, durationS: 500, laps: [Self.lap(90_000, nil, nil), Self.lap(95_000, 10, 105)])
        #expect(LapClips.clipCandidate(parsed)?.index == 1)
    }

    @Test func clipCandidateKeepsEstimatedLaps() {
        let parsed = ParsedTelemetry(kind: .pdr, durationS: 500, laps: [Self.lap(99_000, 10, 109, true)])
        #expect(LapClips.clipCandidate(parsed)?.index == 0)
    }

    @Test func clipCandidateIsNilForAnythingThatIsntAVideo() {
        for kind in [ParsedTelemetry.Kind.live, .vbo, .trackPrecision] {
            #expect(LapClips.clipCandidate(ParsedTelemetry(kind: kind, durationS: 500, laps: [Self.lap(99_000, 10, 109)])) == nil)
        }
        #expect(LapClips.clipCandidate(nil) == nil)
        #expect(LapClips.clipCandidate(ParsedTelemetry(kind: .gopro, durationS: 500, laps: [])) == nil)
    }

    @Test func estimateClipBytesIsTheFilesBitrateOverTheWindow() {
        #expect(LapClips.estimateClipBytes(Self.lap(100_000, 100, 200), 1_000_000_000, 1000) == 105_000_000)
        #expect(LapClips.estimateClipBytes(Self.lap(100_000, 100, 200), 0, 1000) == nil)
        #expect(LapClips.estimateClipBytes(Self.lap(100_000, nil, 200), 1_000_000_000, 1000) == nil)
    }

    private static func video(_ include: Bool = true) -> LapClips.Item {
        LapClips.Item(
            parsed: ParsedTelemetry(kind: .pdr, durationS: 1000, laps: [lap(100_000, 100, 200)]),
            include: include, fileBytes: 1_000_000_000
        )
    }

    private static let vbo = LapClips.Item(
        parsed: ParsedTelemetry(kind: .vbo, durationS: 1000, laps: [lap(100_000, 100, 200)]), include: true, fileBytes: 10
    )

    private static func storage(used: Int = 0, coaches: Int = 0) -> ClipStorage {
        ClipStorage(usedBytes: used, quotaBytes: 20 * GiB, coachCount: coaches)
    }

    @Test func clipOfferOnForProLockedForFreeAndAbsentWithoutAVideo() {
        #expect(LapClips.clipOffer([Self.video()], Self.PRO, Self.storage()) == .on)
        #expect(LapClips.clipOffer([Self.video()], Self.FREE, Self.storage()) == .locked)
        #expect(LapClips.clipOffer([Self.video()], nil, nil) == .locked)
        #expect(LapClips.clipOffer([Self.vbo], Self.PRO, Self.storage()) == .none)
        #expect(LapClips.clipOffer([Self.video(false), Self.vbo], Self.PRO, Self.storage()) == .none)
        #expect(LapClips.clipOffer([], Self.PRO, Self.storage()) == .none)
    }

    @Test func clipOfferIsFullOnceThisReviewsEstimatesPassTheQuota() {
        #expect(LapClips.clipOffer([Self.video()], Self.PRO, Self.storage(used: 20 * Self.GiB - 105_000_000)) == .on)
        #expect(LapClips.clipOffer([Self.video()], Self.PRO, Self.storage(used: 20 * Self.GiB - 104_999_999)) == .full)
        #expect(LapClips.clipOffer([Self.video(), Self.video()], Self.PRO, Self.storage(used: 20 * Self.GiB - 150_000_000)) == .full)
        #expect(LapClips.clipOffer([Self.video()], Self.PRO, nil) == .on)
    }

    @Test func theRowsWords() {
        #expect(LapClips.clipOfferNote(Self.storage(coaches: 0)) == "")
        #expect(LapClips.clipOfferNote(Self.storage(coaches: 1)) == "Your coaches can watch it too.")
        #expect(LapClips.clipOfferNote(Self.storage(coaches: 4)) == "Your coaches can watch it too.")
        #expect(LapClips.clipOfferNote(nil) == "")
        #expect(
            LapClips.clipOfferText(150 * 1024 * 1024)
                == "A clip of each session's fastest lap, about 150 MB each. Uploads on Wi-Fi."
        )
        #expect(LapClips.clipOfferText(nil) == "A clip of each session's fastest lap. Uploads on Wi-Fi.")
        let clips = ClipStorage(usedBytes: Int((3.2 * Double(Self.GiB)).rounded()), quotaBytes: 20 * Self.GiB, coachCount: 0)
        #expect(LapClips.clipFullText(clips) == "Your lap video storage is full (20 GB). Delete old clips from a lap's page.")
        #expect(LapClips.clipStorageLine(clips) == "Lap videos: 3.2 GB of 20 GB")
        #expect(LapClips.clipStorageLine(nil) == nil)
    }

    @Test func fmtClipBytesInMBBelowAGigabyteAndGBToOneDecimalAbove() {
        #expect(LapClips.fmtClipBytes(0) == "0 MB")
        #expect(LapClips.fmtClipBytes(1) == "1 MB")
        #expect(LapClips.fmtClipBytes(150_000_000) == "143 MB")
        #expect(LapClips.fmtClipBytes(Self.GiB - 1) == "1 GB")
        #expect(LapClips.fmtClipBytes(Self.GiB * 13 / 4) == "3.3 GB")
        #expect(LapClips.fmtClipBytes(20 * Self.GiB) == "20 GB")
    }
}

/// `contracts/logic/lap-clips.json`.
struct LapClipsFixture: Decodable {
    let PRE_ROLL_S: Double
    let POST_ROLL_S: Double
    let MAX_CLIP_S: Double
    let VIDEO_KINDS: [String]
    let cases: [Case]
    let offers: [OfferCase]
    let offerNote: [Row<CoachesOnly?, String>]
    let offerText: [Row<Int?, String>]
    let fullText: [Row<ClipStorage?, String>]
    let storageLine: [Row<ClipStorage?, String?>]
    let fmtClipBytes: [Row<Int?, String>]

    static func load() throws -> LapClipsFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/lap-clips.json"))
        return try JSONDecoder().decode(LapClipsFixture.self, from: data)
    }

    struct Case: Decodable {
        let input: Input
        let expected: Expected
    }

    struct Input: Decodable {
        let name: String
        let kind: String
        let durationS: Double
        let fileBytes: Int
        let laps: [LapIn]

        /// The input as a review holds it. A kind the Kit has no case for would be
        /// nil — the "not a video" answer — but every kind the fixture names exists.
        var parsed: ParsedTelemetry? {
            guard let kind = ParsedTelemetry.Kind(rawValue: kind) else { return nil }
            return ParsedTelemetry(
                kind: kind, durationS: durationS,
                laps: laps.map { ParsedLap(timeMs: $0.timeMs, estimated: $0.estimated, startT: $0.startT, endT: $0.endT) }
            )
        }
    }

    struct LapIn: Decodable {
        let timeMs: Int
        let estimated: Bool
        let startT: Double?
        let endT: Double?
    }

    struct Expected: Decodable {
        let candidateIndex: Int?
        let window: WindowIn?
        let estimateBytes: Int?
        let windows: [WindowIn?]
    }

    struct WindowIn: Decodable {
        let startS: Double
        let endS: Double
        let lapOffsetS: Double
    }

    struct OfferCase: Decodable {
        let name: String
        let items: [ItemRef]
        let entitlement: Entitlement?
        let clips: ClipStorage?
        let expected: String
    }

    /// `offerNote`'s inputs carry only the count.
    struct CoachesOnly: Decodable {
        let coach_count: Int
    }

    struct ItemRef: Decodable {
        let input: String
        let include: Bool
    }

    /// A `[input, output]` pair.
    struct Row<In: Decodable, Out: Decodable>: Decodable {
        let input: In
        let output: Out

        init(from decoder: any Decoder) throws {
            var c = try decoder.unkeyedContainer()
            input = try c.decode(In.self)
            output = try c.decode(Out.self)
        }
    }
}

private extension Optional where Wrapped == LapClipsFixture.WindowIn {
    var window: LapClips.Window? {
        map { LapClips.Window(startS: $0.startS, endS: $0.endS, lapOffsetS: $0.lapOffsetS) }
    }
}
