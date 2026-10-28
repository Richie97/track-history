package app.trackevolution.core

import app.trackevolution.core.VideoSync.SideKey
import app.trackevolution.core.VideoSync.SyncMode
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.UnitSystem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/video-sync.test.js`, case for case, plus the
 * cross-language pin against `contracts/logic/video-sync.json` — every row,
 * numbers to 1e-9 and strings exactly.
 */
class VideoSyncTest {

    // Two laps on the same 20 m grid: A is quick, B a touch slower everywhere
    // and much slower through the corner at k 10–14, so "place" and "time" disagree.
    private val n = 30
    private val latG = List(n) { k -> if (k in 10..14) 1.1 else if (k in 22..25) 0.8 else 0.05 }
    private val speedA = List(n) { k -> if (k in 10..14) 90.0 else 160.0 }
    private val speedB = speedA.mapIndexed { k, v -> if (k in 10..14) v - 20 else v - 4 }
    private val entryA = LapChannels(
        n = 3, timeMs = 15_000, speed = speedA, latG = latG,
        throttle = speedA.map { if (it > 100) 100.0 else 20.0 },
        brake = List(n) { k -> if (k == 9) 70.0 else 0.0 },
        gear = speedA.map { if (it > 100) 4.0 else 3.0 },
    )
    private val entryB = LapChannels(n = 5, timeMs = 16_200, speed = speedB, latG = latG)
    private val a = VideoSync.makeSide(SideKey.A, entryA, 20.0, VideoSync.SideClip(3_000.0, 22_000.0))!!
    private val b = VideoSync.makeSide(SideKey.B, entryB, 20.0, VideoSync.SideClip(3_400.0, 23_600.0))!!
    private val ab = VideoSync.Sides(a, b)
    private val corners = Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(entryA, entryB)))

    private val metric = UnitSystem.METRIC
    private val imperial = UnitSystem.IMPERIAL

    // ---- gridAtElapsed / valueAt ----------------------------------------------

    @Test
    fun `gridAtElapsed clamps before the line and past the end`() {
        val t = listOf(0.0, 1.0, 3.0, 6.0)
        assertEquals(0.0, VideoSync.gridAtElapsed(t, -1.0))
        assertEquals(0.0, VideoSync.gridAtElapsed(t, 0.0))
        assertEquals(3.0, VideoSync.gridAtElapsed(t, 6.0))
        assertEquals(3.0, VideoSync.gridAtElapsed(t, 9.0))
    }

    @Test
    fun `gridAtElapsed interpolates between points and lands exactly on one`() {
        val t = listOf(0.0, 1.0, 3.0, 6.0)
        assertEquals(1.5, VideoSync.gridAtElapsed(t, 2.0))
        assertEquals(2.0, VideoSync.gridAtElapsed(t, 3.0))
        assertEquals(2.5, VideoSync.gridAtElapsed(t, 4.5))
    }

    @Test
    fun `gridAtElapsed is the inverse of valueAt on the time curve`() {
        for (k in listOf(0.0, 0.25, 7.5, 13.2, (n - 1).toDouble())) {
            assertEquals(k, VideoSync.gridAtElapsed(a.t, VideoSync.valueAt(a.t, k)!!), 1e-9)
        }
    }

    @Test
    fun `valueAt clamps k and returns null for a missing series`() {
        assertEquals(2.0, VideoSync.valueAt(listOf(1.0, 3.0), 0.5))
        assertEquals(1.0, VideoSync.valueAt(listOf(1.0, 3.0), -4.0))
        assertEquals(3.0, VideoSync.valueAt(listOf(1.0, 3.0), 9.0))
        assertNull(VideoSync.valueAt(null, 1.0))
        assertNull(VideoSync.valueAt(emptyList(), 1.0))
    }

    @Test
    fun `lapTimeSeries stays strictly increasing through a standstill`() {
        val t = ChannelGraphs.lapTimeSeries(listOf(0.0, 0.0, 0.0, 40.0, 80.0, 0.0, 0.0, 60.0), 20.0, 30_000)
        for (k in 1 until t.size) assertTrue(t[k] > t[k - 1])
    }

    // ---- makeSide -------------------------------------------------------------

    @Test
    fun `makeSide integrates the time curve once and takes a stored one instead`() {
        assertEquals(15.0, a.t.last(), 1e-9)
        val stored = List(n) { k -> k / 2.0 }
        assertSame(stored, VideoSync.makeSide(SideKey.A, entryA, 20.0, null, stored)!!.t)
    }

    @Test
    fun `makeSide is null without a speed trace, and drops a clip with no offset`() {
        assertNull(VideoSync.makeSide(SideKey.A, LapChannels(n = 1, timeMs = 1), 20.0, null))
        assertNull(VideoSync.makeSide(SideKey.A, entryA, 20.0, VideoSync.SideClip(null, 1.0))!!.clip)
    }

    // ---- sideAtClipTime / clipTimeAtGrid --------------------------------------

    @Test
    fun `round-trips at the line, mid-lap and the end`() {
        for (k in listOf(0.0, 12.5, (n - 1).toDouble())) {
            val c = VideoSync.clipTimeAtGrid(a, k)
            val s = VideoSync.sideAtClipTime(a, c)
            assertEquals(k, s.k, 1e-9)
            assertTrue(s.inLap)
        }
        assertEquals(3_000.0, VideoSync.clipTimeAtGrid(a, 0.0))
        assertEquals(18_000.0, VideoSync.clipTimeAtGrid(a, (n - 1).toDouble()), 1e-6)
    }

    @Test
    fun `is out of the lap in the pre- and post-roll`() {
        assertEquals(VideoSync.SideAt(-2.0, 0.0, false), VideoSync.sideAtClipTime(a, 1_000.0))
        val post = VideoSync.sideAtClipTime(a, 20_000.0)
        assertFalse(post.inLap)
        assertEquals((n - 1).toDouble(), post.k)
    }

    @Test
    fun `scrubs from two seconds before the line to two after`() {
        assertEquals(-2.0, VideoSync.scrubRange(a).min)
        assertEquals(17.0, VideoSync.scrubRange(a).max, 1e-9)
    }

    // ---- playheadAt -----------------------------------------------------------

    @Test
    fun `holds both cars at one distance in place mode`() {
        val s = VideoSync.playheadAt(ab, SideKey.A, 8.0, SyncMode.PLACE)
        assertEquals(s.a.k, s.b!!.k, 1e-9)
        assertTrue(s.b!!.e > 8) // B is slower, so later at the same place
        assertEquals(s.a.e - s.b!!.e, s.deltaS!!, 1e-9)
        assertTrue(s.deltaS!! < 0)
        assertNull(s.gapM)
        assertEquals(3_400 + 1000 * s.b!!.e, s.b!!.clipMs!!, 1e-6)
    }

    @Test
    fun `holds both at one time in time mode, the gap negative when B is behind`() {
        val s = VideoSync.playheadAt(ab, SideKey.A, 8.0, SyncMode.TIME)
        assertEquals(8.0, s.b!!.e)
        assertTrue(s.b!!.k < s.a.k)
        assertEquals((s.b!!.k - s.a.k) * 20, s.gapM!!, 1e-9)
        assertTrue(s.gapM!! < 0)
    }

    @Test
    fun `follows a swapped master and still reports A's delta`() {
        val s = VideoSync.playheadAt(ab, SideKey.B, 8.0, SyncMode.PLACE)
        assertEquals(SideKey.B, s.masterKey)
        assertEquals(8.0, s.b!!.e)
        assertEquals(s.b!!.k, s.a.k, 1e-9)
        assertTrue(s.deltaS!! < 0)
    }

    @Test
    fun `is out of the lap before the line, with both cars the same time short of it`() {
        val s = VideoSync.playheadAt(ab, SideKey.A, -1.5, SyncMode.PLACE)
        assertFalse(s.inLap)
        assertEquals(-1.5, s.b!!.e)
        assertFalse(s.a.inLap)
        assertNull(s.deltaS)
        assertEquals(1_500.0, s.a.clipMs)
    }

    @Test
    fun `rolls both out the same time past the line in place mode`() {
        val s = VideoSync.playheadAt(ab, SideKey.A, 15.5, SyncMode.PLACE)
        assertFalse(s.inLap)
        assertEquals(16.7, s.b!!.e, 1e-9)
    }

    @Test
    fun `matches laps by fraction when their lengths differ past the warning`() {
        val short = VideoSync.makeSide(SideKey.B, entryB.copy(speed = speedB.take(25)), 20.0, null)!!
        assertTrue(VideoSync.matchByFraction(a, short))
        val s = VideoSync.playheadAt(VideoSync.Sides(a, short), SideKey.A, 7.0, SyncMode.PLACE)
        assertTrue(s.byFraction)
        assertEquals(s.a.k * 24 / 29, s.b!!.k, 1e-9)
        assertNull(s.b!!.clipMs)
        assertFalse(s.b!!.inClip)
    }

    @Test
    fun `is one-sided without B`() {
        val s = VideoSync.playheadAt(VideoSync.Sides(a, null), SideKey.A, 4.0)
        assertEquals(VideoSync.DEFAULT_SYNC_MODE, s.mode)
        assertNull(s.b)
        assertNull(s.deltaS)
        assertEquals(160.0, s.a.now.speedKph)
        assertEquals(4.0, s.a.now.gear)
    }

    @Test
    fun `says when a side's clip doesn't hold the moment`() {
        val late = VideoSync.Sides(VideoSync.makeSide(SideKey.A, entryA, 20.0, VideoSync.SideClip(500.0, 9_000.0))!!)
        assertFalse(VideoSync.playheadAt(late, SideKey.A, -1.0).a.inClip)
        assertTrue(VideoSync.playheadAt(late, SideKey.A, 4.0).a.inClip)
        assertFalse(VideoSync.playheadAt(late, SideKey.A, 10.0).a.inClip)
    }

    // ---- followRate / needsResync ---------------------------------------------

    @Test
    fun `followRate is the master's speed over the follower's, clamped`() {
        assertEquals(90.0 / 70.0, VideoSync.followRate(ab, SideKey.A, 12.0), 1e-9)
        assertEquals(1.0, VideoSync.followRate(VideoSync.Sides(a), SideKey.A, 12.0))
        val crawl = VideoSync.makeSide(SideKey.B, entryB.copy(speed = speedB.map { 10.0 }), 20.0, null)!!
        assertEquals(VideoSync.FOLLOW_RATE_MAX, VideoSync.followRate(VideoSync.Sides(a, crawl), SideKey.A, 2.0))
        assertEquals(VideoSync.FOLLOW_RATE_MIN, VideoSync.followRate(VideoSync.Sides(a, crawl), SideKey.B, 2.0))
    }

    @Test
    fun `re-seeks only past RESYNC_MS`() {
        assertEquals(150.0, VideoSync.RESYNC_MS)
        assertFalse(VideoSync.needsResync(1000.0, 1149.0))
        assertFalse(VideoSync.needsResync(1000.0, 1150.0))
        assertTrue(VideoSync.needsResync(1000.0, 1151.0))
        assertTrue(VideoSync.needsResync(1000.0, 849.0))
    }

    // ---- words ----------------------------------------------------------------

    @Test
    fun `formats the clock, the delta and the gap`() {
        assertEquals("0:36.0", VideoSync.fmtStageTime(36.0))
        assertEquals("2:19.8", VideoSync.fmtStageTime(139.84))
        assertEquals("−0:01.5", VideoSync.fmtStageTime(-1.5))
        assertEquals("0:00.0", VideoSync.fmtStageTime(-0.01))
        assertEquals("1:00.0", VideoSync.fmtStageTime(59.96))
        assertEquals("+0.31 s", VideoSync.fmtDeltaS(0.314))
        assertEquals("−0.12 s", VideoSync.fmtDeltaS(-0.12))
        assertEquals("0.00 s", VideoSync.fmtDeltaS(0.004))
        assertEquals("B ahead 26 m", VideoSync.fmtGap(26.2, metric))
        assertEquals("A ahead 86 ft", VideoSync.fmtGap(-26.2, imperial))
        assertEquals("Level", VideoSync.fmtGap(0.1, metric))
    }

    @Test
    fun `places k among the corners`() {
        assertEquals(listOf(listOf(10, 14), listOf(22, 25)), corners.map { listOf(it.k0, it.k1) })
        assertEquals("before T1", VideoSync.cornerPlace(corners, 3.0))
        assertEquals("in T1", VideoSync.cornerPlace(corners, 12.0))
        assertEquals("after T1", VideoSync.cornerPlace(corners, 18.0))
        assertEquals("after T2", VideoSync.cornerPlace(corners, 28.0))
        assertNull(VideoSync.cornerPlace(emptyList(), 5.0))
    }

    @Test
    fun `words a corner, a straight and the run-up, in both systems`() {
        val inCorner = VideoSync.playheadAt(ab, SideKey.A, VideoSync.valueAt(a.t, 12.0)!!, SyncMode.PLACE)
        assertEquals(
            VideoSync.PlayheadText(
                place = "240 m · in T1",
                value = "${VideoSync.fmtStageTime(inCorner.a.e)}, 240 m, in T1, 90 km/h, throttle 20 %, ${VideoSync.fmtDeltaS(inCorner.deltaS)}",
                delta = VideoSync.fmtDeltaS(inCorner.deltaS),
            ),
            VideoSync.playheadText(inCorner, corners, metric),
        )
        val braking = VideoSync.playheadAt(VideoSync.Sides(a), SideKey.A, VideoSync.valueAt(a.t, 9.0)!!, SyncMode.PLACE)
        assertEquals(
            "${VideoSync.fmtStageTime(braking.a.e)}, 591 ft, before T1, 99 mph, braking 70 %",
            VideoSync.playheadText(braking, corners, imperial).value,
        )
        val time = VideoSync.playheadAt(ab, SideKey.A, 12.0, SyncMode.TIME)
        assertEquals(VideoSync.fmtGap(time.gapM, metric), VideoSync.playheadText(time, corners, metric).delta)
        assertEquals(
            VideoSync.PlayheadText("Before the line", "−0:01.0, Before the line", null),
            VideoSync.playheadText(VideoSync.playheadAt(ab, SideKey.A, -1.0, SyncMode.PLACE), corners, metric),
        )
        assertEquals(
            "After the line",
            VideoSync.playheadText(VideoSync.playheadAt(ab, SideKey.A, 16.0, SyncMode.PLACE), corners, metric).place,
        )
    }

    @Test
    fun `stops at each corner's start`() {
        assertEquals(
            listOf(
                VideoSync.CornerStop("T1", VideoSync.valueAt(a.t, 10.0)!!),
                VideoSync.CornerStop("T2", VideoSync.valueAt(a.t, 22.0)!!),
            ),
            VideoSync.cornerStops(corners, a.t),
        )
    }

    // ---- referenceLap / stageSides --------------------------------------------

    private val refLaps = listOf(
        Lap(id = 1, sessionId = 1, lapNum = 1, timeMs = 95_000),
        Lap(id = 2, sessionId = 1, lapNum = 2, timeMs = 91_000),
        Lap(id = 3, sessionId = 1, lapNum = 3, timeMs = 92_000),
        Lap(id = 4, sessionId = 1, lapNum = 4, timeMs = 90_500), // typed in: no channels
    )
    private val refCh = listOf(95_000, 91_000, 92_000).mapIndexed { i, t -> LapChannels(n = i + 1, timeMs = t) }

    @Test
    fun `referenceLap is the session best, the next-best for the best, or nothing alone`() {
        val matched = ChannelGraphs.matchLapsToChannels(refLaps, refCh)
        assertEquals(1, VideoSync.referenceLap(matched, 0)!!.chIdx)
        assertEquals(2, VideoSync.referenceLap(matched, 1)!!.chIdx)
        assertNull(VideoSync.referenceLap(ChannelGraphs.matchLapsToChannels(refLaps.take(1), refCh.take(1)), 0))
    }

    @Test
    fun `stageSides puts the opened lap on A when lit, else the newest, and the fastest other on B`() {
        assertEquals(VideoSync.StageSides(2, 1), VideoSync.stageSides(listOf(0, 2, 1), refCh, 2))
        assertEquals(VideoSync.StageSides(2, 0), VideoSync.stageSides(listOf(0, 2), refCh, 1))
        assertEquals(VideoSync.StageSides(1, null), VideoSync.stageSides(listOf(1), refCh, 1))
        assertNull(VideoSync.stageSides(emptyList(), refCh, 1))
    }

    @Test
    fun `names the two modes, place first`() {
        assertEquals(listOf("place", "time"), VideoSync.SYNC_MODES.map { it.key })
        assertEquals(SyncMode.PLACE, VideoSync.DEFAULT_SYNC_MODE)
        assertEquals(SyncMode.TIME, SyncMode.fromKey("time"))
        assertEquals(SyncMode.PLACE, SyncMode.fromKey("sideways"))
        assertEquals(SyncMode.PLACE, SyncMode.fromKey(null))
    }

    // ---- the fixture ----------------------------------------------------------

    private val json = Json { ignoreUnknownKeys = true }

    private fun num(expected: JsonElement?, actual: Double?, what: String) {
        if (expected == null || expected is JsonNull) {
            assertNull(actual, what)
        } else {
            assertNotNull(actual, what)
            assertEquals(expected.jsonPrimitive.double, actual!!, 1e-9, what)
        }
    }

    private fun str(expected: JsonElement?, actual: String?, what: String) {
        if (expected == null || expected is JsonNull) assertNull(actual, what) else assertEquals(expected.jsonPrimitive.content, actual, what)
    }

    private fun bool(expected: JsonElement?, actual: Boolean, what: String) =
        assertEquals(expected!!.jsonPrimitive.booleanOrNull, actual, what)

    private fun units(s: String) = if (s == "metric") UnitSystem.METRIC else UnitSystem.IMPERIAL

    private fun sideState(expected: JsonElement?, actual: VideoSync.SideState?, what: String) {
        if (expected == null || expected is JsonNull) {
            assertNull(actual, what)
            return
        }
        val o = expected.jsonObject
        assertNotNull(actual, what)
        val s = actual!!
        num(o["e"], s.e, "$what.e")
        num(o["k"], s.k, "$what.k")
        num(o["distM"], s.distM, "$what.distM")
        bool(o["inLap"], s.inLap, "$what.inLap")
        num(o["clipMs"], s.clipMs, "$what.clipMs")
        bool(o["inClip"], s.inClip, "$what.inClip")
        val now = o["now"]!!.jsonObject
        num(now["speedKph"], s.now.speedKph, "$what.now.speedKph")
        num(now["throttle"], s.now.throttle, "$what.now.throttle")
        num(now["brake"], s.now.brake, "$what.now.brake")
        num(now["gear"], s.now.gear, "$what.now.gear")
    }

    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val fixture = Json.parseToJsonElement(RepoRoot.path("contracts/logic/video-sync.json").readText()).jsonObject
        val c = fixture["constants"]!!.jsonObject
        assertEquals(c["syncModes"]!!.jsonArray.map { it.jsonPrimitive.content }, VideoSync.SYNC_MODES.map { it.key })
        assertEquals(c["defaultSyncMode"]!!.jsonPrimitive.content, VideoSync.DEFAULT_SYNC_MODE.key)
        num(c["resyncMs"], VideoSync.RESYNC_MS, "RESYNC_MS")
        num(c["followRateMin"], VideoSync.FOLLOW_RATE_MIN, "FOLLOW_RATE_MIN")
        num(c["followRateMax"], VideoSync.FOLLOW_RATE_MAX, "FOLLOW_RATE_MAX")
        num(c["brakingWordPct"], VideoSync.BRAKING_WORD_PCT, "BRAKING_WORD_PCT")

        val input = fixture["input"]!!.jsonObject
        val dStepM = input["dStepM"]!!.jsonPrimitive.double
        fun entry(name: String) = json.decodeFromJsonElement<LapChannels>(input[name]!!)
        fun clip(name: String) = input[name]!!.jsonObject.let {
            VideoSync.SideClip(it["lapOffsetMs"]!!.jsonPrimitive.double, it["durationMs"]?.jsonPrimitive?.doubleOrNull)
        }
        val eA = entry("entryA")
        val eB = entry("entryB")
        val sA = VideoSync.makeSide(SideKey.A, eA, dStepM, clip("clipA"))!!
        val sB = VideoSync.makeSide(SideKey.B, eB, dStepM, clip("clipB"))!!
        val sShort = VideoSync.makeSide(SideKey.B, entry("entryShort"), dStepM, null)!!
        val sLate = VideoSync.makeSide(SideKey.A, eA, dStepM, clip("clipLate"))!!
        val sCrawl = VideoSync.makeSide(SideKey.B, eB.copy(speed = eB.speed!!.map { 10.0 }), dStepM, null)!!
        val sides = mapOf(
            "AB" to VideoSync.Sides(sA, sB),
            "AShort" to VideoSync.Sides(sA, sShort),
            "A" to VideoSync.Sides(sA),
            "Late" to VideoSync.Sides(sLate),
            "ACrawl" to VideoSync.Sides(sA, sCrawl),
        )

        val ex = fixture["expected"]!!.jsonObject
        ex["timeCurveA"]!!.jsonArray.forEachIndexed { i, v -> num(v, sA.t[i], "timeCurveA[$i]") }
        ex["timeCurveB"]!!.jsonArray.forEachIndexed { i, v -> num(v, sB.t[i], "timeCurveB[$i]") }
        assertEquals(sA.t.size, ex["timeCurveA"]!!.jsonArray.size)

        val fxCorners = ex["corners"]!!.jsonArray.map { json.decodeFromJsonElement<Corners.Corner>(it) }
        assertEquals(
            fxCorners,
            Corners.sessionCorners(SessionChannels(v = 1, dStepM = dStepM, laps = listOf(eA, eB))),
        )

        for (row in ex["gridAtElapsed"]!!.jsonArray.map { it.jsonObject }) {
            val t = row["t"]!!.jsonArray.map { it.jsonPrimitive.double }
            val e = row["e"]!!.jsonPrimitive.double
            num(row["k"], VideoSync.gridAtElapsed(t, e), "gridAtElapsed($e)")
        }
        for (row in ex["valueAt"]!!.jsonArray.map { it.jsonObject }) {
            val series = row["series"]!!.jsonArray.map { it.jsonPrimitive.double }
            val k = row["k"]!!.jsonPrimitive.double
            num(row["value"], VideoSync.valueAt(series, k), "valueAt($series, $k)")
        }
        for (row in ex["sideAtClipTime"]!!.jsonArray.map { it.jsonObject }) {
            val clipMs = row["clipMs"]!!.jsonPrimitive.double
            val at = row["at"]!!.jsonObject
            val got = VideoSync.sideAtClipTime(sA, clipMs)
            num(at["e"], got.e, "sideAtClipTime($clipMs).e")
            num(at["k"], got.k, "sideAtClipTime($clipMs).k")
            bool(at["inLap"], got.inLap, "sideAtClipTime($clipMs).inLap")
        }
        for (row in ex["clipTimeAtGrid"]!!.jsonArray.map { it.jsonObject }) {
            val k = row["k"]!!.jsonPrimitive.double
            num(row["clipMs"], VideoSync.clipTimeAtGrid(sA, k), "clipTimeAtGrid($k)")
        }
        ex["scrubRange"]!!.jsonObject.let {
            num(it["min"], VideoSync.scrubRange(sA).min, "scrubRange.min")
            num(it["max"], VideoSync.scrubRange(sA).max, "scrubRange.max")
        }
        ex["matchByFraction"]!!.jsonObject.let {
            bool(it["ab"], VideoSync.matchByFraction(sA, sB), "matchByFraction(ab)")
            bool(it["aShort"], VideoSync.matchByFraction(sA, sShort), "matchByFraction(aShort)")
        }

        val playheads = ex["playheadAt"]!!.jsonArray.map { it.jsonObject }
        assertEquals(13, playheads.size)
        for (row in playheads) {
            val name = row["name"]!!.jsonPrimitive.content
            val got = VideoSync.playheadAt(
                sides.getValue(row["sides"]!!.jsonPrimitive.content),
                SideKey.valueOf(row["masterKey"]!!.jsonPrimitive.content),
                row["eMaster"]!!.jsonPrimitive.double,
                SyncMode.fromKey(row["mode"]!!.jsonPrimitive.content),
            )
            val s = row["state"]!!.jsonObject
            assertEquals(s["mode"]!!.jsonPrimitive.content, got.mode.key, "$name.mode")
            assertEquals(s["masterKey"]!!.jsonPrimitive.content, got.masterKey.name, "$name.masterKey")
            bool(s["inLap"], got.inLap, "$name.inLap")
            bool(s["byFraction"], got.byFraction, "$name.byFraction")
            sideState(s["a"], got.a, "$name.a")
            sideState(s["b"], got.b, "$name.b")
            num(s["deltaS"], got.deltaS, "$name.deltaS")
            num(s["gapM"], got.gapM, "$name.gapM")
        }

        for (row in ex["followRate"]!!.jsonArray.map { it.jsonObject }) {
            val key = row["sides"]!!.jsonPrimitive.content
            val master = SideKey.valueOf(row["masterKey"]!!.jsonPrimitive.content)
            val k = row["k"]!!.jsonPrimitive.double
            num(row["rate"], VideoSync.followRate(sides.getValue(key), master, k), "followRate($key, $master, $k)")
        }
        for (row in ex["needsResync"]!!.jsonArray.map { it.jsonObject }) {
            val target = row["targetMs"]!!.jsonPrimitive.double
            val actual = row["actualMs"]!!.jsonPrimitive.double
            bool(row["resync"], VideoSync.needsResync(target, actual), "needsResync($target, $actual)")
        }
        for (row in ex["fmtStageTime"]!!.jsonArray.map { it.jsonObject }) {
            val s = row["s"]!!.jsonPrimitive.double
            str(row["text"], VideoSync.fmtStageTime(s), "fmtStageTime($s)")
        }
        for (row in ex["fmtDeltaS"]!!.jsonArray.map { it.jsonObject }) {
            val d = row["d"]!!.jsonPrimitive.double
            str(row["text"], VideoSync.fmtDeltaS(d), "fmtDeltaS($d)")
        }
        for (row in ex["fmtGap"]!!.jsonArray.map { it.jsonObject }) {
            val g = row["gapM"]!!.jsonPrimitive.double
            str(row["text"], VideoSync.fmtGap(g, units(row["units"]!!.jsonPrimitive.content)), "fmtGap($g)")
        }
        for (row in ex["cornerPlace"]!!.jsonArray.map { it.jsonObject }) {
            val k = row["k"]!!.jsonPrimitive.double
            str(row["text"], VideoSync.cornerPlace(fxCorners, k), "cornerPlace($k)")
        }
        val texts = ex["playheadText"]!!.jsonArray.map { it.jsonObject }
        assertEquals(14, texts.size)
        for (row in texts) {
            val name = "${row["name"]!!.jsonPrimitive.content} (${row["units"]!!.jsonPrimitive.content})"
            val state = VideoSync.playheadAt(
                sides.getValue(row["sides"]!!.jsonPrimitive.content),
                SideKey.A,
                row["eMaster"]!!.jsonPrimitive.double,
                SyncMode.fromKey(row["mode"]!!.jsonPrimitive.content),
            )
            val got = VideoSync.playheadText(state, fxCorners, units(row["units"]!!.jsonPrimitive.content))
            val t = row["text"]!!.jsonObject
            str(t["place"], got.place, "$name.place")
            str(t["value"], got.value, "$name.value")
            str(t["delta"], got.delta, "$name.delta")
        }
        val stops = VideoSync.cornerStops(fxCorners, sA.t)
        val fxStops = ex["cornerStops"]!!.jsonArray.map { it.jsonObject }
        assertEquals(fxStops.size, stops.size)
        fxStops.forEachIndexed { i, o ->
            str(o["label"], stops[i].label, "cornerStops[$i].label")
            num(o["e"], stops[i].e, "cornerStops[$i].e")
        }

        val matched = ChannelGraphs.matchLapsToChannels(refLaps, refCh)
        val alone = ChannelGraphs.matchLapsToChannels(refLaps.take(1), refCh.take(1))
        for (row in ex["referenceLap"]!!.jsonArray.map { it.jsonObject }) {
            val chIdx = row["chIdx"]!!.jsonPrimitive.int
            val isAlone = row["alone"]?.jsonPrimitive?.booleanOrNull == true
            val got = VideoSync.referenceLap(if (isAlone) alone else matched, chIdx)?.chIdx
            num(row["ref"], got?.toDouble(), "referenceLap($chIdx, alone=$isAlone)")
        }
        for (row in ex["stageSides"]!!.jsonArray.map { it.jsonObject }) {
            val lit = row["lit"]!!.jsonArray.map { it.jsonPrimitive.int }
            val opened = row["opened"]!!.jsonPrimitive.int
            val got = VideoSync.stageSides(lit, refCh, opened)
            val want = row["sides"]
            if (want == null || want is JsonNull) {
                assertNull(got, "stageSides($lit)")
            } else {
                val o: JsonObject = want.jsonObject
                assertEquals(o["a"]!!.jsonPrimitive.int, got!!.a, "stageSides($lit).a")
                num(o["b"], got.b?.toDouble(), "stageSides($lit).b")
            }
        }
    }
}
