package app.trackevolution.core

import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.WearEstimate

/**
 * Garage logbook presentation logic — pure, unit-tested (NS-31).
 *
 * A port of the consumable half of `public/js/garage.js` plus `garageAlerts`
 * from `public/app.js`, keeping the JS function and constant names so the two
 * diff by eye. The setup-sheet half of that file (`SETUP_FIELDS`,
 * `flattenSetup`, `diffSetups`) is **not** here: the setup notebook stays
 * deferred on both native platforms, and porting its field spec without its UI
 * would be dead code drifting silently from `sanitizeSetup`.
 *
 * **The wear math is not here either, and must not be added.** `wearEstimate` in
 * `src/lib/wear.ts` runs on the server and arrives pre-computed on every part
 * ([Part.wear]), so there is exactly one implementation of it. Reimplementing it
 * here would make a *fifth* copy — server, web mirror, iOS presentation, offline
 * mirror, this — and it would be wrong in the paddock, where the client has
 * stale events and the server does not. This file only decides how to *say*
 * what the server computed, which is also why garage writes need a live server
 * and never queue offline.
 *
 * Everything below is pinned against the JS by `contracts/logic/garage-status.json`
 * — the same fixture the iOS port asserts against, so the two are checked
 * against the web implementation rather than against each other.
 */
public object Garage {

    /**
     * Rough conversion for the "how many more track days" phrasing — matches
     * `DEFAULT_HOURS_PER_DAY` in `src/lib/wear.ts`.
     */
    public const val HOURS_PER_DAY: Double = 2.0

    /**
     * Traffic-light status for a part's wear estimate. Null means there was no
     * basis for one — no expected life and fewer than two measurements — which
     * reads differently from "fine": the app says so rather than showing green.
     */
    public enum class PartStatus(public val rawValue: String) {
        /** Replace now: over the limit, or past the expected life. */
        DUE("due"),

        /** Roughly two track days or less remaining. */
        LOW("low"),

        /** Plenty left. */
        OK("ok"),
    }

    /** `partStatus` in `public/js/garage.js`. */
    public fun partStatus(wear: WearEstimate?): PartStatus? {
        val remaining = wear?.remainingHours ?: return null
        if (remaining <= 0 || (wear.pctUsed ?: 0.0) >= 1) return PartStatus.DUE
        if (remaining <= 2 * HOURS_PER_DAY) return PartStatus.LOW
        return PartStatus.OK
    }

    /**
     * "4.5 h", "12 h", "—". Rounded to 1dp the JavaScript way, and a whole
     * number keeps no trailing `.0` — `${Math.round(h * 10) / 10} h` stringifies
     * that way.
     */
    public fun fmtHours(hours: Double?): String {
        if (hours == null || !hours.isFinite()) return EM_DASH
        return "${trimmed(JsMath.round(hours, 10.0))} h"
    }

    /**
     * "~4.5 h left (≈2 track days)" — the phrasing for remaining life, or null
     * when there is no projection to phrase.
     */
    public fun fmtRemaining(wear: WearEstimate?): String? {
        val remaining = wear?.remainingHours ?: return null
        if (remaining <= 0) return "replace now"
        val days = remaining / HOURS_PER_DAY
        // Half-day precision below two days, whole days above: "≈1.5 track days"
        // is useful, "≈7.5" is false precision on an estimate this soft.
        val roundedDays = if (days >= 2) JsMath.round(days, 1.0) else JsMath.round(days, 2.0)
        val noun = if (roundedDays == 1.0) "track day" else "track days"
        return "~${fmtHours(remaining)} left (≈${trimmed(roundedDays)} $noun)"
    }

    /** Cents → "$389" / "$389.50". Whole dollars lose the cents, as in the JS. */
    public fun fmtCost(cents: Int?): String? {
        if (cents == null) return null
        val dollars = cents / 100.0
        return if (cents % 100 == 0) {
            "$" + String.format(java.util.Locale.ROOT, "%.0f", dollars)
        } else {
            "$" + String.format(java.util.Locale.ROOT, "%.2f", dollars)
        }
    }

    /** A part at or near the end of its life, and the vehicle it is fitted to. */
    public data class Alert(
        val vehicle: GarageVehicle,
        val part: Part,
        val status: PartStatus,
    )

    /**
     * The maintenance items worth shouting about: **active** parts that are due
     * or low, worst first. `garageAlerts` in `public/app.js`.
     *
     * Retired parts are excluded on purpose — a worn-out part you already
     * replaced is history, not a reminder. The sort is stable, like the JS
     * `sort` on a 0/1 key: due first, and within each group the order the
     * vehicles and their parts already came in.
     */
    public fun garageAlerts(garage: List<GarageVehicle>?): List<Alert> =
        garage.orEmpty()
            .flatMap { vehicle ->
                vehicle.parts.mapNotNull { part ->
                    if (part.retiredOn != null) return@mapNotNull null
                    val status = partStatus(part.wear) ?: return@mapNotNull null
                    if (status != PartStatus.DUE && status != PartStatus.LOW) return@mapNotNull null
                    Alert(vehicle = vehicle, part = part, status = status)
                }
            }
            .sortedBy { if (it.status == PartStatus.DUE) 0 else 1 }

    /** A number the way JavaScript stringifies it: `4.5` → "4.5", `4.0` → "4". */
    private fun trimmed(value: Double): String =
        if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) {
            value.toLong().toString()
        } else {
            value.toString()
        }

    private const val EM_DASH = "—"
}

/**
 * `PART_KINDS` in `public/js/garage.js` — the label shown for each kind. A kind
 * a newer server introduces falls back to its raw value rather than rendering
 * blank.
 */
public val PartKind.label: String
    get() = when (this) {
        PartKind.PADS_FRONT -> "Front pads"
        PartKind.PADS_REAR -> "Rear pads"
        PartKind.TIRES -> "Tires"
        PartKind.ROTORS_FRONT -> "Front rotors"
        PartKind.ROTORS_REAR -> "Rear rotors"
        PartKind.BRAKE_FLUID -> "Brake fluid"
        PartKind.OIL -> "Oil"
        PartKind.OTHER -> "Other"
        else -> rawValue
    }

/**
 * `WEAR_LIMIT_HINTS` — the suggested replace-at level, shown as a form
 * placeholder. A hint, never enforced.
 */
public val PartKind.wearLimitHint: String?
    get() = when (this) {
        PartKind.PADS_FRONT, PartKind.PADS_REAR -> "3 (mm)"
        PartKind.TIRES -> "3 (32nds)"
        PartKind.ROTORS_FRONT -> "28 (mm)"
        PartKind.ROTORS_REAR -> "26 (mm)"
        else -> null
    }

/**
 * The unit a first measurement of this kind is most likely in — the web
 * measurement form's default (`viewVehicle` in `public/app.js`).
 */
public val PartKind.defaultUnit: String
    get() = if (this == PartKind.TIRES) "32nds" else "mm"
