package app.trackevolution.core.offline

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * One queued mutation, waiting to be replayed.
 *
 * [body] is the raw request JSON rather than a decoded model: the queue has to
 * survive an app update that changes a model, and a body it can no longer decode
 * is a write it can no longer send.
 */
public data class QueuedWrite(
    /** Assigned by the store on insert; ordering is by this and nothing else. */
    val qid: Long = 0,
    val method: String,
    val path: String,
    val body: String? = null,
    /**
     * The negative id handed out for a create, so later writes can reference a
     * row the server has never seen. Null for everything else.
     */
    val tempId: Int? = null,
    /** 5xx retries, capped — see [OfflineStore.flush]. */
    val attempts: Int = 0,
)

/**
 * Where the offline cache and queue actually live.
 *
 * The *logic* — ordering, temp-id rewriting, cascade cancellation, the optimistic
 * patches — is [OfflineStore] and [applyLocal], in `:core`, where it unit-tests
 * on the JVM in milliseconds. This interface is the seam beneath it: `:app`
 * implements it with Room, tests use [InMemoryOfflinePersistence], and neither
 * knows anything about the other. Do not move the replay algorithm into a DAO.
 *
 * [transaction] is the only entry point, and that is the point: a queued write
 * and the optimistic cache patch that makes it visible must commit **together**,
 * or the UI can show a change whose queue entry didn't survive (or the reverse).
 * The web app cannot do this across IndexedDB object stores; one SQLite database
 * can, so both native clients take the win.
 *
 * Implementations must be safe to call from any thread, and must not deadlock
 * when [transaction] is called sequentially. Nesting is **not** supported — a
 * block must never open another transaction.
 */
public interface OfflinePersistence {
    public suspend fun <T> transaction(block: suspend (OfflineTransaction) -> T): T
}

/**
 * The storage operations, inside a transaction.
 *
 * Three stores, mirroring `offline.js`: cached response bodies keyed by request
 * path, the write queue keyed by an ascending [QueuedWrite.qid], and a small
 * key/value area for the temp-id map and counter.
 */
public interface OfflineTransaction {
    /** The cached body for a request path, or null. */
    public suspend fun responseGet(path: String): String?

    public suspend fun responsePut(path: String, body: String)

    public suspend fun responseDelete(path: String)

    /** Every cached request path. Used to find the lists a patch has to touch. */
    public suspend fun responsePaths(): List<String>

    /** The queue in insertion order — which is replay order, and is the contract. */
    public suspend fun queueAll(): List<QueuedWrite>

    /** Inserts and returns the assigned [QueuedWrite.qid]. */
    public suspend fun queueAdd(write: QueuedWrite): Long

    public suspend fun queueUpdate(write: QueuedWrite)

    public suspend fun queueDelete(qid: Long)

    public suspend fun queueCount(): Int

    public suspend fun kvGet(key: String): String?

    public suspend fun kvPut(key: String, value: String)

    /** Sign-out: everything goes. */
    public suspend fun clearAll()
}

/**
 * An in-memory [OfflinePersistence], for unit tests and for a client that has no
 * durable store yet.
 *
 * The counterpart of `memBackend()` in `offline.js`, and it exists for the same
 * reason: the queue logic is the part worth testing, and it should be testable
 * without a device, a database file, or a schema migration.
 */
public class InMemoryOfflinePersistence : OfflinePersistence {
    private val lock = Mutex()
    private val responses = LinkedHashMap<String, String>()
    private val queue = LinkedHashMap<Long, QueuedWrite>()
    private val kv = LinkedHashMap<String, String>()
    private var nextQid = 0L

    override suspend fun <T> transaction(block: suspend (OfflineTransaction) -> T): T =
        lock.withLock { block(Txn()) }

    private inner class Txn : OfflineTransaction {
        override suspend fun responseGet(path: String): String? = responses[path]

        override suspend fun responsePut(path: String, body: String) {
            responses[path] = body
        }

        override suspend fun responseDelete(path: String) {
            responses.remove(path)
        }

        override suspend fun responsePaths(): List<String> = responses.keys.toList()

        override suspend fun queueAll(): List<QueuedWrite> = queue.values.sortedBy { it.qid }

        override suspend fun queueAdd(write: QueuedWrite): Long {
            val qid = ++nextQid
            queue[qid] = write.copy(qid = qid)
            return qid
        }

        override suspend fun queueUpdate(write: QueuedWrite) {
            if (queue.containsKey(write.qid)) queue[write.qid] = write
        }

        override suspend fun queueDelete(qid: Long) {
            queue.remove(qid)
        }

        override suspend fun queueCount(): Int = queue.size

        override suspend fun kvGet(key: String): String? = kv[key]

        override suspend fun kvPut(key: String, value: String) {
            kv[key] = value
        }

        override suspend fun clearAll() {
            responses.clear()
            queue.clear()
            kv.clear()
            // The temp-id counter lives in `kv` and is cleared with it; qids
            // restart too, since nothing that referenced them survives.
            nextQid = 0
        }
    }
}
