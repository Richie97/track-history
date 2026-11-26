package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/corners.test.js`, case for case, plus the
 * cross-language pin against `contracts/logic/corners.json`.
 */
class CornersTest {

    /**
     * 24 grid points: a real corner at k 2–5, a double apex at k 9–13 with a
     * one-point dip in the middle, a kerb strike at k 17 and a straight
     * everywhere else — the straights three points long, so the merge gap (two)
     * leaves them apart. No yaw and no steering: the magnitude-only reading.
     */
    private val latG = listOf(
        0.0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0.0, 0.0, 0.7, 0.8, 0.2,
        0.9, 0.7, 0.1, 0.0, 0.0, 1.4, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0,
    )

    private val lap = LapChannels(
        n = 1,
        timeMs = 90_000,
        speed = List(24) { 100.0 },
        latG = latG,
    )

    /**
     * 21 grid points of esses: left at k 1–3, right at k 5–7 with one clear
     * point between them, then a left double apex at k 11–13 and k 15–17. Read
     * as a magnitude the first two are one corner; read with a direction they
     * are two, and the double apex is still one.
     */
    private val essG = listOf(
        0.0, 0.6, 0.8, 0.7, 0.2, 0.7, 0.9, 0.8, 0.1, 0.0, 0.0,
        0.6, 0.7, 0.6, 0.1, 0.5, 0.6, 0.5, 0.0, 0.0, 0.0,
    )
    private val essYaw = listOf(
        1.0, 5.0, 6.0, 5.0, 1.0, -5.0, -6.0, -5.0, -1.0, 1.0, 1.0,
        4.0, 4.0, 4.0, 1.0, 4.0, 4.0, 4.0, 1.0, 1.0, 1.0,
    )
    private val esses = LapChannels(
        n = 1,
        timeMs = 60_000,
        speed = List(21) { 100.0 },
        latG = essG,
        yaw = essYaw,
    )

    /** Still loaded left through k 4 and k 5, where [esses] has let go or turned right. */
    private val late = esses.copy(
        n = 3,
        latG = essG.mapIndexed { k, g -> if (k == 4 || k == 5) 0.5 else g },
        yaw = essYaw.mapIndexed { k, v -> if (k == 4 || k == 5) 3.0 else v },
    )

    private fun session(vararg laps: LapChannels) =
        SessionChannels(v = 1, dStepM = 20.0, laps = laps.toList())

    private fun windows(cs: List<Corners.Corner>) = cs.map { listOf(it.n, it.k0, it.k1) }

    @Test
    fun `reads the direction from yaw, else steering, and has none without either`() {
        val base = LapChannels(n = 1, timeMs = 0, latG = listOf(1.0, 1.0, 1.0))
        assertEquals(listOf(1, -1, 1), Corners.lateralSigns(base.copy(yaw = listOf(2.0, -3.0, 0.0))))
        assertEquals(listOf(-1, 1, 1), Corners.lateralSigns(base.copy(steering = listOf(-40.0, 40.0, 40.0))))
        // yaw wins when a lap has both
        assertEquals(
            listOf(1, 1, 1),
            Corners.lateralSigns(base.copy(yaw = listOf(1.0, 1.0, 1.0), steering = listOf(-40.0, -40.0, -40.0))),
        )
        assertNull(Corners.lateralSigns(lap))
        assertNull(Corners.lateralSigns(LapChannels(n = 1, timeMs = 0, yaw = listOf(1.0, 2.0))))
        assertTrue(Corners.hasCornerData(lap))
        assertFalse(Corners.hasCornerData(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0))))
    }

    @Test
    fun `marks sustained lateral load and treats a stored sign as a magnitude`() {
        val g = listOf(0.0, 0.34, 0.35, -0.9)
        assertEquals(listOf(0, 0, 1, 1), Corners.cornerDirs(g))
        assertEquals(listOf(0, 0, -1, 1), Corners.cornerDirs(g, listOf(1, -1, -1, 1)))
        assertEquals(emptyList<Int>(), Corners.cornerDirs(null))
        assertEquals(0.35, Corners.CORNER_MIN_G, 1e-12)
    }

    @Test
    fun `merges across a short dip and drops a run too short to be a corner`() {
        val dirs = Corners.cornerDirs(latG)
        // The double apex's dip at k 11 is one clear point, so it merges; the
        // kerb strike at k 17 is one point, so it drops.
        assertEquals(listOf(Limits.Run(2, 5), Limits.Run(9, 13)), Corners.cornersFromDirs(dirs))
        assertEquals(2, Corners.CORNER_MERGE_GAP_POINTS)
        assertEquals(3, Corners.MIN_CORNER_POINTS)
    }

    @Test
    fun `takes its thresholds as options`() {
        val dirs = Corners.cornerDirs(latG)
        assertEquals(listOf(Limits.Run(2, 5)), Corners.cornersFromDirs(dirs, mergeGap = 0))
        assertEquals(
            listOf(Limits.Run(2, 5), Limits.Run(9, 10), Limits.Run(12, 13)),
            Corners.cornersFromDirs(dirs, mergeGap = 0, minPoints = 2),
        )
        assertEquals(3, Corners.cornersFromDirs(dirs, minPoints = 1).size) // the strike counts
    }

    @Test
    fun `never merges across a change of direction`() {
        assertEquals(
            listOf(Limits.Run(0, 2), Limits.Run(4, 6)),
            Corners.cornersFromDirs(listOf(1, 1, 1, 0, -1, -1, -1)),
        )
        // no gap at all
        assertEquals(
            listOf(Limits.Run(0, 2), Limits.Run(3, 5)),
            Corners.cornersFromDirs(listOf(1, 1, 1, -1, -1, -1)),
        )
        // An opposite flick between two same-direction runs keeps them apart
        // even though the gap between them is inside the merge distance.
        val flick = listOf(1, 1, 1, -1, 1, 1, 1)
        assertEquals(
            listOf(Limits.Run(0, 2), Limits.Run(3, 3), Limits.Run(4, 6)),
            Corners.cornersFromDirs(flick, minPoints = 1),
        )
        assertEquals(listOf(Limits.Run(0, 2), Limits.Run(4, 6)), Corners.cornersFromDirs(flick))
    }

    @Test
    fun `numbers the corners from the start-finish line and finds each peak`() {
        val cs = Corners.lapCorners(lap)
        assertEquals(listOf(listOf(1, 2, 5), listOf(2, 9, 13)), windows(cs))
        assertEquals(1.0, cs[0].peakG, 1e-9)
        assertEquals(4, cs[0].peakK)
        assertEquals(0.9, cs[1].peakG, 1e-9)
        assertEquals(12, cs[1].peakK)
        assertEquals("T2", Corners.cornerLabel(cs[1]))
    }

    @Test
    fun `cuts linked corners apart where the direction changes`() {
        val cut = listOf(listOf(1, 1, 3), listOf(2, 5, 7), listOf(3, 11, 17))
        // same direction either side of the dip: the double apex is still one
        assertEquals(cut, windows(Corners.lapCorners(esses)))
        // Which sign is "left" is the recorder's business: the cut is the same.
        val steered = esses.copy(yaw = null, steering = essYaw.map { it * -3 })
        assertEquals(cut, windows(Corners.lapCorners(steered)))
        // Without a direction the esses are one corner, as they were.
        assertEquals(
            listOf(listOf(1, 1, 7), listOf(2, 11, 17)),
            windows(Corners.lapCorners(esses.copy(yaw = null))),
        )
    }

    @Test
    fun `is empty without a lateral G channel`() {
        assertTrue(Corners.lapCorners(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0))).isEmpty())
        assertTrue(Corners.lapCorners(null).isEmpty())
    }

    @Test
    fun `puts a lap from a recorder with the opposite convention the same way round`() {
        val flipped = esses.copy(yaw = essYaw.map { -it })
        val dirs = Corners.sessionDirs(listOf(esses, flipped))
        assertEquals(dirs[0], dirs[1])
        assertEquals(listOf(0, 1, 1, 1, 0, -1, -1, -1), dirs[0].take(8))
    }

    @Test
    fun `uses no direction at all when any lap has none`() {
        val dirs = Corners.sessionDirs(listOf(esses, esses.copy(yaw = null)))
        assertEquals(dirs[0], dirs[1])
        assertEquals(listOf(0, 1, 1, 1, 0, 1, 1, 1), dirs[0].take(8))
    }

    @Test
    fun `segments every lap together so the list is one list for the session`() {
        // The second lap takes the first corner wider (load starts a point
        // earlier) and never loads the tire through the double apex.
        val wide = lap.copy(
            n = 2,
            latG = latG.mapIndexed { k, g -> if (k == 1) 0.4 else if (k in 9..13) 0.1 else g },
        )
        val cs = Corners.sessionCorners(session(lap, wide))
        assertEquals(
            listOf(listOf(1, 1, 5, 2), listOf(2, 9, 13, 1)),
            cs.map { listOf(it.n, it.k0, it.k1, it.laps) },
        )
        assertEquals(1.0, cs[0].peakG, 1e-9) // the highest any lap saw
    }

    @Test
    fun `keeps linked corners apart across laps, whatever each recorder calls left`() {
        val flipped = esses.copy(n = 2, yaw = essYaw.map { -it })
        val cs = Corners.sessionCorners(session(esses, flipped))
        assertEquals(
            listOf(listOf(1, 1, 3, 2), listOf(2, 5, 7, 2), listOf(3, 11, 17, 2)),
            cs.map { listOf(it.n, it.k0, it.k1, it.laps) },
        )
    }

    @Test
    fun `gives a contested point to the direction more laps turn, the earliest lap on a tie`() {
        // Two against one at k 5: it stays in the right-hander. k 4 is loaded
        // by one lap only, so the left-hander reaches it.
        assertEquals(
            listOf(listOf(1, 1, 4), listOf(2, 5, 7), listOf(3, 11, 17)),
            windows(Corners.sessionCorners(session(esses, esses.copy(n = 2), late))),
        )
        // One against one at k 5: the earliest lap decides, either way round…
        assertEquals(listOf(2, 5, 7), windows(Corners.sessionCorners(session(esses, late)))[1])
        // …and what is left of the right-hander is then too short to be a corner.
        assertEquals(
            listOf(listOf(1, 1, 5), listOf(2, 11, 17)),
            windows(Corners.sessionCorners(session(late, esses))),
        )
    }

    @Test
    fun `falls back to magnitude alone when a lap has no direction`() {
        assertEquals(
            listOf(listOf(1, 1, 7), listOf(2, 11, 17)),
            windows(Corners.sessionCorners(session(esses, esses.copy(n = 2, yaw = null)))),
        )
    }

    @Test
    fun `ignores laps without lateral G and is empty when none has it`() {
        val bare = LapChannels(n = 9, timeMs = 0, speed = listOf(1.0))
        assertEquals(2, Corners.sessionCorners(session(bare, lap)).size)
        assertTrue(Corners.sessionCorners(session(bare)).isEmpty())
        assertTrue(Corners.sessionCorners(null).isEmpty())
    }

    @Test
    fun `finds the corner a grid point sits in, null on a straight`() {
        val cs = Corners.lapCorners(lap)
        assertEquals(cs[0], Corners.cornerAt(cs, 3))
        // the dip inside the double apex is still that corner
        assertEquals(cs[1], Corners.cornerAt(cs, 11))
        assertNull(Corners.cornerAt(cs, 7))
        assertNull(Corners.cornerAt(emptyList(), 3))
    }

    // ---- cross-language pin ------------------------------------------------

    /**
     * The JS implementation's own output for a shared input has to come back out
     * of this port: the windows exactly, the peaks to 1e-9.
     */
    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/corners.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val channels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)
        val fixtureLatG = channels.laps[0].latG!!
        val probe = json.decodeFromJsonElement<List<Double>>(input["latG"]!!)
        val turns = json.decodeFromJsonElement<List<Int>>(input["turns"]!!)
        val ess = json.decodeFromJsonElement<Map<String, LapChannels>>(input["esses"]!!)
        fun runs(key: String) = json.decodeFromJsonElement<List<Limits.Run>>(expected[key]!!)
        fun corners(key: String) = json.decodeFromJsonElement<List<Corners.Corner>>(expected[key]!!)
        fun essLap(key: String) = ess.getValue(key)

        assertEquals(json.decodeFromJsonElement<List<Int>>(expected["dirs"]!!), Corners.cornerDirs(probe))
        assertEquals(
            json.decodeFromJsonElement<List<Int>>(expected["signedDirs"]!!),
            Corners.cornerDirs(probe, json.decodeFromJsonElement<List<Int>>(input["signs"]!!)),
        )
        val dirs = Corners.cornerDirs(fixtureLatG)
        assertEquals(runs("runs"), Corners.cornersFromDirs(dirs))
        assertEquals(runs("tightRuns"), Corners.cornersFromDirs(dirs, mergeGap = 0))
        assertEquals(runs("shortRuns"), Corners.cornersFromDirs(dirs, mergeGap = 0, minPoints = 2))
        assertEquals(runs("strikeRuns"), Corners.cornersFromDirs(dirs, minPoints = 1))
        assertEquals(runs("turnRuns"), Corners.cornersFromDirs(turns))
        assertEquals(runs("turnRunsAll"), Corners.cornersFromDirs(turns, minPoints = 1))

        val signs = json.decodeFromJsonElement<Map<String, List<Int>?>>(expected["signs"]!!)
        for (key in listOf("a", "steered", "bare")) {
            assertEquals(signs.getValue(key), Corners.lateralSigns(essLap(key)), "lateralSigns $key")
        }

        assertSameCorners(corners("lapA"), Corners.lapCorners(channels.laps[0]), "lapCorners")
        assertSameCorners(corners("essLap"), Corners.lapCorners(essLap("a")), "essLap")
        assertSameCorners(corners("essSteered"), Corners.lapCorners(essLap("steered")), "essSteered")
        assertSameCorners(corners("essBare"), Corners.lapCorners(essLap("bare")), "essBare")

        val session = Corners.sessionCorners(channels)
        assertSameCorners(corners("session"), session, "sessionCorners")
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["labels"]!!),
            session.map { Corners.cornerLabel(it) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<Int?>>(expected["at"]!!),
            listOf(3, 11, 7, 99).map { Corners.cornerAt(session, it)?.n },
        )
        assertTrue(Corners.sessionCorners(session(channels.laps[2])).isEmpty())
        assertTrue(corners("noData").isEmpty())

        assertEquals(
            json.decodeFromJsonElement<List<List<Int>>>(expected["flippedDirs"]!!),
            Corners.sessionDirs(listOf(essLap("a"), essLap("flipped"))),
        )
        assertEquals(
            json.decodeFromJsonElement<List<List<Int>>>(expected["bareDirs"]!!),
            Corners.sessionDirs(listOf(essLap("a"), essLap("bare"))),
        )
        val sessions = mapOf(
            "essFlipped" to listOf("a", "flipped"),
            "essVote" to listOf("a", "again", "late"),
            "essTie" to listOf("a", "late"),
            "essTieLate" to listOf("late", "a"),
            "essMixed" to listOf("a", "bare"),
        )
        for ((key, laps) in sessions) {
            assertSameCorners(
                corners(key),
                Corners.sessionCorners(session(*laps.map { essLap(it) }.toTypedArray())),
                key,
            )
        }
    }

    private fun assertSameCorners(want: List<Corners.Corner>, got: List<Corners.Corner>, label: String) {
        assertEquals(want.size, got.size, "$label count")
        want.forEachIndexed { i, w ->
            assertEquals(w.n, got[i].n, "$label [$i] n")
            assertEquals(w.k0, got[i].k0, "$label [$i] k0")
            assertEquals(w.k1, got[i].k1, "$label [$i] k1")
            assertEquals(w.peakK, got[i].peakK, "$label [$i] peakK")
            assertEquals(w.laps, got[i].laps, "$label [$i] laps")
            assertEquals(w.peakG, got[i].peakG, 1e-9, "$label [$i] peakG")
        }
    }
}
