package app.trackevolution.core

import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Cross-event lap comparison (#165): the pure half of "compare two laps" —
 * pick any two laps with stored channel data at a track, put them on one
 * distance grid, and reduce each to head-to-head numbers.
 *
 * A port of `public/js/compare-laps.js` — same function names, same inclusive
 * thresholds — pinned against the web implementation by
 * `contracts/logic/compare-laps.json` ([CompareLapsTest]). The pair
 * [alignLapPair] returns is an ordinary [SessionChannels], so the existing
 * chart stack draws a cross-event pair the same way it draws one session.
 */
public object CompareLaps {

    /**
     * "Flat out" / "on the brakes" thresholds for [lapMetrics]' percentages.
     * Display semantics, not physics — see the JS.
     */
    public const val FULL_THROTTLE_PCT: Double = 95.0
    public const val BRAKING_PCT: Double = 10.0

    /**
     * Two laps whose driven lengths differ by more than this are probably not
     * the same layout / start line — the screen warns past it.
     */
    public const val LENGTH_MISMATCH_WARN: Double = 0.05

    /**
     * One event's contribution to the picker: what [comparableLaps] reads off
     * an event detail. A class of its own (rather than [EventDetail]) so the
     * contract test can build inputs without fabricating a full event row.
     */
    public data class EventLaps(
        val eventId: Int,
        val date: String,
        val club: String?,
        val sessions: List<SessionLaps>,
    ) {
        public constructor(detail: EventDetail) : this(
            eventId = detail.event.id,
            date = detail.event.startDate,
            club = detail.event.club,
            sessions = detail.sessions.map(::SessionLaps),
        )
    }

    public data class SessionLaps(
        val sessionId: Int,
        val label: String?,
        val laps: List<Lap>,
        val channels: SessionChannels?,
    ) {
        public constructor(session: Session) : this(
            sessionId = session.id,
            label = session.label,
            laps = session.laps,
            channels = session.channels,
        )
    }

    /**
     * One pickable lap: a stored lap row that [ChannelGraphs.matchLapsToChannels]
     * paired with a channel entry. [chIdx] indexes that session's `channels.laps`.
     */
    public data class Row(
        val eventId: Int,
        val date: String,
        val club: String?,
        val sessionId: Int,
        val sessionLabel: String?,
        val lapNum: Int,
        val timeMs: Int,
        val chIdx: Int,
    )

    /** Indexes into the rows [defaultComparePicks] was given. */
    public data class Picks(val a: Int, val b: Int)

    /**
     * Flatten event details into one pickable list of laps that have channel
     * data. Keeps the given event order; within an event, session order then
     * lap order. Laps without a channel entry (hand-added, no distance window)
     * drop out, exactly as on the web.
     */
    public fun comparableLaps(events: List<EventLaps>): List<Row> {
        val rows = mutableListOf<Row>()
        for (event in events) {
            for (session in event.sessions) {
                val channels = session.channels ?: continue
                if (channels.laps.isEmpty() || session.laps.isEmpty()) continue
                for (match in ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)) {
                    if (!match.hasChannels) continue
                    rows +=
                        Row(
                            eventId = event.eventId,
                            date = event.date,
                            club = event.club,
                            sessionId = session.sessionId,
                            sessionLabel = session.label,
                            lapNum = match.lap.lapNum,
                            timeMs = match.lap.timeMs,
                            chIdx = match.chIdx,
                        )
                }
            }
        }
        return rows
    }

    /**
     * Default selection: side A is "current me" — the best lap of the most
     * recent event with comparable laps — and side B is "best me", the overall
     * best lap; when they coincide, B falls back to the best of the rest.
     * Null when there is nothing to compare.
     */
    public fun defaultComparePicks(rows: List<Row>): Picks? {
        if (rows.size < 2) return null
        val latest = rows.maxOf { it.date }
        fun bestIn(idxs: List<Int>): Int = idxs.reduce { m, i -> if (rows[i].timeMs < rows[m].timeMs) i else m }
        val all = rows.indices.toList()
        val a = bestIn(all.filter { rows[it].date == latest })
        var b = bestIn(all)
        if (b == a) b = bestIn(all.filter { it != a })
        return Picks(a, b)
    }

    /**
     * Linear-resample one stored channel-lap entry from its grid spacing onto
     * another. Identity when the spacings already match (every writer uses
     * 20 m today, but `dStepM` is stored per session and this must not
     * assume). Same arithmetic as the JS, so the fixture pins every value.
     */
    public fun resampleChannelLap(entry: LapChannels, fromStepM: Double, toStepM: Double): LapChannels {
        if (fromStepM == toStepM) return entry
        fun resample(arr: List<Double>?): List<Double>? {
            if (arr == null || arr.size < 2) return null
            val n = floor((arr.size - 1) * fromStepM / toStepM).toInt() + 1
            return List(n) { k ->
                val p = k * toStepM / fromStepM
                val i0 = min(arr.size - 2, floor(p).toInt())
                arr[i0] + (arr[i0 + 1] - arr[i0]) * (p - i0)
            }
        }
        return LapChannels(
            n = entry.n,
            timeMs = entry.timeMs,
            speed = resample(entry.speed),
            rpm = resample(entry.rpm),
            latG = resample(entry.latG),
            throttle = resample(entry.throttle),
            brake = resample(entry.brake),
            steering = resample(entry.steering),
        )
    }

    /**
     * Put a pair of channel-lap entries on one grid: side B is resampled onto
     * side A's spacing when the two sessions stored different grids.
     */
    public fun alignLapPair(
        entryA: LapChannels,
        stepA: Double,
        entryB: LapChannels,
        stepB: Double,
    ): SessionChannels =
        SessionChannels(v = 1, dStepM = stepA, laps = listOf(entryA, resampleChannelLap(entryB, stepB, stepA)))

    /** Driven length a stored entry covers (its grid extent, meters). */
    public fun drivenLengthM(entry: LapChannels, stepM: Double): Double {
        val n = entry.speed?.size ?: 0
        return if (n > 1) (n - 1) * stepM else 0.0
    }

    /**
     * Relative driven-length difference between two entries (0 = identical).
     * Distance is measured from each lap's own start line, so a large ratio
     * means a different layout, picked line, or off-track excursion — the
     * comparison still renders, with a warning past [LENGTH_MISMATCH_WARN].
     */
    public fun lengthMismatchRatio(
        entryA: LapChannels,
        stepA: Double,
        entryB: LapChannels,
        stepB: Double,
    ): Double {
        val la = drivenLengthM(entryA, stepA)
        val lb = drivenLengthM(entryB, stepB)
        val longest = max(la, lb)
        return if (longest > 0) abs(la - lb) / longest else 0.0
    }

    /**
     * One lap's channels reduced to head-to-head numbers. Speed stays km/h as
     * stored (the screen converts for display); percentages are shares of grid
     * samples — on a uniform distance grid, shares of driven distance.
     * Channels the lap didn't store are null.
     */
    public data class Metrics(
        val timeMs: Int,
        val topSpeedKph: Double?,
        val minSpeedKph: Double?,
        val avgSpeedKph: Double?,
        val maxRpm: Double?,
        val maxLatG: Double?,
        val fullThrottlePct: Double?,
        val brakingPct: Double?,
    )

    public fun lapMetrics(entry: LapChannels): Metrics {
        val speed = entry.speed?.takeIf { it.isNotEmpty() }
        fun share(arr: List<Double>?, minValue: Double): Double? {
            if (arr.isNullOrEmpty()) return null
            return 100.0 * arr.count { it >= minValue } / arr.size
        }
        fun maxOf(arr: List<Double>?): Double? = arr?.takeIf { it.isNotEmpty() }?.max()
        return Metrics(
            timeMs = entry.timeMs,
            topSpeedKph = speed?.max(),
            minSpeedKph = speed?.min(),
            avgSpeedKph = speed?.let { it.sum() / it.size },
            maxRpm = maxOf(entry.rpm),
            maxLatG = maxOf(entry.latG),
            fullThrottlePct = share(entry.throttle, FULL_THROTTLE_PCT),
            brakingPct = share(entry.brake, BRAKING_PCT),
        )
    }
}
