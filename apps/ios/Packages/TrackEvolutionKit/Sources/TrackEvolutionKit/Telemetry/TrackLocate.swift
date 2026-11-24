import Foundation

/// Which track was this driven at, and which event does it belong to (NS-57,
/// `docs/specs/native/NS-57-auto-place-laps.md`) — the port of
/// `public/js/import/locate.js` under the same names, pinned by
/// `contracts/logic/track-locate.json`.
///
/// Pure, and run on the device: no coordinate is sent anywhere to be matched.
/// A recording's place — the centre of its best lap and that lap's length — is
/// compared with the driver's own tracks first (any track with one anchored
/// session is a known place, catalog or not) and then with the seeded catalog.
/// Location finds the venue; only the lap's length tells one layout of a venue
/// from another, so a match that length cannot settle is offered, never made.
///
/// The JS takes plain objects. Here the three inputs are small structs built
/// from the API models (`OwnTrack(_:)` from a `Track`, `CatalogRow(_:)` from a
/// `CatalogTrack`, `EventRow(_:)` from an `Event`), and the JS's string unions
/// are enums whose raw value is the JS string.
public enum TrackLocate {
    public static let OWN_RADIUS_M: Double = 400
    public static let VENUE_RADIUS_M: Double = 2000
    /// Own-track tolerance: both sides are driven laps and may differ either way.
    public static let LENGTH_TOLERANCE: Double = 0.04
    /// Against the catalog's published length the error is one-sided: a best
    /// lap's trace ran 0.7–4.0 % short on real footage and never long.
    public static let CATALOG_SHORT_TOLERANCE: Double = 0.06
    public static let CATALOG_LONG_TOLERANCE: Double = 0.02
    /// A file's date is local on some sources and UTC on others.
    public static let DATE_SLACK_DAYS: Int = 1
    /// Half the width of a gate rebuilt from a known line: `buildGate`'s default.
    public static let GATE_HALF_WIDTH_M: Double = 20

    // MARK: - Inputs

    /// A `GET /api/tracks` row, as far as matching reads it.
    public struct OwnTrack: Hashable, Sendable {
        public var id: Int
        public var name: String
        public var catalogId: Int?
        public var geo: TrackPlace?

        public init(id: Int, name: String, catalogId: Int? = nil, geo: TrackPlace? = nil) {
            self.id = id
            self.name = name
            self.catalogId = catalogId
            self.geo = geo
        }

        public init(_ track: Track) {
            self.init(id: track.id, name: track.name, catalogId: track.catalogId, geo: track.geo)
        }
    }

    /// A `GET /api/catalog` row.
    public struct CatalogRow: Hashable, Sendable {
        public var id: Int
        public var name: String
        public var lat: Double?
        public var lon: Double?
        public var lengthM: Int?

        public init(id: Int, name: String, lat: Double? = nil, lon: Double? = nil, lengthM: Int? = nil) {
            self.id = id
            self.name = name
            self.lat = lat
            self.lon = lon
            self.lengthM = lengthM
        }

        public init(_ row: CatalogTrack) {
            self.init(id: row.id, name: row.name, lat: row.lat, lon: row.lon, lengthM: row.lengthM)
        }
    }

    /// A `GET /api/events` row, as far as grouping reads it.
    public struct EventRow: Hashable, Sendable {
        public var id: Int
        public var trackId: Int
        public var startDate: String
        public var days: Double

        public init(id: Int, trackId: Int, startDate: String, days: Double) {
            self.id = id
            self.trackId = trackId
            self.startDate = startDate
            self.days = days
        }

        public init(_ event: Event) {
            self.init(id: event.id, trackId: event.trackId, startDate: event.startDate, days: event.days)
        }
    }

    // MARK: - Shapes

    /// Where a recording was driven. `lengthM` is nil before there are laps.
    public struct Place: Hashable, Sendable {
        public var lat: Double
        public var lon: Double
        public var lengthM: Double?

        public init(lat: Double, lon: Double, lengthM: Double? = nil) {
            self.lat = lat
            self.lon = lon
            self.lengthM = lengthM
        }
    }

    public enum Source: String, Hashable, Sendable {
        case own, catalog
        /// A track the driver named, in a group only.
        case new
    }

    public enum Confidence: String, Hashable, Sendable {
        /// One candidate and its length agrees: pre-fill it.
        case exact
        /// The driver named the track.
        case chosen
        /// Several candidates, or one whose length could not be checked: ask.
        case choose
        /// Nothing known is here.
        case none
    }

    public struct Candidate: Hashable, Sendable {
        public var source: Source
        public var id: Int
        public var name: String
        public var distM: Double
        public var lengthOff: Double?

        public init(source: Source, id: Int, name: String, distM: Double, lengthOff: Double?) {
            self.source = source
            self.id = id
            self.name = name
            self.distM = distM
            self.lengthOff = lengthOff
        }
    }

    /// `venueOnly` is true for the one `choose` where the place is a venue we
    /// know but the lap fits none of its layouts: the venue's rows are offered
    /// and nothing is pre-filled.
    public struct Located: Hashable, Sendable {
        public var confidence: Confidence
        public var candidates: [Candidate]
        public var venueOnly: Bool

        public init(confidence: Confidence, candidates: [Candidate], venueOnly: Bool = false) {
            self.confidence = confidence
            self.candidates = candidates
            self.venueOnly = venueOnly
        }

        public static let nothing = Located(confidence: .none, candidates: [], venueOnly: false)
    }

    /// A group's track: `id` is nil for a `.new` one the driver named.
    public struct GroupTrack: Hashable, Sendable {
        public var source: Source
        public var id: Int?
        public var name: String

        public init(source: Source, id: Int?, name: String) {
            self.source = source
            self.id = id
            self.name = name
        }
    }

    /// One file that has laps; `located` is `locateTrack`'s answer for its `place`.
    public struct Item: Hashable, Sendable {
        public var id: Int
        public var date: String?
        public var time: String?
        public var place: Place?
        public var located: Located?

        public init(id: Int, date: String?, time: String?, place: Place?, located: Located?) {
            self.id = id
            self.date = date
            self.time = time
            self.place = place
            self.located = located
        }
    }

    /// One card of the review: an existing event (`eventId`) or a new one.
    public struct Group: Hashable, Sendable, Identifiable {
        public var key: String
        public var eventId: Int?
        public var track: GroupTrack?
        public var confidence: Confidence
        public var candidates: [Candidate]
        public var venueOnly: Bool
        public var start: String
        public var days: Int
        public var itemIds: [Int]

        public var id: String { key }

        public init(
            key: String, eventId: Int?, track: GroupTrack?, confidence: Confidence, candidates: [Candidate],
            venueOnly: Bool, start: String, days: Int, itemIds: [Int]
        ) {
            self.key = key
            self.eventId = eventId
            self.track = track
            self.confidence = confidence
            self.candidates = candidates
            self.venueOnly = venueOnly
            self.start = start
            self.days = days
            self.itemIds = itemIds
        }
    }

    public struct KnownLine: Hashable, Sendable {
        public var id: Int
        public var name: String
        public var sf: StartFinish
        public var distM: Double
    }

    private static func usable(_ lat: Double?, _ lon: Double?) -> Bool {
        guard let lat, let lon, lat.isFinite, lon.isFinite else { return false }
        return abs(lat) <= 85 && abs(lon) <= 180 && !(abs(lat) < 0.01 && abs(lon) < 0.01)
    }

    // MARK: - Where

    /// Metres between two coordinates, on `projectTrace`'s own constants.
    public static func distanceM(_ aLat: Double, _ aLon: Double, _ bLat: Double, _ bLon: Double) -> Double {
        let dy = (aLat - bLat) * Geo.KY
        let dx = (aLon - bLon) * Geo.KX((aLat + bLat) / 2)
        return (dx * dx + dy * dy).squareRoot()
    }

    public static func distanceM(_ a: Place, _ b: Place) -> Double {
        distanceM(a.lat, a.lon, b.lat, b.lon)
    }

    /// A closed polyline's length in metres — the server's `polylineLength`.
    public static func traceLengthM(_ trace: [TracePoint]?) -> Double? {
        guard let trace, trace.count >= 2 else { return nil }
        var total = 0.0
        for i in trace.indices {
            let a = trace[i]
            let b = trace[(i + 1) % trace.count]
            let dx = b.x - a.x
            let dy = b.y - a.y
            total += (dx * dx + dy * dy).squareRoot()
        }
        return total > 0 ? total : nil
    }

    /// Where a parsed file was driven. With laps, the centre of the best lap's
    /// bounding box and its closed length. Without laps yet (a source waiting
    /// for its start/finish line), the centre of the raw trace and no length —
    /// enough for the venue, never for the layout. Nil when the file carries no
    /// usable position.
    public static func recordingPlace(_ parsed: ParsedTelemetry?) -> Place? {
        recordingPlace(trace: parsed?.bestLapTrace, geo: parsed?.traceGeo, gps: parsed?.gps)
    }

    public static func recordingPlace(trace: [TracePoint]?, geo: TraceGeo?, gps: [Geo.Point]?) -> Place? {
        if let trace, trace.count >= 2, let geo, usable(geo.lat, geo.lon) {
            let kx = Geo.KX(geo.lat)
            let points = trace.map { (lat: geo.lat + $0.y / Geo.KY, lon: geo.lon + $0.x / kx) }
            guard let centre = boxCentre(points) else { return nil }
            return Place(lat: centre.lat, lon: centre.lon, lengthM: traceLengthM(trace))
        }
        guard let centre = boxCentre((gps ?? []).map { (lat: $0.lat, lon: $0.lon) }) else { return nil }
        return Place(lat: centre.lat, lon: centre.lon, lengthM: nil)
    }

    private static func boxCentre(_ points: [(lat: Double, lon: Double)]) -> (lat: Double, lon: Double)? {
        var s = Double.infinity
        var n = -Double.infinity
        var w = Double.infinity
        var e = -Double.infinity
        for p in points where usable(p.lat, p.lon) {
            if p.lat < s { s = p.lat }
            if p.lat > n { n = p.lat }
            if p.lon < w { w = p.lon }
            if p.lon > e { e = p.lon }
        }
        return s.isFinite ? (lat: (s + n) / 2, lon: (w + e) / 2) : nil
    }

    private static func lengthOff(_ lengthM: Double?, _ trackM: Int?) -> Double? {
        guard let lengthM, let trackM, trackM > 0 else { return nil }
        return abs(lengthM - Double(trackM)) / Double(trackM)
    }

    /// Whether a driven lap could be a catalog layout of published length `trackM`.
    public static func fitsCatalogLength(_ lengthM: Double?, _ trackM: Int?) -> Bool {
        guard let lengthM, let trackM, trackM > 0 else { return true } // nothing to rule it out by
        let signed = (lengthM - Double(trackM)) / Double(trackM)
        return signed >= -CATALOG_SHORT_TOLERANCE && signed <= CATALOG_LONG_TOLERANCE
    }

    /// Measured first, then the closer length, the nearer place, the lower id.
    private static func byOrder(_ a: Candidate, _ b: Candidate) -> Bool {
        let an = a.lengthOff == nil ? 1 : 0
        let bn = b.lengthOff == nil ? 1 : 0
        if an != bn { return an < bn }
        let ao = a.lengthOff ?? 0
        let bo = b.lengthOff ?? 0
        if ao != bo { return ao < bo }
        if a.distM != b.distM { return a.distM < b.distM }
        return a.id < b.id
    }

    /// The tracks a place could be, best first, and how sure that is. A catalog
    /// row the driver already has a track for comes back as that own track.
    public static func locateTrack(_ place: Place?, _ ownTracks: [OwnTrack], _ catalog: [CatalogRow]) -> Located {
        guard let place, usable(place.lat, place.lon) else { return .nothing }
        let measured = place.lengthM != nil

        // Your own tracks: the same place and, once there is a lap, the same length.
        var own: [Candidate] = []
        for t in ownTracks {
            guard let geo = t.geo, usable(geo.lat, geo.lon) else { continue }
            let distM = distanceM(place.lat, place.lon, geo.lat, geo.lon)
            let off = lengthOff(place.lengthM, geo.lengthM)
            let here: Bool
            if measured {
                if let off { here = distM <= OWN_RADIUS_M && off <= LENGTH_TOLERANCE } else { here = false }
            } else {
                here = distM <= VENUE_RADIUS_M
            }
            if here { own.append(Candidate(source: .own, id: t.id, name: t.name, distM: distM, lengthOff: off)) }
        }
        own.sort(by: byOrder)
        if measured, !own.isEmpty {
            return Located(confidence: own.count == 1 ? .exact : .choose, candidates: own, venueOnly: false)
        }

        // Then the catalog: every layout at the venue the lap's length does not rule out.
        var ownByCatalog: [Int: OwnTrack] = [:]
        for t in ownTracks {
            if let cid = t.catalogId, ownByCatalog[cid] == nil { ownByCatalog[cid] = t }
        }
        var found = own
        var offLayout: [Candidate] = [] // at the venue, but the lap's length rules the layout out
        var seen = Set(own.map(\.id))
        var seenOff = Set<Int>()
        for row in catalog {
            guard let lat = row.lat, let lon = row.lon, usable(lat, lon) else { continue }
            let distM = distanceM(place.lat, place.lon, lat, lon)
            if distM > VENUE_RADIUS_M { continue }
            let off = lengthOff(place.lengthM, row.lengthM)
            let fits = fitsCatalogLength(place.lengthM, row.lengthM)
            let candidate: Candidate
            if let mine = ownByCatalog[row.id] {
                let already = fits ? seen.contains(mine.id) : seenOff.contains(mine.id)
                if fits { seen.insert(mine.id) } else { seenOff.insert(mine.id) }
                if already { continue }
                candidate = Candidate(source: .own, id: mine.id, name: mine.name, distM: distM, lengthOff: off)
            } else {
                candidate = Candidate(source: .catalog, id: row.id, name: row.name, distM: distM, lengthOff: off)
            }
            if fits { found.append(candidate) } else { offLayout.append(candidate) }
        }
        found.sort(by: byOrder)
        if !found.isEmpty {
            let exact = found.count == 1 && found[0].lengthOff != nil
            return Located(confidence: exact ? .exact : .choose, candidates: found, venueOnly: false)
        }
        if offLayout.isEmpty { return .nothing }
        offLayout.sort(by: byOrder)
        return Located(confidence: .choose, candidates: offLayout, venueOnly: true)
    }

    // MARK: - Grouping a batch into events

    /// Days since 1970-01-01 for an ISO `yyyy-mm-dd`, on the proleptic
    /// Gregorian calendar — date-only arithmetic, so a DST change cannot skip
    /// or repeat a day. Nil for anything that isn't three integers.
    private static func dayNumber(_ iso: String) -> Int? {
        let parts = iso.split(separator: "-", omittingEmptySubsequences: false).map { Int($0) }
        guard parts.count == 3, let y0 = parts[0], let m = parts[1], let d = parts[2] else { return nil }
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    private static func isoDate(_ dayNumber: Int) -> String {
        let z = dayNumber + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
        return "\(pad(y, 4))-\(pad(m, 2))-\(pad(d, 2))"
    }

    private static func pad(_ n: Int, _ width: Int) -> String {
        let s = String(n)
        return s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }

    public static func addDays(_ iso: String, _ n: Int) -> String {
        guard let day = dayNumber(iso) else { return iso }
        return isoDate(day + n)
    }

    private static func dayGap(_ a: String, _ b: String) -> Int {
        guard let da = dayNumber(a), let db = dayNumber(b) else { return 0 }
        return db - da
    }

    private static func trimmed(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func sameName(_ a: String, _ b: String) -> Bool {
        trimmed(a).lowercased() == trimmed(b).lowercased()
    }

    /// `Math.max(1, Math.trunc(Number(days)) || 1)`.
    private static func wholeDays(_ days: Double) -> Int {
        guard days.isFinite, abs(days) < 1_000_000 else { return 1 }
        return max(1, Int(days.rounded(.towardZero)))
    }

    /// The event a file dated `date` at own track `trackId` joins: one at that
    /// track whose days cover the date — or, failing that, cover it once
    /// widened by `DATE_SLACK_DAYS`. Never an event at another track. Overlaps
    /// go to the one that started most recently, then the higher id.
    public static func eventForDate(_ events: [EventRow], _ trackId: Int, _ date: String) -> EventRow? {
        for slack in [0, DATE_SLACK_DAYS] {
            var best: EventRow?
            for e in events {
                if e.trackId != trackId || e.startDate.isEmpty { continue }
                let days = wholeDays(e.days)
                if date < addDays(e.startDate, -slack) || date > addDays(e.startDate, days - 1 + slack) { continue }
                if let b = best {
                    if e.startDate > b.startDate || (e.startDate == b.startDate && e.id > b.id) { best = e }
                } else {
                    best = e
                }
            }
            if let best { return best }
        }
        return nil
    }

    private struct Row {
        var item: Item
        var date: String
        var track: GroupTrack?
        var confidence: Confidence
        var trackKey: String?
        var located: Located
    }

    /// The review's cards. `choices` maps an item id to the track name the
    /// driver gave, which outranks the match. A group either joins an existing
    /// event or is one track over one run of consecutive dates; its `track` is
    /// nil until a choose / none group is answered.
    public static func groupImports(
        _ items: [Item],
        _ events: [EventRow],
        choices: [Int: String] = [:],
        ownTracks: [OwnTrack] = [],
        today: String
    ) -> [Group] {
        var rows: [Row] = items.map { item in
            let date = (item.date?.isEmpty == false ? item.date : nil) ?? today
            let choice = trimmed(choices[item.id] ?? "")
            let located = item.located ?? .nothing
            var track: GroupTrack?
            var confidence = located.confidence
            var trackKey: String?
            if !choice.isEmpty {
                if let mine = ownTracks.first(where: { sameName($0.name, choice) }) {
                    track = GroupTrack(source: .own, id: mine.id, name: mine.name)
                    trackKey = "own:\(mine.id)"
                } else {
                    track = GroupTrack(source: .new, id: nil, name: choice)
                    trackKey = "new:\(choice.lowercased())"
                }
                confidence = .chosen
            } else if let top = located.candidates.first {
                if confidence == .exact { track = GroupTrack(source: top.source, id: top.id, name: top.name) }
                trackKey = "\(top.source.rawValue):\(top.id)\(confidence == .exact ? "" : "?")"
            } else {
                trackKey = nil // clustered by place below
            }
            return Row(item: item, date: date, track: track, confidence: confidence, trackKey: trackKey, located: located)
        }

        // Files nothing is known about group by where they are.
        var clusters: [Place] = []
        for i in rows.indices where rows[i].trackKey == nil {
            guard let place = rows[i].item.place else {
                rows[i].trackKey = "nowhere"
                continue
            }
            if let idx = clusters.firstIndex(where: { distanceM($0, place) <= VENUE_RADIUS_M }) {
                rows[i].trackKey = "place:\(idx)"
            } else {
                clusters.append(place)
                rows[i].trackKey = "place:\(clusters.count - 1)"
            }
        }

        // By date, then time, keeping the order given for a tie (the JS sort is
        // stable; Swift's makes no such promise, so the offset settles it). The
        // JS compares times with localeCompare; they are "HH:MM" digits, so a
        // plain comparison orders them the same.
        let sorted = rows.enumerated().sorted { a, b in
            if a.element.date != b.element.date { return a.element.date < b.element.date }
            let at = a.element.item.time ?? ""
            let bt = b.element.item.time ?? ""
            if at != bt { return at < bt }
            return a.offset < b.offset
        }.map(\.element)

        var groups: [Group] = []
        var open: [String: Int] = [:] // trackKey -> index of the newest new-event group for it
        var attached: [Int: Int] = [:] // event id -> index of its group
        for r in sorted {
            var event: EventRow?
            if let track = r.track, track.source == .own, let id = track.id {
                event = eventForDate(events, id, r.date)
            }
            if let event {
                if let idx = attached[event.id] {
                    if r.confidence == .chosen { groups[idx].confidence = .chosen }
                    groups[idx].itemIds.append(r.item.id)
                } else {
                    attached[event.id] = groups.count
                    groups.append(Group(
                        key: "event:\(event.id)",
                        eventId: event.id,
                        track: r.track,
                        confidence: r.confidence,
                        candidates: r.located.candidates,
                        venueOnly: r.located.venueOnly,
                        start: event.startDate,
                        days: wholeDays(event.days),
                        itemIds: [r.item.id]
                    ))
                }
                continue
            }
            let key = r.trackKey ?? "nowhere"
            var idx = open[key]
            if let i = idx, dayGap(addDays(groups[i].start, groups[i].days - 1), r.date) > 1 { idx = nil }
            if idx == nil {
                open[key] = groups.count
                idx = groups.count
                groups.append(Group(
                    key: "\(key)@\(r.date)",
                    eventId: nil,
                    track: r.track,
                    confidence: r.confidence,
                    candidates: r.located.candidates,
                    venueOnly: r.located.venueOnly,
                    start: r.date,
                    days: 1,
                    itemIds: []
                ))
            }
            if let i = idx {
                groups[i].days = max(groups[i].days, dayGap(groups[i].start, r.date) + 1)
                groups[i].itemIds.append(r.item.id)
            }
        }
        // By start date, keeping the order made for a tie.
        return groups.enumerated().sorted { a, b in
            a.element.start != b.element.start ? a.element.start < b.element.start : a.offset < b.offset
        }.map(\.element)
    }

    /// The `POST /events` body for a new-event group whose track is known; nil
    /// for a group still waiting for its track.
    public static func eventBodyFor(_ group: Group, _ defaultCar: String? = nil) -> EventDraft? {
        guard let track = group.track else { return nil }
        var draft = EventDraft(startDate: group.start, trackName: track.name)
        draft.days = Double(group.days)
        draft.car = (defaultCar?.isEmpty == false) ? defaultCar : nil
        return draft
    }

    // MARK: - A start/finish line we already know (phase 3)

    /// The gate for a known start/finish line, in the projected frame of the
    /// trace it will time: `origin` is where that trace was projected from. The
    /// same shape `buildGate` returns, direction filter included, so a
    /// reverse-direction day finds no laps and falls back to the picker.
    public static func gateFromSf(_ sf: StartFinish?, _ origin: Geo.Origin?) -> Geo.Gate? {
        guard let sf, usable(sf.lat, sf.lon), sf.heading.isFinite, let origin else { return nil }
        let x = (sf.lon - origin.lon) * Geo.KX(origin.lat)
        let y = (sf.lat - origin.lat) * Geo.KY
        let h = sf.heading * .pi / 180
        let ux = sin(h)
        let uy = cos(h)
        return Geo.Gate(
            x: x, y: y, hx: ux, hy: uy,
            x1: x + uy * GATE_HALF_WIDTH_M, y1: y - ux * GATE_HALF_WIDTH_M,
            x2: x - uy * GATE_HALF_WIDTH_M, y2: y + ux * GATE_HALF_WIDTH_M
        )
    }

    /// The driver's own tracks at a place that have a line to offer, nearest
    /// first. A file with no laps yet has only a venue, so this is every own
    /// track in the venue's radius; which one's line is right is settled by
    /// trying it (`lineFits`).
    public static func knownLines(_ place: Place?, _ ownTracks: [OwnTrack]) -> [KnownLine] {
        guard let place, usable(place.lat, place.lon) else { return [] }
        var out: [KnownLine] = []
        for t in ownTracks {
            guard let geo = t.geo, let sf = geo.sf, usable(geo.lat, geo.lon) else { continue }
            let distM = distanceM(place.lat, place.lon, geo.lat, geo.lon)
            if distM <= VENUE_RADIUS_M { out.append(KnownLine(id: t.id, name: t.name, sf: sf, distM: distM)) }
        }
        return out.sorted { $0.distM != $1.distM ? $0.distM < $1.distM : $0.id < $1.id }
    }

    /// Whether a known line was the right one for the files it was applied to:
    /// `places` are `recordingPlace` of each file *after* the gate timed it, nil
    /// for a file it cut no laps from. It fits when at least one file got laps
    /// and every file that did is, by place and lap length, exactly the track
    /// the line came from.
    public static func lineFits(
        _ trackId: Int, _ places: [Place?], _ ownTracks: [OwnTrack], _ catalog: [CatalogRow]
    ) -> Bool {
        let timed = places.compactMap { $0 }.filter { $0.lengthM != nil }
        if timed.isEmpty { return false }
        return timed.allSatisfy { p in
            let found = locateTrack(p, ownTracks, catalog)
            guard found.confidence == .exact, let top = found.candidates.first else { return false }
            return top.source == .own && top.id == trackId
        }
    }

    /// For a file imported onto an event the driver picked: the name of another
    /// track it was certainly driven at, or nil. Only an `exact` match that is
    /// not this event's track says anything.
    public static func otherTrackHere(_ located: Located?, trackId: Int?, trackCatalogId: Int?) -> String? {
        guard let located, located.confidence == .exact, let top = located.candidates.first else { return nil }
        let same = top.source == .own ? top.id == trackId : top.id == trackCatalogId
        return same ? nil : top.name
    }

    /// "14 Mar 2026" needs a locale; the cards take the caller's formatter.
    public static func groupDatesText(_ group: Group, _ fmtDate: (String) -> String) -> String {
        group.days > 1
            ? "\(fmtDate(group.start)) – \(fmtDate(addDays(group.start, group.days - 1)))"
            : fmtDate(group.start)
    }
}
