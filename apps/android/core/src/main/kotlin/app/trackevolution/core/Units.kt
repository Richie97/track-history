package app.trackevolution.core

import app.trackevolution.core.model.UnitSystem
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * The unit system (imperial / metric) — the port of `public/js/units.js`,
 * keeping its function and constant names so the two diff by eye.
 *
 * The preference lives on the account (`users.units`, served by `GET /api/me`
 * and set by `PUT /api/me/units`) so every client shows the same system.
 * Nothing stored changes with it: lap times are milliseconds, event
 * temperatures are whole °F (`events.temp_f`), channel speeds km/h, the
 * recorder's fixes m/s and metres, and a wear measurement carries whatever unit
 * it was logged in. This object converts at the edges — display, and form input
 * on the way back — so the server and the offline mirror never see a converted
 * value.
 *
 * What is deliberately **not** ported: the web's `currentUnits()` /
 * `cacheUnits()` / `clearUnitsCache()`. Those exist because a public share page
 * and the import review have no `/me` to read; here every screen composes under
 * the signed-in user, and `User.effectiveUnits` (null read as imperial, what the
 * app always showed) is published once as `LocalUnitSystem` in `:app`. A second
 * cache would be a second copy of one value.
 *
 * Rounding follows JavaScript: `Math.round` ties go toward +∞ ([JsMath]), and
 * `toFixed` works on the double's exact value ([toFixed]) — a port that reaches
 * for `%.1f` differs from the web on 0.15 and its kin.
 *
 * Pinned against the web by `contracts/logic/units.json`.
 */
public object Units {

    /** `UNIT_SYSTEMS` — the two choices as the Settings toggle offers them. */
    public data class Option(val units: UnitSystem, val label: String, val examples: String)

    public val UNIT_SYSTEMS: List<Option> = listOf(
        Option(UnitSystem.IMPERIAL, "Imperial", "mph · °F · psi · gal"),
        Option(UnitSystem.METRIC, "Metric", "km/h · °C · bar · L"),
    )

    /**
     * What an account that never chose sees — the app always showed imperial,
     * so the default keeps every existing logbook reading the way it did.
     * Mirrors `DEFAULT_UNITS` in `src/lib/validate.ts`.
     */
    public val DEFAULT_UNITS: UnitSystem = UnitSystem.IMPERIAL

    public fun isMetric(units: UnitSystem): Boolean = units == UnitSystem.METRIC

    // ---- speed (stored km/h) -------------------------------------------------

    public const val KPH_TO_MPH: Double = 0.621371

    /**
     * m/s → mph, for the live recorder's read-out. `3.6 × KPH_TO_MPH`, spelled
     * out so the two speed paths can't disagree at a rounding boundary.
     */
    public const val MPS_TO_MPH: Double = 3.6 * KPH_TO_MPH

    public fun speedUnit(units: UnitSystem): String = if (isMetric(units)) "km/h" else "mph"

    public fun convSpeedKph(kph: Double, units: UnitSystem): Double =
        if (isMetric(units)) kph else kph * KPH_TO_MPH

    public fun convSpeedMps(mps: Double, units: UnitSystem): Double =
        if (isMetric(units)) mps * 3.6 else mps * MPS_TO_MPH

    /** `"121 mph"` / `"195 km/h"`. */
    public fun fmtSpeedKph(kph: Double, units: UnitSystem, dp: Int = 0): String =
        "${toFixed(convSpeedKph(kph, units), dp)} ${speedUnit(units)}"

    // ---- distance (stored metres) --------------------------------------------

    public const val M_PER_MI: Double = 1609.344
    public const val FT_PER_M: Double = 3.28084

    /**
     * Axis-tick / read-out style: "940 m" / "2.4 km", or "800 ft" / "0.75 mi".
     *
     * Feet give way to miles at a quarter mile — below that a distance reads
     * better in feet, above it in the number a driver already knows a track by.
     * Zero is "0 mi" so an imperial axis doesn't open in a different unit than
     * it continues in.
     */
    public fun fmtDist(m: Double, units: UnitSystem): String {
        if (!isMetric(units)) {
            val mi = m / M_PER_MI
            // `Number(mi.toFixed(2))` — fixed to two places, then the trailing
            // zeros a number literal would not carry: "0.5 mi", not "0.50 mi".
            if (m == 0.0 || mi >= 0.25) return "${trimZeros(toFixed(mi, 2))} mi"
            return "${JsMath.roundToInt(m * FT_PER_M)} ft"
        }
        if (m >= 1000) return "${toFixed(m / 1000, if (m % 1000 != 0.0) 1 else 0)} km"
        return "${jsNumber(m)} m"
    }

    /** GPS accuracy style: "±4 m" / "±13 ft". */
    public fun fmtAccuracy(m: Double, units: UnitSystem): String =
        if (isMetric(units)) "±${JsMath.roundToInt(m)} m" else "±${JsMath.roundToInt(m * FT_PER_M)} ft"

    // ---- temperature (stored whole °F) ---------------------------------------

    public fun tempUnit(units: UnitSystem): String = if (isMetric(units)) "°C" else "°F"

    /** A stored °F as the whole number the user sees. */
    public fun tempToDisplay(f: Int?, units: UnitSystem): Int? =
        if (f == null) null else if (isMetric(units)) JsMath.roundToInt((f - 32) * 5.0 / 9) else f

    /**
     * A typed number in the user's system as the whole °F the server stores.
     * Every whole °C from -40 to 65 survives a save-and-edit cycle unchanged —
     * see the test — so a metric user never watches their own entry drift.
     */
    public fun tempToStored(v: Double?, units: UnitSystem): Int? =
        if (v == null) null else JsMath.roundToInt(if (isMetric(units)) v * 9 / 5 + 32 else v)

    /** `"72°F"` / `"22°C"`, or "" for nothing recorded. */
    public fun fmtTemp(f: Int?, units: UnitSystem): String =
        if (f == null) "" else "${tempToDisplay(f, units)}${tempUnit(units)}"

    /**
     * The event form's input bounds — the °F range is what `isValidTemp` in
     * `src/lib/validate.ts` enforces; the °C one maps onto it.
     */
    public data class TempInputSpec(val min: Int, val max: Int, val placeholder: Int)

    public fun tempInputSpec(units: UnitSystem): TempInputSpec =
        if (isMetric(units)) TempInputSpec(-40, 65, 22) else TempInputSpec(-40, 150, 72)

    // ---- pressure (stored psi) and fuel (stored gallons) ---------------------

    // The setup notebook that uses these stays web-only; the constants are here
    // so the port's constant list stays diffable against the JS.
    public const val PSI_PER_BAR: Double = 14.503774
    public const val L_PER_GAL: Double = 3.785412

    // ---- the two-valued enums the older modules spell -------------------------

    /**
     * `condUnits()` in `public/app.js`: the conditions module spells the two
     * systems `US` | `METRIC`, and this maps the account's choice onto that once.
     */
    public fun condUnits(units: UnitSystem): SessionConditions.Units =
        if (isMetric(units)) SessionConditions.Units.METRIC else SessionConditions.Units.US

    /** The same mapping for the health strip's enum. */
    public fun healthUnits(units: UnitSystem): Health.Units =
        if (isMetric(units)) Health.Units.METRIC else Health.Units.US

    // ---- JavaScript number formatting -------------------------------------------

    /**
     * `Number.prototype.toFixed(dp)`: the integer `n` with `n / 10^dp` closest to
     * the double's **exact** value, the larger `n` on a tie. That is half-up for
     * a positive tie and half-down for a negative one, and it is decided on the
     * exact binary value rather than on the shortest decimal — which is why this
     * is `BigDecimal(value)` and not `%.${dp}f`: `(0.15).toFixed(1)` is "0.1" in
     * JavaScript because 0.15 is really 0.1499999…, and `%.1f` says "0.2".
     */
    public fun toFixed(value: Double, dp: Int): String {
        if (!value.isFinite()) return value.toString()
        val mode = if (value < 0) RoundingMode.HALF_DOWN else RoundingMode.HALF_UP
        val fixed = BigDecimal(value).setScale(dp, mode)
        // -0.0 and a negative that rounds to zero print as "0", the way the
        // template strings here are used (an axis never reads "-0 mi").
        return if (fixed.signum() == 0) BigDecimal.ZERO.setScale(dp).toPlainString() else fixed.toPlainString()
    }

    /** `Number("2.50")` back into a template string: "2.5"; "1.00" → "1". */
    private fun trimZeros(fixed: String): String =
        if (!fixed.contains('.')) fixed else fixed.trimEnd('0').trimEnd('.')

    /** A number the way JavaScript stringifies it in `${m} m`: `800.0` → "800". */
    private fun jsNumber(value: Double): String =
        if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()
}
