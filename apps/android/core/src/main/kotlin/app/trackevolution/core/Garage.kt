package app.trackevolution.core

import app.trackevolution.core.model.CatalogCar
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.PartOdometer
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.VehicleOdometer
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

    // ---- the car's own odometer (#192) ------------------------------------------

    /**
     * `vehicleOdometerLine` in `public/js/garage.js`: what the car's own
     * odometer last said, naming the recorded session it came from — only
     * video imports carry a reading, so the line never claims to be current.
     */
    public fun vehicleOdometerLine(odo: VehicleOdometer?, units: UnitSystem): String? {
        if (odo == null) return null
        val line = "Odometer: ${Units.fmtOdometer(odo.km, units)} at the last recorded session (${odo.on})"
        if (odo.otherCar == 0) return line
        val noun = if (odo.otherCar == 1) "reading" else "readings"
        return "$line · ${odo.otherCar} lower $noun skipped as another car's"
    }

    /**
     * `partOdometerLine`: the distance the odometer covered between a part's
     * first and last recorded sessions — a lower bound, and worded as one.
     */
    public fun partOdometerLine(odo: PartOdometer?, units: UnitSystem): String? {
        if (odo == null) return null
        return "Odometer: ${Units.fmtOdometer(odo.km, units)} between its first and last recorded sessions"
    }

    /** A part at or near the end of its life, and the vehicle it is fitted to. */
    public data class Alert(
        val vehicle: GarageVehicle,
        val part: Part,
        val status: PartStatus,
    )

    /**
     * The maintenance items worth shouting about: parts **on the car** that are
     * due or low, worst first. `garageAlerts` in `public/app.js`.
     *
     * Retired parts are excluded on purpose — a worn-out part you already
     * replaced is history, not a reminder — and so are spares on the shelf
     * ([Part.equipped] false, migration 0029), which aren't wearing. The sort is stable, like the JS
     * `sort` on a 0/1 key: due first, and within each group the order the
     * vehicles and their parts already came in.
     */
    public fun garageAlerts(garage: List<GarageVehicle>?): List<Alert> =
        garage.orEmpty()
            .flatMap { vehicle ->
                vehicle.parts.mapNotNull { part ->
                    if (part.retiredOn != null || part.equipped == false) return@mapNotNull null
                    val status = partStatus(part.wear) ?: return@mapNotNull null
                    if (status != PartStatus.DUE && status != PartStatus.LOW) return@mapNotNull null
                    Alert(vehicle = vehicle, part = part, status = status)
                }
            }
            .sortedBy { if (it.status == PartStatus.DUE) 0 else 1 }

    // ---- units ----------------------------------------------------------------

    /**
     * `wearLimitHint(kind, units)` in `public/js/garage.js`: the suggested
     * replace-at level as a form placeholder, in the user's tread-depth idiom.
     * Pads and rotors are specified in millimetres on both sides of the
     * Atlantic; only tread depth changes idiom (32nds of an inch vs. mm). The
     * imperial table is [PartKind.wearLimitHint], the one
     * `contracts/logic/garage-status.json` pins. "" for a kind with no hint.
     */
    public fun wearLimitHint(kind: PartKind, units: UnitSystem): String =
        if (Units.isMetric(units) && isTireKind(kind)) "3 (mm)" else kind.wearLimitHint.orEmpty()

    /**
     * `defaultMeasurementUnit(kind, units)`: the unit a new wear measurement is
     * offered in. A measurement stores its own unit string, so this is only a
     * default — a part's later measurements follow its first one.
     */
    public fun defaultMeasurementUnit(kind: PartKind, units: UnitSystem): String =
        if (isTireKind(kind) && !Units.isMetric(units)) "32nds" else "mm"

    /** `isTireKind` in `public/js/garage.js`: a full set or a front or rear pair. */
    public fun isTireKind(kind: PartKind): Boolean =
        kind == PartKind.TIRES || kind == PartKind.TIRES_FRONT || kind == PartKind.TIRES_REAR

    // ---- on the car, or on the shelf (migration 0029) ---------------------------

    /**
     * `equipSwapKinds` in `public/js/garage.js` (and `src/lib/wear.ts`): which
     * kinds share a place on the car with [kind] — what equipping a part takes
     * off. A full set swaps with either pair and the pairs swap with a full
     * set, but a front pair leaves the rears alone; `other` swaps nothing.
     */
    public fun equipSwapKinds(kind: PartKind): List<PartKind> = when (kind) {
        PartKind.OTHER -> emptyList()
        PartKind.TIRES -> listOf(PartKind.TIRES, PartKind.TIRES_FRONT, PartKind.TIRES_REAR)
        PartKind.TIRES_FRONT, PartKind.TIRES_REAR -> listOf(kind, PartKind.TIRES)
        else -> listOf(kind)
    }

    /**
     * `equipSwapsOff`: the equipped parts that equipping a part of [kind] (with
     * id [partId], null for one not created yet) would take off the car. The
     * server makes the same choice; this is only so the switch can say so
     * first. A part with no `equipped` — cached before 0029 — is never named,
     * as in the JS, where `undefined` is falsy.
     */
    public fun equipSwapsOff(partId: Int?, kind: PartKind, parts: List<Part>): List<Part> {
        val kinds = equipSwapKinds(kind)
        return parts.filter {
            it.id != partId && it.equipped == true && it.retiredOn == null && it.kind in kinds
        }
    }

    /** `partTitle`: the part's name with its size, when it has one — "Hoosier A7 · 285/30R18". */
    public fun partTitle(name: String?, size: String?): String =
        if (!size.isNullOrEmpty()) "${name.orEmpty()} · $size" else name.orEmpty()

    public fun partTitle(part: Part): String = partTitle(part.name, part.size)

    /**
     * On the car right now — `onCarParts` in `public/app.js`. A part with no
     * `equipped` (a response cached before 0029) counts as on the car.
     */
    public fun isOnCar(part: Part): Boolean = part.retiredOn == null && part.equipped != false

    /** On the shelf: off the car but not retired — a spare set, the street pads. */
    public fun isSpare(part: Part): Boolean = part.retiredOn == null && part.equipped == false

    /**
     * Parts in the car's own order — pads, tires full set then front then
     * rear, rotors, fluids — newest first within a kind, as the web page
     * lists them. A kind the client doesn't know sorts first, like the JS's
     * `findIndex` of -1.
     */
    public fun sortedByKind(parts: List<Part>): List<Part> =
        parts.sortedWith(
            compareBy<Part> { PartKind.all.indexOf(it.kind) }.thenByDescending { it.installedOn },
        )

    /**
     * When the part last came off the car (the latest `removed_on`), or null
     * if it never has — a spare with no history is "not fitted yet".
     */
    public fun lastOff(part: Part): String? = part.mounts.mapNotNull { it.removedOn }.maxOrNull()

    /**
     * The earliest date the Equipped switch accepts for its swap: taking a
     * part off can't predate the stretch it is on, and putting one on can't go
     * back inside a stretch it was already on. The server refuses the same.
     */
    public fun earliestSwapDate(part: Part): String =
        if (part.equipped != false) {
            part.mounts.firstOrNull { it.removedOn == null }?.mountedOn ?: part.installedOn
        } else {
            lastOff(part)?.takeIf { it > part.installedOn } ?: part.installedOn
        }

    /**
     * What the Equipped switch says before it writes: taking a part off, or
     * putting it on and what that takes off. The web page's confirm row.
     */
    public fun equipNote(part: Part, parts: List<Part>): String {
        if (part.equipped != false) {
            return "Take it off the car? It moves to Spares with its history, and its wear stops until it goes back on."
        }
        val swaps = equipSwapsOff(part.id, part.kind, parts)
        return if (swaps.isEmpty()) "Put it on the car? Its wear picks up from here."
        else "Put it on the car? This takes off ${swapList(swaps)} — ${movesTo(swaps)} to Spares."
    }

    /**
     * What adding (or refreshing into) a new part of [kind] takes off when it
     * goes on the car; null when nothing does. The add form's hint.
     */
    public fun addSwapNote(kind: PartKind, parts: List<Part>): String? {
        val swaps = equipSwapsOff(null, kind, parts)
        return if (swaps.isEmpty()) null else "Takes off ${swapList(swaps)} — ${movesTo(swaps)} to Spares."
    }

    private fun swapList(swaps: List<Part>) = swaps.joinToString(" and ") { partTitle(it) }
    private fun movesTo(swaps: List<Part>) = if (swaps.size == 1) "it moves" else "they move"

    // ---- car catalog (#222) ---------------------------------------------------
    //
    // The vehicle form's catalog picker: one searchable field over
    // GET /api/car-catalog. Pinned against the JS by
    // contracts/logic/car-catalog-match.json — the same fixture the iOS Kit
    // asserts against — so "c7" ranks the Corvette row the same on every client.

    /** "Chevrolet Corvette C7" — `catalogCarName`: the name a pick writes into an *empty* name field. */
    public fun catalogCarName(car: CatalogCar): String =
        listOfNotNull(car.make, car.model, car.generation).joinToString(" ")

    /** "2014–2019", or "2020–" while still in production — `catalogCarYears`. */
    public fun catalogCarYears(car: CatalogCar): String =
        if (car.yearTo != null) "${car.yearFrom}–${car.yearTo}" else "${car.yearFrom}–"

    /**
     * "Chevrolet Corvette · C7 · 2014–2019" — `catalogCarLabel`: how a picker row
     * reads. The generation and the year span are what disambiguate seven
     * Corvettes, so they are rendered rather than the bare model repeated.
     */
    public fun catalogCarLabel(car: CatalogCar): String =
        listOfNotNull("${car.make} ${car.model}", car.generation, catalogCarYears(car)).joinToString(" · ")

    /**
     * How well one query token fits a row — `tokenScore`: 3 for a whole word
     * ("c7"), 2 for a word prefix ("corv"), 1 for a substring anywhere, 0 for no
     * fit. Words are compared as written and with punctuation stripped, so "mx5"
     * finds "MX-5"; a four-digit token that fits nothing by name is tried as a
     * model year inside the row's span, so "corvette 2017" finds the C7.
     */
    private fun tokenScore(token: String, words: List<String>, row: CatalogCar): Int {
        var best = 0
        for (w in words) {
            val plain = w.filter { it in 'a'..'z' || it in '0'..'9' }
            best = when {
                w == token || plain == token -> maxOf(best, 3)
                w.startsWith(token) || plain.startsWith(token) -> maxOf(best, 2)
                w.contains(token) || plain.contains(token) -> maxOf(best, 1)
                else -> best
            }
        }
        if (best == 0 && token.length == 4 && token.all { it in '0'..'9' }) {
            val year = token.toInt()
            if (year >= row.yearFrom && (row.yearTo == null || year <= row.yearTo)) best = 2
        }
        return best
    }

    /**
     * The catalog rows matching a query, best first — `matchCatalogCars`. Every
     * whitespace-separated token has to fit the row somewhere (make, model,
     * generation or year span), so "chevrolet corvette" narrows rather than
     * widens; ties keep the catalog's own order, and an empty query is the
     * whole list.
     */
    public fun matchCatalogCars(query: String, rows: List<CatalogCar>): List<CatalogCar> {
        val tokens = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return rows.toList()
        data class Scored(val row: CatalogCar, val score: Int, val index: Int)
        val scored = ArrayList<Scored>()
        rows.forEachIndexed { i, row ->
            val words = catalogCarName(row).lowercase().split(" ")
            var score = 0
            for (t in tokens) {
                val s = tokenScore(t, words, row)
                if (s == 0) return@forEachIndexed
                score += s
            }
            scored += Scored(row, score, i)
        }
        return scored.sortedWith(compareByDescending<Scored> { it.score }.thenBy { it.index }).map { it.row }
    }

    /** The numbers on a vehicle form that a catalog pick may fill. */
    public data class VehicleGeometry(val wheelbaseMm: Int? = null, val steeringRatio: Double? = null)

    /** What a pick may do to one field — the three outcomes of [catalogPrefill]. */
    public enum class CatalogPrefillAction(public val rawValue: String) {
        /**
         * Write the catalog's value, null included: a car re-picked from a C7 to
         * a car with no single ratio must not keep the C7's.
         */
        FILL("fill"),

        /** The number is the driver's and differs; ask before replacing it. */
        ASK("ask"),

        /**
         * Nothing to do: already equal, or the driver's own number and the
         * catalog has nothing better than "unknown".
         */
        KEEP("keep"),
    }

    public data class CatalogPrefillStep<V>(val value: V?, val action: CatalogPrefillAction)

    public data class CatalogPrefillPlan(
        val wheelbaseMm: CatalogPrefillStep<Int>,
        val steeringRatio: CatalogPrefillStep<Double>,
    )

    /**
     * The "pre-fill, never overwrite" rule, decided per field — `catalogPrefill`.
     *
     * A number is the driver's when it is set and is not what the previous pick
     * ([previous]: the row the form's numbers came from, or null for a car typed
     * by hand) filled in — so a corrected ratio survives a re-pick behind a
     * question, and an untouched one is replaced silently.
     */
    public fun catalogPrefill(row: CatalogCar, current: VehicleGeometry, previous: CatalogCar?): CatalogPrefillPlan {
        fun <V> step(value: V?, cur: V?, prev: V?): CatalogPrefillStep<V> {
            val driverOwned = cur != null && (previous == null || cur != prev)
            val action = when {
                cur == value -> CatalogPrefillAction.KEEP
                !driverOwned -> CatalogPrefillAction.FILL
                value == null -> CatalogPrefillAction.KEEP
                else -> CatalogPrefillAction.ASK
            }
            return CatalogPrefillStep(value, action)
        }
        return CatalogPrefillPlan(
            wheelbaseMm = step(row.wheelbaseMm, current.wheelbaseMm, previous?.wheelbaseMm),
            steeringRatio = step(row.steeringRatio, current.steeringRatio, previous?.steeringRatio),
        )
    }

    // ---- a car's logbook (NS-37) ------------------------------------------------

    /**
     * The fields [vehicleLogbook] reads off an event row.
     * [app.trackevolution.core.model.Event] implements it, so logbook rows pass
     * straight in. `bestMs` is the *computed* best (`withComputed`: a manual
     * best counts).
     */
    public interface LogbookEvent : RemoteRecording.EventCandidate {
        public val id: Int
        public val vehicleId: Int?
        public val trackId: Int
        public val trackName: String
        public val bestMs: Int?
    }

    /** `{ id, track_id, track_name, start_date }` — the last-out / next-up row. */
    public data class LogbookEventRef(
        val id: Int,
        val trackId: Int,
        val trackName: String,
        val startDate: String,
    )

    /** One row of "best in this car": the fastest time at a track, and the day it was set. */
    public data class LogbookBest(
        val trackId: Int,
        val trackName: String,
        val bestMs: Int,
        val eventId: Int,
        val startDate: String,
    )

    /** `vehicleLogbook`'s answer. [trackDays] is fractional because `days` is. */
    public data class VehicleLogbook(
        val trackDays: Double,
        val events: Int,
        val lastEvent: LogbookEventRef?,
        val nextEvent: LogbookEventRef?,
        val bests: List<LogbookBest>,
    )

    private val eventOrder: Comparator<LogbookEvent> =
        compareBy<LogbookEvent> { it.startDate }.thenBy { it.id }

    private fun eventRef(e: LogbookEvent?): LogbookEventRef? =
        e?.let { LogbookEventRef(id = it.id, trackId = it.trackId, trackName = it.trackName, startDate = it.startDate) }

    /**
     * `vehicleLogbook(vehicleId, events, today)` in `public/js/garage.js` — the
     * free half of a car's tile and page, reduced from the cached event list so
     * it costs no request and works offline. Rows belong to the car by
     * `vehicleId`, which the server matched from the car name on save; a row
     * whose `car` text merely reads the same is **not** counted. Past means
     * `startDate <= today` (the totals' rule). Hours are deliberately absent:
     * they are the wear math's, and arrive computed on the Pro `GET /garage`.
     *
     * `bests` is one row per track with a time, ordered by the car's most recent
     * event there (event id breaking a date tie); within a track the fastest
     * wins and a tie keeps the earlier event.
     */
    public fun vehicleLogbook(vehicleId: Int, events: List<LogbookEvent>?, today: String): VehicleLogbook {
        val mine = events.orEmpty().filter { it.vehicleId != null && it.vehicleId == vehicleId }.sortedWith(eventOrder)
        val past = mine.filter { it.startDate <= today }
        val upcoming = mine.filter { it.startDate > today }
        val latest = LinkedHashMap<Int, LogbookEvent>()
        val best = HashMap<Int, LogbookEvent>()
        for (e in past) {
            latest[e.trackId] = e // `past` is ascending, so the last one seen is the latest
            val ms = e.bestMs ?: continue
            val current = best[e.trackId]?.bestMs
            if (current == null || ms < current) best[e.trackId] = e
        }
        val bests = latest.entries
            .filter { best[it.key] != null }
            .sortedWith { a, b -> eventOrder.compare(b.value, a.value) }
            .map { entry ->
                val e = best.getValue(entry.key)
                LogbookBest(
                    trackId = e.trackId,
                    trackName = e.trackName,
                    bestMs = e.bestMs!!,
                    eventId = e.id,
                    startDate = e.startDate,
                )
            }
        return VehicleLogbook(
            trackDays = past.sumOf { it.days },
            events = past.size,
            lastEvent = eventRef(past.lastOrNull()),
            nextEvent = eventRef(upcoming.firstOrNull()),
            bests = bests,
        )
    }

    /**
     * `vehicleTileLine(logbook)`: the one line a car's tile carries — "14 track
     * days · last at VIR (Full)", "Next: Road Atlanta", "No track days yet". No
     * date in it, since a date is locale work; the words are pinned because
     * three clients write them.
     */
    public fun vehicleTileLine(logbook: VehicleLogbook): String {
        val days = logbook.trackDays
        logbook.lastEvent?.let {
            return "${trimmed(days)} track day${if (days == 1.0) "" else "s"} · last at ${it.trackName}"
        }
        logbook.nextEvent?.let { return "Next: ${it.trackName}" }
        return "No track days yet"
    }

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
        PartKind.TIRES -> "Tires (full set)"
        PartKind.TIRES_FRONT -> "Front tires"
        PartKind.TIRES_REAR -> "Rear tires"
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
        PartKind.TIRES, PartKind.TIRES_FRONT, PartKind.TIRES_REAR -> "3 (32nds)"
        PartKind.ROTORS_FRONT -> "28 (mm)"
        PartKind.ROTORS_REAR -> "26 (mm)"
        else -> null
    }

/**
 * The unit a first measurement of this kind is most likely in for an imperial
 * user — the web measurement form's default before the unit preference
 * existed. The screens read [Garage.defaultMeasurementUnit], which takes the
 * account's system; this stays as the imperial table it always was.
 */
public val PartKind.defaultUnit: String
    get() = Garage.defaultMeasurementUnit(this, UnitSystem.IMPERIAL)
