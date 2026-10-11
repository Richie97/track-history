package app.trackevolution.core

/**
 * Track-day costs on the event form and page (#147, NS-40) — the port of the
 * form half of `public/js/costs.js`, under the same names, pinned by
 * `contracts/logic/costs.json`.
 *
 * Money is whole cents. The four line items are plain event columns
 * (`cost_*_cents`); [eventCostCents] is their total, null — never zero — when
 * none was entered, the mirror of `eventCostCents` in `src/lib/costs.ts` that
 * [app.trackevolution.core.offline.OfflineMirrors.recomputeDetail] calls.
 */
public object Costs {

    /** A line item: its column, the form's label and the input's placeholder. */
    public data class CostField(val key: String, val label: String, val placeholder: String)

    /** The line items, in the order the form and the breakdown render them. */
    public val COST_FIELDS: List<CostField> = listOf(
        CostField("cost_entry_cents", "Entry fee", "450"),
        CostField("cost_fuel_cents", "Fuel", "120"),
        CostField("cost_travel_cents", "Travel & lodging", "300"),
        CostField("cost_misc_cents", "Misc", "tow, insurance, a mirror…"),
    )

    /** The entered line items summed, null when none was entered. */
    public fun eventCostCents(entry: Int?, fuel: Int?, travel: Int?, misc: Int?): Int? {
        val items = listOfNotNull(entry, fuel, travel, misc)
        return if (items.isEmpty()) null else items.sum()
    }

    /**
     * JavaScript's `Number(string)` for what a person types: an optional sign,
     * digits with an optional fraction, an optional exponent. Kotlin's
     * `toDoubleOrNull` also takes "1d", "NaN" and "Infinity", which `Number`
     * either refuses or makes non-finite.
     */
    private val DECIMAL = Regex("""[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?""")

    /**
     * Dollars typed on a form → whole cents, null for blank, negative or not a
     * number. `Math.round(n * 100)` on the double, exactly as the web does, so
     * "0.285" is 28 cents (the product is 28.499999999999996) — rounding the
     * decimal string instead would be a cent out.
     */
    public fun dollarsToCents(raw: String?): Int? {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty() || !DECIMAL.matches(t)) return null
        val n = t.toDouble()
        if (!n.isFinite() || n < 0) return null
        return kotlin.math.floor(n * 100 + 0.5).toInt()
    }

    /** Cents → what the form's input shows: "389" / "389.50", "" for null. */
    public fun centsToDollars(cents: Int?): String {
        if (cents == null) return ""
        val whole = cents / 100
        val frac = cents % 100
        return if (frac == 0) "$whole" else "$whole.${frac.toString().padStart(2, '0')}"
    }

    /** A spend as the roll-ups say it: "$1,234.56", "$980"; null for null. */
    public fun fmtSpend(cents: Int?): String? {
        if (cents == null) return null
        val dollars = "%,d".format(java.util.Locale.US, cents / 100)
        val frac = cents % 100
        return if (frac == 0) "$$dollars" else "$$dollars.${frac.toString().padStart(2, '0')}"
    }
}
