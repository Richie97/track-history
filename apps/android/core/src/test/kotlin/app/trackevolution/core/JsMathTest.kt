package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource

/**
 * Every expected value here was produced by running the JS idiom
 * `Math.round(v * f) / f` in Node against the same inputs — not derived by
 * hand. If one of these fails, the Kotlin port has diverged from the web and
 * iOS clients, and shared checkpoints/lap times will disagree.
 */
class JsMathTest {

    @ParameterizedTest(name = "round({0}, {1}) == {2}")
    @CsvSource(
        // --- half-way cases: JS rounds half UP (toward +infinity) ------------
        // kotlin.math.round would give 0, 2, 2 for the .5 cases (half-to-even),
        // and a naive "away from zero" would give -2 for -1.5.
        "0.5,        1,       1.0",
        "-0.5,       1,       0.0",
        "1.5,        1,       2.0",
        "-1.5,       1,       -1.0",
        "2.5,        1,       3.0",
        "-2.5,       1,       -2.0",

        // --- the classic floor(x + 0.5) trap --------------------------------
        // A naive implementation returns 1.0 here. JS and java.lang.Math.round
        // both return 0.
        "0.49999999999999994, 1, 0.0",

        // --- float representation, not arithmetic intuition -----------------
        // 1.005 * 100 is 100.49999999999999 in IEEE-754, so this is 1.0, not
        // 1.01. Anyone "fixing" this has broken parity with the web client.
        "1.005,      100,     1.0",
        "-1.005,     100,     -1.0",
        "12.345,     10,      12.3",
        "123.456,    100,     123.46",

        // --- the precisions the recorder and geo ports actually use ---------
        "37.7749295,   1000000, 37.77493",     // latitude, 6dp
        "-122.4194155, 1000000, -122.419415",  // longitude, 6dp, negative
        "-0.004,       100,     0.0",          // speed, 2dp, rounds to zero
        "0.0,          1,       0.0",
    )
    fun `matches JavaScript Math_round`(value: Double, factor: Double, expected: Double) {
        assertEquals(expected, JsMath.round(value, factor))
    }

    @Test
    fun `normalizes negative zero so JSON matches the web client`() {
        // JS: Math.round(-0.5) is -0, and JSON.stringify(-0) is "0".
        // Kotlin would serialize -0.0 as "-0.0", making checkpoints written on
        // Android differ byte-for-byte from the web's.
        val result = JsMath.round(-0.5, 1.0)
        assertEquals(0.0, result)
        assertTrue(1.0 / result > 0) { "expected +0.0 but got -0.0" }
    }

    @Test
    fun `passes non-finite values through instead of throwing`() {
        // A corrupt checkpoint must not crash launch — deserialization rejects
        // it, but rounding is reached first in some paths.
        assertTrue(JsMath.round(Double.NaN, 100.0).isNaN())
        assertEquals(Double.POSITIVE_INFINITY, JsMath.round(Double.POSITIVE_INFINITY, 100.0))
        assertEquals(Double.NEGATIVE_INFINITY, JsMath.round(Double.NEGATIVE_INFINITY, 100.0))
    }

    @Test
    fun `roundToInt matches JS for lap-time milliseconds`() {
        // Lap times are integer milliseconds everywhere (see AGENTS.md).
        assertEquals(121_500, JsMath.roundToInt(121_499.5))
        assertEquals(1, JsMath.roundToInt(0.5))
        assertEquals(0, JsMath.roundToInt(-0.5))
        assertEquals(-1, JsMath.roundToInt(-1.5))
    }

    @Test
    fun `roundToInt rejects values it cannot represent`() {
        val tooBig = runCatching { JsMath.roundToInt(3e18) }
        assertTrue(tooBig.isFailure) { "expected out-of-range value to be rejected" }
        val notFinite = runCatching { JsMath.roundToInt(Double.NaN) }
        assertTrue(notFinite.isFailure) { "expected NaN to be rejected" }
    }
}
