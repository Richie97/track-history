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
import app.trackevolution.core.model.TrackLeaderboard
import app.trackevolution.core.model.TrackPatch
import app.trackevolution.core.model.Vehicle
import app.trackevolution.core.model.VehicleDraft
import app.trackevolution.core.model.VehiclePatch
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.MeasurementDraft
import app.trackevolution.core.model.PartDraft
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.PartRefresh
import app.trackevolution.core.model.PartRefreshDraft
import app.trackevolution.core.offline.OfflineJson
import app.trackevolution.core.offline.OfflineStore
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
 * When an [OfflineStore] is supplied this client **is** the offline layer: reads
 * are network-first with a cache fallback and writes on the queueable whitelist
 * are stored and replayed. There is deliberately no second path a screen could
 * take to reach the server, and so none to forget to test.
 *
 * Deliberately not in scope: obtaining a token (NS-09 — this layer only asks
 * [TokenProvider] for one).
 */
public class ApiClient(
    engine: HttpClientEngine,
    baseUrl: String = DEFAULT_BASE_URL,
    private val tokens: TokenProvider = NoToken,
    /**
     * The offline cache and write queue (NS-22). Null talks straight to the
     * server, which is what the contract tests want.
     */
    private val offline: OfflineStore? = null,
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

    // ---- The offline layer (NS-22) ----------------------------------------

    /**
     * What the sync banner collects: how many writes are waiting, how many the
     * server refused, and whether the last request reached it at all. Emits a
     * quiet, never-changing status when there is no offline store.
     */
    public val syncStatus: StateFlow<OfflineStore.SyncStatus>
        get() = offline?.syncStatus ?: noSync

    /**
     * Replay anything queued. Safe to call often — it no-ops on an empty queue,
     * and a second concurrent call is a no-op rather than a second replay.
     */
    public suspend fun flushQueue(): OfflineStore.SyncStatus? {
        val store = offline ?: return null
        if (store.pendingCount() == 0) return store.syncStatus.value
        return store.flush { method, path, body ->
            val (status, text) = rawSend(method, path, body, emptyList(), true, API_PREFIX)
            OfflineStore.SendResult(status, text)
        }
    }

    /** Acknowledge dropped writes, so the banner stops reporting them. */
    public fun clearSyncFailures() {
        offline?.clearFailed()
    }

    /** Sign-out: drop the cached logbook and any unsent writes. */
    public suspend fun clearOffline() {
        offline?.clear()
    }

    /**
     * The real id a row created offline was given, once its create flushed. A
     * screen parked on a temp id follows it here rather than 404ing against the
     * server.
     */
    public suspend fun resolveTempId(id: Int): Int? = offline?.resolveId(id)

    /**
     * Pull every event's detail into the cache, so an event you never opened still
     * reads in the paddock. The counterpart to `public/js/prefetch.js`, and the
     * difference between "offline works" and "offline works for the two events you
     * happened to tap": signal is gone *before* you need the data.
     *
     * Cheap on repeat visits — a row whose cached copy is already at the server's
     * `updated_at` (migration 0011, trigger-maintained) is skipped without a
     * request. Failures are ignored: this is a warm-up, not a load.
     */
    public suspend fun warmCache(events: List<Event>) {
        val store = offline ?: return
        for (row in events) {
            if (OfflineStore.isTemp(row.id)) continue
            val cached = store.cachedGet("/events/${row.id}")?.let { raw ->
                runCatching {
                    OfflineJson.decode.decodeFromString(EventDetail.serializer(), raw)
                }.getOrNull()
            }
            if (cached?.event?.updatedAt == row.updatedAt) continue
            runCatching { event(row.id) }
        }
        // Drop cached details for events deleted elsewhere (another device, the
        // web app) — the list is authoritative for what still exists.
        val live = events.map { it.id.toString() }.toSet()
        for (key in store.cachedKeys()) {
            val id = key.removePrefix("/events/").takeIf { key.startsWith("/events/") } ?: continue
            if (id.contains('/') || id.contains('?')) continue
            val numeric = id.toIntOrNull() ?: continue
            if (!OfflineStore.isTemp(numeric) && id !in live) store.removeCached(key)
        }
    }

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

    /**
     * Toggles the per-track leaderboard opt-in. Deliberately a live write,
     * never queued offline: publishing your name is not something to replay
     * silently later.
     */
    public suspend fun setLeaderboardOptIn(optIn: Boolean) {
        val body = buildJsonObject { put("opt_in", JsonPrimitive(optIn)) }
        send("PUT", "/me/leaderboard", body = body, deserializer = OkResponse.serializer())
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

    /**
     * The per-track community leaderboard: opted-in users' best laps at the
     * same catalog track. `catalogId` null means the catalog doesn't know this
     * track — no cross-user identity, so no leaderboard.
     */
    public suspend fun trackLeaderboard(id: Int): TrackLeaderboard =
        get("/tracks/$id/leaderboard", TrackLeaderboard.serializer())

    public suspend fun updateTrack(id: Int, patch: TrackPatch) {
        send("PUT", "/tracks/$id", encode(TrackPatch.serializer(), patch), OkResponse.serializer())
    }

    public suspend fun deleteTrack(id: Int) {
        send("DELETE", "/tracks/$id", null, OkResponse.serializer())
    }

    // ---- Vehicles ---------------------------------------------------------

    /** The user's vehicles — enough to pre-fill an event's car from the default. */
    public suspend fun vehicles(): List<Vehicle> =
        get("/vehicles", ListSerializer(Vehicle.serializer()))

    public suspend fun createVehicle(draft: VehicleDraft): Vehicle =
        send("POST", "/vehicles", encode(VehicleDraft.serializer(), draft), Vehicle.serializer())

    public suspend fun updateVehicle(id: Int, patch: VehiclePatch) {
        send("PUT", "/vehicles/$id", encode(VehiclePatch.serializer(), patch), OkResponse.serializer())
    }

    /**
     * Deleting a vehicle takes its parts and measurements with it. Events keep
     * the free-text car name they were logged with and simply stop being linked.
     */
    public suspend fun deleteVehicle(id: Int) {
        send("DELETE", "/vehicles/$id", null, OkResponse.serializer())
    }

    // ---- The garage -------------------------------------------------------
    //
    // **The wear math is not ported, and that is deliberate.** `GET /api/garage`
    // arrives with each part's estimate already computed by `src/lib/wear.ts`,
    // so the client only decides how to *say* it. A fifth implementation of a
    // least-squares projection is a fifth thing to keep in step.
    //
    // **These writes stay off the offline queue**, unlike events and laps.
    // Retiring a part rewrites its neighbours' wear, a new part's expected life
    // is defaulted server-side from retired lifecycles, and a refresh is a
    // retire-plus-create whose successor id the client cannot invent. So the
    // garage reads offline from the cache and fails to write, which is the same
    // call iOS and the web app make.

    /** Every vehicle with its accrued hours, parts, measurements and wear. */
    public suspend fun garage(): List<GarageVehicle> =
        get("/garage", ListSerializer(GarageVehicle.serializer()))

    public suspend fun createPart(vehicleId: Int, draft: PartDraft): Int =
        send(
            "POST", "/vehicles/$vehicleId/parts",
            encode(PartDraft.serializer(), draft), CreatedId.serializer(),
        ).id

    public suspend fun updatePart(id: Int, patch: PartPatch) {
        send("PUT", "/parts/$id", encode(PartPatch.serializer(), patch), OkResponse.serializer())
    }

    /**
     * Deletes the part **and its measurements**. Retiring keeps the history;
     * this does not — which is why the UI offers both.
     */
    public suspend fun deletePart(id: Int) {
        send("DELETE", "/parts/$id", null, OkResponse.serializer())
    }

    /**
     * One-tap replacement: retires this part as of the swap date and installs a
     * same-spec successor, so accrued hours reset without re-entering the part.
     */
    public suspend fun refreshPart(id: Int, draft: PartRefreshDraft = PartRefreshDraft()): PartRefresh =
        send(
            "POST", "/parts/$id/refresh",
            encode(PartRefreshDraft.serializer(), draft), PartRefresh.serializer(),
        )

    public suspend fun addMeasurement(partId: Int, draft: MeasurementDraft): Int =
        send(
            "POST", "/parts/$partId/measurements",
            encode(MeasurementDraft.serializer(), draft), CreatedId.serializer(),
        ).id

    public suspend fun deleteMeasurement(partId: Int, id: Int) {
        send("DELETE", "/parts/$partId/measurements/$id", null, OkResponse.serializer())
    }

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
        val text = route(method, path, body?.toString(), query, authenticated, prefix)
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
     * One request, with the offline layer in the middle when there is one.
     * Mirrors `api()` in `public/js/api.js`.
     */
    private suspend fun route(
        method: String,
        path: String,
        body: String?,
        query: List<Pair<String, String>>,
        authenticated: Boolean,
        prefix: String,
    ): String {
        // Sign-in never touches the cache: it has no offline meaning, and a token
        // exchange replayed later would be a burned code.
        val store = offline
        if (store == null || prefix != API_PREFIX) {
            val (status, text) = rawSend(method, path, body, query, authenticated, prefix)
            if (status !in 200..299) throw ApiException.from(status, text)
            return text
        }

        val cacheKey = cacheKey(path, query)
        if (method == "GET") return routeGet(store, path, body, query, authenticated, cacheKey)

        // While writes are queued, a later queueable write has to queue too:
        // sending it directly would reorder it ahead of the queue.
        val queueable = OfflineStore.isQueueable(method, path)
        if (queueable && store.pendingCount() > 0) {
            return synthetic(store.enqueue(method, path, body))
        }

        val (status, text) = try {
            rawSend(method, path, body, query, authenticated, prefix)
        } catch (e: ApiException.Transport) {
            store.noteOffline()
            if (!queueable) throw e
            return synthetic(store.enqueue(method, path, body))
        }
        store.noteOnline()
        if (status !in 200..299) throw ApiException.from(status, text)
        return text
    }

    private suspend fun routeGet(
        store: OfflineStore,
        path: String,
        body: String?,
        query: List<Pair<String, String>>,
        authenticated: Boolean,
        cacheKey: String,
    ): String {
        // A row created offline exists only in the cache: the server would 404 its
        // temp id.
        if (OfflineStore.isTempPath(cacheKey)) {
            store.cachedGet(cacheKey)?.let { return it }
        }

        val (status, text) = try {
            rawSend("GET", path, body, query, authenticated, API_PREFIX)
        } catch (e: ApiException.Transport) {
            // Network gone: a cached copy is better than an error. A *status* from
            // the server is not a network failure and must not fall back.
            store.noteOffline()
            return store.cachedGet(cacheKey) ?: throw e
        }
        store.noteOnline()
        if (status !in 200..299) throw ApiException.from(status, text)

        store.cachePut(cacheKey, text)
        if (store.pendingCount() > 0) {
            // Fresh server state predates the queued writes — re-patch it so they
            // stay visible until the flush lands.
            store.reapplyQueue()
            store.cachedGet(cacheKey)?.let { return it }
        }
        return text
    }

    /** The response a queued write stands in for, in the server's own shape. */
    private fun synthetic(result: OfflineStore.QueuedResult): String = when (result) {
        is OfflineStore.QueuedResult.Created -> """{"id":${result.id}}"""
        OfflineStore.QueuedResult.Ok -> """{"ok":true}"""
    }

    /**
     * The cache is keyed by the path the web app uses, query string included, so
     * `/events?track_id=7` is a distinct entry the store knows how to derive.
     */
    private fun cacheKey(path: String, query: List<Pair<String, String>>): String =
        if (query.isEmpty()) path else path + "?" + query.joinToString("&") { "${it.first}=${it.second}" }

    /**
     * The transport, with no offline behavior and no error mapping: throws only
     * when the network failed, and otherwise hands back whatever the server said.
     */
    private suspend fun rawSend(
        method: String,
        path: String,
        body: String?,
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
                    setBody(body)
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

        /** A never-changing status, for a client with no offline store. */
        private val noSync: StateFlow<OfflineStore.SyncStatus> =
            MutableStateFlow(OfflineStore.SyncStatus())

        /** Trailing slashes would double up when paths are appended. */
        private fun normalize(url: String): String = url.trimEnd('/')
    }
}
