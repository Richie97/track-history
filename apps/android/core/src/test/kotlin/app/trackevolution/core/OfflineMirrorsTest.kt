package app.trackevolution.core

import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.offline.OfflineMirrors
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

/**
 * The two server behaviors the offline layer reimplements, checked against the
 * server's own answers.
 *
 * The golden fixtures are what make this more than a self-consistency test: they
 * are real `withComputed` output, so a mirror that drifts from the server fails
 * here rather than in a paddock, where the symptom would be an event's stats
 * changing the moment it syncs.
 */
class OfflineMirrorsTest {

    /** Blank every field [OfflineMirrors.recomputeDetail] is supposed to derive. */
    private fun stripComputed(detail: EventDetail): EventDetail = detail.copy(
        event = detail.event.copy(
            lapBestMs = null,
            lapCount = 0,
            sessionCount = 0,
            bestMs = null,
            consistency = null,
            hours = 0.0,
        ),
    )

    @ParameterizedTest
    @ValueSource(strings = ["event-detail", "event-detail-no-laps"])
    fun `recomputes what the server computed`(golden: String) {
        val server = Goldens.decode(golden, EventDetail.serializer())
        val ours = OfflineMirrors.recomputeDetail(stripComputed(server))

        assertEquals(server.event.lapCount, ours.event.lapCount)
        assertEquals(server.event.sessionCount, ours.event.sessionCount)
        assertEquals(server.event.lapBestMs, ours.event.lapBestMs)
        assertEquals(server.event.bestMs, ours.event.bestMs)
        assertEquals(server.event.hours, ours.event.hours)
        if (server.event.consistency == null) {
            assertNull(ours.event.consistency)
        } else {
            // The server averages in SQL and we average in Kotlin; agreement to
            // 1e-12 is agreement, and anything looser would hide real drift.
            assertEquals(server.event.consistency!!, ours.event.consistency!!, 1e-12)
        }
    }

    @Test
    fun `consistency is null below three laps, never zero`() {
        assertNull(recompute(laps = listOf(110_000, 120_000)).event.consistency)
        assertNull(recompute(laps = listOf(110_000)).event.consistency)
        assertNull(recompute(laps = emptyList()).event.consistency)

        // Mirrors the JS case: stdev 8164.97 over a 110000 mean.
        val three = recompute(laps = listOf(100_000, 110_000, 120_000))
        assertEquals(8164.97 / 110_000, three.event.consistency!!, 1e-4)
    }

    @Test
    fun `best_ms prefers whichever of the manual best and the logged best is faster`() {
        val manualWins = recompute(bestTimeMs = 105_000, laps = listOf(110_000, 120_000))
        assertEquals(105_000, manualWins.event.bestMs)
        assertEquals(110_000, manualWins.event.lapBestMs)
        assertEquals(2, manualWins.event.lapCount)

        val lapsWin = recompute(bestTimeMs = 105_000, laps = listOf(100_000, 110_000, 120_000))
        assertEquals(100_000, lapsWin.event.bestMs)

        // Neither: null, not zero.
        assertNull(recompute().event.bestMs)
    }

    @Test
    fun `hours takes the override, else the greater of two per day and time on track`() {
        // Two days, nothing logged: the estimate.
        assertEquals(4.0, recompute(days = 2.0).event.hours)

        // Laps only push the estimate up, never down — sparse logging must not
        // shrink the seat time.
        assertEquals(4.0, recompute(days = 2.0, laps = List(10) { 120_000 }).event.hours)
        assertEquals(5.0, recompute(days = 1.0, laps = List(150) { 120_000 }).event.hours)

        // The override wins outright, and only when positive.
        assertEquals(1.5, recompute(days = 2.0, trackHours = 1.5).event.hours)
        assertEquals(4.0, recompute(days = 2.0, trackHours = 0.0).event.hours)

        // Rounded to 1dp, the way `withComputed` does.
        assertEquals(0.7, recompute(days = 0.0, laps = listOf(2_400_000)).event.hours)
    }

    @Test
    fun `cleanLaps matches sanitizeLaps`() {
        assertEquals(
            listOf(121_000, 119_000),
            OfflineMirrors.cleanLaps(listOf(121_000.4, 0.0, -5.0, Double.NaN, 119_000.0)),
        )
        // Half up toward +infinity, as JavaScript rounds — not half to even.
        assertEquals(listOf(3, 3), OfflineMirrors.cleanLaps(listOf(2.5, 3.4)))
        assertEquals(emptyList<Int>(), OfflineMirrors.cleanLaps(emptyList()))
        assertEquals(
            emptyList<Int>(),
            OfflineMirrors.cleanLaps(listOf(Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 0.4)),
        )
    }

    private fun recompute(
        bestTimeMs: Int? = null,
        days: Double = 1.0,
        trackHours: Double? = null,
        laps: List<Int> = emptyList(),
    ): EventDetail = OfflineMirrors.recomputeDetail(
        EventDetail(
            event = Event(
                id = 1,
                trackId = 1,
                trackName = "Test Ring",
                startDate = "2026-05-01",
                days = days,
                bestTimeMs = bestTimeMs,
                trackHours = trackHours,
                updatedAt = 0,
                lapCount = 0,
                sessionCount = 0,
                hours = 0.0,
            ),
            sessions = if (laps.isEmpty()) {
                emptyList()
            } else {
                listOf(
                    Session(
                        id = 1,
                        sort = 1,
                        laps = laps.mapIndexed { index, ms ->
                            Lap(id = index, sessionId = 1, lapNum = index + 1, timeMs = ms)
                        },
                    ),
                )
            },
            setups = emptyList(),
        ),
    )
}
