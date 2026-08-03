package app.trackevolution.data

import androidx.test.core.app.ApplicationProvider
import app.trackevolution.core.offline.OfflineStore
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException

/**
 * The durability half of NS-22, against real SQLite.
 *
 * `OfflineStoreTest` in `:core` already proves the queue *logic* reloads, but it
 * proves it by handing a second `OfflineStore` the same in-memory map — which
 * demonstrates that the store re-reads its storage, and nothing whatsoever about
 * whether the storage survives the process. That was the gap left open on the
 * NS-22 issue, and it is the gap that matters: the writes in this queue are lap
 * sessions recorded in a paddock that exist nowhere else.
 *
 * So these tests close the database and open it again from its file, which is
 * the closest a JVM test gets to the app being killed. Robolectric supplies a
 * real SQLite rather than an emulator, so this runs in CI in seconds.
 */
@RunWith(RobolectricTestRunner::class)
class RoomOfflinePersistenceTest {

    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()

    private var db = OfflineDatabase.open(context)

    private fun store() = OfflineStore(RoomOfflinePersistence(db))

    /** Kill the process, come back to whatever SQLite actually kept. */
    private fun reopen() {
        db.close()
        db = OfflineDatabase.open(context)
    }

    @After
    fun tearDown() {
        db.close()
        context.deleteDatabase("offline.db")
    }

    private fun ok(id: Int? = null) =
        OfflineStore.SendResult(200, if (id != null) """{"id":$id}""" else "{}")

    // ---- durability -------------------------------------------------------

    @Test
    fun `the queue survives the process that made it`() = runTest {
        val created = store().enqueue(
            "POST", "/events",
            """{"track_name":"X","start_date":"2026-05-01"}""",
        ) as OfflineStore.QueuedResult.Created
        store().enqueue("POST", "/events/${created.id}/sessions", """{"laps":[121000]}""")

        reopen()

        val after = store()
        assertEquals(2, after.pendingCount())

        val sent = mutableListOf<String>()
        after.flush { method, path, _ ->
            sent += "$method $path"
            ok(id = if (sent.size == 1) 42 else 43)
        }
        // The temp id was resolved from the map SQLite kept, not from memory.
        assertEquals(listOf("POST /events", "POST /events/42/sessions"), sent)
        assertEquals(0, after.pendingCount())
    }

    @Test
    fun `replay resumes where it stopped after process death mid-queue`() = runTest {
        val before = store()
        before.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")
        before.enqueue("PUT", "/tracks/4", """{"goal_ms":2}""")
        before.enqueue("PUT", "/tracks/5", """{"goal_ms":3}""")

        var calls = 0
        before.flush { _, _, _ ->
            if (++calls == 2) throw IOException("network gone")
            ok()
        }

        reopen()

        val after = store()
        assertEquals(2, after.pendingCount())
        val sent = mutableListOf<String>()
        after.flush { _, path, _ ->
            sent += path
            ok()
        }
        assertEquals(listOf("/tracks/4", "/tracks/5"), sent)
    }

    @Test
    fun `the cache survives too, so the logbook reads offline after a restart`() = runTest {
        store().cachePut("/events", """[{"id":1,"track_name":"X"}]""")

        reopen()

        assertEquals("""[{"id":1,"track_name":"X"}]""", store().cachedGet("/events"))
    }

    @Test
    fun `sign-out leaves nothing behind, including after a restart`() = runTest {
        val store = store()
        store.cachePut("/events", "[]")
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")
        store.clear()

        reopen()

        val after = store()
        assertEquals(0, after.pendingCount())
        assertNull(after.cachedGet("/events"))
        assertTrue(after.cachedKeys().isEmpty())
    }

    // ---- the transaction guarantee ----------------------------------------

    @Test
    fun `a queued write and its cache patch commit together or not at all`() = runTest {
        val persistence = RoomOfflinePersistence(db)
        persistence.transaction { it.responsePut("/events", "[]") }

        // The single guarantee this seam exists for: the web app cannot make a
        // queue insert and its optimistic cache patch atomic across two
        // IndexedDB stores, and one SQLite database can.
        runCatching {
            persistence.transaction { txn ->
                txn.responsePut("/events", """[{"id":-1}]""")
                txn.queueAdd(
                    app.trackevolution.core.offline.QueuedWrite(
                        method = "POST",
                        path = "/events",
                        body = "{}",
                        tempId = -1,
                    ),
                )
                // Both halves really did land before the failure — without this
                // the rollback assertions below would also pass if the writes
                // had simply never run.
                assertEquals("""[{"id":-1}]""", txn.responseGet("/events"))
                assertEquals(1, txn.queueCount())
                throw IOException("died mid-write")
            }
        }

        persistence.transaction { txn ->
            // Neither half landed. A patched cache with no queue entry behind it
            // would show the user a change that is never going to be sent.
            assertEquals("[]", txn.responseGet("/events"))
            assertEquals(0, txn.queueCount())
        }
    }

    // ---- contract parity with the in-memory reference ---------------------

    @Test
    fun `queueAdd hands back ascending ids, which is replay order`() = runTest {
        val persistence = RoomOfflinePersistence(db)
        val ids = persistence.transaction { txn ->
            (1..3).map { n ->
                txn.queueAdd(
                    app.trackevolution.core.offline.QueuedWrite(
                        method = "PUT",
                        path = "/tracks/$n",
                        body = "{}",
                    ),
                )
            }
        }

        assertEquals(ids.sorted(), ids)
        assertEquals(ids.distinct(), ids)
        assertEquals(
            listOf("/tracks/1", "/tracks/2", "/tracks/3"),
            persistence.transaction { it.queueAll() }.map { row -> row.path },
        )
    }

    @Test
    fun `queueUpdate on a row that is already gone is a no-op, not an insert`() = runTest {
        val persistence = RoomOfflinePersistence(db)
        // `@Update` matches by primary key, where the in-memory reference does an
        // explicit containsKey check. Same observable behaviour; asserted because
        // the two implementations reach it differently.
        persistence.transaction { txn ->
            txn.queueUpdate(
                app.trackevolution.core.offline.QueuedWrite(
                    qid = 99,
                    method = "PUT",
                    path = "/tracks/9",
                    body = "{}",
                    attempts = 1,
                ),
            )
            assertEquals(0, txn.queueCount())
        }
    }
}
