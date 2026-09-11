import Foundation

/// The friction circle (#186) — the port of `public/js/grip.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (`GripTests`), and the output is pinned
/// against the web implementation by `contracts/logic/grip.json`.
///
/// A PDR import stores `latG` and `longG` per lap on the driven-distance grid.
/// Neither says much alone — a longitudinal-G trace is the brake trace with
/// extra steps — but plotted against each other they draw the one picture in
/// amateur telemetry that says what to do differently rather than only where
/// the time went. The tyre has one grip budget, spent in any direction: brake
/// in a straight line, release, turn, then accelerate and the samples draw a
/// cross; trail the brake into the corner and feed the throttle out of it and
/// they fill the circle. The empty space between the two is the lost time.
///
/// Two properties of the stored data shape everything here.
///
/// **`latG` is a magnitude, not a signed value.** `pdr.js` stores
/// `abs(lateral acceleration)` (and `sanitizeChannels` clamps the channel at
/// 0), so left and right are indistinguishable in the blob. The side is
/// recovered from the sign of the `steering` trace at the same grid point —
/// steering angle *is* turn direction — and a lap that stored no steering plots
/// on the right-hand side alone. That is a derivation, so it is named
/// (`latSign`), one-sided output is a legitimate outcome, and the read-out never
/// depends on it: the quadrant shares use the magnitude.
///
/// **The 20 m grid smooths peaks.** A grid point every 20 m is about 0.3 s at
/// 250 km/h, so a spike is averaged away and these figures are the *shape* of
/// grip usage rather than peak G. The peaks are the session's max lateral and
/// braking G, taken from the full-rate series at import.
public enum Grip {
    /// Combined G below this is the car coasting, not the tyre working. It is
    /// the denominator of the read-out: "of the time you were actually using the
    /// tyre, how much of it was combined" is the question that trends across a
    /// day, and one long straight would otherwise decide the answer.
    public static let MIN_LOAD_G: Double = 0.3

    /// One axis below this is not meaningfully doing that thing, so the sample
    /// is not combined cornering. Display semantics, not physics — tune against
    /// real footage, like `Limits.WHEELSPIN_PCT`.
    public static let COMBINED_MIN_G: Double = 0.2

    /// The reference arc is the session's own peak combined G at this
    /// percentile, not its maximum: one kerb strike should not set the envelope
    /// for the day.
    public static let PEAK_PERCENTILE: Double = 0.99

    /// True when the lap stored both halves of the picture.
    public static func hasGripData(_ entry: LapChannels) -> Bool {
        entry.latG != nil && entry.longG != nil
    }

    /// One plottable lap of a session, keeping its channel index.
    public struct GripLap: Equatable, Sendable {
        public var chIdx: Int
        public var entry: LapChannels
    }

    /// The laps of a session that can be plotted.
    public static func gripLaps(_ channels: SessionChannels) -> [GripLap] {
        channels.laps.enumerated().compactMap { chIdx, entry in
            hasGripData(entry) ? GripLap(chIdx: chIdx, entry: entry) : nil
        }
    }

    /// Which way the car was turning at grid point k: the sign of the steering
    /// angle, or +1 for a lap that stored no steering (so its samples land on
    /// one side rather than being dropped). The stored `latG` carries no side of
    /// its own — see the type's documentation.
    public static func latSign(_ entry: LapChannels, _ k: Int) -> Double {
        guard let s = entry.steering, k < s.count else { return 1 }
        return s[k] < 0 ? -1 : 1
    }

    /// One scatter point: `lat` signed by `latSign`, `long` signed as stored
    /// (negative under braking) and `g` the combined magnitude.
    public struct Point: Equatable, Sendable, Decodable {
        public var k: Int
        public var lat: Double
        public var long: Double
        public var g: Double

        public init(k: Int, lat: Double, long: Double, g: Double) {
            self.k = k
            self.lat = lat
            self.long = long
            self.g = g
        }
    }

    /// One lap as scatter points — one per grid sample carrying both channels.
    public static func gripPoints(_ entry: LapChannels) -> [Point] {
        guard let latG = entry.latG, let longG = entry.longG else { return [] }
        let n = min(latG.count, longG.count)
        guard n > 0 else { return [] }
        return (0..<n).map { k in
            let lat = abs(latG[k])
            let long = longG[k]
            return Point(k: k, lat: lat * latSign(entry, k), long: long, g: hypot(lat, long))
        }
    }

    /// How a lap (or a whole session) spent its grip budget: the share of
    /// *loaded* samples that were cornering while braking and cornering while on
    /// the power. A cross scores near zero on both, a filled circle scores high.
    public struct Shares: Equatable, Sendable, Decodable {
        public var samples: Int
        public var loaded: Int
        public var trailBrake: Int
        public var powerDown: Int
        public var trailPct: Double
        public var powerPct: Double

        public init(samples: Int, loaded: Int, trailBrake: Int, powerDown: Int, trailPct: Double, powerPct: Double) {
            self.samples = samples
            self.loaded = loaded
            self.trailBrake = trailBrake
            self.powerDown = powerDown
            self.trailPct = trailPct
            self.powerPct = powerPct
        }
    }

    /// nil when the lap has no loaded sample.
    public static func gripShares(_ entry: LapChannels) -> Shares? {
        sharesOf(gripPoints(entry))
    }

    /// The shares of an already-built point list, so a caller holding the points
    /// doesn't walk the lap twice.
    private static func sharesOf(_ pts: [Point]) -> Shares? {
        var loaded = 0, trailBrake = 0, powerDown = 0
        for p in pts {
            if p.g < MIN_LOAD_G { continue }
            loaded += 1
            if abs(p.lat) < COMBINED_MIN_G { continue }
            if p.long <= -COMBINED_MIN_G {
                trailBrake += 1
            } else if p.long >= COMBINED_MIN_G {
                powerDown += 1
            }
        }
        guard loaded > 0 else { return nil }
        return Shares(
            samples: pts.count, loaded: loaded, trailBrake: trailBrake, powerDown: powerDown,
            trailPct: Double(trailBrake) / Double(loaded) * 100,
            powerPct: Double(powerDown) / Double(loaded) * 100
        )
    }

    /// The session's peak combined G at `pct`, over every sample of every lap
    /// that stored both channels — the radius of the reference arc, i.e. what
    /// this car actually did today. nil when no lap can be plotted.
    public static func peakCombinedG(_ channels: SessionChannels, _ pct: Double = PEAK_PERCENTILE) -> Double? {
        var all: [Double] = []
        for lap in gripLaps(channels) {
            for p in gripPoints(lap.entry) { all.append(p.g) }
        }
        guard !all.isEmpty else { return nil }
        all.sort()
        let idx = min(all.count - 1, max(0, Int((pct * Double(all.count - 1)).rounded(.down))))
        return all[idx]
    }

    /// One lap's row in the read-out.
    public struct LapShares: Equatable, Sendable, Decodable {
        public var chIdx: Int
        public var samples: Int
        public var loaded: Int
        public var trailBrake: Int
        public var powerDown: Int
        public var trailPct: Double
        public var powerPct: Double
    }

    /// A session reduced for the read-out: the arc's radius, the true maximum
    /// (which is *not* the arc), a row per plottable lap and every sample pooled.
    public struct SessionGrip: Equatable, Sendable, Decodable {
        public var peakG: Double?
        public var maxG: Double
        public var laps: [LapShares]
        public var all: Shares
    }

    /// nil when no lap stored both channels.
    public static func sessionGrip(_ channels: SessionChannels, _ pct: Double = PEAK_PERCENTILE) -> SessionGrip? {
        let laps = gripLaps(channels)
        guard !laps.isEmpty else { return nil }
        var rows: [LapShares] = []
        var maxG: Double = 0
        var samples = 0, loaded = 0, trailBrake = 0, powerDown = 0
        for lap in laps {
            let pts = gripPoints(lap.entry)
            for p in pts where p.g > maxG { maxG = p.g }
            guard let sh = sharesOf(pts) else { continue }
            rows.append(
                LapShares(
                    chIdx: lap.chIdx, samples: sh.samples, loaded: sh.loaded, trailBrake: sh.trailBrake,
                    powerDown: sh.powerDown, trailPct: sh.trailPct, powerPct: sh.powerPct
                )
            )
            samples += sh.samples
            loaded += sh.loaded
            trailBrake += sh.trailBrake
            powerDown += sh.powerDown
        }
        guard !rows.isEmpty else { return nil }
        return SessionGrip(
            peakG: peakCombinedG(channels, pct),
            maxG: maxG,
            laps: rows,
            all: Shares(
                samples: samples, loaded: loaded, trailBrake: trailBrake, powerDown: powerDown,
                trailPct: Double(trailBrake) / Double(loaded) * 100,
                powerPct: Double(powerDown) / Double(loaded) * 100
            )
        )
    }
}
