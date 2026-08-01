package app.trackevolution.core

import java.util.Locale

/**
 * Lap-time formatting and parsing.
 *
 * A direct port of `public/js/format.js` — **same function names, same
 * behavior** — and the test cases from `test/unit/format.test.js` come with it
 * (`LapTimeTest`). The HTML-escaping and locale-date helpers in that file are
 * deliberately not ported: neither has any meaning outside a browser.
 *
 * Lap times are integer milliseconds everywhere in this app. Never model them as
 * a `Duration` or a `Float`.
 */
public object LapTime {

    /** ms → "2:01.24" (trailing zeros trimmed, at least one decimal), null → "—". */
    public fun fmtMs(ms: Int?): String {
        if (ms == null) return EM_DASH
        // Integer division, like the JS `Math.floor`, for the non-negative values
        // a lap time can hold.
        val m = ms / 60_000
        val s = (ms % 60_000) / 1000
        val frac = (ms % 1000).toString().padStart(3, '0').trimEnd('0').ifEmpty { "0" }
        return "$m:${s.toString().padStart(2, '0')}.$frac"
    }

    /**
     * Fractional-millisecond overload, rounding first exactly like the JS
     * `Math.round` (half up, toward positive infinity) — for sources that
     * measure sub-millisecond, such as a GPS-derived lap.
     */
    public fun fmtMs(ms: Double?): String {
        if (ms == null || !ms.isFinite()) return EM_DASH
        return fmtMs(Math.round(ms).toInt())
    }

    /** "2:01.24" | "121.24" | "2:01" → ms. null when unparseable. */
    public fun parseTime(text: String?): Int? {
        val t = (text ?: "").trim()
        if (t.isEmpty()) return null
        CLOCK.matchEntire(t)?.let { m ->
            val minutes = m.groupValues[1].toInt()
            val seconds = m.groupValues[2].toInt()
            return (minutes * 60 + seconds) * 1000 + fraction(m.groupValues[3])
        }
        SECONDS.matchEntire(t)?.let { m ->
            return m.groupValues[1].toInt() * 1000 + fraction(m.groupValues[2])
        }
        return null
    }

    /**
     * A whitespace/comma/semicolon-separated list of times → ms, dropping
     * unparseable and non-positive entries.
     */
    public fun parseLapList(text: String?): List<Int> =
        SEPARATORS.split(text ?: "").mapNotNull { parseTime(it) }.filter { it > 0 }

    /** Coefficient of variation → "1.2%", null → "—". */
    public fun fmtConsistency(cv: Double?): String {
        if (cv == null) return EM_DASH
        return String.format(Locale.ROOT, "%.1f%%", cv * 100)
    }

    /** ms delta → signed seconds: "+1.24s" / "-0.8s" / "0s". */
    public fun fmtDelta(ms: Int?): String {
        if (ms == null) return EM_DASH
        val s = ms / 1000.0
        val magnitude = Math.abs(s)
        val text = String.format(Locale.ROOT, if (magnitude < 10) "%.2f" else "%.1f", magnitude)
        // Trim trailing zeros, and the decimal point when nothing follows it.
        val trimmed = TRAILING_ZEROS.replaceFirst(text, "").ifEmpty { "0" }
        val sign = if (s > 0) "+" else if (s < 0) "-" else ""
        return "$sign${trimmed}s"
    }

    /**
     * A captured fraction-of-a-second group, right-padded to milliseconds:
     * "5" → 500, "24" → 240, "999" → 999.
     */
    private fun fraction(digits: String): Int =
        if (digits.isEmpty()) 0 else digits.padEnd(3, '0').toInt()

    private const val EM_DASH = "—"

    // The same two patterns as `parseTime` in public/js/format.js — seconds are
    // at most two digits, so "1:234" is not a lap time.
    private val CLOCK = Regex("""^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$""")
    private val SECONDS = Regex("""^(\d+)(?:[.,](\d{1,3}))?$""")
    private val SEPARATORS = Regex("""[\s,;]+""")
    private val TRAILING_ZEROS = Regex("""\.?0+$""")
}
