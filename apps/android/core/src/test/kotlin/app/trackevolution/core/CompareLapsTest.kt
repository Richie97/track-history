package app.trackevolution.core

import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/compare-laps.test.js`, plus the cross-language pin
 * against `contracts/logic/compare-laps.json`.
 */
class CompareLapsTest {

    private fun lap(num: Int, ms: Int, sessionId: Int = 0) =
        Lap(id = 0, sessionId = sessionId, lapNum = num, timeMs = ms)

    private fun session(id: Int, laps: List<Lap>, chLaps: List<LapChannels>?, label: String? = null) =
        CompareLaps.SessionLaps(
            sessionId = id,
            label = label,
            laps = laps,
            channels = chLaps?.let { SessionChannels(v = 1, dStepM = 20.0, laps = it) },
        )

    @Test
    fun `flattens event details into pickable laps, skipping laps without channels`() {
        val events = listOf(
            CompareLaps.EventLaps(
                eventId = 7, date = "2026-06-01", club = null,
                sessions = listOf(
                    session(
                        40,
                        laps = listOf(lap(1, 92_000), lap(2, 91_000), lap(3, 90_500)), // lap 3: hand-added
                        chLaps = listOf(
                            LapChannels(n = 1, timeMs = 92_000, speed = listOf(10.0, 20.0)),
                            LapChannels(n = 2, timeMs = 91_000, speed = listOf(10.0, 20.0)),
                        ),
                        label = "AM",
                    ),
                    session(41, laps = listOf(lap(1, 95_000)), chLaps = null), // no channels at all
                ),
            ),
            CompareLaps.EventLaps(
                eventId = 8, date = "2026-07-04", club = null,
                sessions = listOf(
                    session(
                        50,
                        laps = listOf(lap(1, 89_000)),
                        chLaps = listOf(LapChannels(n = 1, timeMs = 89_000, speed = listOf(10.0, 20.0))),
                    ),
                ),
            ),
        )
        assertEquals(
            listOf(
                CompareLaps.Row(7, "2026-06-01", null, 40, "AM", 1, 92_000, 0),
                CompareLaps.Row(7, "2026-06-01", null, 40, "AM", 2, 91_000, 1),
                CompareLaps.Row(8, "2026-07-04", null, 50, null, 1, 89_000, 0),
            ),
            CompareLaps.comparableLaps(events),
        )
    }

    private fun row(date: String, timeMs: Int) =
        CompareLaps.Row(0, date, null, 0, null, 1, timeMs, 0)

    @Test
    fun `picks the best lap of the latest event vs the overall best`() {
        val rows = listOf(
            row("2026-05-01", 90_000), // overall best
            row("2026-05-01", 93_000),
            row("2026-07-01", 92_000), // best of latest → side A
            row("2026-07-01", 94_000),
        )
        assertEquals(CompareLaps.Picks(a = 2, b = 0), CompareLaps.defaultComparePicks(rows))
    }

    @Test
    fun `falls back to the best of the rest when the latest best is the overall best`() {
        val rows = listOf(row("2026-05-01", 95_000), row("2026-07-01", 90_000), row("2026-07-01", 91_000))
        assertEquals(CompareLaps.Picks(a = 1, b = 2), CompareLaps.defaultComparePicks(rows))
    }

    @Test
    fun `needs two laps`() {
        assertNull(CompareLaps.defaultComparePicks(emptyList()))
        assertNull(CompareLaps.defaultComparePicks(listOf(row("2026-05-01", 90_000))))
    }

    @Test
    fun `resample is the identity when the grid spacings match`() {
        val entry = LapChannels(n = 1, timeMs = 90_000, speed = listOf(100.0, 110.0, 120.0))
        assertEquals(entry, CompareLaps.resampleChannelLap(entry, 20.0, 20.0))
    }

    @Test
    fun `resample linearly interpolates onto a finer grid, endpoints preserved`() {
        val entry = LapChannels(
            n = 1, timeMs = 90_000,
            speed = listOf(100.0, 110.0, 120.0),
            latG = listOf(0.0, 1.0, 0.0),
        )
        val out = CompareLaps.resampleChannelLap(entry, 20.0, 10.0)
        assertEquals(listOf(100.0, 105.0, 110.0, 115.0, 120.0), out.speed)
        assertEquals(listOf(0.0, 0.5, 1.0, 0.5, 0.0), out.latG)
        assertEquals(1, out.n)
        assertEquals(90_000, out.timeMs)
    }

    @Test
    fun `resample drops onto a coarser grid without reading past the end`() {
        val entry = LapChannels(n = 2, timeMs = 88_000, speed = listOf(100.0, 110.0, 120.0, 130.0, 140.0))
        assertEquals(listOf(100.0, 120.0, 140.0), CompareLaps.resampleChannelLap(entry, 10.0, 20.0).speed)
    }

    @Test
    fun `resample skips channels the entry does not carry`() {
        val out = CompareLaps.resampleChannelLap(LapChannels(n = 1, timeMs = 90_000, speed = listOf(1.0, 2.0)), 20.0, 10.0)
        assertNull(out.throttle)
        assertNull(out.rpm)
    }

    @Test
    fun `align passes both entries through unchanged when the grids already agree`() {
        val a = LapChannels(n = 1, timeMs = 90_000, speed = listOf(1.0, 2.0))
        val b = LapChannels(n = 2, timeMs = 91_000, speed = listOf(3.0, 4.0))
        assertEquals(
            SessionChannels(v = 1, dStepM = 20.0, laps = listOf(a, b)),
            CompareLaps.alignLapPair(a, 20.0, b, 20.0),
        )
    }

    @Test
    fun `align resamples side B onto side A's grid`() {
        val a = LapChannels(n = 1, timeMs = 90_000, speed = listOf(1.0, 2.0, 3.0))
        val b = LapChannels(n = 2, timeMs = 91_000, speed = listOf(100.0, 120.0))
        val pair = CompareLaps.alignLapPair(a, 10.0, b, 20.0)
        assertEquals(10.0, pair.dStepM, 0.0)
        assertEquals(listOf(100.0, 110.0, 120.0), pair.laps[1].speed)
    }

    @Test
    fun `measures driven length and mismatch`() {
        val a = LapChannels(n = 1, timeMs = 0, speed = List(101) { 1.0 }) // 2000 m at 20 m
        val b = LapChannels(n = 2, timeMs = 0, speed = List(91) { 1.0 }) // 1800 m
        assertEquals(2000.0, CompareLaps.drivenLengthM(a, 20.0), 0.0)
        assertEquals(0.0, CompareLaps.drivenLengthM(LapChannels(n = 1, timeMs = 0, speed = listOf(1.0)), 20.0), 0.0)
        assertEquals(0.0, CompareLaps.drivenLengthM(LapChannels(n = 1, timeMs = 0), 20.0), 0.0)
        assertEquals(0.0, CompareLaps.lengthMismatchRatio(a, 20.0, a, 20.0), 0.0)
        assertEquals(0.1, CompareLaps.lengthMismatchRatio(a, 20.0, b, 20.0), 1e-10)
        // Different grids, same driven length: no mismatch.
        val fine = LapChannels(n = 3, timeMs = 0, speed = List(201) { 1.0 })
        assertEquals(0.0, CompareLaps.lengthMismatchRatio(a, 20.0, fine, 10.0), 0.0)
        assertEquals(
            0.0,
            CompareLaps.lengthMismatchRatio(LapChannels(n = 1, timeMs = 0), 20.0, LapChannels(n = 2, timeMs = 0), 20.0),
            0.0,
        )
    }

    @Test
    fun `reduces channels to head-to-head numbers, thresholds inclusive`() {
        val m = CompareLaps.lapMetrics(
            LapChannels(
                n = 1,
                timeMs = 90_000,
                speed = listOf(80.0, 120.0, 100.0),
                rpm = listOf(5000.0, 6400.0, 6000.0),
                latG = listOf(0.2, 1.05, 0.8),
                throttle = listOf(CompareLaps.FULL_THROTTLE_PCT, 100.0, 40.0, 0.0), // 2 of 4 at/over the cutoff
                brake = listOf(0.0, CompareLaps.BRAKING_PCT, 80.0, 0.0), // 2 of 4
            ),
        )
        assertEquals(
            CompareLaps.Metrics(
                timeMs = 90_000,
                topSpeedKph = 120.0,
                minSpeedKph = 80.0,
                avgSpeedKph = 100.0,
                maxRpm = 6400.0,
                maxLatG = 1.05,
                fullThrottlePct = 50.0,
                brakingPct = 50.0,
            ),
            m,
        )
    }

    @Test
    fun `metrics are null for channels the lap did not store`() {
        val m = CompareLaps.lapMetrics(LapChannels(n = 1, timeMs = 90_000, speed = listOf(100.0)))
        assertNull(m.maxRpm)
        assertNull(m.maxLatG)
        assertNull(m.fullThrottlePct)
        assertNull(m.brakingPct)
        val none = CompareLaps.lapMetrics(LapChannels(n = 1, timeMs = 90_000))
        assertNull(none.topSpeedKph)
        assertNull(none.avgSpeedKph)
    }

    // ---- the cross-language contract ---------------------------------------

    @Test
    fun `matches the web implementation's reference output`() {
        // contracts/logic/compare-laps.json is generated by running the *web*
        // implementation, so this asserts equality with the reference rather
        // than with the Swift port — the two could agree and both be wrong.
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/compare-laps.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject

        fun channelOf(o: JsonObject, key: String): List<Double>? =
            o[key]?.takeIf { it !is JsonNull }?.jsonArray?.map { it.jsonPrimitive.content.toDouble() }

        fun entryOf(o: JsonObject) = LapChannels(
            n = o["n"]!!.jsonPrimitive.content.toInt(),
            timeMs = o["timeMs"]!!.jsonPrimitive.content.toInt(),
            speed = channelOf(o, "speed"),
            rpm = channelOf(o, "rpm"),
            latG = channelOf(o, "latG"),
            throttle = channelOf(o, "throttle"),
            brake = channelOf(o, "brake"),
            steering = channelOf(o, "steering"),
        )

        fun stringOrNull(o: JsonObject, key: String): String? =
            o[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

        val events = input["events"]!!.jsonArray.map { eventEl ->
            val e = eventEl.jsonObject
            CompareLaps.EventLaps(
                eventId = e["id"]!!.jsonPrimitive.content.toInt(),
                date = e["start_date"]!!.jsonPrimitive.content,
                club = stringOrNull(e, "club"),
                sessions = e["sessions"]!!.jsonArray.map { sessionEl ->
                    val s = sessionEl.jsonObject
                    val sessionId = s["id"]!!.jsonPrimitive.content.toInt()
                    CompareLaps.SessionLaps(
                        sessionId = sessionId,
                        label = stringOrNull(s, "label"),
                        laps = s["laps"]!!.jsonArray.map {
                            val l = it.jsonObject
                            Lap(
                                id = 0,
                                sessionId = sessionId,
                                lapNum = l["lap_num"]!!.jsonPrimitive.content.toInt(),
                                timeMs = l["time_ms"]!!.jsonPrimitive.content.toInt(),
                            )
                        },
                        channels = s["channels"]?.takeIf { it !is JsonNull }?.jsonObject?.let { ch ->
                            SessionChannels(
                                v = ch["v"]!!.jsonPrimitive.content.toInt(),
                                dStepM = ch["dStepM"]!!.jsonPrimitive.content.toDouble(),
                                laps = ch["laps"]!!.jsonArray.map { entryOf(it.jsonObject) },
                            )
                        },
                    )
                },
            )
        }

        val rows = CompareLaps.comparableLaps(events)
        val wantRows = expected["comparableLaps"]!!.jsonArray.map {
            val o = it.jsonObject
            CompareLaps.Row(
                eventId = o["eventId"]!!.jsonPrimitive.content.toInt(),
                date = o["date"]!!.jsonPrimitive.content,
                club = stringOrNull(o, "club"),
                sessionId = o["sessionId"]!!.jsonPrimitive.content.toInt(),
                sessionLabel = stringOrNull(o, "sessionLabel"),
                lapNum = o["lapNum"]!!.jsonPrimitive.content.toInt(),
                timeMs = o["timeMs"]!!.jsonPrimitive.content.toInt(),
                chIdx = o["chIdx"]!!.jsonPrimitive.content.toInt(),
            )
        }
        assertEquals(wantRows, rows)

        fun picksOf(key: String): CompareLaps.Picks {
            val o = expected[key]!!.jsonObject
            return CompareLaps.Picks(
                a = o["a"]!!.jsonPrimitive.content.toInt(),
                b = o["b"]!!.jsonPrimitive.content.toInt(),
            )
        }
        assertEquals(picksOf("defaultComparePicks"), CompareLaps.defaultComparePicks(rows))

        val fallbackRows = input["fallbackRows"]!!.jsonArray.map {
            val o = it.jsonObject
            row(o["date"]!!.jsonPrimitive.content, o["timeMs"]!!.jsonPrimitive.content.toInt())
        }
        assertEquals(picksOf("defaultPicksFallback"), CompareLaps.defaultComparePicks(fallbackRows))

        fun checkArr(got: List<Double>?, want: List<Double>?, name: String) {
            if (want == null) {
                assertNull(got, name)
                return
            }
            assertEquals(want.size, got!!.size, "$name size")
            want.forEachIndexed { i, w ->
                assertTrue(kotlin.math.abs(got[i] - w) < 1e-9, "$name[$i]: ${got[i]} != $w")
            }
        }

        fun checkLap(got: LapChannels, want: LapChannels, name: String) {
            assertEquals(want.n, got.n, "$name.n")
            assertEquals(want.timeMs, got.timeMs, "$name.timeMs")
            checkArr(got.speed, want.speed, "$name.speed")
            checkArr(got.rpm, want.rpm, "$name.rpm")
            checkArr(got.latG, want.latG, "$name.latG")
            checkArr(got.throttle, want.throttle, "$name.throttle")
            checkArr(got.brake, want.brake, "$name.brake")
            checkArr(got.steering, want.steering, "$name.steering")
        }

        val pairA = events[0].sessions[0].channels!!.laps[1]
        val pairB = events[1].sessions[0].channels!!.laps[1]
        val fullEntry = entryOf(input["fullEntry"]!!.jsonObject)
        val speedOnlyEntry = entryOf(input["speedOnlyEntry"]!!.jsonObject)

        checkLap(
            CompareLaps.resampleChannelLap(pairB, 25.0, 20.0),
            entryOf(expected["resampledTo20"]!!.jsonObject),
            "resampledTo20",
        )
        checkLap(
            CompareLaps.resampleChannelLap(fullEntry, 20.0, 50.0),
            entryOf(expected["resampledTo50"]!!.jsonObject),
            "resampledTo50",
        )

        val aligned = CompareLaps.alignLapPair(pairA, 20.0, pairB, 25.0)
        val wantAligned = expected["alignedPair"]!!.jsonObject
        assertEquals(wantAligned["dStepM"]!!.jsonPrimitive.content.toDouble(), aligned.dStepM, 0.0)
        val wantAlignedLaps = wantAligned["laps"]!!.jsonArray.map { entryOf(it.jsonObject) }
        assertEquals(wantAlignedLaps.size, aligned.laps.size)
        wantAlignedLaps.forEachIndexed { i, want -> checkLap(aligned.laps[i], want, "alignedPair.laps[$i]") }

        assertEquals(
            expected["drivenLengthA"]!!.jsonPrimitive.content.toDouble(),
            CompareLaps.drivenLengthM(pairA, 20.0),
            0.0,
        )
        assertEquals(
            expected["drivenLengthB"]!!.jsonPrimitive.content.toDouble(),
            CompareLaps.drivenLengthM(pairB, 25.0),
            0.0,
        )
        assertEquals(
            expected["lengthMismatchRatio"]!!.jsonPrimitive.content.toDouble(),
            CompareLaps.lengthMismatchRatio(pairA, 20.0, pairB, 25.0),
            1e-9,
        )

        fun doubleOrNull(o: JsonObject, key: String): Double? =
            o[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content?.toDouble()

        fun checkMetrics(got: CompareLaps.Metrics, key: String) {
            val o = expected[key]!!.jsonObject
            assertEquals(o["timeMs"]!!.jsonPrimitive.content.toInt(), got.timeMs, "$key.timeMs")
            for (
                (name, value) in listOf(
                    "topSpeedKph" to got.topSpeedKph,
                    "minSpeedKph" to got.minSpeedKph,
                    "avgSpeedKph" to got.avgSpeedKph,
                    "maxRpm" to got.maxRpm,
                    "maxLatG" to got.maxLatG,
                    "fullThrottlePct" to got.fullThrottlePct,
                    "brakingPct" to got.brakingPct,
                )
            ) {
                val want = doubleOrNull(o, name)
                if (want == null) {
                    assertNull(value, "$key.$name")
                } else {
                    assertTrue(kotlin.math.abs(value!! - want) < 1e-9, "$key.$name: $value != $want")
                }
            }
        }

        checkMetrics(CompareLaps.lapMetrics(fullEntry), "metricsFull")
        checkMetrics(CompareLaps.lapMetrics(speedOnlyEntry), "metricsSpeedOnly")
    }
}
