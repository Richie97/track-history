package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlin.math.abs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/balance.test.js`, case for case, plus the
 * cross-language pin against `contracts/logic/balance.json`.
 */
class BalanceTest {

    /**
     * A car with yaw gain K: yaw = K · v · δ (v in m/s). Fifteen grid points at
     * a constant 100 km/h: a right-hander at k 2–5, a left-hander at k 9–11,
     * straight elsewhere (three clear points between them, so the segmenter's
     * merge gap keeps them apart). The neutral lap answers the steering exactly
     * in both corners; the pushing lap delivers only 75% of the rotation asked
     * for in the left-hander.
     */
    private val k = 0.03
    private val v = 100.0 / 3.6
    private val steering = listOf(0.0, 0.0, 20.0, 40.0, 40.0, 20.0, 0.0, 0.0, 0.0, -30.0, -30.0, -30.0, 0.0, 0.0, 0.0)
    private val latG = listOf(0.0, 0.0, 0.5, 0.9, 0.9, 0.5, 0.0, 0.0, 0.0, 0.8, 0.8, 0.8, 0.0, 0.0, 0.0)

    private fun yaw(scaleAt: (Int) -> Double) = steering.mapIndexed { i, d -> k * v * d * scaleAt(i) }

    private val neutral = LapChannels(
        n = 1,
        timeMs = 90_000,
        speed = List(15) { 100.0 },
        latG = latG,
        steering = steering,
        yaw = yaw { 1.0 },
    )

    private val pushing = neutral.copy(
        n = 2,
        timeMs = 91_000,
        yaw = yaw { if (it >= 9) 0.75 else 1.0 },
    )

    private val channels = SessionChannels(v = 1, dStepM = 20.0, laps = listOf(neutral, pushing))

    private fun sessionOf(vararg laps: LapChannels) =
        SessionChannels(v = 1, dStepM = 20.0, laps = laps.toList())

    @Test
    fun `needs yaw, steering and speed`() {
        assertTrue(Balance.hasBalanceData(neutral))
        assertFalse(Balance.hasBalanceData(LapChannels(n = 1, timeMs = 0, steering = listOf(1.0), yaw = listOf(1.0))))
        assertFalse(Balance.hasBalanceData(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0), yaw = listOf(1.0))))
        assertFalse(Balance.hasBalanceData(null))
        assertEquals(listOf(0, 1), Balance.balanceLaps(channels).map { it.chIdx })
        assertEquals(
            listOf(1),
            Balance.balanceLaps(sessionOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)), pushing))
                .map { it.chIdx },
        )
        assertTrue(Balance.balanceLaps(null).isEmpty())
    }

    @Test
    fun `counts a sample only with steering to divide by and the car moving`() {
        assertTrue(Balance.usableAt(neutral, 3))
        assertFalse(Balance.usableAt(neutral, 0)) // straight
        assertFalse(Balance.usableAt(neutral.copy(steering = steering.map { Balance.MIN_STEER_DEG - 0.1 }), 3))
        assertFalse(Balance.usableAt(neutral.copy(speed = List(15) { Balance.MIN_SPEED_KPH - 1 }), 3))
        assertFalse(Balance.usableAt(neutral, 99))
        assertFalse(Balance.usableAt(LapChannels(n = 1, timeMs = 0, yaw = listOf(1.0)), 0))
    }

    @Test
    fun `the alignment is measured, not assumed`() {
        assertEquals(1.0, Balance.yawSign(channels), 1e-12)
        assertEquals(-1.0, Balance.yawSign(sessionOf(neutral.copy(yaw = neutral.yaw!!.map { -it }))), 1e-12)
        // nothing to measure
        assertEquals(1.0, Balance.yawSign(sessionOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)))), 1e-12)
    }

    @Test
    fun `recovers the car's gain from a usable sample, null otherwise`() {
        assertEquals(k, Balance.yawGain(neutral, 3)!!, 1e-9)
        assertEquals(k, Balance.yawGain(neutral, 9)!!, 1e-9) // a left-hander gives the same gain
        assertEquals(0.75 * k, Balance.yawGain(pushing, 9)!!, 1e-9)
        assertNull(Balance.yawGain(neutral, 0))
        // the alignment sign is applied before dividing
        assertEquals(k, Balance.yawGain(neutral.copy(yaw = neutral.yaw!!.map { -it }), 3, -1.0)!!, 1e-9)
    }

    @Test
    fun `takes the median over every usable sample of every lap`() {
        // 14 usable samples: 11 at K, 3 at 0.75 K — the median is the car, not
        // the corner.
        assertEquals(k, Balance.referenceGain(channels)!!, 1e-9)
        assertNull(Balance.referenceGain(sessionOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)))))
        assertEquals(2.0, Balance.median(listOf(3.0, 1.0, 2.0))!!, 1e-12)
        assertEquals(2.5, Balance.median(listOf(4.0, 1.0, 3.0, 2.0))!!, 1e-12)
        assertNull(Balance.median(emptyList()))
    }

    @Test
    fun `divides the speed out so a neutral car is one line through the origin`() {
        val pts = Balance.balancePoints(neutral)
        assertEquals(15, pts.size)
        assertEquals(40.0, pts[3].steer, 1e-12)
        assertEquals(k * 40, pts[3].rot, 1e-9) // yaw / v = K · δ
        assertEquals(100.0, pts[3].speed, 1e-12)
        assertTrue(pts[3].usable)
        assertFalse(pts[0].usable)
        // a faster lap through the same corner lands on the same line
        val fast = neutral.copy(
            speed = List(15) { 200.0 },
            yaw = steering.map { k * (200.0 / 3.6) * it },
        )
        assertEquals(pts[3].rot, Balance.balancePoints(fast)[3].rot, 1e-9)
    }

    @Test
    fun `skips a stationary sample and applies the alignment sign`() {
        val parked = neutral.copy(speed = neutral.speed!!.mapIndexed { i, s -> if (i == 0) 0.0 else s })
        assertEquals(14, Balance.balancePoints(parked).size)
        assertEquals(
            k * 40,
            Balance.balancePoints(neutral.copy(yaw = neutral.yaw!!.map { -it }), -1.0)[3].rot,
            1e-9,
        )
        assertTrue(Balance.balancePoints(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0))).isEmpty())
    }

    @Test
    fun `reads a corner as the ratio of rotation delivered to rotation asked for`() {
        val corners = Corners.sessionCorners(channels)
        assertEquals(listOf(listOf(2, 5), listOf(9, 11)), corners.map { listOf(it.k0, it.k1) })
        val n1 = Balance.cornerBalance(neutral, corners[0], k)!!
        assertEquals(4, n1.samples)
        assertEquals(1.0, n1.ratio, 1e-9)
        assertEquals(0.0, n1.pct, 1e-9)
        val p2 = Balance.cornerBalance(pushing, corners[1], k)!!
        assertEquals(0.75, p2.ratio, 1e-9)
        assertEquals(-25.0, p2.pct, 1e-9)
        // a left-hander projects onto the steering's direction, so it reads the
        // same way round
        assertEquals(0.0, Balance.cornerBalance(neutral, corners[1], k)!!.pct, 1e-9)
    }

    @Test
    fun `is null without usable samples, a reference, or the channels`() {
        val corners = Corners.sessionCorners(channels)
        val straight = Corners.Corner(n = 1, k0 = 0, k1 = 1, peakG = 0.0, peakK = 0)
        assertNull(Balance.cornerBalance(neutral, straight, k))
        assertNull(Balance.cornerBalance(neutral, corners[0], 0.0))
        assertNull(Balance.cornerBalance(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)), corners[0], k))
    }

    @Test
    fun `names the reading by side and size`() {
        assertEquals("neutral", Balance.balanceLabel(0.0))
        assertEquals("neutral", Balance.balanceLabel(Balance.NEUTRAL_PCT - 0.1))
        assertEquals("slight understeer", Balance.balanceLabel(-Balance.NEUTRAL_PCT))
        assertEquals("slight oversteer", Balance.balanceLabel(Balance.SLIGHT_PCT - 0.1))
        assertEquals("understeer", Balance.balanceLabel(-Balance.SLIGHT_PCT))
        assertEquals("oversteer", Balance.balanceLabel(40.0))
        assertEquals("understeer 25%", Balance.fmtBalance(-25.4))
        assertEquals("slight oversteer 12%", Balance.fmtBalance(12.0))
        assertEquals("neutral", Balance.fmtBalance(3.0))
    }

    @Test
    fun `reads every corner for every readable lap and pools the session`() {
        val sb = Balance.sessionBalance(channels)!!
        assertEquals(1.0, sb.sign, 1e-12)
        assertEquals(k, sb.refGain, 1e-9)
        assertEquals(listOf(1, 2), sb.corners.map { it.corner.n })
        val t2 = sb.corners[1]
        assertEquals(listOf(0, 1), t2.laps.map { it.chIdx })
        assertEquals(0.0, t2.laps[0].pct, 1e-9)
        assertEquals(-25.0, t2.laps[1].pct, 1e-9)
        // pooled: (1 + 0.75) / 2 of the rotation asked for
        assertEquals(-12.5, t2.all.pct, 1e-9)
        assertEquals(6, t2.all.samples)
    }

    @Test
    fun `is null without readable laps, corners, or a reference`() {
        assertNull(Balance.sessionBalance(sessionOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)))))
        // nowhere to find corners
        assertNull(Balance.sessionBalance(sessionOf(neutral.copy(latG = null))))
        // no rotation at all
        assertNull(Balance.sessionBalance(sessionOf(neutral.copy(yaw = neutral.yaw!!.map { 0.0 }))))
        assertNull(Balance.sessionBalance(null))
    }

    @Test
    fun `drops a corner no readable lap steered through`() {
        // Lateral load with the wheel straight — a banked straight, say — is a
        // corner to the segmenter but gives the diagnosis nothing to divide by.
        val banked = neutral.copy(steering = steering.mapIndexed { i, d -> if (i >= 9) 0.0 else d })
        assertEquals(listOf(1), Balance.sessionBalance(sessionOf(banked))!!.corners.map { it.corner.n })
    }

    @Test
    fun `names the corners that sit off the reference, pooled across laps`() {
        assertEquals("understeer in T2", Balance.balanceSummary(channels))
        assertEquals("balance neutral", Balance.balanceSummary(sessionOf(neutral)))
        val loose = neutral.copy(yaw = neutral.yaw!!.mapIndexed { i, y -> if (i >= 9) y * 1.3 else y })
        assertEquals("oversteer in T2", Balance.balanceSummary(sessionOf(loose)))
        assertNull(Balance.balanceSummary(sessionOf(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)))))
    }

    @Test
    fun `counts rather than names once there are more than three`() {
        // Eight corners, the odd ones pushing.
        val st = ArrayList<Double>()
        val lg = ArrayList<Double>()
        val yw = ArrayList<Double>()
        for (c in 0 until 8) {
            st.addAll(listOf(0.0, 0.0, 30.0, 30.0, 30.0, 0.0))
            lg.addAll(listOf(0.0, 0.0, 0.8, 0.8, 0.8, 0.0))
            val s = if (c % 2 == 1) 0.7 else 1.0
            yw.addAll(listOf(0.0, 0.0, k * v * 30 * s, k * v * 30 * s, k * v * 30 * s, 0.0))
        }
        val many = LapChannels(
            n = 1,
            timeMs = 90_000,
            speed = List(st.size) { 100.0 },
            latG = lg,
            steering = st,
            yaw = yw,
        )
        // With four pushing and four neutral, the median sits between them and
        // both sides read off it — the relative reading, stated in the docs.
        assertEquals(
            "understeer in 4 corners and oversteer in 4 corners",
            Balance.balanceSummary(sessionOf(many)),
        )
        val few = many.copy(
            speed = List(36) { 100.0 },
            latG = lg.take(36),
            steering = st.take(36),
            yaw = yw.take(36),
        )
        assertEquals(
            "understeer in T2, T4, T6 and oversteer in T1, T3, T5",
            Balance.balanceSummary(sessionOf(few)),
        )
    }

    // ---- cross-language pin ------------------------------------------------

    /** One corner of the fixture's `sessionBalance` — the corner keys, then the
     * per-lap readings and the pooled one. `laps` is the readings array here:
     * the JS spreads the corner and then overwrites its lap *count* with them. */
    @Serializable
    private data class SessionCornerRow(
        val n: Int,
        val k0: Int,
        val k1: Int,
        val peakG: Double,
        val peakK: Int,
        val laps: List<Balance.LapReading>,
        val all: Balance.Reading,
    )

    @Serializable
    private data class SessionRow(
        val sign: Double,
        val refGain: Double,
        val corners: List<SessionCornerRow>,
    )

    /**
     * The JS implementation's own output for a shared input has to come back out
     * of this port: the wording exactly, the doubles to 1e-9.
     */
    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/balance.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val fixtureChannels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)
        val flipped = json.decodeFromJsonElement<SessionChannels>(input["flipped"]!!)
        val edgeLap = json.decodeFromJsonElement<LapChannels>(input["edgeLap"]!!)
        val mixedLap = json.decodeFromJsonElement<LapChannels>(input["mixedLap"]!!)
        val bankedLap = json.decodeFromJsonElement<LapChannels>(input["bankedLap"]!!)
        val manyLap = json.decodeFromJsonElement<LapChannels>(input["manyLap"]!!)
        val fewLap = json.decodeFromJsonElement<LapChannels>(input["fewLap"]!!)
        val refGain = input["refGain"]!!.jsonPrimitive.content.toDouble()
        val pcts = json.decodeFromJsonElement<List<Double>>(input["pcts"]!!)
        val lapA = fixtureChannels.laps[0]
        val lapB = fixtureChannels.laps[1]

        // The alignment: measured, and the flipped recorder reads the same car.
        assertEquals(expected["sign"]!!.jsonPrimitive.content.toDouble(), Balance.yawSign(fixtureChannels), 1e-12)
        assertEquals(expected["flippedSign"]!!.jsonPrimitive.content.toDouble(), Balance.yawSign(flipped), 1e-12)
        assertEquals(expected["flippedSummary"]!!.jsonPrimitive.content, Balance.balanceSummary(flipped))

        // Both usability bounds are inclusive, and the stationary sample leaves
        // the scatter rather than plotting at the origin.
        val wantUsable = json.decodeFromJsonElement<List<Boolean>>(expected["edgeUsable"]!!)
        assertEquals(wantUsable, wantUsable.indices.map { Balance.usableAt(edgeLap, it) })
        assertSamePoints(
            json.decodeFromJsonElement<List<Balance.Point>>(expected["edgePoints"]!!),
            Balance.balancePoints(edgeLap),
            "edge points",
        )

        val wantGains = json.decodeFromJsonElement<List<Double?>>(expected["gainsAt"]!!)
        listOf(0, 3, 9).forEachIndexed { i, gridK ->
            val got = Balance.yawGain(lapA, gridK)
            val want = wantGains[i]
            if (want == null) assertNull(got, "gain at $gridK") else assertEquals(want, got!!, 1e-9, "gain at $gridK")
        }
        val wantPushing = json.decodeFromJsonElement<List<Double>>(expected["pushingGainsAt"]!!)
        listOf(3, 9).forEachIndexed { i, gridK ->
            assertEquals(wantPushing[i], Balance.yawGain(lapB, gridK)!!, 1e-9)
        }
        assertEquals(
            expected["refGain"]!!.jsonPrimitive.content.toDouble(),
            Balance.referenceGain(fixtureChannels)!!,
            1e-9,
        )
        val wantMedians = json.decodeFromJsonElement<List<Double?>>(expected["medians"]!!)
        assertEquals(wantMedians[0]!!, Balance.median(listOf(3.0, 1.0, 2.0))!!, 1e-12)
        assertEquals(wantMedians[1]!!, Balance.median(listOf(4.0, 1.0, 3.0, 2.0))!!, 1e-12)
        assertTrue(wantMedians[2] == null && Balance.median(emptyList()) == null)

        val wantPoints = json.decodeFromJsonElement<List<List<Balance.Point>>>(expected["points"]!!)
        assertSamePoints(wantPoints[0], Balance.balancePoints(lapA), "lap A points")
        assertSamePoints(wantPoints[1], Balance.balancePoints(lapB), "lap B points")

        val wantCorners = json.decodeFromJsonElement<List<Corners.Corner>>(expected["corners"]!!)
        val corners = Corners.sessionCorners(fixtureChannels)
        assertEquals(wantCorners.map { it.n }, corners.map { it.n })
        assertEquals(wantCorners.map { it.k0 }, corners.map { it.k0 })
        assertEquals(wantCorners.map { it.k1 }, corners.map { it.k1 })

        val wantReadings = json.decodeFromJsonElement<List<List<Balance.Reading?>>>(expected["cornerReadings"]!!)
        corners.forEachIndexed { i, c ->
            assertSameReading(wantReadings[i][0], Balance.cornerBalance(lapA, c, refGain), "corner $i lap A")
            assertSameReading(wantReadings[i][1], Balance.cornerBalance(lapB, c, refGain), "corner $i lap B")
        }

        // Summed, not averaged: a port that means the per-sample ratios reads
        // +100% here rather than +46%.
        val mixedCorner = Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(mixedLap)))[0]
        assertSameReading(
            json.decodeFromJsonElement<Balance.Reading>(expected["mixed"]!!),
            Balance.cornerBalance(mixedLap, mixedCorner, refGain),
            "mixed corner",
        )

        val wantSession = json.decodeFromJsonElement<SessionRow>(expected["session"]!!)
        val session = Balance.sessionBalance(fixtureChannels)!!
        assertEquals(wantSession.sign, session.sign, 1e-12)
        assertEquals(wantSession.refGain, session.refGain, 1e-9)
        assertEquals(wantSession.corners.map { it.n }, session.corners.map { it.corner.n })
        session.corners.forEachIndexed { i, row ->
            val want = wantSession.corners[i]
            assertEquals(want.laps.map { it.chIdx }, row.laps.map { it.chIdx }, "session corner $i laps")
            row.laps.forEachIndexed { j, lap ->
                assertEquals(want.laps[j].pct, lap.pct, 1e-9, "session corner $i lap $j pct")
                assertEquals(want.laps[j].samples, lap.samples, "session corner $i lap $j samples")
            }
            assertEquals(want.all.pct, row.all.pct, 1e-9, "session corner $i pooled pct")
            assertEquals(want.all.samples, row.all.samples, "session corner $i pooled samples")
        }

        assertEquals(
            json.decodeFromJsonElement<List<Int>>(expected["banked"]!!),
            Balance.sessionBalance(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(bankedLap)))!!
                .corners.map { it.corner.n },
        )

        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["labels"]!!),
            pcts.map { Balance.balanceLabel(it) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["formatted"]!!),
            pcts.map { Balance.fmtBalance(it) },
        )
        assertEquals(expected["summary"]!!.jsonPrimitive.content, Balance.balanceSummary(fixtureChannels))
        assertEquals(
            expected["neutralSummary"]!!.jsonPrimitive.content,
            Balance.balanceSummary(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(lapA))),
        )
        assertEquals(
            expected["manySummary"]!!.jsonPrimitive.content,
            Balance.balanceSummary(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(manyLap))),
        )
        assertEquals(
            expected["fewSummary"]!!.jsonPrimitive.content,
            Balance.balanceSummary(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(fewLap))),
        )
        // The third fixture lap has cornering force but no yaw.
        assertNull(
            Balance.sessionBalance(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(fixtureChannels.laps[2]))),
        )
    }

    private fun assertSamePoints(want: List<Balance.Point>, got: List<Balance.Point>, label: String) {
        assertEquals(want.size, got.size, "$label count")
        want.forEachIndexed { i, w ->
            assertEquals(w.k, got[i].k, "$label [$i] k")
            assertEquals(w.usable, got[i].usable, "$label [$i] usable")
            assertEquals(w.steer, got[i].steer, 1e-9, "$label [$i] steer")
            assertEquals(w.rot, got[i].rot, 1e-9, "$label [$i] rot")
            assertEquals(w.speed, got[i].speed, 1e-9, "$label [$i] speed")
        }
    }

    private fun assertSameReading(want: Balance.Reading?, got: Balance.Reading?, label: String) {
        if (want == null || got == null) {
            assertTrue(want == null && got == null, "$label: one side is null")
            return
        }
        assertEquals(want.samples, got.samples, "$label samples")
        assertTrue(abs(want.expected - got.expected) < 1e-9, "$label expected")
        assertTrue(abs(want.actual - got.actual) < 1e-9, "$label actual")
        assertTrue(abs(want.ratio - got.ratio) < 1e-9, "$label ratio")
        assertTrue(abs(want.pct - got.pct) < 1e-9, "$label pct")
    }
}
