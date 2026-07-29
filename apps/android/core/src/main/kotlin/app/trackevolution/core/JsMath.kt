package app.trackevolution.core

/**
 * JavaScript-compatible rounding.
 *
 * The recorder core (NS-12) and lap geometry (NS-14) are ports of
 * `public/js/record/core.js` and `public/js/import/geo.js`, both of which round
 * with the idiom `Math.round(v * f) / f`. That rounding is part of the wire
 * format, not cosmetic: fix tuples are shared with the web and iOS clients, and
 * lap times are compared against the JS implementation to the millisecond.
 *
 * Two traps make a naive port wrong:
 *
 *  1. [kotlin.math.round] is half-to-even — `round(2.5) == 2.0`. JavaScript's
 *     `Math.round` is half-**up toward +infinity** — `Math.round(2.5) === 3`,
 *     and critically `Math.round(-1.5) === -1`, *not* -2. Latitude, longitude
 *     and the relative clock all cross zero, so this is reachable in real data.
 *     `java.lang.Math.round(double)` has exactly the JS semantics, including
 *     the `0.49999999999999994` case that a naive `floor(x + 0.5)` gets wrong.
 *
 *  2. JavaScript's `Math.round(-0.5)` is `-0`, which `JSON.stringify` writes as
 *     `0`. Kotlin would serialize `-0.0` as `-0.0`, so a checkpoint written on
 *     Android would not be byte-comparable with one written on the web. We
 *     normalize negative zero away.
 *
 * Do not replace calls to this with `kotlin.math.round`, `String.format`, or
 * `BigDecimal` — each rounds differently at the boundary.
 */
public object JsMath {

    /**
     * `Math.round(value * factor) / factor`, matching JavaScript exactly.
     *
     * [factor] is the reciprocal of the desired precision: `100.0` for two
     * decimal places, `1e6` for six. Non-finite input is returned unchanged,
     * mirroring JS, where `Math.round(NaN)` is `NaN` and the division
     * propagates it.
     */
    public fun round(value: Double, factor: Double): Double {
        if (!value.isFinite()) return value
        val scaled = value * factor
        // Guard the Long conversion: java.lang.Math.round saturates at
        // Long.MIN/MAX_VALUE, which would silently corrupt an absurd input
        // rather than surfacing it. Nothing in the recorder's domain gets
        // here, but a corrupt checkpoint could.
        if (!scaled.isFinite() || scaled <= -9.007199254740992E15 || scaled >= 9.007199254740992E15) {
            return value
        }
        val result = java.lang.Math.round(scaled).toDouble() / factor
        // -0.0 == 0.0 is true, so this catches negative zero without an
        // explicit sign test and leaves every other value untouched.
        return if (result == 0.0) 0.0 else result
    }

    /** Convenience for the integer-millisecond case: `Math.round(seconds * 1000)`. */
    public fun roundToInt(value: Double): Int {
        require(value.isFinite()) { "cannot round non-finite value to Int: $value" }
        val rounded = java.lang.Math.round(value)
        require(rounded in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
            "value out of Int range: $value"
        }
        return rounded.toInt()
    }
}
