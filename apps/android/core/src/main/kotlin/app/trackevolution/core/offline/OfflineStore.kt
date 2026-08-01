package app.trackevolution.core.offline

import app.trackevolution.core.model.CreatedId
import app.trackevolution.core.model.Event
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * The offline layer: a durable cache of GET `/api` responses plus a persistent
 * queue of writes made while offline, replayed in order once the server is
 * reachable. A port of `public/js/offline.js`.
 *
 * This is not a nice-to-have. A paddock has no usable signal, and the app is used
 * *there*.
 *
 * ## Temp ids: negative integers, not `tmp-N`
 *
 * The web app gives an offline-created row the string id `tmp-3`, because JS
 * doesn't care. Here [Event.id] is an `Int`, pinned by the golden API contract, so
 * a temp row gets a **negative** id instead and [isTemp] is `id < 0`. Real server
 * ids are always positive, the values never reach the server (they're substituted
 * on replay, and an unresolvable one is dropped), and no two clients share this
 * storage — so the representation differs while the behavior doesn't. A `String`
 * id would have meant an untyped id everywhere else. iOS made the same call.
 *
 * ## What is *not* here
 *
 * No sync engine, no CRDTs, no conflict UI. Conflict policy is last-write-wins,
 * which is adequate for a single-user logbook and is the chosen policy rather than
 * a stopping point.
 */
public class OfflineStore(private val db: OfflinePersistence) {

    /** What the sync banner needs to know. */
    public data class SyncStatus(
        /** The last request failed at the network level. */
        val offline: Boolean = false,
        /** Writes waiting to be replayed. */
        val pending: Int = 0,
        /**
         * Writes the server rejected, or that kept failing. Surfaced once, then
         * acknowledged with [clearFailed] — never retried forever.
         */
        val failed: Int = 0,
    )

    /** What the caller gets back instead of the server's answer. */
    public sealed interface QueuedResult {
        /** A create: the temp id the row carries until it flushes. */
        public data class Created(val id: Int) : QueuedResult

        public data object Ok : QueuedResult
    }

    /**
     * How a queued write is sent when the queue flushes. Returns the server's
     * status and body; **throws only when the network failed** — a 4xx is a
     * result, not an exception, and the two are handled very differently.
     */
    public fun interface Sender {
        public suspend fun send(method: String, path: String, body: String?): SendResult
    }

    public data class SendResult(val status: Int, val body: String)

    private val state = MutableStateFlow(SyncStatus())

    /**
     * The sync banner's source. Every enqueue and every flush updates it, so a
     * screen collecting this always agrees with the queue.
     */
    public val syncStatus: StateFlow<SyncStatus> = state.asStateFlow()

    private val loadLock = Mutex()

    /**
     * Held for the length of a flush. `tryLock` rather than `withLock`: two rapid
     * connectivity flaps must not start two replays of the same queue, and the
     * second one has nothing useful to wait for.
     */
    private val flushLock = Mutex()

    @Volatile
    private var loaded = false

    // ---- Lifecycle --------------------------------------------------------

    /**
     * Load the pending count from storage, once.
     *
     * **Load-bearing.** [SyncStatus.pending] is in memory, and everything that
     * moves the queue is gated on it: [flush] would find nothing to do, the banner
     * would say nothing, and a fresh queueable write would be sent *directly*
     * instead of queueing behind the ones already waiting. Without this the queue
     * outlives the process and the count doesn't, so writes made in the paddock
     * sit in the database forever and arrive — if ever — out of order.
     */
    private suspend fun ready() {
        if (loaded) return
        loadLock.withLock {
            if (loaded) return
            val pending = db.transaction { it.queueCount() }
            state.value = state.value.copy(pending = pending)
            loaded = true
        }
    }

    /**
     * Sign-out: a shared device must not retain the previous user's logbook or
     * their unsent writes.
     */
    public suspend fun clear() {
        db.transaction { it.clearAll() }
        state.value = SyncStatus()
        loaded = true
    }

    // ---- Status -----------------------------------------------------------

    public suspend fun pendingCount(): Int {
        ready()
        return state.value.pending
    }

    public fun noteOffline() {
        state.value = state.value.copy(offline = true)
    }

    public fun noteOnline() {
        state.value = state.value.copy(offline = false)
    }

    /** Acknowledge dropped writes, so the banner stops reporting them. */
    public fun clearFailed() {
        state.value = state.value.copy(failed = 0)
    }

    private suspend fun refreshPending() {
        state.value = state.value.copy(pending = db.transaction { it.queueCount() })
    }

    // ---- Temp ids ---------------------------------------------------------

    /** The real id a temp id became, once its create flushed. */
    public suspend fun resolveId(tempId: Int): Int? = db.transaction { idMap(it)[tempId.toString()] }

    private suspend fun idMap(txn: OfflineTransaction): Map<String, Int> {
        val raw = txn.kvGet(KEY_ID_MAP) ?: return emptyMap()
        return runCatching { kvJson.decodeFromString(idMapSerializer, raw) }.getOrDefault(emptyMap())
    }

    private suspend fun putIdMap(txn: OfflineTransaction, map: Map<String, Int>) {
        txn.kvPut(KEY_ID_MAP, kvJson.encodeToString(idMapSerializer, map))
    }

    private suspend fun nextTempId(txn: OfflineTransaction): Int {
        val current = txn.kvGet(KEY_TEMP_SEQ)?.toIntOrNull() ?: 0
        val next = current + 1
        txn.kvPut(KEY_TEMP_SEQ, next.toString())
        return -next
    }

    /** Swap temp segments of a path for the real ids their creates came back with. */
    private fun substituteIds(path: String, map: Map<String, Int>): String =
        path.split("/").joinToString("/") { segment ->
            val id = segment.toIntOrNull()
            if (id != null && isTemp(id)) map[segment]?.toString() ?: segment else segment
        }

    // ---- Response cache ---------------------------------------------------

    public suspend fun cachePut(path: String, body: String) {
        db.transaction { it.responsePut(path, body) }
    }

    public suspend fun removeCached(path: String) {
        db.transaction { it.responseDelete(path) }
    }

    public suspend fun cachedKeys(): List<String> = db.transaction { it.responsePaths() }

    /**
     * A cached response, with one derivation: a track-filtered events list is
     * computed from the cached full list, so a track page works offline even if it
     * was never visited.
     */
    public suspend fun cachedGet(path: String): String? = db.transaction { cachedGet(path, it) }

    private suspend fun cachedGet(path: String, txn: OfflineTransaction): String? {
        txn.responseGet(path)?.let { return it }
        val trackId = trackFilter(path) ?: return null
        val all = txn.responseGet("/events") ?: return null
        val events = runCatching { OfflineJson.decode.decodeFromString(eventListSerializer, all) }
            .getOrNull() ?: return null
        return runCatching {
            OfflineJson.encode.encodeToString(
                eventListSerializer,
                events.filter { it.trackId.toString() == trackId },
            )
        }.getOrNull()
    }

    // ---- Enqueue ----------------------------------------------------------

    /**
     * Queue a mutation, patch the cache so the UI shows it immediately, and hand
     * back the synthetic response — all in one transaction.
     */
    public suspend fun enqueue(method: String, path: String, body: String?): QueuedResult {
        ready()
        val result = db.transaction { txn ->
            // Deleting a row that only exists as a queued create cancels that
            // create — and everything created under it — rather than queueing a
            // DELETE the server could never resolve.
            val target = path.split("/").filter { it.isNotEmpty() }.lastOrNull()?.toIntOrNull()
            if (method == "DELETE" && target != null && isTemp(target)) {
                dropQueuedFor(target, txn)
                applyLocal(QueuedWrite(method = method, path = path, body = body), txn)
                return@transaction QueuedResult.Ok
            }

            val tempId = if (rule(method, path)?.creates == true) nextTempId(txn) else null
            val write = QueuedWrite(method = method, path = path, body = body, tempId = tempId)
            val qid = txn.queueAdd(write)
            applyLocal(write.copy(qid = qid), txn)
            tempId?.let { QueuedResult.Created(it) } ?: QueuedResult.Ok
        }
        refreshPending()
        return result
    }

    /**
     * Re-patch the caches from the queue, after a fresh server response landed
     * while writes are still pending — so queued changes stay visible until the
     * flush lands. [applyLocal] is idempotent: patched rows carry temp ids and are
     * deduped.
     */
    public suspend fun reapplyQueue() {
        db.transaction { txn ->
            for (item in txn.queueAll()) applyLocal(item, txn)
        }
    }

    /**
     * Cancel a queued create and everything queued underneath it, walking
     * transitively: sessions of a temp event, laps of a temp session.
     *
     * Port of `dropQueuedFor` in `offline.js`. The walk repeats until it stops
     * growing because the queue is in insertion order, not dependency order —
     * a lap append can be queued before the session create it depends on is
     * reached.
     *
     * (The JS spells the growth condition `(refs || targets.has(item.tempId)) &&
     * … && !targets.has(item.tempId)`, whose second disjunct can never decide
     * anything. Written here as what it actually does.)
     */
    private suspend fun dropQueuedFor(tempId: Int, txn: OfflineTransaction) {
        val targets = mutableSetOf(tempId)
        var grew = true
        while (grew) {
            grew = false
            for (item in txn.queueAll()) {
                val itemTemp = item.tempId ?: continue
                if (itemTemp in targets) continue
                if (references(item.path, targets)) {
                    targets.add(itemTemp)
                    grew = true
                }
            }
        }
        for (item in txn.queueAll()) {
            val itemTemp = item.tempId
            val doomed = (itemTemp != null && itemTemp in targets) || references(item.path, targets)
            if (doomed) txn.queueDelete(item.qid)
        }
    }

    private fun references(path: String, targets: Set<Int>): Boolean =
        path.split("/").any { segment -> segment.toIntOrNull()?.let { it in targets } == true }

    // ---- Flush ------------------------------------------------------------

    /**
     * Replay the queue in order. Stops — keeping the remainder — on a network
     * failure. Drops what the server rejects (4xx) or what keeps failing (5xx),
     * counting them so the UI can say so.
     *
     * Concurrent calls are a no-op rather than a second replay: ordering is the
     * contract, and two workers interleaving the same queue would break it.
     */
    public suspend fun flush(send: Sender): SyncStatus {
        ready()
        if (!flushLock.tryLock()) return state.value
        try {
            var map = db.transaction { idMap(it) }
            for (item in db.transaction { it.queueAll() }) {
                val path = substituteIds(item.path, map)
                if (isTempPath(path)) {
                    // Depends on a create that failed or was cancelled: unresolvable.
                    db.transaction { it.queueDelete(item.qid) }
                    state.value = state.value.copy(failed = state.value.failed + 1)
                    continue
                }

                val response = try {
                    send.send(item.method, path, item.body)
                } catch (e: CancellationException) {
                    throw e
                } catch (@Suppress("SwallowedException") e: Exception) {
                    // The only thing a throw means here is "no answer" — the sender
                    // contract turns every status into a result. Keep the rest of
                    // the queue for the next kick.
                    noteOffline()
                    break
                }
                noteOnline()

                when {
                    response.status in 200..299 -> {
                        val tempId = item.tempId
                        val createdId = if (tempId != null) createdId(response.body) else null
                        if (tempId != null && createdId != null) {
                            map = map + (tempId.toString() to createdId)
                            db.transaction { putIdMap(it, map) }
                        }
                        db.transaction { it.queueDelete(item.qid) }
                    }

                    response.status >= 500 -> {
                        val retried = item.copy(attempts = item.attempts + 1)
                        if (retried.attempts >= MAX_ATTEMPTS) {
                            db.transaction { it.queueDelete(item.qid) }
                            state.value = state.value.copy(failed = state.value.failed + 1)
                        } else {
                            db.transaction { it.queueUpdate(retried) }
                            // Server trouble rather than a bad request: leave the
                            // rest for the next kick.
                            break
                        }
                    }

                    else -> {
                        db.transaction { it.queueDelete(item.qid) }
                        state.value = state.value.copy(failed = state.value.failed + 1)
                    }
                }
            }
        } finally {
            refreshPending()
            flushLock.unlock()
        }
        return state.value
    }

    /**
     * The id a create came back with.
     *
     * Decoded leniently, unlike every other response in this client: a field the
     * server adds to a create response must not strand a queue that is otherwise
     * replaying fine. Drift in this shape is caught by the golden contract test,
     * which is the right place for it — not in a paddock.
     */
    private fun createdId(body: String): Int? =
        runCatching { lenientJson.decodeFromString(CreatedId.serializer(), body).id }.getOrNull()

    /** Queue contents, for tests and for the sync banner's detail. */
    public suspend fun queuedWrites(): List<QueuedWrite> = db.transaction { it.queueAll() }

    public companion object {
        /** Real server ids are positive; a row the server has never seen is negative. */
        public fun isTemp(id: Int): Boolean = id < 0

        /** Does this path reference a row the server has never seen? */
        public fun isTempPath(path: String): Boolean =
            path.split('/', '?').any { segment -> segment.toIntOrNull()?.let { isTemp(it) } == true }

        /**
         * Only mutations whose effect can be mirrored locally may queue; everything
         * else (vehicles, garage parts, share links — flows that need a real server
         * answer) simply fails offline with its normal error message.
         *
         * Copied from `QUEUEABLE` in `offline.js`. Vehicle and garage-part writes
         * are **deliberately** absent: retiring a part rewrites its neighbours'
         * wear, a new part's expected life is defaulted server-side, and a refresh
         * is a retire-plus-create whose successor id the client cannot invent.
         * Don't "improve" this.
         */
        public fun isQueueable(method: String, path: String): Boolean = rule(method, path) != null

        /**
         * A path shape: literal segments, `*` for any id, `#` for digits. Segment
         * matching rather than regex, matching the iOS port so the two whitelists
         * can be diffed by eye.
         */
        private class Queueable(
            val method: String,
            path: String,
            val creates: Boolean = false,
        ) {
            private val segments = path.split("/").filter { it.isNotEmpty() }

            fun matches(method: String, path: List<String>): Boolean {
                if (method != this.method || path.size != segments.size) return false
                return segments.zip(path).all { (pattern, actual) ->
                    when (pattern) {
                        "*" -> actual.isNotEmpty()
                        "#" -> actual.isNotEmpty() && actual.all { it.isDigit() }
                        else -> pattern == actual
                    }
                }
            }
        }

        private val queueable = listOf(
            Queueable("POST", "/events", creates = true),
            Queueable("PUT", "/events/*"),
            Queueable("DELETE", "/events/*"),
            Queueable("POST", "/events/*/sessions", creates = true),
            Queueable("PUT", "/events/*/setups/#"),
            Queueable("DELETE", "/events/*/setups/#"),
            Queueable("PUT", "/sessions/*"),
            Queueable("DELETE", "/sessions/*"),
            Queueable("POST", "/sessions/*/laps"),
            Queueable("DELETE", "/laps/*"),
            Queueable("PUT", "/tracks/*"),
        )

        private fun rule(method: String, path: String): Queueable? {
            val segments = path.split("/").filter { it.isNotEmpty() }
            return queueable.firstOrNull { it.matches(method, segments) }
        }

        /** `/events?track_id=7` → `"7"`. */
        private fun trackFilter(path: String): String? {
            val prefix = "/events?track_id="
            if (!path.startsWith(prefix)) return null
            val value = path.removePrefix(prefix)
            if (value.isEmpty() || value.contains("&")) return null
            return runCatching { java.net.URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
        }

        /** 5xx retries before a write is given up on and reported as failed. */
        private const val MAX_ATTEMPTS = 5

        private const val KEY_ID_MAP = "idMap"
        private const val KEY_TEMP_SEQ = "tempSeq"

        private val kvJson = Json
        private val lenientJson = Json { ignoreUnknownKeys = true }
        private val idMapSerializer = MapSerializer(String.serializer(), Int.serializer())
        private val eventListSerializer = ListSerializer(Event.serializer())
    }
}
