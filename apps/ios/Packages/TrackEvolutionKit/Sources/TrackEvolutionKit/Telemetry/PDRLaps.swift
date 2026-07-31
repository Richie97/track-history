import Foundation

/// Lap recovery for PDR recordings without beacons whose GPS also can't be
/// decoded (normally it can — the delta-encoded lat/lon channels feed the line
/// picker; see `PDR`).
///
/// A port of `public/js/import/pdr-laps.js`, name for name, with its test cases
/// (`test/unit/pdr-laps.test.js` → `PDRLapsTests`).
///
/// What any PDR telemetry gives us is latitude and the cumulative odometer, and
/// latitude as a function of driven distance repeats exactly once per lap:
///   - lap length = the autocorrelation peak of lat(distance)
///   - start/finish phase = cross-correlating lat(distance) against a one-lap
///     template from a beacon-timed recording of the same track (same import
///     batch); without one, laps are cut from where the car first reaches pace
///   - lap times = odometer time at distance D0 + k·lapLength
///
/// Validated against real footage: lap length within 2 m of the beacon-calibrated
/// value, lap times within ±0.2 s of beacon times.
public enum PDRLaps {
    /// Metres per lat(distance) sample.
    public static let PROFILE_STEP: Double = 5
    /// Shortest plausible circuit.
    static let MIN_LAP_M: Double = 800
    /// Longest plausible circuit.
    static let MAX_LAP_M: Double = 12000
    /// Profile bins (300 m) that must overlap in autocorrelation.
    static let MIN_OVERLAP = 60
    /// Periodicity confidence needed to trust a lap length.
    static let MIN_LAP_R = 0.9
    /// Template match needed to trust a start/finish alignment.
    static let MIN_PHASE_R = 0.8

    /// Latitude resampled on a uniform odometer-distance grid.
    public struct Profile: Sendable {
        public var xs: [Double]
        public var d0: Double
        public var step: Double
    }

    /// A lap length and how confidently the profile repeats at it.
    public struct LapLength: Hashable, Sendable {
        public var lapM: Double
        public var r: Double
    }

    /// One lap of lat(distance) starting at the start/finish line.
    public struct Template: Sendable {
        public var xs: [Double]
        public var lapM: Double
    }

    /// Where a template's start/finish falls within a profile.
    public struct Phase: Hashable, Sendable {
        public var offsetM: Double
        public var r: Double
    }

    static func mean(_ xs: [Double]) -> Double {
        xs.reduce(0, +) / Double(xs.count)
    }

    static func pearson(_ a: [Double], _ b: [Double], _ n: Int) -> Double {
        var sa = 0.0
        var sb = 0.0
        for i in 0..<n {
            sa += a[i]
            sb += b[i]
        }
        sa /= Double(n)
        sb /= Double(n)
        var num = 0.0
        var va = 0.0
        var vb = 0.0
        for i in 0..<n {
            let p = a[i] - sa
            let q = b[i] - sb
            num += p * q
            va += p * p
            vb += q * q
        }
        return va > 0 && vb > 0 ? num / (va * vb).squareRoot() : 0
    }

    /// Latitude resampled on a uniform odometer-distance grid. Returns nil when
    /// the channels are too thin or the car didn't cover two laps' distance.
    public static func latDistanceProfile(
        _ latPts: [ChannelPoint]?, _ odoPts: [ChannelPoint]?, _ step: Double = PROFILE_STEP
    ) -> Profile? {
        guard let latPts, let odoPts, latPts.count >= 50, odoPts.count >= 50 else { return nil }
        let odo = series(odoPts)
        let lat = series(latPts)
        let d0 = odo.first.v
        let d1 = odo.last.v
        if d1 - d0 < 2 * MIN_LAP_M { return nil }
        var xs: [Double] = []
        var d = d0
        while d <= d1 {
            xs.append(lat.at(odo.timeAt(d)))
            d += step
        }
        return Profile(xs: xs, d0: d0, step: step)
    }

    /// Lap length = smallest strong autocorrelation peak of the profile.
    ///
    /// A periodic signal peaks at every multiple of the true period, so among
    /// peaks within tolerance of the best, the smallest lag wins. Requires
    /// contrast between the best and worst lag: a car driving a straight line
    /// correlates ~1.0 at EVERY lag (lat(d) is linear) and must not produce fake
    /// laps.
    public static func findLapLength(_ profile: Profile) -> LapLength? {
        let xs = profile.xs
        let step = profile.step
        let n = xs.count
        let m = mean(xs)
        let z = xs.map { $0 - m }
        let lo = JSMath.roundToInt(MIN_LAP_M / step) ?? 0
        let hi = Swift.min(JSMath.roundToInt(MAX_LAP_M / step) ?? 0, n - MIN_OVERLAP)
        if hi <= lo { return nil }
        var rs = [Double](repeating: 0, count: hi + 1)
        var rMax = -Double.infinity
        var rMin = Double.infinity
        for lag in lo...hi {
            // proper per-window Pearson: a straight line must score r=1 at EVERY
            // lag (zero contrast), not decay artificially from a shared global mean
            var sa = 0.0
            var sb = 0.0
            var saa = 0.0
            var sbb = 0.0
            var sab = 0.0
            let m = n - lag
            for i in 0..<m {
                let a = z[i]
                let b = z[i + lag]
                sa += a
                sb += b
                saa += a * a
                sbb += b * b
                sab += a * b
            }
            let cov = sab - (sa * sb) / Double(m)
            let va = saa - (sa * sa) / Double(m)
            let vb = sbb - (sb * sb) / Double(m)
            let r = va > 0 && vb > 0 ? cov / (va * vb).squareRoot() : 0
            rs[lag] = r
            if r > rMax { rMax = r }
            if r < rMin { rMin = r }
        }
        if rMax < MIN_LAP_R || rMax - rMin < 0.5 { return nil }
        for lag in lo...hi {
            // `rs[lag - 1]` is `undefined` at lag 0 in the JS and every
            // comparison against it is false, so a zero lag never wins here either.
            let previous = lag > 0 ? rs[lag - 1] : Double.infinity
            if rs[lag] >= rMax - 0.02, rs[lag] >= previous, lag == hi || rs[lag] >= rs[lag + 1] {
                return LapLength(lapM: Double(lag) * step, r: rs[lag])
            }
        }
        return nil
    }

    /// One-lap lat(distance) template starting at the start/finish line, built
    /// from a recording whose laps came from beacons. Used to phase-anchor
    /// beacon-less recordings of the same track.
    public static func lapTemplate(_ parsed: ParsedTelemetry) -> Template? {
        guard let ch = parsed.channels, !parsed.laps.isEmpty,
              ch.latPts.count >= 50, ch.odoPts.count >= 50
        else { return nil }
        let anchor = parsed.laps.first { !$0.estimated } ?? parsed.laps[0]
        guard let startT = anchor.startT, let endT = anchor.endT else { return nil }
        let odo = series(ch.odoPts)
        let lat = series(ch.latPts)
        let dStart = odo.at(startT)
        let lapM = odo.at(endT) - dStart
        if lapM < MIN_LAP_M || lapM > MAX_LAP_M { return nil }
        var xs: [Double] = []
        var d = dStart
        while d < dStart + lapM && d <= odo.last.v {
            xs.append(lat.at(odo.timeAt(d)))
            d += PROFILE_STEP
        }
        return Template(xs: xs, lapM: lapM)
    }

    /// Slide the template over the profile's first lap: the best-matching offset
    /// is where the start/finish line falls. Returns metres from the profile
    /// start, or nil when nothing matches convincingly.
    public static func matchPhase(_ profile: Profile, _ template: [Double], _ lapM: Double) -> Phase? {
        let xs = profile.xs
        let step = profile.step
        let bins = JSMath.roundToInt(lapM / step) ?? 0
        let tn = template.count
        var bestOff: Int?
        var bestR = -Double.infinity
        var window = [Double](repeating: 0, count: tn)
        var off = 0
        while off < bins {
            let n = Swift.min(tn, xs.count - off)
            if Double(n) < Double(tn) * 0.8 { break }
            for i in 0..<n { window[i] = xs[off + i] }
            let r = pearson(template, window, n)
            if r > bestR {
                bestR = r
                bestOff = off
            }
            off += 1
        }
        guard let bestOff, bestR >= MIN_PHASE_R else { return nil }
        return Phase(offsetM: Double(bestOff) * step, r: bestR)
    }

    /// Cut laps every `lapM` metres of odometer distance starting at `dStart`.
    /// Same accuracy class as the beacon-gap interpolation in `PDR` (~±0.2 s).
    public static func cutLapsAtDistance(
        _ odoPts: [ChannelPoint], _ dStart: Double, _ lapM: Double
    ) -> [ParsedLap] {
        let odo = series(odoPts)
        var laps: [ParsedLap] = []
        // The JS relies on every caller passing a lap length it just found; a
        // non-positive one would spin forever rather than return nothing.
        guard lapM > 0 else { return laps }
        var d = dStart
        while d + lapM <= odo.last.v {
            let startT = odo.timeAt(d)
            let endT = odo.timeAt(d + lapM)
            laps.append(
                ParsedLap(
                    timeMs: JSMath.roundToInt((endT - startT) * 1000) ?? 0,
                    estimated: true,
                    startT: startT,
                    endT: endT
                )
            )
            d += lapM
        }
        return laps
    }

    /// Beacon-less, template-less recovery (parse-time): find the lap length and
    /// cut rolling laps starting where the car first reaches pace.
    ///
    /// The result's boundaries aren't the official start/finish — `anchorPdrBatch`
    /// re-cuts them when a beacon-timed session of the same track is in the batch.
    public static func recoverPdrLaps(_ channels: ParsedTelemetry.RawChannels?) -> ParsedTelemetry.LapRecovery? {
        guard let profile = latDistanceProfile(channels?.latPts, channels?.odoPts),
              let channels,
              let found = findLapLength(profile)
        else { return nil }
        let odo = series(channels.odoPts)
        var rates: [Double] = []
        var t = odo.first.t + 2
        while t < odo.last.t - 2 {
            rates.append(odo.rate(t))
            t += 2
        }
        if rates.isEmpty { return nil }
        let sorted = rates.sorted()
        let pace = sorted[Int((Double(rates.count) * 0.75).rounded(.down))]
        var dStart = odo.first.v
        t = odo.first.t + 2
        while t < odo.last.t - 2 {
            if odo.rate(t) >= 0.5 * pace {
                dStart = odo.at(t)
                break
            }
            t += 2
        }
        let laps = cutLapsAtDistance(channels.odoPts, dStart, found.lapM)
        return laps.isEmpty
            ? nil
            : ParsedTelemetry.LapRecovery(laps: laps, lapM: found.lapM, r: found.r, anchored: false)
    }

    /// Batch pass: re-anchor recovered laps to the real start/finish using any
    /// beacon-timed PDR recording of the same track (lap lengths must agree to
    /// 2%) picked in the same import.
    public static func anchorPdrBatch(_ results: inout [ParsedTelemetry?]) {
        var templates: [Template] = []
        for p in results {
            guard let p, p.kind == .pdr, p.beaconCount >= 2, !p.laps.isEmpty else { continue }
            if let t = lapTemplate(p) { templates.append(t) }
        }
        if templates.isEmpty { return }
        for i in results.indices {
            guard var p = results[i], p.kind == .pdr,
                  let recovery = p.lapRecovery, let channels = p.channels
            else { continue }
            guard let tmpl = templates.first(where: { abs($0.lapM - recovery.lapM) / $0.lapM < 0.02 })
            else { continue }
            guard let profile = latDistanceProfile(channels.latPts, channels.odoPts),
                  let phase = matchPhase(profile, tmpl.xs, recovery.lapM)
            else { continue }
            let laps = cutLapsAtDistance(channels.odoPts, profile.d0 + phase.offsetM, recovery.lapM)
            if !laps.isEmpty {
                p.laps = laps
                p.lapRecovery = ParsedTelemetry.LapRecovery(
                    laps: laps, lapM: recovery.lapM, r: recovery.r, anchored: true, phaseR: phase.r
                )
                results[i] = p
            }
        }
    }
}
