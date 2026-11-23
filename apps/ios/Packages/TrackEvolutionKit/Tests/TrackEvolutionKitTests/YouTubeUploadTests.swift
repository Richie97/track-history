import Foundation
import Testing

@testable import TrackEvolutionKit

/// Publish a best-lap video to YouTube (NS-46): the JS cases from
/// `test/unit/youtube-client.test.js` ported with the code, agreement with
/// `contracts/logic/youtube.json` — the fixture the Android port asserts
/// against too — and the routes on the API client.
struct YouTubeUploadTests {
    private static let pro = Entitlement(tier: .pro, source: .apple, expiresAt: 1_800_000_000_000, autoRenew: true)
    private static let free = Entitlement(tier: .free)

    private static func me(available: Bool = true, connected: Bool = true) -> YouTubeAccount {
        YouTubeAccount(available: available, connected: connected, account: "a@b.c", channelTitle: nil)
    }

    private static func clip(_ status: String?) -> LapClip {
        LapClip(
            id: 1, durationMs: 1000, lapOffsetMs: 0,
            youtube: status.map { LapClipYouTube(status: $0, privacy: "unlisted") }
        )
    }

    // MARK: - The JS cases

    @Test func offersTheUploadToAConnectedProDriverAndTheConnectStepBeforeThat() {
        #expect(YouTubeUpload.youtubeOffer(Self.clip(nil), Self.pro, Self.me(), false) == .upload)
        #expect(YouTubeUpload.youtubeOffer(Self.clip(nil), Self.pro, Self.me(connected: false), false) == .connect)
    }

    @Test func followsTheUploadsState() {
        #expect(YouTubeUpload.youtubeOffer(Self.clip("queued"), Self.pro, Self.me(), false) == .pending)
        #expect(YouTubeUpload.youtubeOffer(Self.clip("uploading"), Self.pro, Self.me(), false) == .pending)
        #expect(YouTubeUpload.youtubeOffer(Self.clip("done"), Self.pro, Self.me(), false) == .done)
        #expect(YouTubeUpload.youtubeOffer(Self.clip("failed"), Self.pro, Self.me(), false) == .failed)
    }

    @Test func locksStartingOneForAFreeAccountButNeverHidesALinkAlreadyMade() {
        #expect(YouTubeUpload.youtubeOffer(Self.clip(nil), Self.free, Self.me(), false) == .locked)
        #expect(YouTubeUpload.youtubeOffer(Self.clip("failed"), Self.free, Self.me(), false) == .locked)
        #expect(YouTubeUpload.youtubeOffer(Self.clip("done"), Self.free, Self.me(), false) == .done)
        #expect(YouTubeUpload.youtubeOffer(Self.clip("uploading"), Self.free, Self.me(), false) == .pending)
    }

    @Test func drawsNothingWhileTheFeatureIsOffWithNoClipOrForACoach() {
        #expect(YouTubeUpload.youtubeOffer(Self.clip("done"), Self.pro, Self.me(available: false), false) == .none)
        #expect(YouTubeUpload.youtubeOffer(Self.clip(nil), Self.pro, nil, false) == .none)
        #expect(YouTubeUpload.youtubeOffer(nil, Self.pro, Self.me(), false) == .none)
        for status in [nil, "queued", "done", "failed"] {
            #expect(YouTubeUpload.youtubeOffer(Self.clip(status), Self.pro, Self.me(), true) == .none)
        }
    }

    @Test func saysWhereTheUploadIsFlooringThePercentageUnder100() {
        #expect(YouTubeUpload.youtubeStatusLine(status: "queued", progress: 0) == "Waiting to upload to YouTube")
        #expect(YouTubeUpload.youtubeStatusLine(status: "uploading", progress: 0.4) == "Uploading to YouTube · 40%")
        #expect(YouTubeUpload.youtubeStatusLine(status: "uploading", progress: 0.996) == "Uploading to YouTube · 99%")
        #expect(YouTubeUpload.youtubeStatusLine(status: "uploading", progress: 1) == "Uploading to YouTube · 99%")
        #expect(YouTubeUpload.youtubeStatusLine(status: "done", privacy: "public") == "On YouTube · Public")
        #expect(
            YouTubeUpload.youtubeStatusLine(status: "failed", error: "YouTube was disconnected.")
                == "YouTube was disconnected."
        )
        #expect(YouTubeUpload.youtubeStatusLine(status: "failed") == "YouTube didn't accept the upload. Try again.")
        #expect(YouTubeUpload.youtubeStatusLine(YouTubeUpload?.none) == "")
    }

    @Test func letsAWaitingNoteWinOverThePercentage() {
        let note = "Waiting for YouTube — uploads continue tomorrow."
        #expect(YouTubeUpload.youtubeStatusLine(status: "queued", progress: 0, error: note) == note)
        #expect(YouTubeUpload.youtubeStatusLine(status: "uploading", progress: 0.5, error: note) == note)
    }

    @Test func pollsOnlyWhileOnItsWay() {
        #expect(["queued", "uploading", "done", "failed"].map(YouTubeUpload.youtubeIsPending) == [true, true, false, false])
    }

    @Test func namesBothOfGooglesDocumentsInTheConsentTextAndLinksThem() {
        for link in YouTubeUpload.YOUTUBE_LINKS {
            #expect(YouTubeUpload.YOUTUBE_CONNECT_TEXT.contains(link.label))
        }
        #expect(YouTubeUpload.YOUTUBE_CONNECT_TEXT.contains("YouTube API Services"))
        #expect(YouTubeUpload.YOUTUBE_PRIVACY.map(\.value) == ["private", "unlisted", "public"])
    }

    @Test func theTitleIsCountedInCodePoints() {
        #expect(YouTubeUpload.titleLength("VIR 🏁") == 5)
        #expect(YouTubeUpload.titleLength("e\u{301}") == 2)
    }

    @Test func theConnectRedirectsResultIsReadAndAnythingElseIsAnError() {
        #expect(YouTubeUpload.connectResult(URL(string: "trackevolution://youtube?result=connected")!) == "connected")
        #expect(YouTubeUpload.connectResult(URL(string: "trackevolution://youtube?result=denied")!) == "denied")
        #expect(YouTubeUpload.connectResult(URL(string: "trackevolution://youtube?result=pwned")!) == "error")
        #expect(YouTubeUpload.connectResult(URL(string: "trackevolution://youtube")!) == "error")
    }

    // MARK: - The fixture

    private struct Fixture: Decodable {
        struct Choice: Decodable { let value: String; let label: String }
        struct Link: Decodable { let label: String; let url: URL }
        struct Me: Decodable { let youtube: YouTubeAccount? }
        struct Offer: Decodable {
            let name: String
            let clip: LapClip?
            let entitlement: Entitlement?
            let me: Me?
            let readOnly: Bool
            let offer: YouTubeOffer
        }
        struct Upload: Decodable {
            let status: String
            let progress: Double?
            let privacy: String?
            let error: String?
        }
        struct StatusLine: Decodable { let upload: Upload; let line: String; let pending: Bool }
        struct RequestError: Decodable { let message: String; let text: String }
        struct AccountLine: Decodable { let youtube: YouTubeAccount; let line: String }

        let privacy: [Choice]
        let defaultPrivacy: String
        let connectText: String
        let links: [Link]
        let permissionsUrl: URL
        let kidsText: String
        let deleteNote: String
        let disconnectNote: String
        let offline: String
        let resultText: [String: String]
        let offers: [Offer]
        let statusLines: [StatusLine]
        let requestErrors: [RequestError]
        let accountLines: [AccountLine]
    }

    private static func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: RepoRoot.path("contracts/logic/youtube.json")))
    }

    @Test func theFixedWordsMatchTheWeb() throws {
        let f = try Self.fixture()
        #expect(YouTubeUpload.YOUTUBE_PRIVACY.map(\.value) == f.privacy.map(\.value))
        #expect(YouTubeUpload.YOUTUBE_PRIVACY.map(\.label) == f.privacy.map(\.label))
        #expect(YouTubeUpload.YOUTUBE_DEFAULT_PRIVACY == f.defaultPrivacy)
        #expect(YouTubeUpload.YOUTUBE_CONNECT_TEXT == f.connectText)
        #expect(YouTubeUpload.YOUTUBE_LINKS.map(\.label) == f.links.map(\.label))
        #expect(YouTubeUpload.YOUTUBE_LINKS.map(\.url) == f.links.map(\.url))
        #expect(YouTubeUpload.GOOGLE_PERMISSIONS_URL == f.permissionsUrl)
        #expect(YouTubeUpload.YOUTUBE_KIDS_TEXT == f.kidsText)
        #expect(YouTubeUpload.YOUTUBE_DELETE_NOTE == f.deleteNote)
        #expect(YouTubeUpload.YOUTUBE_DISCONNECT_NOTE == f.disconnectNote)
        #expect(YouTubeUpload.YOUTUBE_OFFLINE == f.offline)
        #expect(YouTubeUpload.YOUTUBE_RESULT_TEXT == f.resultText)
    }

    @Test func everyOfferMatchesTheWeb() throws {
        let rows = try Self.fixture().offers
        #expect(rows.count >= 19)
        for row in rows {
            #expect(
                YouTubeUpload.youtubeOffer(row.clip, row.entitlement, row.me?.youtube, row.readOnly) == row.offer,
                "\(row.name)"
            )
        }
    }

    @Test func everyStatusLineMatchesTheWeb() throws {
        for row in try Self.fixture().statusLines {
            let u = row.upload
            #expect(
                YouTubeUpload.youtubeStatusLine(status: u.status, progress: u.progress, privacy: u.privacy, error: u.error)
                    == row.line
            )
            #expect(YouTubeUpload.youtubeIsPending(u.status) == row.pending)
        }
    }

    @Test func everyRefusalAndAccountLineMatchesTheWeb() throws {
        let f = try Self.fixture()
        for row in f.requestErrors { #expect(YouTubeUpload.youtubeRequestError(row.message) == row.text) }
        for row in f.accountLines { #expect(YouTubeUpload.youtubeAccountLine(row.youtube) == row.line) }
    }

    // MARK: - The routes

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

    @Test func connectAsksForATicketAddress() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (200, Data(#"{"url":"https://example.test/youtube/connect?ticket=abc"}"#.utf8))
        }
        #expect(try await api.youTubeConnectURL().absoluteString == "https://example.test/youtube/connect?ticket=abc")
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/youtube/connect")
    }

    @Test func theUploadPostsWhatTheFormApproved() async throws {
        let seen = Recorder()
        let api = client { request in
            seen.record(request)
            return (202, Data(#"{"status":"queued","progress":0,"privacy":"public","url":null,"error":null}"#.utf8))
        }
        let upload = try await api.startYouTubeUpload(
            clipId: 9, YouTubeUploadBody(title: "VIR · 2:01.500", description: "Best lap", privacy: "public")
        )
        #expect(upload.status == "queued")
        #expect(upload.privacy == "public")
        #expect(seen.last?.httpMethod == "POST")
        #expect(seen.last?.url?.path == "/api/clips/9/youtube")
        let body = try #require(seen.lastBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(json == ["title": "VIR · 2:01.500", "description": "Best lap", "privacy": "public"])
    }

    @Test func aRefusalCarriesTheServersWords() async throws {
        let api = client { _ in (429, Data(#"{"error":"youtube upload limit"}"#.utf8)) }
        await #expect(throws: APIError.server(status: 429, message: "youtube upload limit")) {
            _ = try await api.startYouTubeUpload(clipId: 9, YouTubeUploadBody(title: "t", description: "", privacy: "unlisted"))
        }
    }

    @Test func theDraftAndTheStatusAreReadPastTheCache() async throws {
        let store = try OfflineStore()
        let seen = Recorder()
        let api = client(offline: store) { request in
            seen.record(request)
            if request.url?.path.hasSuffix("/draft") == true {
                return (200, try Goldens.body("youtube-draft"))
            }
            return (200, try Goldens.body("youtube-upload"))
        }
        let draft = try await api.youTubeDraft(clipId: 9)
        #expect(draft.privacy == "unlisted")
        #expect(seen.last?.url?.path == "/api/clips/9/youtube/draft")
        let upload = try await api.youTubeUpload(clipId: 9)
        #expect(upload.status == "done")
        #expect(seen.last?.url?.path == "/api/clips/9/youtube")
        #expect(try await store.cachedKeys().isEmpty)
    }

    @Test func nothingIsQueuedOfflineAndDisconnectIsADelete() async throws {
        let store = try OfflineStore()
        let down = client(offline: store) { _ in throw Offline() }
        await #expect(throws: (any Error).self) { try await down.disconnectYouTube() }
        await #expect(throws: (any Error).self) {
            _ = try await down.startYouTubeUpload(clipId: 9, YouTubeUploadBody(title: "t", description: "", privacy: "unlisted"))
        }
        #expect(try await store.pendingCount() == 0)

        let seen = Recorder()
        let up = client { request in
            seen.record(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        try await up.disconnectYouTube()
        #expect(seen.last?.httpMethod == "DELETE")
        #expect(seen.last?.url?.path == "/api/youtube")
    }

    @Test func aCoachsClientRefusesEveryRouteUnsent() async throws {
        let seen = Recorder()
        let student = client { request in
            seen.record(request)
            return (200, Data("{}".utf8))
        }.scoped(toStudent: 7)
        await #expect(throws: APIError.readOnly) { _ = try await student.youTubeConnectURL() }
        await #expect(throws: APIError.readOnly) { try await student.disconnectYouTube() }
        await #expect(throws: APIError.readOnly) { _ = try await student.youTubeDraft(clipId: 9) }
        await #expect(throws: APIError.readOnly) { _ = try await student.youTubeUpload(clipId: 9) }
        await #expect(throws: APIError.readOnly) {
            _ = try await student.startYouTubeUpload(clipId: 9, YouTubeUploadBody(title: "t", description: "", privacy: "unlisted"))
        }
        #expect(seen.last == nil)
    }
}
