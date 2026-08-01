package app.trackevolution.core

/**
 * Turning a picked point on the trace into laps, and naming the two ways that
 * legitimately produces nothing.
 *
 * Separated from the screen because "the user picked somewhere useless" is
 * logic, not layout: both outcomes need a specific thing said to the driver, and
 * a dead end with no explanation is the failure mode the web app's wording
 * exists to avoid. The wording itself stays in the UI; what is decided here is
 * *which* case it is.
 */
public object LineReview {

    /** Why a pick produced no laps. Null in [Result.problem] means it worked. */
    public enum class Problem {
        /**
         * The car was stationary at the picked point, so there is no direction of
         * travel to build a gate perpendicular to — `buildGate` returns null.
         * Common: someone taps the paddock end of the trace.
         */
        STATIONARY_PICK,

        /**
         * A gate was built, but the trace never crosses it in a way that makes a
         * lap — an out-lap-only recording, or a pick on a piece of road driven
         * once.
         */
        NO_CROSSINGS,
    }

    public data class Result(
        /** The gate to draw, when one could be built. */
        val gate: Gate?,
        val laps: List<Lap>,
        val problem: Problem?,
    ) {
        val hasLaps: Boolean get() = laps.isNotEmpty()
    }

    /** Nothing picked yet — the screen's initial state. */
    public val EMPTY: Result = Result(gate = null, laps = emptyList(), problem = null)

    /**
     * Builds a gate at [index] and times every pass across it.
     *
     * The same two calls the web app makes, in the same order, so a pick in the
     * same place yields the same laps to the millisecond — which is what
     * `contracts/logic/geo-laps.json` pins.
     */
    public fun pick(trace: List<TracePoint>, index: Int): Result {
        val gate = GeoTrace.buildGate(trace, index)
            ?: return Result(gate = null, laps = emptyList(), problem = Problem.STATIONARY_PICK)
        val laps = GeoTrace.deriveLaps(trace, gate)
        return Result(
            gate = gate,
            laps = laps,
            problem = if (laps.isEmpty()) Problem.NO_CROSSINGS else null,
        )
    }

    /** The index of the quickest lap, or null when there are none. */
    public fun bestLapIndex(laps: List<Lap>): Int? =
        laps.indices.minByOrNull { laps[it].timeMs }
}
