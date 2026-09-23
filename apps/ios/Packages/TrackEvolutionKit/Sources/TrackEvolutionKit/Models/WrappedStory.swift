import Foundation

/// Season Wrapped's presentation rules (NS-36) — the port of the pure half of
/// `public/js/wrapped.js` under the same names, pinned to it by
/// `contracts/logic/wrapped.json`, the fixture Android's `:core` asserts
/// against too.
///
/// The numbers are the server's (`GET /api/wrapped/:year`, `src/lib/wrapped.ts`)
/// and arrive already computed in a `Wrapped`; nothing here recomputes them. What
/// ports is only what the story decides: the dashboard hero's window, which cards
/// a season gets, and the poster's words.
///
/// One signature differs from the JS, and has to: `wrappedCards` there tells the
/// public share from a free account by whether the payload *has* a `pro` key,
/// and `Codable` reads an absent key and a `null` alike as `nil`. The app only
/// ever shows its own account's season, where `nil` means locked, so the share
/// case is the explicit `shared:` flag the fixture's shared season passes.
public enum WrappedStory {
    public static let KM_PER_MILE = 1.609344

    /// The year the dashboard promotes, or nil outside the reveal: the running
    /// year from 1 November to 31 December, the one just ended through
    /// 31 January. `today` is an ISO date (`yyyy-MM-dd`).
    public static func wrappedSeason(_ today: String) -> Int? {
        let parts = today.split(separator: "-")
        guard parts.count >= 2, let year = Int(parts[0]), let month = Int(parts[1]) else { return nil }
        if month >= 11 { return year }
        if month == 1 { return year - 1 }
        return nil
    }

    /// The same, for the viewer's local day.
    public static func wrappedSeason(_ date: Date, calendar: Calendar = .current) -> Int? {
        let c = calendar.dateComponents([.year, .month], from: date)
        guard let year = c.year, let month = c.month else { return nil }
        return wrappedSeason(String(format: "%04d-%02d-01", year, month))
    }

    public enum Kind: String, Sendable, Hashable, CaseIterable {
        case cover, numbers, mostDriven = "most_driven", improvement, fastest
        case newTracks = "new_tracks", hours, hottest, tire, topSpeed = "top_speed", poster
    }

    public struct Card: Hashable, Sendable {
        public var kind: Kind
        /// One of the two Pro cards on a free account: drawn in its shape with
        /// the upsell rather than skipped.
        public var locked: Bool

        public init(kind: Kind, locked: Bool = false) {
            self.kind = kind
            self.locked = locked
        }
    }

    /// The ordered card list for one season. A card with no data is left out,
    /// never drawn empty. The two Pro cards follow `data.pro`: nil (a free
    /// account) draws them locked, an object draws whichever has data, and a
    /// shared season has no Pro cards at all.
    public static func wrappedCards(_ data: Wrapped, shared: Bool = false) -> [Card] {
        var cards = [Card(kind: .cover), Card(kind: .numbers)]
        if data.mostDriven != nil { cards.append(Card(kind: .mostDriven)) }
        if data.improvement != nil { cards.append(Card(kind: .improvement)) }
        if data.fastest != nil { cards.append(Card(kind: .fastest)) }
        if !data.newTracks.isEmpty { cards.append(Card(kind: .newTracks)) }
        cards.append(Card(kind: .hours))
        if data.hottest != nil { cards.append(Card(kind: .hottest)) }
        if !shared {
            if let pro = data.pro {
                if pro.tire != nil { cards.append(Card(kind: .tire)) }
                if pro.topSpeed != nil { cards.append(Card(kind: .topSpeed)) }
            } else {
                cards.append(Card(kind: .tire, locked: true))
                cards.append(Card(kind: .topSpeed, locked: true))
            }
        }
        cards.append(Card(kind: .poster))
        return cards
    }

    /// `CARD_TITLES` — what each card is called, for the progress dots and
    /// VoiceOver.
    public static let CARD_TITLES: [Kind: String] = [
        .cover: "Cover",
        .numbers: "The numbers",
        .mostDriven: "Most driven",
        .improvement: "Biggest improvement",
        .fastest: "Fastest lap",
        .newTracks: "New tracks",
        .hours: "Hours behind the wheel",
        .hottest: "Hottest day",
        .tire: "Favourite tyre",
        .topSpeed: "Top speed",
        .poster: "Your season",
    ]

    // MARK: - The words

    /// `Math.round(n).toLocaleString("en-US")`: ties toward +infinity, thousands
    /// separated by commas.
    public static func int(_ n: Double) -> String {
        let v = JSMath.roundToInt(n) ?? 0
        let digits = String(abs(v))
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return v < 0 ? "-" + out : out
    }

    public static func plural(_ n: Double, _ one: String, _ many: String? = nil) -> String {
        n == 1 ? one : (many ?? one + "s")
    }

    /// Track days are REAL — a half day is 0.5 — so they show one decimal only
    /// when they aren't whole.
    public static func fmtDays(_ d: Double) -> String {
        d == d.rounded(.towardZero) ? int(d) : Units.toFixed(d, 1)
    }

    public struct Distance: Hashable, Sendable {
        public var value: String
        public var unit: String
    }

    /// "4,281" and its unit, in the account's system.
    public static func trackDistance(_ miles: Double, _ units: UnitSystem) -> Distance {
        let metric = Units.isMetric(units)
        return Distance(value: int(metric ? miles * KM_PER_MILE : miles), unit: metric ? "track km" : "track miles")
    }

    /// Seconds found, as the card says it: "4.83 s".
    public static func fmtGain(_ ms: Int) -> String { "\(Units.toFixed(Double(ms) / 1000, 2)) s" }

    /// The hours card's figure: one decimal only when it isn't whole.
    public static func fmtHoursWord(_ h: Double) -> String {
        let v = JSMath.round(h, 10)
        return v == v.rounded(.towardZero) ? int(v) : Units.toFixed(v, 1)
    }

    public struct Poster: Hashable, Sendable {
        public var title: String
        public var headline: [String]
        public var rows: [[String]]
    }

    /// The poster's lines — the summary card and the share image draw the same
    /// rows, so the two never disagree about what a season said. The owner's
    /// own poster says "My"; a shared one names the driver.
    public static func posterLines(_ data: Wrapped, _ units: UnitSystem, share: Bool = false) -> Poster {
        let t = data.totals
        let dist = trackDistance(t.miles, units)
        var headline = [
            "\(fmtDays(t.trackDays)) \(plural(t.trackDays, "track day"))",
            "\(int(Double(t.tracks))) \(plural(Double(t.tracks), "track"))",
            "\(int(Double(t.laps))) \(plural(Double(t.laps), "lap"))",
        ]
        if t.milesTracksCounted != 0 { headline.append("\(dist.value) \(dist.unit)") }
        var rows: [[String]] = []
        if let m = data.mostDriven { rows.append(["Most driven", m.trackName]) }
        if let g = data.improvement { rows.append(["Biggest improvement", "\(g.trackName), −\(fmtGain(g.gainMs))"]) }
        if let f = data.fastest { rows.append(["Fastest lap", "\(f.trackName), \(LapTime.fmtMs(f.bestMs))"]) }
        if let tire = data.pro?.tire { rows.append(["Favourite tyre", tire.name]) }
        let who = share ? "\(data.name.flatMap { $0.isEmpty ? nil : $0 } ?? "A driver")'s" : "My"
        return Poster(title: "\(who) \(data.year) Track Evolution", headline: headline, rows: rows)
    }
}
