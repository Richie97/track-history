package app.trackevolution.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update

/**
 * The durable half of the offline layer (NS-22).
 *
 * Three tables, mirroring `offline.js`'s three IndexedDB stores and the shape
 * `OfflineTransaction` in `:core` asks for: cached GET bodies keyed by request
 * path, the write queue ordered by an ascending id, and a small key/value area
 * for the temp-id map.
 *
 * **One database, on purpose.** A queued write and the optimistic cache patch
 * that makes it visible have to commit together — the web app cannot do that
 * across two IndexedDB stores and takes the risk; one SQLite database can, and
 * [RoomOfflinePersistence] is where that guarantee is cashed in.
 *
 * **There is no `fallbackToDestructiveMigration`, and that is deliberate.** The
 * cache is disposable — it can be refetched — but the queue is not: it holds
 * sessions recorded in a paddock that exist nowhere else until they replay.
 * Destructive migration would throw those away silently, on an app update, from
 * the one place the user could not have known to look. A future schema change
 * owes this database a real [androidx.room.migration.Migration]; the schema is
 * exported to `app/schemas/` so the change is visible in review.
 */
@Database(
    entities = [CachedResponseRow::class, QueuedWriteRow::class, KvRow::class],
    version = 1,
    exportSchema = true,
)
internal abstract class OfflineDatabase : RoomDatabase() {
    abstract fun offlineDao(): OfflineDao

    companion object {
        fun open(context: Context): OfflineDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                OfflineDatabase::class.java,
                "offline.db",
            ).build()
    }
}

@Entity(tableName = "cached_responses")
internal data class CachedResponseRow(
    @PrimaryKey val path: String,
    val body: String,
)

/**
 * A queued mutation. The row mirrors `QueuedWrite` in `:core` field for field.
 *
 * [body] is stored as raw request JSON rather than a decoded model for the
 * reason given on `QueuedWrite`: a queue that survives an app update must not
 * depend on a model that update might have changed.
 */
@Entity(tableName = "queued_writes")
internal data class QueuedWriteRow(
    @PrimaryKey(autoGenerate = true) val qid: Long = 0,
    val method: String,
    val path: String,
    val body: String?,
    val tempId: Int?,
    val attempts: Int,
)

@Entity(tableName = "kv")
internal data class KvRow(
    @PrimaryKey val key: String,
    val value: String,
)

@Dao
internal interface OfflineDao {

    @Query("SELECT body FROM cached_responses WHERE path = :path")
    suspend fun responseGet(path: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun responsePut(row: CachedResponseRow)

    @Query("DELETE FROM cached_responses WHERE path = :path")
    suspend fun responseDelete(path: String)

    @Query("SELECT path FROM cached_responses")
    suspend fun responsePaths(): List<String>

    /** Insertion order is replay order, and replay order is the contract. */
    @Query("SELECT * FROM queued_writes ORDER BY qid ASC")
    suspend fun queueAll(): List<QueuedWriteRow>

    /** Returns the assigned rowid, which is the [QueuedWriteRow.qid]. */
    @Insert
    suspend fun queueAdd(row: QueuedWriteRow): Long

    /** A no-op when the row is already gone, matching the in-memory reference. */
    @Update
    suspend fun queueUpdate(row: QueuedWriteRow)

    @Query("DELETE FROM queued_writes WHERE qid = :qid")
    suspend fun queueDelete(qid: Long)

    @Query("SELECT COUNT(*) FROM queued_writes")
    suspend fun queueCount(): Int

    @Query("SELECT value FROM kv WHERE key = :key")
    suspend fun kvGet(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun kvPut(row: KvRow)

    @Query("DELETE FROM cached_responses")
    suspend fun clearResponses()

    @Query("DELETE FROM queued_writes")
    suspend fun clearQueue()

    @Query("DELETE FROM kv")
    suspend fun clearKv()
}
