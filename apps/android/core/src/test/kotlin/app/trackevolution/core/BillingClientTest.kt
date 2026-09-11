package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.AuthProvider
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * The `/billing` half of the client and the two things `:app` hangs off it
 * (NS-32 phase C): the `X-TE-Client` header the transitional build identifies
 * itself with, and the request shapes the server's `test/api/billing.test.ts`
 * expects. What the responses decode into is `GoldenContractTest`'s job
 * (`billing-legacy-claim`).
 */
class BillingClientTest {

    private val recorded = mutableListOf<HttpRequestData>()

    private fun client(
        headers: Map<String, String> = mapOf("X-TE-Client" to "android/42"),
        offline: OfflineStore? = null,
        handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): ApiClient {
        val engine = MockEngine { request ->
            recorded += request
            handler(request)
        }
        return ApiClient(
            engine,
            baseUrl = "https://example.test",
            tokens = StaticToken("tok"),
            offline = offline,
            defaultHeaders = headers,
        )
    }

    private fun MockRequestHandleScope.ok(json: String) =
        respond(json, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun bodyOf(request: HttpRequestData) =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    // ---- X-TE-Client -------------------------------------------------------

    @Test
    fun `the default headers ride on every request, api and auth alike`() = runTest {
        val api = client { request ->
            when {
                request.url.encodedPath.endsWith("/providers") -> ok("""{"google":true,"apple":false}""")
                request.url.encodedPath.endsWith("/share/eric") -> ok(Goldens.bodyText("share-public"))
                request.url.encodedPath.endsWith("/logout") -> ok("""{"ok":true}""")
                else -> ok(Goldens.bodyText("me"))
            }
        }
        api.me()
        api.authProviders()
        api.sharedLogbook("eric")
        api.logout()
        assertEquals(4, recorded.size)
        recorded.forEach { request ->
            assertEquals("android/42", request.headers["X-TE-Client"], "${request.url}: header missing")
        }
        // The sign-in URL is opened by the browser, not this client, so the header
        // cannot travel with it — which is exactly why the claim runs from the app
        // on launch rather than from the code exchange.
        assertTrue(api.signInUrl(AuthProvider.GOOGLE, "x").startsWith("https://example.test/auth/login"))
    }

    @Test
    fun `no default headers means no extra headers`() = runTest {
        val api = client(headers = emptyMap()) { ok(Goldens.bodyText("me")) }
        api.me()
        assertEquals(null, recorded.single().headers["X-TE-Client"])
    }

    // ---- The two writes ----------------------------------------------------

    @Test
    fun `a Play purchase posts the token and product id`() = runTest {
        val api = client { ok(Goldens.bodyText("billing-legacy-claim")) }
        val response = api.postGooglePurchase("tok-abc", "app.trackevolution.pro")
        val request = recorded.single()
        assertEquals("POST", request.method.value)
        assertEquals("https://example.test/api/billing/google", request.url.toString())
        assertEquals("Bearer tok", request.headers[HttpHeaders.Authorization])
        val body = bodyOf(request)
        assertEquals("tok-abc", body["purchase_token"]!!.jsonPrimitive.content)
        assertEquals("app.trackevolution.pro", body["product_id"]!!.jsonPrimitive.content)
        assertTrue(response.ok)
        assertTrue(Entitlement.isPro(response.entitlement))
    }

    @Test
    fun `the legacy claim sends no body fields and answers with the entitlement`() = runTest {
        val api = client { ok(Goldens.bodyText("billing-legacy-claim")) }
        val response = api.claimGoogleLegacy()
        val request = recorded.single()
        assertEquals("POST", request.method.value)
        assertEquals("https://example.test/api/billing/google/legacy", request.url.toString())
        assertEquals("android/42", request.headers["X-TE-Client"])
        assertEquals(0, bodyOf(request).size, "the claim carries no body fields")
        assertEquals(Entitlement.Source.LEGACY, response.entitlement.source)
        assertEquals("Pro · lifetime", Entitlement.entitlementSummary(response.entitlement))
    }

    @Test
    fun `a closed claim window is a plain server error the caller can read`() = runTest {
        val api = client {
            respond(
                """{"error":"legacy claim window closed"}""",
                HttpStatusCode.Forbidden,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val error = assertThrows<ApiException> { api.claimGoogleLegacy() }
        assertEquals(403, error.status)
        assertEquals("legacy claim window closed", error.message)
    }

    // ---- 402 ---------------------------------------------------------------

    @Test
    fun `402 is its own case, the way 401 is`() {
        val error = ApiException.from(402, """{"error":"pro required"}""")
        assertTrue(error.isPaymentRequired)
        assertFalse(error.isUnauthorized)
        assertEquals(402, error.status)
        assertEquals("pro required", error.message)
        assertTrue(error is ApiException.PaymentRequired)
        // And 401 is unchanged by it.
        assertTrue(ApiException.from(401, """{"error":"unauthorized"}""").isUnauthorized)
        assertFalse(ApiException.from(409, """{"error":"x"}""").isPaymentRequired)
    }

    // ---- Off the offline queue ---------------------------------------------

    @Test
    fun `billing writes are never queued`() {
        assertFalse(OfflineStore.isQueueable("POST", "/billing/google"))
        assertFalse(OfflineStore.isQueueable("POST", "/billing/google/legacy"))
        assertFalse(OfflineStore.isQueueable("POST", "/billing/apple"))
    }

    @Test
    fun `offline, a purchase post fails with a transport error rather than queueing`() = runTest {
        val store = OfflineStore(InMemoryOfflinePersistence())
        val api = client(offline = store) { throw IOException("no network") }
        val error = assertThrows<ApiException> { api.postGooglePurchase("tok", "app.trackevolution.pro") }
        assertTrue(error is ApiException.Transport)
        assertEquals(0, store.pendingCount(), "a purchase token must not sit in the write queue")
    }
}
