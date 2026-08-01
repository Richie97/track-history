package app.trackevolution.core

import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.Track
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineMirrors
import app.trackevolution.core.offline.OfflineStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.IOException

/**
 * The offline cache and write queue, case for case with
 * `test/unit/offline.test.js` — the three clients have to behave identically, so
 * the JS suite is the specification and its test names are kept.
 *
 * Everything here runs on the JVM against [InMemoryOfflinePersistence]: the
 * replay algorithm is the part worth testing and it must be testable without an
 * emulator, which is exactly why it lives in `:core` and Room does not.
 */
class OfflineStoreTest {

    private val json = Json { encodeDefaults = true }
    private val eventList = ListSerializer(Event.serializer())
    private val trackList = ListSerializer(Track.serializer())

    private fun store() = OfflineStore(InMemoryOfflinePersistence())

    // A cached event-detail body in the exact shape GET /api/events/:id returns.
    private fun event(
        id: Int = 10,
        trackId: Int = 3,
        trackName: String = "Test Ring",
        startDate: String = "2026-05-01",
        days: Double = 2.0,
        bestTimeMs: Int? = null,
    ) = Event(
        id = id,
        trackId = trackId,
        trackName = trackName,
        startDate = startDate,
        days = days,
        bestTimeMs = bestTimeMs,
        updatedAt = 111,
        lapCount = 0,
        sessionCount = 0,
        hours = 0.0,
    )

    private fun detail(event: Event = event(), sessions: List<Session> = emptyList()) =
        OfflineMirrors.recomputeDetail(EventDetail(event, sessions, emptyList()))

    private fun session(id: Int, label: String? = null, laps: List<Int> = emptyList()) = Session(
        id = id,
        label = label,
        sort = 1,
        laps = laps.mapIndexed { index, ms ->
            Lap(id = id * 10 + index, sessionId = id, lapNum = index + 1, timeMs = ms)
        },
    )

    private suspend fun OfflineStore.putDetail(d: EventDetail) =
        cachePut("/events/${d.event.id}", json.encodeToString(EventDetail.serializer(), d))

    private suspend fun OfflineStore.putList(vararg rows: Event) =
        cachePut("/events", json.encodeToString(eventList, rows.toList()))

    private suspend fun OfflineStore.detailAt(id: Int): EventDetail? =
        cachedGet("/events/$id")?.let { json.decodeFromString(EventDetail.serializer(), it) }

    private suspend fun OfflineStore.list(path: String = "/events"): List<Event>? =
        cachedGet(path)?.let { json.decodeFromString(eventList, it) }

    private fun ok(id: Int? = null) =
        OfflineStore.SendResult(if (id == null) 200 else 201, if (id == null) """{"ok":true}""" else """{"id":$id}""")

    // ---- response cache ---------------------------------------------------

    @Test
    fun `stores and returns bodies by path`() = runTest {
        val store = store()
        store.cachePut("/me", """{"user":{"id":1}}""")
        assertEquals("""{"user":{"id":1}}""", store.cachedGet("/me"))
        assertNull(store.cachedGet("/nope"))
    }

    @Test
    fun `derives a track-filtered events list from the cached full list`() = runTest {
        val store = store()
        store.putList(event(id = 1, trackId = 3), event(id = 2, trackId = 4))
        assertEquals(listOf(2), store.list("/events?track_id=4")?.map { it.id })
    }

    // ---- offline mutation queue -------------------------------------------

    @Test
    fun `whitelists only mirrorable mutations`() {
        assertTrue(OfflineStore.isQueueable("POST", "/events"))
        assertTrue(OfflineStore.isQueueable("POST", "/events/12/sessions"))
        assertTrue(OfflineStore.isQueueable("DELETE", "/laps/5"))
        assertTrue(OfflineStore.isQueueable("PUT", "/tracks/2"))
        assertTrue(OfflineStore.isQueueable("PUT", "/events/12/setups/1"))
        assertFalse(OfflineStore.isQueueable("PUT", "/share"))
        assertFalse(OfflineStore.isQueueable("POST", "/vehicles"))
        // Garage writes need a live server; see the whitelist's comment.
        assertFalse(OfflineStore.isQueueable("POST", "/vehicles/1/parts"))
        assertFalse(OfflineStore.isQueueable("POST", "/parts/1/refresh"))
        // A day has to be a number — `/setups/latest` is not a setup sheet.
        assertFalse(OfflineStore.isQueueable("PUT", "/events/12/setups/latest"))
    }

    @Test
    fun `creates an event locally with a temp id, inserted in date order`() = runTest {
        val store = store()
        store.putList(event(id = 1, startDate = "2026-06-01"), event(id = 2, startDate = "2026-04-01"))

        val result = store.enqueue(
            "POST", "/events",
            """{"track_name":"New Ring","start_date":"2026-05-01"}""",
        )
        val tempId = (result as OfflineStore.QueuedResult.Created).id
        assertTrue(OfflineStore.isTempPath("/events/$tempId"))
        assertEquals(1, store.pendingCount())

        assertEquals(listOf(1, tempId, 2), store.list()?.map { it.id })
        val created = store.detailAt(tempId)!!
        assertEquals("New Ring", created.event.trackName)
        assertEquals(emptyList<Session>(), created.sessions)
    }

    @Test
    fun `names a created event from the cached tracks list when given a track id`() = runTest {
        val store = store()
        store.putList()
        store.cachePut(
            "/tracks",
            json.encodeToString(trackList, listOf(track(id = 3, name = "Summit Point (Shenandoah)"))),
        )

        val result = store.enqueue("POST", "/events", """{"track_id":3,"start_date":"2026-05-01"}""")
        val tempId = (result as OfflineStore.QueuedResult.Created).id
        assertEquals("Summit Point (Shenandoah)", store.detailAt(tempId)?.event?.trackName)
    }

    @Test
    fun `adds a session with laps and recomputes event aggregates everywhere`() = runTest {
        val store = store()
        val d = detail()
        store.putDetail(d)
        store.putList(d.event)

        val result = store.enqueue(
            "POST", "/events/10/sessions",
            """{"label":"S1","laps":[121000.4,0,-5,null,119000]}""",
        )
        val tempId = (result as OfflineStore.QueuedResult.Created).id

        val after = store.detailAt(10)!!
        assertEquals(1, after.sessions.size)
        assertEquals(tempId, after.sessions[0].id)
        assertEquals(listOf(121000, 119000), after.sessions[0].laps.map { it.timeMs })
        assertEquals(119000, after.event.bestMs)
        assertEquals(1, after.event.sessionCount)

        val row = store.list()!![0]
        assertEquals(2, row.lapCount)
        assertEquals(119000, row.bestMs)
    }

    @Test
    fun `patches event edits and deletes into detail and lists`() = runTest {
        val store = store()
        val d = detail()
        store.putDetail(d)
        store.putList(d.event)

        store.enqueue("PUT", "/events/10", """{"notes":"wet all day","best_time_ms":130000}""")
        assertEquals("wet all day", store.detailAt(10)?.event?.notes)
        assertEquals(130000, store.list()?.first()?.bestMs)

        store.enqueue("DELETE", "/events/10", null)
        assertNull(store.cachedGet("/events/10"))
        assertEquals(emptyList<Event>(), store.list())
    }

    @Test
    fun `patches an event edit into the lists when no detail is cached`() = runTest {
        val store = store()
        store.putList(event())

        store.enqueue("PUT", "/events/10", """{"club":"NASA","notes":null}""")
        val row = store.list()!!.first()
        assertEquals("NASA", row.club)
        assertNull(row.notes)
    }

    @Test
    fun `cancels queued creates (and their children) when a temp row is deleted`() = runTest {
        val store = store()
        store.putList()
        val created = store.enqueue(
            "POST", "/events",
            """{"track_name":"X","start_date":"2026-05-01"}""",
        ) as OfflineStore.QueuedResult.Created
        store.enqueue("POST", "/events/${created.id}/sessions", """{"laps":[121000]}""")
        assertEquals(2, store.pendingCount())

        store.enqueue("DELETE", "/events/${created.id}", null)
        assertEquals(0, store.pendingCount())
        assertNull(store.cachedGet("/events/${created.id}"))
        assertEquals(emptyList<Event>(), store.list())
    }

    @Test
    fun `updates and deletes sessions and laps inside a cached detail`() = runTest {
        val store = store()
        val d = detail(sessions = listOf(session(id = 7, label = "S1", laps = listOf(121000))))
        store.putDetail(d)
        store.putList(d.event)

        store.enqueue("PUT", "/sessions/7", """{"label":"Renamed"}""")
        assertEquals("Renamed", store.detailAt(10)?.sessions?.first()?.label)

        store.enqueue("POST", "/sessions/7/laps", """{"laps":[119000]}""")
        assertEquals(listOf(1, 2), store.detailAt(10)?.sessions?.first()?.laps?.map { it.lapNum })
        assertEquals(119000, store.list()?.first()?.bestMs)

        store.enqueue("DELETE", "/laps/70", null)
        assertEquals(1, store.detailAt(10)?.sessions?.first()?.laps?.size)

        store.enqueue("DELETE", "/sessions/7", null)
        assertEquals(emptyList<Session>(), store.detailAt(10)?.sessions)
        assertEquals(0, store.list()?.first()?.lapCount)
    }

    @Test
    fun `clears both session fields on a rename, as the route does`() = runTest {
        val store = store()
        val d = detail(
            sessions = listOf(session(id = 7, label = "S1", laps = listOf(121000)).copy(notes = "damp")),
        )
        store.putDetail(d)

        // `PUT /sessions/:id` writes `label = ?, notes = ?` unconditionally, so an
        // omitted note is a cleared note — not a preserved one.
        store.enqueue("PUT", "/sessions/7", """{"label":"Renamed"}""")
        assertNull(store.detailAt(10)?.sessions?.first()?.notes)
    }

    @Test
    fun `patches setup sheets into the cached detail`() = runTest {
        val store = store()
        store.putDetail(detail())

        store.enqueue("PUT", "/events/10/setups/2", """{"fuel":12.5,"notes":"more rear bar"}""")
        store.enqueue("PUT", "/events/10/setups/1", """{"fuel":10.0}""")
        assertEquals(listOf(1, 2), store.detailAt(10)?.setups?.map { it.day })
        assertEquals(12.5, store.detailAt(10)?.setups?.last()?.data?.fuel)

        store.enqueue("DELETE", "/events/10/setups/1", null)
        assertEquals(listOf(2), store.detailAt(10)?.setups?.map { it.day })
    }

    @Test
    fun `patches track goal and notes into the cached tracks list`() = runTest {
        val store = store()
        store.cachePut("/tracks", json.encodeToString(trackList, listOf(track(id = 3))))

        store.enqueue("PUT", "/tracks/3", """{"goal_ms":119500}""")
        val tracks = json.decodeFromString(trackList, store.cachedGet("/tracks")!!)
        assertEquals(119500, tracks[0].goalMs)
        assertEquals("Test Ring", tracks[0].name)
    }

    // ---- flush ------------------------------------------------------------

    @Test
    fun `replays in order, maps temp ids into later paths, and reports flushed`() = runTest {
        val store = store()
        store.putList()
        val created = store.enqueue(
            "POST", "/events",
            """{"track_name":"X","start_date":"2026-05-01"}""",
        ) as OfflineStore.QueuedResult.Created
        store.enqueue("POST", "/events/${created.id}/sessions", """{"laps":[121000]}""")

        val sent = mutableListOf<String>()
        val status = store.flush { method, path, _ ->
            sent += "$method $path"
            ok(id = if (sent.size == 1) 42 else 43)
        }

        assertEquals(listOf("POST /events", "POST /events/42/sessions"), sent)
        assertEquals(42, store.resolveId(created.id))
        assertEquals(0, status.pending)
        assertEquals(0, status.failed)
    }

    @Test
    fun `stops on network failure and keeps the remainder queued`() = runTest {
        val store = store()
        var calls = 0
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":2}""")

        val status = store.flush { _, _, _ ->
            if (++calls == 2) throw IOException("network gone")
            ok()
        }

        assertEquals(1, status.pending)
        assertTrue(status.offline)
    }

    @Test
    fun `drops server-rejected items and counts them as failed`() = runTest {
        val store = store()
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":-1}""")
        store.enqueue("PUT", "/tracks/4", """{"goal_ms":2}""")

        val sent = mutableListOf<String>()
        val status = store.flush { _, path, _ ->
            sent += path
            if (path == "/tracks/3") {
                OfflineStore.SendResult(400, """{"error":"invalid goal"}""")
            } else {
                ok()
            }
        }

        assertEquals(listOf("/tracks/3", "/tracks/4"), sent)
        assertEquals(0, status.pending)
        assertEquals(1, status.failed)
    }

    @Test
    fun `drops items whose temp-id dependency never resolved`() = runTest {
        val store = store()
        store.putList()
        val created = store.enqueue(
            "POST", "/events",
            """{"track_name":"X","start_date":"2026-05-01"}""",
        ) as OfflineStore.QueuedResult.Created
        store.enqueue("POST", "/events/${created.id}/sessions", """{"laps":[121000]}""")

        val status = store.flush { _, path, _ ->
            if (path == "/events") {
                OfflineStore.SendResult(400, """{"error":"nope"}""")
            } else {
                throw AssertionError("should not send the dependent item")
            }
        }

        assertEquals(0, status.pending)
        assertEquals(2, status.failed)
    }

    @Test
    fun `retries a 5xx a bounded number of times, then gives up`() = runTest {
        val store = store()
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")

        var sent = 0
        repeat(4) {
            val status = store.flush { _, _, _ ->
                sent += 1
                OfflineStore.SendResult(503, """{"error":"down"}""")
            }
            assertEquals(1, status.pending)
            assertEquals(0, status.failed)
        }

        val status = store.flush { _, _, _ ->
            sent += 1
            OfflineStore.SendResult(503, """{"error":"down"}""")
        }
        assertEquals(5, sent)
        assertEquals(0, status.pending)
        assertEquals(1, status.failed)
    }

    @Test
    fun `a second concurrent flush does not resend the queue`() = runTest {
        val store = store()
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")

        val gate = CompletableDeferred<Unit>()
        val sent = mutableListOf<String>()
        val first = launch {
            store.flush { _, path, _ ->
                sent += path
                gate.await()
                ok()
            }
        }
        // Let the first flush take the lock and park inside the sender — which is
        // what a real replay does for the length of a request.
        yield()

        // Two rapid connectivity flaps: the second must not replay the same queue.
        store.flush { _, path, _ ->
            sent += "second $path"
            ok()
        }
        gate.complete(Unit)
        first.join()

        assertEquals(listOf("/tracks/3"), sent)
    }

    // ---- durability -------------------------------------------------------

    @Test
    fun `the queue survives the process that made it`() = runTest {
        val storage = InMemoryOfflinePersistence()
        val before = OfflineStore(storage)
        before.putList()
        val created = before.enqueue(
            "POST", "/events",
            """{"track_name":"X","start_date":"2026-05-01"}""",
        ) as OfflineStore.QueuedResult.Created
        before.enqueue("POST", "/events/${created.id}/sessions", """{"laps":[121000]}""")

        // Process death: a new store over the same storage. The pending count has
        // to come back with it, or the queue is invisible and never replays.
        val after = OfflineStore(storage)
        assertEquals(2, after.pendingCount())

        val sent = mutableListOf<String>()
        after.flush { method, path, _ ->
            sent += "$method $path"
            ok(id = if (sent.size == 1) 42 else 43)
        }
        assertEquals(listOf("POST /events", "POST /events/42/sessions"), sent)
    }

    @Test
    fun `replay resumes where it stopped after process death mid-queue`() = runTest {
        val storage = InMemoryOfflinePersistence()
        val before = OfflineStore(storage)
        before.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")
        before.enqueue("PUT", "/tracks/4", """{"goal_ms":2}""")
        before.enqueue("PUT", "/tracks/5", """{"goal_ms":3}""")

        var calls = 0
        before.flush { _, _, _ ->
            if (++calls == 2) throw IOException("network gone")
            ok()
        }

        val after = OfflineStore(storage)
        assertEquals(2, after.pendingCount())
        val sent = mutableListOf<String>()
        after.flush { _, path, _ ->
            sent += path
            ok()
        }
        assertEquals(listOf("/tracks/4", "/tracks/5"), sent)
    }

    @Test
    fun `sign-out leaves no cached rows and no queued writes`() = runTest {
        val store = store()
        store.putDetail(detail())
        store.enqueue("PUT", "/tracks/3", """{"goal_ms":1}""")

        store.clear()

        assertEquals(0, store.pendingCount())
        assertEquals(emptyList<String>(), store.cachedKeys())
        assertNull(store.cachedGet("/events/10"))
        assertNull(store.resolveId(-1))
    }

    // ---- reapplyQueue -----------------------------------------------------

    @Test
    fun `re-patches a fresh server response without duplicating queued rows`() = runTest {
        val store = store()
        val d = detail()
        store.putDetail(d)
        store.putList(d.event)
        store.enqueue("POST", "/events/10/sessions", """{"label":"S1","laps":[121000]}""")

        // A fresh (pre-sync) server body lands, then the overlay re-applies —
        // twice, to prove idempotence.
        store.putDetail(detail())
        store.reapplyQueue()
        store.reapplyQueue()

        val after = store.detailAt(10)!!
        assertEquals(1, after.sessions.size)
        assertEquals(1, after.sessions[0].laps.size)
    }

    @Test
    fun `re-applies appended laps once, not once per pass`() = runTest {
        val store = store()
        val d = detail(sessions = listOf(session(id = 7, laps = listOf(121000))))
        store.putDetail(d)
        store.enqueue("POST", "/sessions/7/laps", """{"laps":[119000]}""")

        store.putDetail(d)
        store.reapplyQueue()
        store.reapplyQueue()

        assertEquals(listOf(121000, 119000), store.detailAt(10)?.sessions?.first()?.laps?.map { it.timeMs })
    }

    private fun track(id: Int = 3, name: String = "Test Ring") = Track(
        id = id,
        name = name,
        updatedAt = 0,
        eventCount = 0,
        trackDays = 0,
        series = emptyList(),
    )
}
