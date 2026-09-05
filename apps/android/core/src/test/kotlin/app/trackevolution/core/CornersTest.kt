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
     * 24 grid points: a real corner at k 2–5, a chicane at k 9–13 with a
     * one-point dip in the middle, a kerb strike at k 17 and a straight
     * everywhere else — the straights three points long, so the merge gap (two)
     * leaves them apart.
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

    @Test
    fun `marks sustained lateral load and treats a stored sign as a magnitude`() {
        assertEquals(
            listOf(false, false, true, true),
            Corners.cornerMask(listOf(0.0, 0.34, 0.35, -0.9)),
        )
        assertEquals(emptyList<Boolean>(), Corners.cornerMask(null))
        assertTrue(Corners.hasCornerData(lap))
        assertFalse(Corners.hasCornerData(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0))))
        assertEquals(0.35, Corners.CORNER_MIN_G, 1e-12)
    }

    @Test
    fun `merges across a short dip and drops a run too short to be a corner`() {
        val mask = Corners.cornerMask(latG)
        // The chicane's dip at k 11 is one clear point, so it merges; the kerb
        // strike at k 17 is one point, so it drops.
        assertEquals(listOf(Limits.Run(2, 5), Limits.Run(9, 13)), Corners.cornersFromMask(mask))
        assertEquals(2, Corners.CORNER_MERGE_GAP_POINTS)
        assertEquals(3, Corners.MIN_CORNER_POINTS)
    }

    @Test
    fun `takes its thresholds as options`() {
        val mask = Corners.cornerMask(latG)
        assertEquals(listOf(Limits.Run(2, 5)), Corners.cornersFromMask(mask, mergeGap = 0))
        assertEquals(
            listOf(Limits.Run(2, 5), Limits.Run(9, 10), Limits.Run(12, 13)),
            Corners.cornersFromMask(mask, mergeGap = 0, minPoints = 2),
        )
        assertEquals(3, Corners.cornersFromMask(mask, minPoints = 1).size) // the strike counts
    }

    @Test
    fun `numbers the corners from the start-finish line and finds each peak`() {
        val cs = Corners.lapCorners(lap)
        assertEquals(listOf(listOf(1, 2, 5), listOf(2, 9, 13)), cs.map { listOf(it.n, it.k0, it.k1) })
        assertEquals(1.0, cs[0].peakG, 1e-9)
        assertEquals(4, cs[0].peakK)
        assertEquals(0.9, cs[1].peakG, 1e-9)
        assertEquals(12, cs[1].peakK)
        assertEquals("T2", Corners.cornerLabel(cs[1]))
    }

    @Test
    fun `is empty without a lateral G channel`() {
        assertTrue(Corners.lapCorners(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0))).isEmpty())
        assertTrue(Corners.lapCorners(null).isEmpty())
    }

    @Test
    fun `segments where the laps agree so the list is one list for the session`() {
        // The second lap takes the first corner wider (load starts a point
        // earlier) and never loads the tyre through the chicane. Two laps need
        // only one to agree, so this is still the union — the quorum has
        // nothing to arbitrate until there are three.
        val wide = lap.copy(
            n = 2,
            latG = latG.mapIndexed { k, g -> if (k == 1) 0.4 else if (k in 9..13) 0.1 else g },
        )
        val cs = Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(lap, wide)))
        assertEquals(
            listOf(listOf(1, 1, 5, 2), listOf(2, 9, 13, 1)),
            cs.map { listOf(it.n, it.k0, it.k1, it.laps) },
        )
        assertEquals(1.0, cs[0].peakG, 1e-9) // the highest any lap saw
    }

    // Two corners with a three-point straight between them — one point more
    // than the merge gap, so they stay apart — and a lap that stays loaded
    // across it. Under the union this used to take, that one lap chained the
    // pair into a single corner; this is the VIR failure in miniature.
    private val bridgeLatG =
        listOf(0.0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0.0, 0.1, 0.7, 0.9, 0.8, 0.5, 0.1, 0.0, 0.0)
    private val bridgeClean = LapChannels(n = 1, timeMs = 90_000, latG = bridgeLatG)
    private val bridging = LapChannels(
        n = 2,
        timeMs = 91_000,
        latG = bridgeLatG.mapIndexed { k, g -> if (k in 6..8) 0.5 else g },
    )

    @Test
    fun `keeps neighbouring corners apart when only a minority of laps bridges them`() {
        // Correct for that lap on its own, and exactly what must not become the
        // session's reading.
        assertEquals(listOf(listOf(2, 12)), Corners.lapCorners(bridging).map { listOf(it.k0, it.k1) })
        val cs = Corners.sessionCorners(
            SessionChannels(v = 1, dStepM = 20.0, laps = listOf(bridgeClean, bridgeClean, bridging)),
        )
        assertEquals(
            listOf(listOf(1, 2, 5, 3), listOf(2, 9, 12, 3)),
            cs.map { listOf(it.n, it.k0, it.k1, it.laps) },
        )
    }

    @Test
    fun `still merges when most laps agree the gap is loaded`() {
        val cs = Corners.sessionCorners(
            SessionChannels(v = 1, dStepM = 20.0, laps = listOf(bridgeClean, bridging, bridging)),
        )
        assertEquals(listOf(listOf(2, 12)), cs.map { listOf(it.k0, it.k1) })
    }

    @Test
    fun `degrades to any-lap below two laps, so a single-lap session still segments`() {
        assertEquals(listOf(1, 1, 2, 4), listOf(1, 2, 3, 7).map { Corners.lapQuorum(it) })
        val cs = Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(bridging)))
        assertEquals(listOf(listOf(2, 12)), cs.map { listOf(it.k0, it.k1) })
        assertEquals(0.5, Corners.CORNER_LAP_QUORUM, 1e-9)
    }

    @Test
    fun `ignores laps without lateral G and is empty when none has it`() {
        val bare = LapChannels(n = 9, timeMs = 0, speed = listOf(1.0))
        assertEquals(
            2,
            Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(bare, lap))).size,
        )
        assertTrue(
            Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(bare))).isEmpty(),
        )
        assertTrue(Corners.sessionCorners(null).isEmpty())
    }

    @Test
    fun `finds the corner a grid point sits in, null on a straight`() {
        val cs = Corners.lapCorners(lap)
        assertEquals(cs[0], Corners.cornerAt(cs, 3))
        // the dip inside the chicane is still the chicane
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

        assertEquals(
            json.decodeFromJsonElement<List<Boolean>>(expected["mask"]!!),
            Corners.cornerMask(json.decodeFromJsonElement<List<Double>>(input["mask"]!!)),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Limits.Run>>(expected["runs"]!!),
            Corners.cornersFromMask(Corners.cornerMask(fixtureLatG)),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Limits.Run>>(expected["tightRuns"]!!),
            Corners.cornersFromMask(Corners.cornerMask(fixtureLatG), mergeGap = 0),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Limits.Run>>(expected["shortRuns"]!!),
            Corners.cornersFromMask(Corners.cornerMask(fixtureLatG), mergeGap = 0, minPoints = 2),
        )
        assertEquals(
            json.decodeFromJsonElement<List<Limits.Run>>(expected["strikeRuns"]!!),
            Corners.cornersFromMask(Corners.cornerMask(fixtureLatG), minPoints = 1),
        )

        assertSameCorners(
            json.decodeFromJsonElement<List<Corners.Corner>>(expected["lapA"]!!),
            Corners.lapCorners(channels.laps[0]),
            "lapCorners",
        )
        val session = Corners.sessionCorners(channels)
        assertSameCorners(
            json.decodeFromJsonElement<List<Corners.Corner>>(expected["session"]!!),
            session,
            "sessionCorners",
        )
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["labels"]!!),
            session.map { Corners.cornerLabel(it) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<Int?>>(expected["at"]!!),
            listOf(3, 11, 7, 99).map { Corners.cornerAt(session, it)?.n },
        )
        assertTrue(
            Corners.sessionCorners(
                SessionChannels(v = 1, dStepM = 20.0, laps = listOf(channels.laps[2])),
            ).isEmpty(),
        )
        assertTrue(json.decodeFromJsonElement<List<Corners.Corner>>(expected["noData"]!!).isEmpty())
        // The quorum, not a union: one lap of three staying loaded across a
        // short straight must not chain the corners either side of it, while
        // two of three must. A port that ORs the masks passes everything above
        // and fails exactly here.
        val bridge = json.decodeFromJsonElement<SessionChannels>(input["bridgeChannels"]!!)
        val bridgeMajority = json.decodeFromJsonElement<SessionChannels>(input["bridgeMajorityChannels"]!!)
        assertSameCorners(
            json.decodeFromJsonElement<List<Corners.Corner>>(expected["bridge"]!!),
            Corners.sessionCorners(bridge),
            "bridge",
        )
        assertSameCorners(
            json.decodeFromJsonElement<List<Corners.Corner>>(expected["bridgeMajority"]!!),
            Corners.sessionCorners(bridgeMajority),
            "bridgeMajority",
        )
        assertSameCorners(
            json.decodeFromJsonElement<List<Corners.Corner>>(expected["bridgeLapAlone"]!!),
            Corners.lapCorners(bridge.laps[2]),
            "bridgeLapAlone",
        )
        assertEquals(
            json.decodeFromJsonElement<List<Int>>(expected["quorum"]!!),
            listOf(1, 2, 3, 7).map { Corners.lapQuorum(it) },
        )
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
