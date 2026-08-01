package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.AuthProvider
import app.trackevolution.core.api.NoToken
import app.trackevolution.core.api.StaticToken
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * The `/auth` half of the client. The server side of this is already covered by
 * `test/api/native-auth.test.ts`; what these pin is that we speak to it exactly
 * as it expects — the query shape, the body field names, and which requests
 * carry a token.
 */
class AuthClientTest {

    private val recorded = mutableListOf<HttpRequestData>()

    private fun client(
        token: String? = null,
        baseUrl: String = "https://example.test",
        handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): ApiClient {
        val engine = MockEngine { request ->
            recorded += request
            handler(request)
        }
        return ApiClient(engine, baseUrl = baseUrl, tokens = token?.let { StaticToken(it) } ?: NoToken)
    }

    private fun bodyOf(request: HttpRequestData): JsonObject =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    @Test
    fun `the sign-in URL carries client=app and the challenge`() {
        val api = client { respondJson("{}") }
        assertEquals(
            "https://example.test/auth/login?client=app&code_challenge=abc-_123",
            api.signInUrl(AuthProvider.GOOGLE, "abc-_123"),
        )
        assertEquals(
            "https://example.test/auth/apple/login?client=app&code_challenge=abc-_123",
            api.signInUrl(AuthProvider.APPLE, "abc-_123"),
        )
    }

    /** The dev-server override has to reach the sign-in URL too, not just `/api`. */
    @Test
    fun `the sign-in URL follows the server override`() {
        val api = client { respondJson("{}") }
        api.serverUrl = "http://10.0.2.2:8787/"
        assertTrue(api.signInUrl(AuthProvider.GOOGLE, "x").startsWith("http://10.0.2.2:8787/auth/login"))
    }

    @Test
    fun `providers are fetched without a token`() = runTest {
        val api = client(token = "tok") { respondJson("""{"google":true,"apple":false}""") }
        val providers = api.authProviders()
        assertTrue(providers.google)
        assertTrue(!providers.apple)
        assertEquals("https://example.test/auth/providers", recorded.single().url.toString())
        assertNull(
            recorded.single().headers[HttpHeaders.Authorization],
            "the sign-in screen asks this before there is a session",
        )
    }

    @Test
    fun `exchange posts the code and the verifier under the server's field names`() = runTest {
        val api = client { respondJson("""{"token":"sess-1"}""") }
        val token = api.exchange(code = "abc123", verifier = "ver456")
        assertEquals("sess-1", token)

        val request = recorded.single()
        assertEquals("https://example.test/auth/exchange", request.url.toString())
        assertEquals(setOf("code", "code_verifier"), bodyOf(request).keys)
        assertEquals("abc123", bodyOf(request)["code"]!!.toString().trim('"'))
        assertEquals("ver456", bodyOf(request)["code_verifier"]!!.toString().trim('"'))
    }

    /**
     * The code is burned before verification, so a failed exchange can never be
     * retried — the app has to recognise this and restart the whole flow rather
     * than sit on a spinner.
     */
    @Test
    fun `an expired code surfaces the server's message as unauthorized`() = runTest {
        val api = client {
            respondJson("""{"error":"invalid or expired code"}""", HttpStatusCode.Unauthorized)
        }
        val error = assertThrows<ApiException> { api.exchange("stale", "ver") }
        assertTrue(error.isUnauthorized)
        assertEquals("invalid or expired code", error.message)
    }

    @Test
    fun `a mismatched verifier surfaces the PKCE failure`() = runTest {
        val api = client {
            respondJson("""{"error":"PKCE verification failed"}""", HttpStatusCode.Unauthorized)
        }
        val error = assertThrows<ApiException> { api.exchange("code", "wrong") }
        assertEquals("PKCE verification failed", error.message)
    }

    /** Logout is the one `/auth` call that must carry the token — it revokes it. */
    @Test
    fun `logout sends the bearer token`() = runTest {
        val api = client(token = "sess-1") { respondJson("""{"ok":true}""") }
        api.logout()
        assertEquals("https://example.test/auth/logout", recorded.single().url.toString())
        assertEquals("Bearer sess-1", recorded.single().headers[HttpHeaders.Authorization])
    }
}

private fun MockRequestHandleScope.respondJson(
    body: String,
    status: HttpStatusCode = HttpStatusCode.OK,
): HttpResponseData = respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
