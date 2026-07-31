import Foundation

/// File-type dispatch for telemetry imports, plus the review flow's pure parts.
///
/// A port of `public/js/import/parse.js` and the non-DOM half of
/// `public/js/import/ui.js` (`applyGate`, `metricsSummary`, `estimatedNote`,
/// `defaultLabel`), so the phone builds the same session — laps, trace, channels,
/// notes — the browser would from the same file.
///
/// `.vbo` is deliberately absent. A VBOX writes to an SD card that gets read on a
/// laptop; video arrives on the phone before the laptop is opened, and that is the
/// whole reason NS-30 took video off the deferred list and left the rest of the
/// long tail on it (`docs/specs/native/README.md`).
public enum Telemetry {
    /// Parse an MP4: Corvette PDR first, then GoPro GPMF.
    ///
    /// Both parsers report "no track of mine here" distinctly from "this file is
    /// mine and it's broken", so a GoPro clip isn't reported as a broken PDR one
    /// and vice versa.
    public static func parseTelemetryFile(_ source: some TelemetryByteSource) throws -> ParsedTelemetry {
        var pdrErr: TelemetryParseError?
        do {
            var pdr = try PDR.parsePdrFile(source)
            // Beacon-timed laps share the telemetry clock with the GPS trace, so
            // the fastest lap's window cuts straight out of it. Without laps, the
            // trace goes to the start/finish line picker instead.
            if let gps = pdr.gps, !pdr.laps.isEmpty,
               let best = pdr.laps.min(by: { $0.timeMs < $1.timeMs }),
               let startT = best.startT, let endT = best.endT {
                pdr.bestLapTrace = Geo.lapTrace(Geo.projectTrace(gps), from: startT, to: endT)
            }
            // No beacons and no decodable GPS trace: recover laps from latitude +
            // odometer. Boundaries start as rolling laps; `PDRLaps.anchorPdrBatch`
            // aligns them to the start/finish when the batch has a beacon-timed
            // session of the same track.
            if pdr.laps.isEmpty && pdr.gps == nil {
                pdr.lapRecovery = PDRLaps.recoverPdrLaps(pdr.channels)
                if let recovery = pdr.lapRecovery { pdr.laps = recovery.laps }
            }
            pdr.needsLine = pdr.laps.isEmpty && pdr.gps != nil
            TelemetryChannels.attachLapChannels(&pdr)
            return pdr
        } catch let error as TelemetryParseError {
            pdrErr = error
        }
        do {
            var gopro = try GPMF.parseGpmfFile(source)
            TelemetryChannels.attachLapChannels(&gopro)
            return gopro
        } catch let gpErr as TelemetryParseError {
            if pdrErr?.isNoTrack == true, gpErr.isNoTrack {
                throw TelemetryParseError(message: "No PDR or GoPro telemetry in this video")
            }
            throw pdrErr?.isNoTrack == true ? gpErr : (pdrErr ?? gpErr)
        }
    }

    // MARK: - The review flow's shared maths

    /// Re-derive laps for every source that needs a picked start/finish line.
    ///
    /// `origin` is the shared projection frame — one picked line applies to every
    /// trace in the batch, which is only meaningful if they're all projected the
    /// same way. A nil gate clears the derived laps rather than leaving stale ones.
    public static func applyGate(_ parsed: inout ParsedTelemetry, origin: Geo.Point?, gate: Geo.Gate?) {
        guard parsed.needsLine, let gps = parsed.gps else { return }
        guard let gate else {
            parsed.laps = []
            parsed.bestLapTrace = nil
            parsed.lapChannels = nil
            return
        }
        let projectionOrigin = origin.map { Geo.Origin(lat: $0.lat, lon: $0.lon) }
        var trace = Geo.projectTrace(gps, origin: projectionOrigin)
        var effective = gate
        if traceDistanceTo(trace, gate) > 1000 {
            // This file's longitude sign convention differs from the displayed
            // trace (Racelogic VBO is west-positive, GPS sources east-positive).
            // Mirror the longitude; handedness flips with it, so drop the gate's
            // direction filter.
            trace = Geo.projectTrace(
                gps.map { Geo.Point(t: $0.t, lat: $0.lat, lon: -$0.lon, v: $0.v) },
                origin: projectionOrigin
            )
            if traceDistanceTo(trace, gate) > 1000 {
                parsed.laps = []
                parsed.bestLapTrace = nil
                parsed.lapChannels = nil
                return
            }
            effective.hx = nil
            effective.hy = nil
        }
        parsed.laps = Geo.deriveLaps(trace, gate: effective).map(ParsedLap.init)
        parsed.bestLapTrace = parsed.laps.isEmpty ? nil : Geo.bestLapTrace(trace, gate: effective)
        TelemetryChannels.attachLapChannels(&parsed)
    }

    /// How far the nearest point of a trace is from a gate's centre — the test for
    /// "is this file even the same track as the displayed trace?".
    static func traceDistanceTo(_ trace: [Geo.Projected], _ gate: Geo.Gate) -> Double {
        var best = Double.infinity
        for p in trace {
            let d = (p.x - gate.x) * (p.x - gate.x) + (p.y - gate.y) * (p.y - gate.y)
            if d < best { best = d }
        }
        return best.squareRoot()
    }

    /// "top speed 121 mph · max 6,703 rpm · 1.43 G lateral" from a PDR file's car
    /// channels; "" when the source has none.
    public static func metricsSummary(_ p: ParsedTelemetry) -> String {
        guard let m = p.metrics else { return "" }
        var parts: [String] = []
        if let top = m.topSpeedKph, let mph = JSMath.roundToInt(top / 1.609344) {
            parts.append("top speed \(mph) mph")
        }
        if let rpm = m.maxRpm, let rounded = JSMath.roundToInt(rpm) {
            parts.append("max \(grouped(rounded)) rpm")
        }
        if let g = m.maxLatG {
            parts.append("\(String(format: "%.2f", g)) G lateral")
        }
        return parts.joined(separator: " · ")
    }

    /// What the `~` on a lap time means for this source — stored in the session's
    /// notes so the number is never read as more precise than it is.
    public static func estimatedNote(_ p: ParsedTelemetry, estCount: Int) -> String {
        if estCount == 0 { return "" }
        if p.kind == .pdr, let recovery = p.lapRecovery {
            // No beacons in this recording: laps recovered from latitude + odometer.
            return recovery.anchored
                ? "laps recovered from latitude + odometer, aligned to the beacon session's start/finish (~±0.2s)"
                : "laps recovered from latitude + odometer (~±0.2s); boundaries are a fixed track point, not the official start/finish"
        }
        if p.kind == .pdr, !p.needsLine {
            return "\(estCount) of \(p.laps.count) laps distance-estimated (~), rest beacon-exact"
        }
        // Phone GPS (the live recorder) fixes at ~1 Hz vs a logger's 10–18 Hz.
        if p.kind == .live { return "lap times derived from GPS start/finish crossings (~±0.2–0.5s)" }
        return "lap times derived from GPS start/finish crossings (~±0.1–0.3s)"
    }

    /// "PDR 09:23:26" — the session label an import proposes, from the file's own
    /// clock, falling back to its name.
    public static func defaultLabel(_ p: ParsedTelemetry, file: String) -> String {
        "\(p.kind.label) \(p.time ?? stripExtension(file))"
    }

    /// The notes line the web importer writes, so a session imported on the phone
    /// reads identically to the same file imported at a desk.
    public static func importNotes(_ p: ParsedTelemetry, file: String) -> String {
        let source = p.kind == .live
            ? "Recorded with the in-app lap timer"
            : "Imported from \(file)"
        let metrics = metricsSummary(p)
        let note = estimatedNote(p, estCount: p.laps.filter(\.estimated).count)
        return source
            + (metrics.isEmpty ? "" : " — \(metrics)")
            + (note.isEmpty ? "" : " — \(note)")
    }

    private static func stripExtension(_ file: String) -> String {
        let lower = file.lowercased()
        for ext in [".mp4", ".vbo"] where lower.hasSuffix(ext) {
            return String(file.dropLast(ext.count))
        }
        return file
    }

    /// `Number.prototype.toLocaleString()` on an integer — grouped for reading, in
    /// the user's locale, exactly as the web app's rpm figure is.
    private static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}
