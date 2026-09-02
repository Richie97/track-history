package app.trackevolution.core.telemetry

import app.trackevolution.core.JsMath

/**
 * Lap recovery for PDR recordings without beacons whose GPS also can't be
 * decoded (normally it can — the delta-encoded lat/lon channels feed the line
 * picker; see [PDR]).
 *
 * A port of `public/js/import/pdr-laps.js`, name for name, with its test cases
 * (`test/unit/pdr-laps.test.js` → `PDRLapsTest`).
 *
 * What any PDR telemetry gives us is latitude and the cumulative odometer, and
 * latitude as a function of driven distance repeats exactly once per lap:
 *   - lap length = the autocorrelation peak of lat(distance)
 *   - start/finish phase = cross-correlating lat(distance) against a one-lap
 *     template from a beacon-timed recording of the same track (same import
 *     batch); without one, laps are cut from where the car first reaches pace
 *   - lap times = odometer time at distance D0 + k·lapLength
 *
 * Validated against real footage: lap length within 2 m of the beacon-calibrated
 * value, lap times within ±0.2 s of beacon times.
 */
public object PDRLaps {

    /** Metres per lat(distance) sample. */
    public const val PROFILE_STEP: Double = 5.0
    /** Shortest plausible circuit. */
    private const val MIN_LAP_M = 800.0
    /** Longest plausible circuit. */
    private const val MAX_LAP_M = 12000.0
    /** Profile bins (300 m) that must overlap in autocorrelation. */
    private const val MIN_OVERLAP = 60
    /** Periodicity confidence needed to trust a lap length. */
    private const val MIN_LAP_R = 0.9
    /** Template match needed to trust a start/finish alignment. */
    private const val MIN_PHASE_R = 0.8

    /** Latitude resampled on a uniform odometer-distance grid. */
    public data class Profile(val xs: List<Double>, val d0: Double, val step: Double)

    /** A lap length and how confidently the profile repeats at it. */
    public data class LapLength(val lapM: Double, val r: Double)

    /** One lap of lat(distance) starting at the start/finish line. */
    public data class Template(val xs: List<Double>, val lapM: Double)

    /** Where a template's start/finish falls within a profile. */
    public data class Phase(val offsetM: Double, val r: Double)

    private fun mean(xs: List<Double>): Double = xs.sum() / xs.size

    private fun pearson(a: List<Double>, b: List<Double>, n: Int): Double {
        var sa = 0.0
        var sb = 0.0
        for (i in 0 until n) {
            sa += a[i]
            sb += b[i]
        }
        sa /= n
        sb /= n
        var num = 0.0
        var va = 0.0
        var vb = 0.0
        for (i in 0 until n) {
            val p = a[i] - sa
            val q = b[i] - sb
            num += p * q
            va += p * p
            vb += q * q
        }
        return if (va > 0 && vb > 0) num / Math.sqrt(va * vb) else 0.0
    }

    /**
     * Latitude resampled on a uniform odometer-distance grid. Returns null when
     * the channels are too thin or the car didn't cover two laps' distance.
     */
    public fun latDistanceProfile(
        latPts: List<ChannelPoint>?,
        odoPts: List<ChannelPoint>?,
        step: Double = PROFILE_STEP,
    ): Profile? {
        if (latPts == null || odoPts == null || latPts.size < 50 || odoPts.size < 50) return null
        val odo = series(odoPts)
        val lat = series(latPts)
        val d0 = odo.first.v
        val d1 = odo.last.v
        if (d1 - d0 < 2 * MIN_LAP_M) return null
        val xs = ArrayList<Double>()
        var d = d0
        while (d <= d1) {
            xs.add(lat.at(odo.timeAt(d)))
            d += step
        }
        return Profile(xs = xs, d0 = d0, step = step)
    }

    /**
     * Lap length = smallest strong autocorrelation peak of the profile.
     *
     * A periodic signal peaks at every multiple of the true period, so among
     * peaks within tolerance of the best, the smallest lag wins. Requires
     * contrast between the best and worst lag: a car driving a straight line
     * correlates ~1.0 at EVERY lag (lat(d) is linear) and must not produce fake
     * laps.
     */
    public fun findLapLength(profile: Profile): LapLength? {
        val xs = profile.xs
        val step = profile.step
        val n = xs.size
        val mu = mean(xs)
        val z = DoubleArray(n) { xs[it] - mu }
        val lo = JsMath.roundToInt(MIN_LAP_M / step)
        val hi = Math.min(JsMath.roundToInt(MAX_LAP_M / step), n - MIN_OVERLAP)
        if (hi <= lo) return null
        val rs = DoubleArray(hi + 1)
        var rMax = Double.NEGATIVE_INFINITY
        var rMin = Double.POSITIVE_INFINITY
        for (lag in lo..hi) {
            // proper per-window Pearson: a straight line must score r=1 at EVERY
            // lag (zero contrast), not decay artificially from a shared global mean
            var sa = 0.0
            var sb = 0.0
            var saa = 0.0
            var sbb = 0.0
            var sab = 0.0
            val m = n - lag
            for (i in 0 until m) {
                val a = z[i]
                val b = z[i + lag]
                sa += a
                sb += b
                saa += a * a
                sbb += b * b
                sab += a * b
            }
            val cov = sab - (sa * sb) / m
            val va = saa - (sa * sa) / m
            val vb = sbb - (sb * sb) / m
            val r = if (va > 0 && vb > 0) cov / Math.sqrt(va * vb) else 0.0
            rs[lag] = r
            if (r > rMax) rMax = r
            if (r < rMin) rMin = r
        }
        if (rMax < MIN_LAP_R || rMax - rMin < 0.5) return null
        for (lag in lo..hi) {
            // `rs[lag - 1]` is a zero-filled Float64Array slot below `lo` in the
            // JS, and a zero-filled DoubleArray slot here.
            if (rs[lag] >= rMax - 0.02 && rs[lag] >= rs[lag - 1] && (lag == hi || rs[lag] >= rs[lag + 1])) {
                return LapLength(lapM = lag * step, r = rs[lag])
            }
        }
        return null
    }

    /**
     * One-lap lat(distance) template starting at the start/finish line, built
     * from a recording whose laps came from beacons. Used to phase-anchor
     * beacon-less recordings of the same track.
     */
    public fun lapTemplate(parsed: ParsedTelemetry?): Template? {
        val ch = parsed?.channels ?: return null
        if (parsed.laps.isEmpty() || ch.latPts.size < 50 || ch.odoPts.size < 50) return null
        val anchor = parsed.laps.firstOrNull { !it.estimated } ?: parsed.laps[0]
        val startT = anchor.startT ?: return null
        val endT = anchor.endT ?: return null
        val odo = series(ch.odoPts)
        val lat = series(ch.latPts)
        val dStart = odo.at(startT)
        val lapM = odo.at(endT) - dStart
        if (lapM < MIN_LAP_M || lapM > MAX_LAP_M) return null
        val xs = ArrayList<Double>()
        var d = dStart
        while (d < dStart + lapM && d <= odo.last.v) {
            xs.add(lat.at(odo.timeAt(d)))
            d += PROFILE_STEP
        }
        return Template(xs = xs, lapM = lapM)
    }

    /**
     * Slide the template over the profile's first lap: the best-matching offset
     * is where the start/finish line falls. Returns metres from the profile
     * start, or null when nothing matches convincingly.
     */
    public fun matchPhase(profile: Profile, template: List<Double>, lapM: Double): Phase? {
        val xs = profile.xs
        val step = profile.step
        val bins = JsMath.roundToInt(lapM / step)
        val tn = template.size
        var bestOff: Int? = null
        var bestR = Double.NEGATIVE_INFINITY
        val window = MutableList(tn) { 0.0 }
        var off = 0
        while (off < bins) {
            val n = Math.min(tn, xs.size - off)
            if (n < tn * 0.8) break
            for (i in 0 until n) window[i] = xs[off + i]
            val r = pearson(template, window, n)
            if (r > bestR) {
                bestR = r
                bestOff = off
            }
            off++
        }
        val found = bestOff ?: return null
        if (bestR < MIN_PHASE_R) return null
        return Phase(offsetM = found * step, r = bestR)
    }

    /**
     * Cut laps every [lapM] metres of odometer distance starting at [dStart].
     * Same accuracy class as the beacon-gap interpolation in [PDR] (~±0.2 s).
     */
    public fun cutLapsAtDistance(odoPts: List<ChannelPoint>, dStart: Double, lapM: Double): List<ParsedLap> {
        val odo = series(odoPts)
        val laps = ArrayList<ParsedLap>()
        // The JS relies on every caller passing a lap length it just found; a
        // non-positive one would spin forever rather than return nothing.
        if (lapM <= 0) return laps
        var d = dStart
        while (d + lapM <= odo.last.v) {
            val startT = odo.timeAt(d)
            val endT = odo.timeAt(d + lapM)
            laps.add(
                ParsedLap(
                    timeMs = JsMath.roundToInt((endT - startT) * 1000),
                    estimated = true,
                    startT = startT,
                    endT = endT,
                ),
            )
            d += lapM
        }
        return laps
    }

    /**
     * Beacon-less, template-less recovery (parse-time): find the lap length and
     * cut rolling laps starting where the car first reaches pace.
     *
     * The result's boundaries aren't the official start/finish — [anchorPdrBatch]
     * re-cuts them when a beacon-timed session of the same track is in the batch.
     */
    public fun recoverPdrLaps(channels: ParsedTelemetry.RawChannels?): ParsedTelemetry.LapRecovery? {
        val profile = latDistanceProfile(channels?.latPts, channels?.odoPts) ?: return null
        if (channels == null) return null
        val found = findLapLength(profile) ?: return null
        val odo = series(channels.odoPts)
        val rates = ArrayList<Double>()
        var t = odo.first.t + 2
        while (t < odo.last.t - 2) {
            rates.add(odo.rate(t))
            t += 2
        }
        if (rates.isEmpty()) return null
        val pace = rates.sorted()[Math.floor(rates.size * 0.75).toInt()]
        var dStart = odo.first.v
        t = odo.first.t + 2
        while (t < odo.last.t - 2) {
            if (odo.rate(t) >= 0.5 * pace) {
                dStart = odo.at(t)
                break
            }
            t += 2
        }
        val laps = cutLapsAtDistance(channels.odoPts, dStart, found.lapM)
        return if (laps.isEmpty()) null else ParsedTelemetry.LapRecovery(laps = laps, lapM = found.lapM, r = found.r, anchored = false)
    }

    /**
     * Batch pass: re-anchor recovered laps to the real start/finish using any
     * beacon-timed PDR recording of the same track (lap lengths must agree to
     * 2%) picked in the same import.
     *
     * Returns the batch with the re-anchored entries replaced; the JS mutates in
     * place. Callers re-run [TelemetryChannels.attachLapChannels] on anything
     * whose laps moved, as the web importer does.
     */
    public fun anchorPdrBatch(results: List<ParsedTelemetry?>): List<ParsedTelemetry?> {
        val templates = ArrayList<Template>()
        for (p in results) {
            if (p == null || p.kind != ParsedTelemetry.Kind.PDR || p.beaconCount < 2 || p.laps.isEmpty()) continue
            lapTemplate(p)?.let { templates.add(it) }
        }
        if (templates.isEmpty()) return results
        return results.map { p ->
            if (p == null || p.kind != ParsedTelemetry.Kind.PDR) return@map p
            val recovery = p.lapRecovery ?: return@map p
            val channels = p.channels ?: return@map p
            val tmpl = templates.firstOrNull { Math.abs(it.lapM - recovery.lapM) / it.lapM < 0.02 } ?: return@map p
            val profile = latDistanceProfile(channels.latPts, channels.odoPts) ?: return@map p
            val phase = matchPhase(profile, tmpl.xs, recovery.lapM) ?: return@map p
            val laps = cutLapsAtDistance(channels.odoPts, profile.d0 + phase.offsetM, recovery.lapM)
            if (laps.isEmpty()) return@map p
            p.copy(
                laps = laps,
                lapRecovery = recovery.copy(laps = laps, anchored = true, phaseR = phase.r),
            )
        }
    }
}
