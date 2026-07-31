import Foundation
import Testing

@testable import TrackEvolutionKit

/// PKCE and the sign-in request shapes. The server's failure modes are documented
/// in `test/api/native-auth.test.ts`; these pin the client half.
struct AuthTests {
    @Test func challengeMatchesTheRfc7636WorkedExample() {
        // RFC 7636 appendix B, so the base64url-without-padding encoding is pinned
        // against the standard rather than against our own implementation. Getting
        // this wrong yields "401 PKCE verification failed" and nothing else.
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func generatedVerifiersAreUnreservedAndLongEnough() {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        var seen = Set<String>()
        for _ in 0..<50 {
            let pkce = PKCE()
            // RFC 7636 requires 43–128 characters from the unreserved set.
            #expect(pkce.verifier.count >= 43)
            #expect(pkce.verifier.count <= 128)
            #expect(pkce.verifier.allSatisfy { allowed.contains($0) })
            #expect(!pkce.challenge.contains("="), "base64url carries no padding")
            #expect(!pkce.challenge.contains("+") && !pkce.challenge.contains("/"))
            seen.insert(pkce.verifier)
        }
        #expect(seen.count == 50, "verifiers must not repeat")
    }

    // MARK: - Remembered providers
    //
    // The bug these pin: `GET /auth/providers` is fetched with `try?`, so a single
    // failed request used to leave the sign-in screen on its Google-only default —
    // and an account that only exists as an Apple one had no way in until the app
    // was relaunched somewhere with signal.

    /// A scratch suite per test, so these never touch the real defaults and never
    /// leak into each other.
    private func scratchDefaults() -> UserDefaults {
        let suite = "AuthProvidersStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func unknownServerFallsBackToGoogleOnly() {
        let store = AuthProvidersStore(defaults: scratchDefaults())
        let providers = store.providers(for: URL(string: "https://example.test")!)
        #expect(providers.google)
        #expect(!providers.apple, "Apple is never assumed — only ever advertised")
    }

    @Test func aSavedAnswerSurvivesAFailedFetch() {
        let server = URL(string: "https://trackevolution.app")!
        let store = AuthProvidersStore(defaults: scratchDefaults())
        store.save(AuthProviders(google: true, apple: true), for: server)

        // A later launch with no signal never calls `save`, so the stored answer is
        // what the sign-in screen starts from.
        #expect(store.providers(for: server).apple)
    }

    @Test func answersAreKeyedPerServer() {
        let hosted = URL(string: "https://trackevolution.app")!
        let dev = URL(string: "http://localhost:8787")!
        let store = AuthProvidersStore(defaults: scratchDefaults())
        store.save(AuthProviders(google: true, apple: true), for: hosted)

        // `wrangler dev` carries no APPLE_* secrets; the hosted app's answer must not
        // draw an Apple button there.
        #expect(!store.providers(for: dev).apple)
        #expect(store.providers(for: hosted).apple)
    }

    @Test func aServerThatDropsAppleIsBelieved() {
        let server = URL(string: "https://trackevolution.app")!
        let store = AuthProvidersStore(defaults: scratchDefaults())
        store.save(AuthProviders(google: true, apple: true), for: server)
        // Remembering is not pinning: a successful fetch always wins, including one
        // that takes Apple away.
        store.save(AuthProviders(google: true, apple: false), for: server)
        #expect(!store.providers(for: server).apple)
    }

    @Test func signInUrlOpensTheProvidersLoginWithTheChallenge() async {
        let api = APIClient(baseURL: URL(string: "https://example.test")!)
        let google = await api.signInURL(provider: .google, challenge: "abc123")
        #expect(google?.absoluteString == "https://example.test/auth/login?client=app&code_challenge=abc123")

        let apple = await api.signInURL(provider: .apple, challenge: "abc123")
        #expect(
            apple?.absoluteString == "https://example.test/auth/apple/login?client=app&code_challenge=abc123"
        )
    }

    @Test func exchangePostsTheCodeAndVerifierUnderTheServersFieldNames() async throws {
        let seen = Recorder()
        let api = APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: StubProtocol.session { request in
                seen.record(request)
                return (200, Data(#"{"token":"sess_abc"}"#.utf8))
            }
        )

        let token = try await api.exchange(code: "one-time", verifier: "the-verifier")
        #expect(token == "sess_abc")

        let request = try #require(seen.last)
        #expect(request.url?.absoluteString == "https://example.test/auth/exchange")
        #expect(request.httpMethod == "POST")
        let body = try #require(seen.lastBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["code"] as? String == "one-time")
        #expect(json["code_verifier"] as? String == "the-verifier", "snake_case: it's the server's name")
    }

    @Test func anExpiredCodeSurfacesTheServersMessage() async {
        let api = APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: StubProtocol.session { _ in
                (401, Data(#"{"error":"invalid or expired code"}"#.utf8))
            }
        )
        await #expect(throws: APIError.unauthorized("invalid or expired code")) {
            _ = try await api.exchange(code: "stale", verifier: "v")
        }
    }

    @Test func providersDrivesTheAppleButton() async throws {
        let api = APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: StubProtocol.session { _ in
                (200, Data(#"{"google":true,"apple":false}"#.utf8))
            }
        )
        let providers = try await api.authProviders()
        #expect(providers.google)
        #expect(!providers.apple, "Apple is only offered when the server carries the APPLE_* secrets")
    }

    @Test func logoutSendsTheBearerTokenSoTheServerCanRevokeIt() async throws {
        let seen = Recorder()
        let api = APIClient(
            baseURL: URL(string: "https://example.test")!,
            tokens: StaticToken("sess_abc"),
            session: StubProtocol.session { request in
                seen.record(request)
                return (200, Data(#"{"ok":true}"#.utf8))
            }
        )
        try await api.logout()
        #expect(seen.last?.url?.absoluteString == "https://example.test/auth/logout")
        #expect(seen.last?.value(forHTTPHeaderField: "Authorization") == "Bearer sess_abc")
    }
}
