package app.trackevolution.core.telemetry

import app.trackevolution.core.Gate
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.JsMath
import app.trackevolution.core.TracePoint
import java.text.NumberFormat
import java.util.Locale

/**
 * File-type dispatch for telemetry imports, plus the review flow's pure parts.
 *
 * A port of `public/js/import/parse.js` and the non-DOM half of
 * `public/js/import/ui.js` ([applyGate], [metricsSummary], [estimatedNote],
 * [defaultLabel]), so the phone builds the same session — laps, trace,
 * channels, notes — the browser would from the same file.
 *
 * `.vbo` is deliberately absent. A VBOX writes to an SD card that gets read on
 * a laptop; video arrives on the phone before the laptop is opened, and that is
 * the whole reason NS-30 took video off the deferred list and left the rest of
 * the long tail on it (`docs/specs/native/README.md`).
 */
public object Telemetry {

    /** `SUPPORTED_EXT` in the JS — what [defaultLabel] strips from a file name. */
    public val SUPPORTED_EXT: Regex = Regex("\\.(mp4|vbo)$", RegexOption.IGNORE_CASE)

    /**
     * Parse an MP4: Corvette PDR first, then GoPro GPMF.
     *
     * Both parsers report "no track of mine here" distinctly from "this file is
     * mine and it's broken", so a GoPro clip isn't reported as a broken PDR one
     * and vice versa.
     */
    public fun parseTelemetryFile(source: TelemetryByteSource): ParsedTelemetry {
        val pdrErr: TelemetryParseException = try {
            return parsePdr(source)
        } catch (e: TelemetryParseException) {
            e
        }
        try {
            return TelemetryChannels.attachLapChannels(GPMF.parseGpmfFile(source))
        } catch (gpErr: TelemetryParseException) {
            if (pdrErr.isNoTrack && gpErr.isNoTrack) {
                throw TelemetryParseException("No PDR or GoPro telemetry in this video")
            }
            throw if (pdrErr.isNoTrack) gpErr else pdrErr
        }
    }

    /** The PDR branch of [parseTelemetryFile]: parse, then the post-parse steps `parse.js` adds. */
    private fun parsePdr(source: TelemetryByteSource): ParsedTelemetry {
        var pdr = PDR.parsePdrFile(source)
        // Beacon-timed laps share the telemetry clock with the GPS trace, so
        // the fastest lap's window cuts straight out of it. Without laps, the
        // trace goes to the start/finish line picker instead.
        val gps = pdr.gps
        if (gps != null && pdr.laps.isNotEmpty()) {
            val best = pdr.laps.reduce { a, b -> if (b.timeMs < a.timeMs) b else a }
            val startT = best.startT
            val endT = best.endT
            if (startT != null && endT != null) {
                pdr = pdr.copy(bestLapTrace = GeoTrace.lapTrace(GeoTrace.projectTrace(gps), startT, endT))
            }
        }
        // No beacons and no decodable GPS trace: recover laps from latitude +
        // odometer. Boundaries start as rolling laps; PDRLaps.anchorPdrBatch
        // aligns them to the start/finish when the batch has a beacon-timed
        // session of the same track.
        if (pdr.laps.isEmpty() && pdr.gps == null) {
            val recovery = PDRLaps.recoverPdrLaps(pdr.channels)
            if (recovery != null) pdr = pdr.copy(lapRecovery = recovery, laps = recovery.laps)
        }
        pdr = pdr.copy(needsLine = pdr.laps.isEmpty() && pdr.gps != null)
        return TelemetryChannels.attachLapChannels(pdr)
    }

    // -----------------------------------------------------------------------
    // The review flow's shared maths
    // -----------------------------------------------------------------------

    /**
     * Re-derive laps for a source that needs a picked start/finish line.
     *
     * [origin] is the shared projection frame — one picked line applies to every
     * trace in the batch, which is only meaningful if they're all projected the
     * same way. A null gate clears the derived laps rather than leaving stale
     * ones. Anything that doesn't need a line is returned unchanged.
     */
    public fun applyGate(parsed: ParsedTelemetry, origin: GpsPoint?, gate: Gate?): ParsedTelemetry {
        if (!parsed.needsLine) return parsed
        val gps = parsed.gps ?: return parsed
        if (gate == null) return parsed.copy(laps = emptyList(), bestLapTrace = null, lapChannels = null)
        var trace = GeoTrace.projectTrace(gps, origin)
        var effective = gate
        if (traceDistanceTo(trace, gate) > 1000) {
            // This file's longitude sign convention differs from the displayed
            // trace (Racelogic VBO is west-positive, GPS sources east-positive).
            // Mirror the longitude; handedness flips with it, so drop the gate's
            // direction filter.
            trace = GeoTrace.projectTrace(gps.map { it.copy(lon = -it.lon) }, origin)
            if (traceDistanceTo(trace, gate) > 1000) {
                return parsed.copy(laps = emptyList(), bestLapTrace = null, lapChannels = null)
            }
            effective = gate.copy(hx = null, hy = null)
        }
        val laps = GeoTrace.deriveLaps(trace, effective).map { ParsedLap.of(it) }
        return TelemetryChannels.attachLapChannels(
            parsed.copy(
                laps = laps,
                bestLapTrace = if (laps.isEmpty()) null else GeoTrace.bestLapTrace(trace, effective),
            ),
        )
    }

    /**
     * How far the nearest point of a trace is from a gate's centre — the test for
     * "is this file even the same track as the displayed trace?".
     */
    internal fun traceDistanceTo(trace: List<TracePoint>, gate: Gate): Double {
        var best = Double.POSITIVE_INFINITY
        for (p in trace) {
            val d = (p.x - gate.x) * (p.x - gate.x) + (p.y - gate.y) * (p.y - gate.y)
            if (d < best) best = d
        }
        return Math.sqrt(best)
    }

    /**
     * "top speed 121 mph · max 6,703 rpm · 1.43 G lateral" from a PDR file's car
     * channels; "" when the source has none.
     */
    public fun metricsSummary(p: ParsedTelemetry): String {
        val m = p.metrics ?: return ""
        val parts = ArrayList<String>()
        m.topSpeedKph?.let { parts.add("top speed ${JsMath.roundToInt(it / 1.609344)} mph") }
        m.maxRpm?.let { parts.add("max ${grouped(JsMath.roundToInt(it))} rpm") }
        m.maxLatG?.let { parts.add("${String.format(Locale.US, "%.2f", it)} G lateral") }
        return parts.joinToString(" · ")
    }

    /**
     * What the `~` on a lap time means for this source — stored in the session's
     * notes so the number is never read as more precise than it is.
     */
    public fun estimatedNote(p: ParsedTelemetry, estCount: Int): String {
        if (estCount == 0) return ""
        val recovery = p.lapRecovery
        if (p.kind == ParsedTelemetry.Kind.PDR && recovery != null) {
            // No beacons in this recording: laps recovered from latitude + odometer.
            return if (recovery.anchored) {
                "laps recovered from latitude + odometer, aligned to the beacon session's start/finish (~±0.2s)"
            } else {
                "laps recovered from latitude + odometer (~±0.2s); boundaries are a fixed track point, not the official start/finish"
            }
        }
        if (p.kind == ParsedTelemetry.Kind.PDR && !p.needsLine) {
            return "$estCount of ${p.laps.size} laps distance-estimated (~), rest beacon-exact"
        }
        // Phone GPS (the live recorder) fixes at ~1Hz vs a logger's 10–18Hz.
        if (p.kind == ParsedTelemetry.Kind.LIVE) return "lap times derived from GPS start/finish crossings (~±0.2–0.5s)"
        return "lap times derived from GPS start/finish crossings (~±0.1–0.3s)"
    }

    /**
     * "PDR 09:23:26" — the session label an import proposes, from the file's own
     * clock, falling back to its name.
     */
    public fun defaultLabel(p: ParsedTelemetry, file: String): String =
        "${p.kind.label} ${p.time ?: file.replace(SUPPORTED_EXT, "")}"

    /**
     * The notes line the web importer writes, so a session imported on the phone
     * reads identically to the same file imported at a desk.
     */
    public fun importNotes(p: ParsedTelemetry, file: String): String {
        val source = if (p.kind == ParsedTelemetry.Kind.LIVE) "Recorded with the in-app lap timer" else "Imported from $file"
        val metrics = metricsSummary(p)
        val note = estimatedNote(p, p.laps.count { it.estimated })
        return source +
            (if (metrics.isEmpty()) "" else " — $metrics") +
            (if (note.isEmpty()) "" else " — $note")
    }

    /**
     * `Number.prototype.toLocaleString()` on an integer — grouped for reading, in
     * the user's locale, exactly as the web app's rpm figure is.
     */
    private fun grouped(value: Int): String = NumberFormat.getIntegerInstance().format(value.toLong())
}
