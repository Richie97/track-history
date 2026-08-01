package app.trackevolution.core.api

import app.trackevolution.core.model.CatalogTrack
import app.trackevolution.core.model.CreatedId
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.Me
import app.trackevolution.core.model.OkResponse
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.model.SessionPatch
import app.trackevolution.core.model.ShareData
import app.trackevolution.core.model.ShareSlug
import app.trackevolution.core.model.Track
import app.trackevolution.core.model.TrackPatch
import app.trackevolution.core.model.Vehicle
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.takeFrom
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * The HTTP client for the Worker's `/api` surface. One suspend function per
 * endpoint, typed to the models; `public/js/api.js` is the reference for request
 * shaping and error handling.
 *
 * The engine is injected rather than chosen here, which is what keeps `:core` a
 * plain JVM module: `:app` passes OkHttp, tests pass `MockEngine`, and the code
 * under test is the same code that ships.
 *
 * Deliberately not in scope: caching and the offline write queue (NS-22), and
 * obtaining a token (NS-09 — this layer only asks [TokenProvider] for one).
 */
public class ApiClient(
    engine: HttpClientEngine,
    baseUrl: String = DEFAULT_BASE_URL,
    private val tokens: TokenProvider = NoToken,
) {
    private val client = HttpClient(engine) {
        // Non-2xx is mapped by hand below, into the server's own message.
        expectSuccess = false
    }

    /**
     * The instance this client talks to. Mutable so a dev build can be pointed
     * at `wrangler dev` on the LAN from a settings screen, the way the Capacitor
     * shell's server panel could.
     */
    @Volatile
    public var serverUrl: String = normalize(baseUrl)
        set(value) {
            field = normalize(value)
        }

    public fun close(): Unit = client.close()

    // ---- Account ----------------------------------------------------------

    public suspend fun me(): Me = get("/me", Me.serializer())

    /**
     * Replaces the prep-checklist template. An empty list clears it, putting the
     * user back on the client's built-in default rather than leaving them with
     * nothing to start a checklist from — the server treats `[]`, null and an
     * absent key alike (`sanitizeChecklistTemplate`).
     */
    public suspend fun updateChecklistTemplate(items: List<String>) {
        val body = buildJsonObject {
            // Always written, never omitted: the key *is* the request.
            put(
                "checklist_template",
                if (items.isEmpty()) {
                    JsonNull
                } else {
                    buildJsonArray { items.forEach { add(JsonPrimitive(it)) } }
                },
            )
        }
        send("PUT", "/me/checklist-template", body = body, deserializer = OkResponse.serializer())
    }

    // ---- Events -----------------------------------------------------------

    public suspend fun events(trackId: Int? = null): List<Event> = get(
        "/events",
        ListSerializer(Event.serializer()),
        query = trackId?.let { listOf("track_id" to it.toString()) } ?: emptyList(),
    )

    public suspend fun event(id: Int): EventDetail = get("/events/$id", EventDetail.serializer())

    /** Returns the new event's id. */
    public suspend fun createEvent(draft: EventDraft): Int =
        send("POST", "/events", encode(EventDraft.serializer(), draft), CreatedId.serializer()).id

    public suspend fun updateEvent(id: Int, patch: EventPatch) {
        send("PUT", "/events/$id", encode(EventPatch.serializer(), patch), OkResponse.serializer())
    }

    public suspend fun deleteEvent(id: Int) {
        send("DELETE", "/events/$id", null, OkResponse.serializer())
    }

    // ---- Sessions and laps ------------------------------------------------

    /**
     * Returns the new session's id. Laps, trace and channels can all ride along
     * in the same request — this is what the recorder saves (NS-18).
     */
    public suspend fun createSession(eventId: Int, draft: SessionDraft): Int = send(
        "POST",
        "/events/$eventId/sessions",
        encode(SessionDraft.serializer(), draft),
        CreatedId.serializer(),
    ).id

    public suspend fun updateSession(id: Int, patch: SessionPatch) {
        send(
            "PUT",
            "/sessions/$id",
            encode(SessionPatch.serializer(), patch),
            OkResponse.serializer(),
        )
    }

    public suspend fun deleteSession(id: Int) {
        send("DELETE", "/sessions/$id", null, OkResponse.serializer())
    }

    /**
     * Appends laps to an existing session. Lap numbers continue from the last
     * one stored.
     */
    public suspend fun appendLaps(sessionId: Int, laps: List<Int>) {
        val body = buildJsonObject {
            put("laps", buildJsonArray { laps.forEach { add(JsonPrimitive(it)) } })
        }
        send("POST", "/sessions/$sessionId/laps", body, OkResponse.serializer())
    }

    public suspend fun deleteLap(id: Int) {
        send("DELETE", "/laps/$id", null, OkResponse.serializer())
    }

    // ---- Tracks -----------------------------------------------------------

    public suspend fun tracks(): List<Track> = get("/tracks", ListSerializer(Track.serializer()))

    /** The seeded canonical catalog behind the event form's name suggestions. */
    public suspend fun catalog(): List<CatalogTrack> =
        get("/catalog", ListSerializer(CatalogTrack.serializer()))

    public suspend fun updateTrack(id: Int, patch: TrackPatch) {
        send("PUT", "/tracks/$id", encode(TrackPatch.serializer(), patch), OkResponse.serializer())
    }

    public suspend fun deleteTrack(id: Int) {
        send("DELETE", "/tracks/$id", null, OkResponse.serializer())
    }

    // ---- Vehicles ---------------------------------------------------------

    /**
     * The user's vehicles — enough to pre-fill an event's car from the default.
     *
     * The garage proper (`GET /api/garage`, parts, measurements, wear) is a
     * deferred feature on Android, so it has models here but no methods; see
     * `docs/specs/native/README.md`.
     */
    public suspend fun vehicles(): List<Vehicle> =
        get("/vehicles", ListSerializer(Vehicle.serializer()))

    // ---- Sharing ----------------------------------------------------------

    public suspend fun shareSlug(slug: String): String {
        val body = buildJsonObject { put("slug", JsonPrimitive(slug)) }
        return send("PUT", "/share", body, ShareSlug.serializer()).slug
    }

    public suspend fun clearShare() {
        send("DELETE", "/share", null, OkResponse.serializer())
    }

    /** The public share page. Unauthenticated on purpose — no token is sent. */
    public suspend fun sharedLogbook(slug: String): ShareData =
        get("/share/$slug", ShareData.serializer(), authenticated = false)

    // ---- Sign-in (NS-09) --------------------------------------------------
    //
    // These live under /auth rather than /api and are what the sign-in screen
    // drives; obtaining and storing the token is `:app`'s job, since `:core`
    // must not touch the Android keystore.

    /**
     * The sign-in URL to open **in the system browser** (a Custom Tab, never a
     * WebView — Google forbids OAuth in an embedded web view, which is the whole
     * reason this flow exists).
     */
    public fun signInUrl(provider: AuthProvider, challenge: String): String =
        "$serverUrl${provider.loginPath}?client=app&code_challenge=${challenge.urlEncoded()}"

    /** Which providers this server advertises. Unauthenticated. */
    public suspend fun authProviders(): AuthProviders =
        send(
            "GET", "/providers", null, AuthProviders.serializer(),
            authenticated = false, prefix = AUTH_PREFIX,
        )

    /**
     * Trades the one-time code from the `trackevolution://auth` redirect, plus
     * the PKCE verifier, for a bearer token. Do this immediately: the code lives
     * 60 seconds and is burned on first use, so a retry needs a whole new flow.
     */
    public suspend fun exchange(code: String, verifier: String): String =
        send(
            "POST", "/exchange",
            requestJson.encodeToJsonElement(
                ExchangeBody.serializer(),
                ExchangeBody(code = code, code_verifier = verifier),
            ),
            AuthTokenResponse.serializer(),
            // No token yet; the endpoint ignores the header harmlessly.
            authenticated = false, prefix = AUTH_PREFIX,
        ).token

    /**
     * Revokes the session server-side. The caller still has to clear the token
     * and every cached row locally — a shared device must not keep the previous
     * user's logbook.
     */
    public suspend fun logout() {
        send(
            "POST", "/logout", buildJsonObject { }, OkResponse.serializer(),
            authenticated = true, prefix = AUTH_PREFIX,
        )
    }

    // ---- Plumbing ---------------------------------------------------------

    private suspend fun <T> get(
        path: String,
        deserializer: DeserializationStrategy<T>,
        query: List<Pair<String, String>> = emptyList(),
        authenticated: Boolean = true,
    ): T = send("GET", path, null, deserializer, query, authenticated)

    private fun <T> encode(
        serializer: kotlinx.serialization.SerializationStrategy<T>,
        value: T,
    ): JsonElement = requestJson.encodeToJsonElement(serializer, value)

    private suspend fun <T> send(
        method: String,
        path: String,
        body: JsonElement?,
        deserializer: DeserializationStrategy<T>,
        query: List<Pair<String, String>> = emptyList(),
        authenticated: Boolean = true,
        prefix: String = API_PREFIX,
    ): T {
        val (status, text) = rawSend(method, path, body, query, authenticated, prefix)
        if (status !in 200..299) throw ApiException.from(status, text)
        return try {
            responseJson.decodeFromString(deserializer, text)
        } catch (e: SerializationException) {
            throw ApiException.Decoding("$path: ${e.message}", e)
        } catch (e: IllegalArgumentException) {
            // Custom serializers (TracePoint, EventDetail) fault this way.
            throw ApiException.Decoding("$path: ${e.message}", e)
        }
    }

    /**
     * The transport, with no error mapping: throws only when the network failed,
     * and otherwise hands back whatever the server said.
     */
    private suspend fun rawSend(
        method: String,
        path: String,
        body: JsonElement?,
        query: List<Pair<String, String>>,
        authenticated: Boolean,
        prefix: String,
    ): Pair<Int, String> {
        val token = if (authenticated) tokens.currentToken() else null
        val response = try {
            client.request {
                this.method = HttpMethod.parse(method)
                url {
                    takeFrom(serverUrl + prefix + path)
                    query.forEach { (name, value) -> parameters.append(name, value) }
                }
                if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
                if (body != null) {
                    contentType(ContentType.Application.Json)
                    setBody(body.toString())
                }
            }
        } catch (e: Exception) {
            // Ktor surfaces DNS, connect and timeout failures as IOException
            // subclasses; anything that isn't an ApiException already is one of
            // those, and none of them are the server's fault.
            if (e is ApiException) throw e
            throw ApiException.Transport(e.message ?: "Network unavailable", e)
        }
        return response.status.value to response.bodyAsText()
    }

    public companion object {
        /** The hosted instance users are pointed to. */
        public const val DEFAULT_BASE_URL: String = "https://trackevolution.app"

        private const val API_PREFIX = "/api"

        /** Sign-in lives outside the API surface, and outside the offline layer. */
        private const val AUTH_PREFIX = "/auth"

        /** Percent-encoding for a query value, without dragging in a URL builder. */
        private fun String.urlEncoded(): String =
            java.net.URLEncoder.encode(this, "UTF-8")

        /**
         * Strict on purpose (item 7 of NS-05): a field the server adds and this
         * client doesn't model is drift, and drift should fail a test rather
         * than disappear.
         */
        internal val responseJson: Json = Json {
            ignoreUnknownKeys = false
            isLenient = false
        }

        /**
         * Request bodies omit nulls, so a draft's untouched field is simply
         * absent — which is what the server's `?? null` / `"key" in body`
         * handling expects. Patches with a genuine three-state field carry their
         * own serializer (see `Drafts.kt`).
         */
        internal val requestJson: Json = Json {
            explicitNulls = false
            encodeDefaults = false
        }

        /** Trailing slashes would double up when paths are appended. */
        private fun normalize(url: String): String = url.trimEnd('/')
    }
}
