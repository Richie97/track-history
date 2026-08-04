package app.trackevolution.core

/**
 * Per-session lap analysis — the port of `public/js/lap-stats.js`.
 *
 * Every input is a list of lap times in integer milliseconds **in running
 * order**, and the order matters: two of these three functions read a trend out
 * of it, so sorting the list before calling them destroys the answer.
 *
 * Note the name clash with `OfflineMirrors.cleanLaps`, which is a different
 * function entirely — that one mirrors the server's `sanitizeLaps` validation,
 * this one applies the 107% pace filter. They are namespaced apart deliberately
 * rather than renamed, because each matches its own JS original.
 */
public object LapStats {

    /** The F1 107% rule's factor: laps slower than this are not representative. */
    public const val CLEAN_FACTOR: Double = 1.07

    /** Within 1% of the session best counts as "up to speed". */
    public const val WARMUP_PCT: Double = 0.01

    /**
     * Laps within [factor] of the session best.
     *
     * This is what separates pace from traffic: an out-lap, a cool-down and a
     * lap spent behind a slower car are all real laps and none of them says
     * anything about how fast the driver was going.
     */
    public fun cleanLaps(laps: List<Int>, factor: Double = CLEAN_FACTOR): List<Int> {
        if (laps.isEmpty()) return emptyList()
        val best = laps.min()
        return laps.filter { it <= best * factor }
    }

    /** Average of the best [n] laps; null with fewer than [n]. */
    public fun bestNAvg(laps: List<Int>, n: Int = 3): Double? {
        if (laps.size < n) return null
        // sorted() copies, so the caller's running order survives — the JS
        // spreads into a new array for the same reason, and a test pins it.
        return laps.sorted().take(n).sumOf { it.toDouble() } / n
    }

    /**
     * Least-squares slope of the clean laps, in milliseconds per lap.
     *
     * Positive means going off through the session — tyres, heat, or the driver.
     * Negative means still finding time. Null below four clean laps, because a
     * trend drawn through three points is a shape, not a trend.
     */
    public fun paceSlope(laps: List<Int>, factor: Double = CLEAN_FACTOR): Double? {
        val clean = cleanLaps(laps, factor)
        val n = clean.size
        if (n < 4) return null

        val meanX = (n - 1) / 2.0
        val meanY = clean.sumOf { it.toDouble() } / n
        var num = 0.0
        var den = 0.0
        clean.forEachIndexed { x, y ->
            num += (x - meanX) * (y - meanY)
            den += (x - meanX) * (x - meanX)
        }
        return num / den
    }

    /**
     * 1-based index of the first lap within [pct] of the session best — how many
     * laps it took to get up to speed. Null with fewer than two laps.
     */
    public fun warmupLapCount(laps: List<Int>, pct: Double = WARMUP_PCT): Int? {
        if (laps.size < 2) return null
        val best = laps.min()
        val idx = laps.indexOfFirst { it <= best * (1 + pct) }
        return if (idx == -1) null else idx + 1
    }

    /**
     * The one-line summary the event page shows under a session, matching the
     * web app's wording.
     *
     * The "fading" and "still improving" thresholds are the web's: a tenth and a
     * half per lap either way is drift, not a story.
     */
    public fun summary(laps: List<Int>): String? {
        if (laps.isEmpty()) return null
        val parts = mutableListOf<String>()

        bestNAvg(laps, 3)?.let { parts += "best 3 avg ${LapTime.fmtMs(it)}" }

        warmupLapCount(laps)?.let { warmup ->
            parts += if (warmup == 1) "on pace from lap 1" else "up to speed by lap $warmup"
        }

        paceSlope(laps)?.let { slope ->
            val perLap = LapTime.fmtDelta(JsMath.roundToInt(kotlin.math.abs(slope)))
            val trend = when {
                slope > FADING_MS_PER_LAP -> " — fading (tires? heat?)"
                slope < -FADING_MS_PER_LAP -> " — still improving"
                else -> ""
            }
            parts += "pace ±$perLap/lap$trend"
        }

        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    private const val FADING_MS_PER_LAP = 150.0
}
