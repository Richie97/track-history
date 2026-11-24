package app.trackevolution.core

import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.StartFinish
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TrackPlace
import app.trackevolution.core.telemetry.ParsedTelemetry
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * Which track was this driven at, and which event does it belong to (NS-57,
 * `docs/specs/native/NS-57-auto-place-laps.md`) — the port of
 * `public/js/import/locate.js` under the same names, pinned by
 * `contracts/logic/track-locate.json`.
 *
 * Pure, and run on the device: no coordinate is sent anywhere to be matched.
 * A recording's place — the centre of its best lap and that lap's length — is
 * compared with the driver's own tracks first (any track with one anchored
 * session is a known place, catalog or not) and then with the seeded catalog.
 * Location finds the venue; only the lap's length tells one layout of a venue
 * from another, so a match that length cannot settle is offered, never made.
 *
 * The JS takes plain objects; here the inputs are three small interfaces the
 * API models implement ([OwnTrack] by `Track`, [CatalogRow] by `CatalogTrack`,
 * [EventRow] by `Event`), and the JS's string unions are enums whose [value]
 * is the JS string.
 */
public object TrackLocate {

    public const val OWN_RADIUS_M: Double = 400.0
    public const val VENUE_RADIUS_M: Double = 2000.0

    /** Own-track tolerance: both sides are driven laps and may differ either way. */
    public const val LENGTH_TOLERANCE: Double = 0.04

    /**
     * Against the catalog's published length the error is one-sided: a best
     * lap's trace ran 0.7–4.0 % short on real footage and never long.
     */
    public const val CATALOG_SHORT_TOLERANCE: Double = 0.06
    public const val CATALOG_LONG_TOLERANCE: Double = 0.02

    /** A file's date is local on some sources and UTC on others. */
    public const val DATE_SLACK_DAYS: Int = 1

    /** Half the width of a gate rebuilt from a known line: `buildGate`'s default. */
    public const val GATE_HALF_WIDTH_M: Double = 20.0

    // ---- inputs ---------------------------------------------------------------

    /** A `GET /api/tracks` row, as far as matching reads it. */
    public interface OwnTrack {
        public val id: Int
        public val name: String
        public val catalogId: Int?
        public val geo: TrackPlace?
    }

    /** A `GET /api/catalog` row. */
    public interface CatalogRow {
        public val id: Int
        public val name: String
        public val lat: Double?
        public val lon: Double?
        public val lengthM: Int?
    }

    /** A `GET /api/events` row, as far as grouping reads it. */
    public interface EventRow {
        public val id: Int
        public val trackId: Int
        public val startDate: String
        public val days: Double
    }

    // ---- shapes ---------------------------------------------------------------

    /** Where a recording was driven. [lengthM] is null before there are laps. */
    public data class Place(val lat: Double, val lon: Double, val lengthM: Double?)

    public enum class Source(public val value: String) { OWN("own"), CATALOG("catalog"), NEW("new") }

    public enum class Confidence(public val value: String) {
        /** One candidate and its length agrees: pre-fill it. */
        EXACT("exact"),

        /** The driver named the track. */
        CHOSEN("chosen"),

        /** Several candidates, or one whose length could not be checked: ask. */
        CHOOSE("choose"),

        /** Nothing known is here. */
        NONE("none"),
    }

    public data class Candidate(
        val source: Source,
        val id: Int,
        val name: String,
        val distM: Double,
        val lengthOff: Double?,
    )

    /**
     * [venueOnly] is true for the one `choose` where the place is a venue we
     * know but the lap fits none of its layouts: the venue's rows are offered
     * and nothing is pre-filled.
     */
    public data class Located(
        val confidence: Confidence,
        val candidates: List<Candidate>,
        val venueOnly: Boolean = false,
    )

    /** A group's track: [id] is null for a [Source.NEW] one the driver named. */
    public data class GroupTrack(val source: Source, val id: Int?, val name: String)

    /** One file that has laps; [located] is [locateTrack]'s answer for its [place]. */
    public data class Item(
        val id: Int,
        val date: String?,
        val time: String?,
        val place: Place?,
        val located: Located?,
    )

    /** One card of the review: an existing event ([eventId]) or a new one. */
    public data class Group(
        val key: String,
        val eventId: Int?,
        val track: GroupTrack?,
        val confidence: Confidence,
        val candidates: List<Candidate>,
        val venueOnly: Boolean,
        val start: String,
        val days: Int,
        val itemIds: List<Int>,
    )

    public data class KnownLine(val id: Int, val name: String, val sf: StartFinish, val distM: Double)

    private val NONE = Located(Confidence.NONE, emptyList(), false)

    private fun usable(lat: Double?, lon: Double?): Boolean =
        lat != null && lon != null && lat.isFinite() && lon.isFinite() &&
            Math.abs(lat) <= 85 && Math.abs(lon) <= 180 &&
            !(Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01)

    // ---- where ------------------------------------------------------------------

    /** Metres between two coordinates, on `projectTrace`'s own constants. */
    public fun distanceM(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
        val dy = (aLat - bLat) * GeoTrace.KY
        val dx = (aLon - bLon) * GeoTrace.KX((aLat + bLat) / 2)
        return Math.hypot(dx, dy)
    }

    public fun distanceM(a: Place, b: Place): Double = distanceM(a.lat, a.lon, b.lat, b.lon)

    /** A closed polyline's length in metres — the server's `polylineLength`. */
    public fun traceLengthM(trace: List<TraceSample>?): Double? {
        if (trace == null || trace.size < 2) return null
        var total = 0.0
        for (i in trace.indices) {
            val a = trace[i]
            val b = trace[(i + 1) % trace.size]
            total += Math.hypot(b.x - a.x, b.y - a.y)
        }
        return if (total > 0) total else null
    }

    /**
     * Where a parsed file was driven. With laps, the centre of the best lap's
     * bounding box and its closed length. Without laps yet (a source waiting
     * for its start/finish line), the centre of the raw trace and no length —
     * enough for the venue, never for the layout. Null when the file carries
     * no usable position.
     */
    public fun recordingPlace(parsed: ParsedTelemetry?): Place? =
        recordingPlace(parsed?.bestLapTrace, parsed?.traceGeo, parsed?.gps)

    /** The venue of a file with no laps yet: `recordingPlace({ gps })`. */
    public fun recordingPlace(gps: List<GpsPoint>?): Place? = recordingPlace(null, null, gps)

    public fun recordingPlace(trace: List<TraceSample>?, geo: TraceGeo?, gps: List<GpsPoint>?): Place? {
        if (trace != null && trace.size >= 2 && geo != null && usable(geo.lat, geo.lon)) {
            val kx = GeoTrace.KX(geo.lat)
            val centre = boxCentre(trace.map { (geo.lat + it.y / GeoTrace.KY) to (geo.lon + it.x / kx) })
            return centre?.let { Place(it.first, it.second, traceLengthM(trace)) }
        }
        val centre = boxCentre((gps ?: emptyList()).map { it.lat to it.lon })
        return centre?.let { Place(it.first, it.second, null) }
    }

    private fun boxCentre(points: List<Pair<Double, Double>>): Pair<Double, Double>? {
        var s = Double.POSITIVE_INFINITY
        var n = Double.NEGATIVE_INFINITY
        var w = Double.POSITIVE_INFINITY
        var e = Double.NEGATIVE_INFINITY
        for ((lat, lon) in points) {
            if (!usable(lat, lon)) continue
            if (lat < s) s = lat
            if (lat > n) n = lat
            if (lon < w) w = lon
            if (lon > e) e = lon
        }
        return if (s.isFinite()) ((s + n) / 2) to ((w + e) / 2) else null
    }

    private fun lengthOff(lengthM: Double?, trackM: Int?): Double? =
        if (lengthM != null && trackM != null && trackM > 0) Math.abs(lengthM - trackM) / trackM else null

    /** Whether a driven lap could be a catalog layout of published length [trackM]. */
    public fun fitsCatalogLength(lengthM: Double?, trackM: Int?): Boolean {
        if (lengthM == null || trackM == null || trackM <= 0) return true // nothing to rule it out by
        val signed = (lengthM - trackM) / trackM
        return signed >= -CATALOG_SHORT_TOLERANCE && signed <= CATALOG_LONG_TOLERANCE
    }

    private val byOrder: Comparator<Candidate> = Comparator { a, b ->
        val nullness = (if (a.lengthOff == null) 1 else 0) - (if (b.lengthOff == null) 1 else 0)
        if (nullness != 0) return@Comparator nullness
        val off = (a.lengthOff ?: 0.0).compareTo(b.lengthOff ?: 0.0)
        if (off != 0) return@Comparator off
        val dist = a.distM.compareTo(b.distM)
        if (dist != 0) dist else a.id.compareTo(b.id)
    }

    /**
     * The tracks a place could be, best first, and how sure that is. A catalog
     * row the driver already has a track for comes back as that own track.
     */
    public fun locateTrack(place: Place?, ownTracks: List<OwnTrack>?, catalog: List<CatalogRow>?): Located {
        if (place == null || !usable(place.lat, place.lon)) return NONE
        val measured = place.lengthM != null

        // Your own tracks: the same place and, once there is a lap, the same length.
        val own = mutableListOf<Candidate>()
        for (t in ownTracks ?: emptyList()) {
            val geo = t.geo ?: continue
            if (!usable(geo.lat, geo.lon)) continue
            val distM = distanceM(place.lat, place.lon, geo.lat, geo.lon)
            val off = lengthOff(place.lengthM, geo.lengthM)
            val here = if (measured) distM <= OWN_RADIUS_M && off != null && off <= LENGTH_TOLERANCE else distM <= VENUE_RADIUS_M
            if (here) own.add(Candidate(Source.OWN, t.id, t.name, distM, off))
        }
        own.sortWith(byOrder)
        if (measured && own.isNotEmpty()) {
            return Located(if (own.size == 1) Confidence.EXACT else Confidence.CHOOSE, own, false)
        }

        // Then the catalog: every layout at the venue the lap's length does not rule out.
        val ownByCatalog = LinkedHashMap<Int, OwnTrack>()
        for (t in ownTracks ?: emptyList()) {
            val cid = t.catalogId ?: continue
            if (!ownByCatalog.containsKey(cid)) ownByCatalog[cid] = t
        }
        val found = own.toMutableList()
        val offLayout = mutableListOf<Candidate>() // at the venue, but the lap's length rules the layout out
        val seen = own.map { it.id }.toMutableSet()
        val seenOff = mutableSetOf<Int>()
        for (row in catalog ?: emptyList()) {
            val lat = row.lat
            val lon = row.lon
            if (lat == null || lon == null || !usable(lat, lon)) continue
            val distM = distanceM(place.lat, place.lon, lat, lon)
            if (distM > VENUE_RADIUS_M) continue
            val off = lengthOff(place.lengthM, row.lengthM)
            val fits = fitsCatalogLength(place.lengthM, row.lengthM)
            val into = if (fits) found else offLayout
            val ids = if (fits) seen else seenOff
            val mine = ownByCatalog[row.id]
            if (mine != null) {
                if (mine.id !in ids) into.add(Candidate(Source.OWN, mine.id, mine.name, distM, off))
                ids.add(mine.id)
            } else {
                into.add(Candidate(Source.CATALOG, row.id, row.name, distM, off))
            }
        }
        found.sortWith(byOrder)
        if (found.isNotEmpty()) {
            val exact = found.size == 1 && found[0].lengthOff != null
            return Located(if (exact) Confidence.EXACT else Confidence.CHOOSE, found, false)
        }
        if (offLayout.isEmpty()) return NONE
        offLayout.sortWith(byOrder)
        return Located(Confidence.CHOOSE, offLayout, true)
    }

    // ---- grouping a batch into events ----------------------------------------------

    /** Date-only arithmetic, so a DST change cannot skip or repeat a day. */
    public fun addDays(iso: String, n: Int): String = LocalDate.parse(iso).plusDays(n.toLong()).toString()

    private fun dayGap(a: String, b: String): Int =
        ChronoUnit.DAYS.between(LocalDate.parse(a), LocalDate.parse(b)).toInt()

    private fun sameName(a: String, b: String): Boolean = a.trim().lowercase() == b.trim().lowercase()

    /** `Math.max(1, Math.trunc(Number(days)) || 1)`. */
    private fun wholeDays(days: Double): Int = if (days.isFinite()) Math.max(1, days.toInt()) else 1

    /**
     * The event a file dated [date] at own track [trackId] joins: one at that
     * track whose days cover the date — or, failing that, cover it once widened
     * by [DATE_SLACK_DAYS]. Never an event at another track. Overlaps go to the
     * one that started most recently, then the higher id.
     */
    public fun <E : EventRow> eventForDate(events: List<E>?, trackId: Int, date: String): E? {
        for (slack in intArrayOf(0, DATE_SLACK_DAYS)) {
            var best: E? = null
            for (e in events ?: emptyList()) {
                if (e.trackId != trackId || e.startDate.isEmpty()) continue
                val days = wholeDays(e.days)
                if (date < addDays(e.startDate, -slack) || date > addDays(e.startDate, days - 1 + slack)) continue
                val b = best
                if (b == null || e.startDate > b.startDate || (e.startDate == b.startDate && e.id > b.id)) best = e
            }
            if (best != null) return best
        }
        return null
    }

    private class Row(
        val it: Item,
        val date: String,
        val track: GroupTrack?,
        val confidence: Confidence,
        var trackKey: String?,
        val located: Located,
    )

    private class Building(
        val key: String,
        val eventId: Int?,
        val track: GroupTrack?,
        var confidence: Confidence,
        val candidates: List<Candidate>,
        val venueOnly: Boolean,
        val start: String,
        var days: Int,
        val itemIds: MutableList<Int> = mutableListOf(),
    ) {
        fun done() = Group(key, eventId, track, confidence, candidates, venueOnly, start, days, itemIds.toList())
    }

    /**
     * The review's cards. [choices] maps an item id to the track name the
     * driver gave, which outranks the match. A group either joins an existing
     * event or is one track over one run of consecutive dates; its `track` is
     * null until a choose / none group is answered.
     */
    public fun groupImports(
        items: List<Item>?,
        events: List<EventRow>?,
        choices: Map<Int, String> = emptyMap(),
        ownTracks: List<OwnTrack> = emptyList(),
        today: String,
    ): List<Group> {
        val rows = (items ?: emptyList()).map { item ->
            val date = item.date?.takeIf { it.isNotEmpty() } ?: today
            val choice = choices[item.id]?.trim().orEmpty()
            val located = item.located ?: NONE
            var track: GroupTrack? = null
            var confidence = located.confidence
            val trackKey: String?
            if (choice.isNotEmpty()) {
                val mine = ownTracks.firstOrNull { sameName(it.name, choice) }
                track = if (mine != null) GroupTrack(Source.OWN, mine.id, mine.name) else GroupTrack(Source.NEW, null, choice)
                confidence = Confidence.CHOSEN
                trackKey = if (mine != null) "own:${mine.id}" else "new:${choice.lowercase()}"
            } else if (located.candidates.isNotEmpty()) {
                val top = located.candidates[0]
                if (confidence == Confidence.EXACT) track = GroupTrack(top.source, top.id, top.name)
                trackKey = "${top.source.value}:${top.id}${if (confidence == Confidence.EXACT) "" else "?"}"
            } else {
                trackKey = null // clustered by place below
            }
            Row(item, date, track, confidence, trackKey, located)
        }

        // Files nothing is known about group by where they are.
        val clusters = mutableListOf<Place>()
        for (r in rows) {
            if (r.trackKey != null) continue
            val place = r.it.place
            var idx = if (place != null) clusters.indexOfFirst { distanceM(it, place) <= VENUE_RADIUS_M } else -1
            if (idx < 0 && place != null) {
                clusters.add(place)
                idx = clusters.size - 1
            }
            r.trackKey = if (place != null) "place:$idx" else "nowhere"
        }

        // The JS compares times with localeCompare; they are "HH:MM" digits, so
        // a plain comparison orders them the same.
        val sorted = rows.sortedWith(compareBy<Row> { it.date }.thenBy { it.it.time ?: "" })

        val groups = mutableListOf<Building>()
        val open = HashMap<String, Building>() // trackKey -> the newest new-event group for it
        val attached = HashMap<Int, Building>() // event id -> group
        for (r in sorted) {
            val track = r.track
            val event = if (track?.source == Source.OWN && track.id != null) eventForDate(events, track.id, r.date) else null
            if (event != null) {
                var g = attached[event.id]
                if (g == null) {
                    g = Building(
                        key = "event:${event.id}",
                        eventId = event.id,
                        track = track,
                        confidence = r.confidence,
                        candidates = r.located.candidates,
                        venueOnly = r.located.venueOnly,
                        start = event.startDate,
                        days = wholeDays(event.days),
                    )
                    attached[event.id] = g
                    groups.add(g)
                }
                if (r.confidence == Confidence.CHOSEN) g.confidence = Confidence.CHOSEN
                g.itemIds.add(r.it.id)
                continue
            }
            val key = r.trackKey!!
            var g = open[key]
            if (g == null || dayGap(addDays(g.start, g.days - 1), r.date) > 1) {
                g = Building(
                    key = "$key@${r.date}",
                    eventId = null,
                    track = track,
                    confidence = r.confidence,
                    candidates = r.located.candidates,
                    venueOnly = r.located.venueOnly,
                    start = r.date,
                    days = 1,
                )
                open[key] = g
                groups.add(g)
            }
            g.days = Math.max(g.days, dayGap(g.start, r.date) + 1)
            g.itemIds.add(r.it.id)
        }
        return groups.sortedBy { it.start }.map { it.done() }
    }

    /** The `POST /events` body for a new-event group whose track is known. */
    public fun eventBodyFor(group: Group, defaultCar: String? = null): EventDraft = EventDraft(
        startDate = group.start,
        trackName = group.track!!.name,
        days = group.days.toDouble(),
        car = defaultCar?.takeIf { it.isNotEmpty() },
    )

    // ---- a start/finish line we already know (phase 3) -----------------------------

    /**
     * The gate for a known start/finish line, in the projected frame of the
     * trace it will time: [origin] is where that trace was projected from. The
     * same shape `buildGate` returns, direction filter included, so a
     * reverse-direction day finds no laps and falls back to the picker.
     */
    public fun gateFromSf(sf: StartFinish?, origin: TraceGeo?): Gate? {
        if (sf == null || !usable(sf.lat, sf.lon) || !sf.heading.isFinite() || origin == null) return null
        val x = (sf.lon - origin.lon) * GeoTrace.KX(origin.lat)
        val y = (sf.lat - origin.lat) * GeoTrace.KY
        val h = sf.heading * Math.PI / 180
        val ux = Math.sin(h)
        val uy = Math.cos(h)
        return Gate(
            x = x,
            y = y,
            hx = ux,
            hy = uy,
            x1 = x + uy * GATE_HALF_WIDTH_M,
            y1 = y - ux * GATE_HALF_WIDTH_M,
            x2 = x - uy * GATE_HALF_WIDTH_M,
            y2 = y + ux * GATE_HALF_WIDTH_M,
        )
    }

    /**
     * The driver's own tracks at a place that have a line to offer, nearest
     * first. A file with no laps yet has only a venue, so this is every own
     * track in the venue's radius; which one's line is right is settled by
     * trying it ([lineFits]).
     */
    public fun knownLines(place: Place?, ownTracks: List<OwnTrack>?): List<KnownLine> {
        if (place == null || !usable(place.lat, place.lon)) return emptyList()
        val out = mutableListOf<KnownLine>()
        for (t in ownTracks ?: emptyList()) {
            val geo = t.geo ?: continue
            val sf = geo.sf ?: continue
            if (!usable(geo.lat, geo.lon)) continue
            val distM = distanceM(place.lat, place.lon, geo.lat, geo.lon)
            if (distM <= VENUE_RADIUS_M) out.add(KnownLine(t.id, t.name, sf, distM))
        }
        return out.sortedWith(compareBy<KnownLine> { it.distM }.thenBy { it.id })
    }

    /**
     * Whether a known line was the right one for the files it was applied to:
     * [places] are [recordingPlace] of each file *after* the gate timed it,
     * null for a file it cut no laps from. It fits when at least one file got
     * laps and every file that did is, by place and lap length, exactly the
     * track the line came from.
     */
    public fun lineFits(
        trackId: Int,
        places: List<Place?>?,
        ownTracks: List<OwnTrack>?,
        catalog: List<CatalogRow>?,
    ): Boolean {
        val timed = (places ?: emptyList()).filterNotNull().filter { it.lengthM != null }
        if (timed.isEmpty()) return false
        return timed.all { p ->
            val found = locateTrack(p, ownTracks, catalog)
            found.confidence == Confidence.EXACT && found.candidates[0].source == Source.OWN && found.candidates[0].id == trackId
        }
    }

    /**
     * For a file imported onto an event the driver picked: the name of another
     * track it was certainly driven at, or null. Only an `exact` match that is
     * not this event's track says anything.
     */
    public fun otherTrackHere(located: Located?, trackId: Int?, trackCatalogId: Int?): String? {
        if (located?.confidence != Confidence.EXACT) return null
        val top = located.candidates[0]
        val same = if (top.source == Source.OWN) top.id == trackId else top.id == trackCatalogId
        return if (same) null else top.name
    }

    /** "14 Mar 2026" needs a locale; the cards take the caller's formatter. */
    public fun groupDatesText(group: Group, fmtDate: (String) -> String): String =
        if (group.days > 1) "${fmtDate(group.start)} – ${fmtDate(addDays(group.start, group.days - 1))}" else fmtDate(group.start)
}
