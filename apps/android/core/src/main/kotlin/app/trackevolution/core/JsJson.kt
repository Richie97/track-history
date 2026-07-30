package app.trackevolution.core

import java.math.BigDecimal

/**
 * JavaScript-compatible number formatting for JSON output.
 *
 * The recorder checkpoint (see [RecorderCore]) is written by the web app, the
 * iOS app and this one, and read by all three. `JSON.stringify` in JavaScript
 * formats numbers with `Number::toString`, which differs from Kotlin's
 * [Double.toString] in two ways that both show up in real checkpoint data:
 *
 *  - **Integer-valued doubles carry no decimal point.** JS writes `0` and `5`;
 *    Kotlin writes `0.0` and `5.0`. Every whole-second timestamp, zero speed and
 *    integer accuracy reading hits this, so a naive port differs on almost every
 *    fix.
 *  - **Small magnitudes stay in plain notation.** Fix coordinates are rounded to
 *    6dp, so the smallest non-zero magnitude is exactly `1e-6`. JS writes
 *    `0.000001`; Kotlin writes `1.0E-6`.
 *
 * Neither difference stops a lenient parser, but both break byte-comparability,
 * which is what makes a cross-client checkpoint diff a one-line check instead of
 * a semantic comparison.
 */
internal object JsJson {

    /** Formats [value] as `JSON.stringify` would. Non-finite input is not valid JSON and throws. */
    fun number(value: Double): String {
        require(value.isFinite()) { "cannot serialize non-finite number: $value" }
        // JS: String(0) and String(-0) are both "0".
        if (value == 0.0) return "0"
        // Integer-valued and small enough for an exact Long round-trip. JS keeps
        // integer form up to 1e21; past 2^63 a Long conversion would saturate,
        // so anything larger falls through to the BigDecimal path.
        if (value == Math.floor(value) && Math.abs(value) < 1e18) {
            return value.toLong().toString()
        }
        // Double.toString gives the shortest round-tripping representation but
        // may use E notation. Re-parsing through BigDecimal preserves those exact
        // digits while toPlainString expands the exponent.
        return BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
    }

    /**
     * Formats an opaque id the way the web app stores it.
     *
     * Event ids arrive from the API as JSON numbers, but an event created while
     * offline carries a `tmp-N` string id (see `public/js/offline.js`). The web
     * app writes whichever it holds, so a checkpoint's `eventId` is legitimately
     * a number, a string, or null — and re-serializing has to preserve the form
     * it arrived in, or a round-trip through this client would rewrite the field.
     */
    fun id(value: String?): String = when {
        value == null -> "null"
        NUMERIC.matches(value) -> value
        else -> string(value)
    }

    /** Minimal JSON string escaping — enough for ids and labels. */
    fun string(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (c in value) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u").append("%04x".format(c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    private val NUMERIC = Regex("""-?(0|[1-9]\d*)""")
}
