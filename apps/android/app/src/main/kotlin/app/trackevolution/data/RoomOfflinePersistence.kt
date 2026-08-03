package app.trackevolution.data

import androidx.room.withTransaction
import app.trackevolution.core.offline.OfflinePersistence
import app.trackevolution.core.offline.OfflineTransaction
import app.trackevolution.core.offline.QueuedWrite

/**
 * [OfflinePersistence] backed by SQLite (NS-22's durable half).
 *
 * This class is deliberately thin. The ordering, temp-id rewriting, cascade
 * cancellation and optimistic patching all live in `:core`'s `OfflineStore`,
 * where they unit-test on the JVM in milliseconds; the interface warns against
 * moving the replay algorithm into a DAO and this honours that. Everything here
 * is a table read or a table write.
 *
 * [transaction] maps onto Room's suspend-aware `withTransaction`, so the whole
 * block commits or none of it does — which is the single guarantee the seam
 * exists for. Room installs a transaction element into the coroutine context,
 * so the DAO calls the block makes join that transaction rather than racing it;
 * a block must therefore not move itself to another dispatcher, and must not
 * open a second transaction. Neither is something `OfflineStore` does.
 */
internal class RoomOfflinePersistence(
    private val db: OfflineDatabase,
) : OfflinePersistence {

    private val dao = db.offlineDao()

    override suspend fun <T> transaction(block: suspend (OfflineTransaction) -> T): T =
        db.withTransaction { block(Txn()) }

    private inner class Txn : OfflineTransaction {

        override suspend fun responseGet(path: String): String? = dao.responseGet(path)

        override suspend fun responsePut(path: String, body: String) {
            dao.responsePut(CachedResponseRow(path = path, body = body))
        }

        override suspend fun responseDelete(path: String) {
            dao.responseDelete(path)
        }

        override suspend fun responsePaths(): List<String> = dao.responsePaths()

        override suspend fun queueAll(): List<QueuedWrite> = dao.queueAll().map { it.toWrite() }

        override suspend fun queueAdd(write: QueuedWrite): Long =
            // qid 0 lets SQLite assign the next rowid; the caller gets it back.
            dao.queueAdd(write.toRow(qid = 0))

        override suspend fun queueUpdate(write: QueuedWrite) {
            dao.queueUpdate(write.toRow(qid = write.qid))
        }

        override suspend fun queueDelete(qid: Long) {
            dao.queueDelete(qid)
        }

        override suspend fun queueCount(): Int = dao.queueCount()

        override suspend fun kvGet(key: String): String? = dao.kvGet(key)

        override suspend fun kvPut(key: String, value: String) {
            dao.kvPut(KvRow(key = key, value = value))
        }

        override suspend fun clearAll() {
            dao.clearResponses()
            dao.clearQueue()
            dao.clearKv()
            // The rowid counter is not reset, unlike the in-memory reference.
            // Nothing observes the absolute value — only that qids ascend — and
            // letting it keep climbing means an id can never be reused by a
            // queue entry written after the one that referenced it was dropped.
        }
    }
}

private fun QueuedWriteRow.toWrite() = QueuedWrite(
    qid = qid,
    method = method,
    path = path,
    body = body,
    tempId = tempId,
    attempts = attempts,
)

private fun QueuedWrite.toRow(qid: Long) = QueuedWriteRow(
    qid = qid,
    method = method,
    path = path,
    body = body,
    tempId = tempId,
    attempts = attempts,
)
