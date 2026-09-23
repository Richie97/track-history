import Foundation

/// Racelogic `.vbo` parser.
///
/// A port of `public/js/import/vbo.js`, function for function and name for name
/// (`parseVboText`, `timeOfDayS`, `varies`, `dateFromName`, `widenGate`,
/// `edgeCrossings`, and the column tables), with its test cases
/// (`test/unit/vbo.test.js` → `VBOTests`) and a cross-language fixture
/// (`contracts/logic/vbo-parsers.json`, over the committed files in
/// `contracts/logic/vbo/`) pinning it to the JS output.
///
/// Plain ASCII: an optional "File created ..." line, `[section]` blocks —
/// `[column names]` for the data layout, `[laptiming]` for the start/finish line,
/// `[data]` for the samples. Written by VBOX hardware and by RaceChrono /
/// TrackAddict / Harry's LapTimer / Porsche Track Precision exports.
///
/// Two layouts of `[column names]` exist in the wild: VBOX hardware writes every
/// name on one line separated by spaces; Porsche's Track Precision App writes one
/// name per line, and its names contain spaces ("steering wheel angle"). A section
/// of more than one line is read as one name per line.
///
/// Coordinates are in minutes (degrees × 60) and Racelogic longitude is
/// west-positive, so it is negated here into the usual east-positive degrees every
/// other source uses — otherwise the stored racing line draws mirrored. An
/// exporter that ignores the convention still times correctly (lap derivation is
/// geometry within the file) and the line picker's mirroring fallback
/// (`Telemetry.applyGate`) still matches it to a batch-mate.
///
/// Unlike the video parsers this one reads the whole file: a `.vbo` is a text log
/// of a few MB, not a multi-GB clip, so `Telemetry.parseTelemetryFile` decodes it
/// as text and hands it here.
public enum VBO {
    // MARK: - Column tables

    /// Car channels, by `[column names]` entry → `CHANNEL_NAMES` name. The first
    /// name present wins, so Porsche's `LatAcc_PTPA` (true G) is preferred over its
    /// `latacc` column, which despite a "latAccel g" header holds G / 9.81. The
    /// closure converts to the stored unit.
    static let CAR_COLUMNS: [(String, [String], @Sendable (Double) -> Double)] = [
        ("rpm", ["engine", "rpm", "engine speed", "enginespeed"], { $0 }),
        // Stored as a magnitude, like PDR.
        ("latG", ["latacc_ptpa", "latacc", "lat_acc", "latg"], { abs($0) }),
        ("longG", ["longacc_ptpa", "longacc", "long_acc", "longg"], { $0 }),
        ("steering", ["steering wheel angle", "steering", "steer", "steering angle"], { $0 }),
        ("gear", ["current gear", "gear"], { $0 >= 1 && $0 <= 8 ? JSMath.round($0, 1) : 0 }),
        ("yaw", ["yaw", "yaw rate", "yawrate"], { $0 }),
    ]

    /// Throttle is a pedal position; exporters write it as a 0-1 fraction or a
    /// percentage, decided per file by the column's own peak.
    static let THROTTLE_COLUMNS = ["pedal", "throttle", "throttle position", "accelerator"]

    /// Brake is a *pressure* in these files (bar), not a pedal position. Stored as
    /// a percentage of the file's own peak, so the trace keeps its shape on the
    /// 0-100 brake axis PDR's pedal position uses.
    static let BRAKE_COLUMNS = ["braking", "brake", "brake pressure", "braking pressure"]

    /// Tyre pressures, bar → kPa, one reading per lap (the lap-end value).
    static let TYRE_COLUMNS: [(String, String)] = [
        ("tyreKpaLF", "tire pressure front left"),
        ("tyreKpaRF", "tire pressure front right"),
        ("tyreKpaLR", "tire pressure rear left"),
        ("tyreKpaRR", "tire pressure rear right"),
    ]

    /// Track Precision writes 3276.8 (0x7FFF / 10) when the car sent no reading.
    static let MAX_TYRE_BAR: Double = 10

    /// The line a file carries can be short — Track Precision's is ~15 m and sits
    /// mostly to one side of the racing line — so it is stretched to at least this
    /// either side of its midpoint (the width of a hand-picked gate).
    static let MIN_GATE_HALF_M: Double = 20

    /// How far past (or short of) the line a recording's first (last) fix may sit
    /// and still have its crossing extrapolated.
    static let EDGE_M: Double = 30

    // MARK: - Helpers

    /// "095512.30" (time-of-day) → seconds.
    static func timeOfDayS(_ s: Substring) -> Double? {
        let chars = Array(s.utf8)
        // /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/
        guard chars.count >= 6, chars[0..<6].allSatisfy(isAsciiDigit) else { return nil }
        if chars.count > 6 {
            guard chars[6] == UInt8(ascii: "."), chars.count > 7,
                  chars[7...].allSatisfy(isAsciiDigit)
            else { return nil }
        }
        let str = String(s)
        let h = Double(str.prefix(2))!
        let m = Double(str.dropFirst(2).prefix(2))!
        let sec = Double(str.dropFirst(4))!
        return h * 3600 + m * 60 + sec
    }

    private static func isAsciiDigit(_ c: UInt8) -> Bool {
        c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")
    }

    /// A column that never changes (Track Precision writes every column it knows,
    /// zeroed when the car doesn't report it) is no channel at all.
    static func varies(_ pts: [ChannelPoint]) -> Bool {
        guard pts.count > 1 else { return false }
        for i in 1..<pts.count where pts[i].v != pts[0].v { return true }
        return false
    }

    /// "recording-2026-06-06-09-53-45.vbo" → "2026-06-06". Track Precision's
    /// "File created at" line is the *export* time, so the name is the better
    /// source for the session's date when it carries one.
    static func dateFromName(_ name: String?) -> String? {
        guard let m = firstMatch(#"([0-9]{4})-([0-9]{2})-([0-9]{2})"#, in: name ?? "") else { return nil }
        return "\(m[1]!)-\(m[2]!)-\(m[3]!)"
    }

    /// Stretch a file's start/finish line about its own midpoint to at least
    /// `MIN_GATE_HALF_M` either side, keeping its angle, and give it the direction
    /// of travel where the trace passes closest, so the wider line can't also
    /// count a nearby stretch of track driven the other way.
    static func widenGate(_ gate: Geo.Gate, _ trace: [Geo.Projected]) -> Geo.Gate {
        let dx = gate.x2 - gate.x1
        let dy = gate.y2 - gate.y1
        let len = hypot(dx, dy)
        if len == 0 || len.isNaN { return gate }
        let half = max(len / 2, MIN_GATE_HALF_M)
        let ux = dx / len
        let uy = dy / len
        var k = 0
        var best = Double.infinity
        for i in 0..<trace.count {
            let ex = trace[i].x - gate.x
            let ey = trace[i].y - gate.y
            let d = ex * ex + ey * ey
            if d < best {
                best = d
                k = i
            }
        }
        let a = trace[max(0, k - 2)]
        let b = trace[min(trace.count - 1, k + 2)]
        let moving = hypot(b.x - a.x, b.y - a.y) > 1
        return Geo.Gate(
            x: gate.x,
            y: gate.y,
            hx: moving ? b.x - a.x : nil,
            hy: moving ? b.y - a.y : nil,
            x1: gate.x - ux * half,
            y1: gate.y - uy * half,
            x2: gate.x + ux * half,
            y2: gate.y + uy * half
        )
    }

    /// Track Precision starts and stops recording *at* the start/finish line, so
    /// the first fix sits a few metres past it and the last a few metres short:
    /// the line is never seen crossed at either end, and the first and last flying
    /// laps would be lost. A fix within `EDGE_M` of the line (well under a second
    /// at track pace), inside its width and moving through it, gets a crossing
    /// extrapolated at its own speed — estimated, like every GPS lap.
    static func edgeCrossings(_ trace: [Geo.Projected], _ gate: Geo.Gate) -> [Double] {
        var crossings = Geo.gateCrossings(trace, gate: gate)
        guard let hx = gate.hx, let hy = gate.hy, trace.count >= 2 else { return crossings }
        let gx = gate.x2 - gate.x1
        let gy = gate.y2 - gate.y1
        let half = hypot(gx, gy) / 2
        let ux = gx / (2 * half)
        let uy = gy / (2 * half)
        // Unit normal pointing the way the car crosses.
        var nx = -uy
        var ny = ux
        if nx * hx + ny * hy < 0 {
            nx = -nx
            ny = -ny
        }
        func speed(_ i: Int, _ j: Int) -> Double {
            if let v = trace[i].v, v.isFinite { return v }
            let dt = abs(trace[j].t - trace[i].t)
            return dt != 0 && !dt.isNaN
                ? hypot(trace[j].x - trace[i].x, trace[j].y - trace[i].y) / dt
                : 0
        }
        func at(_ i: Int, _ j: Int) -> (past: Double, v: Double)? {
            let p = trace[i]
            let along = (p.x - gate.x) * ux + (p.y - gate.y) * uy
            let past = (p.x - gate.x) * nx + (p.y - gate.y) * ny
            let v = speed(i, j)
            return abs(along) <= half && v > 5 ? (past, v) : nil
        }
        if let first = at(0, 1), first.past > 0, first.past < EDGE_M {
            crossings.insert(trace[0].t - first.past / first.v, at: 0)
        }
        let n = trace.count - 1
        if let last = at(n, n - 1), last.past < 0, -last.past < EDGE_M {
            crossings.append(trace[n].t - last.past / last.v)
        }
        return crossings
    }

    // MARK: - Parse

    public static func parseVboText(_ text: String, fileName: String? = nil) throws -> ParsedTelemetry {
        let lines = splitLines(text)
        let firstLine = lines.first ?? ""

        var date = dateFromName(fileName)
        var time: String?
        // VBOX: "File created on 20/06/2026 at 09:15:00" — the recording's own
        // start, so its time is used as well as its date.
        if let created = firstMatch(
            #"created on ([0-9]{2})/([0-9]{2})/([0-9]{4})(?: at| @)? ([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?"#,
            in: firstLine, caseInsensitive: true
        ) {
            if date == nil { date = "\(created[3]!)-\(created[2]!)-\(created[1]!)" }
            time = "\(created[4]!):\(created[5]!):\(created[6] ?? "00")"
        }
        // Track Precision: "File created at 2026-09-22 21:59:37 -0600" — when it
        // was exported, so only a last resort for the date and never the time.
        if let exported = firstMatch(
            #"created at ([0-9]{4})-([0-9]{2})-([0-9]{2})"#, in: firstLine, caseInsensitive: true
        ) {
            if date == nil { date = "\(exported[1]!)-\(exported[2]!)-\(exported[3]!)" }
        }

        // Collect sections.
        var sections: [String: [String]] = [:]
        var current: String?
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            if line.count >= 3, line.hasPrefix("["), line.hasSuffix("]") {
                let name = String(line.dropFirst().dropLast()).lowercased()
                current = name
                sections[name] = []
                continue
            }
            if let current { sections[current, default: []].append(line) }
        }

        let nameLines = sections["column names"] ?? []
        let rawNames: [String] = nameLines.count > 1
            ? nameLines
            : splitWhitespace(nameLines.first ?? "").map(String.init)
        let colNames = rawNames
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        if colNames.isEmpty {
            throw TelemetryParseError(message: "Not a valid VBO file (no [column names] section)")
        }
        func col(_ name: String) -> Int { colNames.firstIndex(of: name) ?? -1 }
        func firstCol(_ names: [String]) -> Int { names.map(col).first { $0 >= 0 } ?? -1 }
        let iTime = col("time")
        let iLat = col("lat")
        let iLon = col("long")
        let iVel = firstCol(["velocity", "speed"])
        if iTime < 0 || iLat < 0 || iLon < 0 {
            throw TelemetryParseError(message: "VBO file is missing time/lat/long columns")
        }
        // gps.v is m/s across all parsers (LapChannels depends on it). The
        // [header] section names the velocity unit — "velocity kmh" in VBOX files
        // and the common exporters; handle mph/knots variants, default km/h.
        let velLine = (sections["header"] ?? []).first(where: startsWithVelocityWord) ?? ""
        let velLower = velLine.lowercased()
        let velToMs: Double = velLower.contains("mph")
            ? 0.44704
            : (velLower.contains("kts") || velLower.contains("knots")) ? 0.514444 : 1 / 3.6

        let iHeight = firstCol(["height", "alt", "altitude"])
        struct CarCol {
            var name: String
            var i: Int
            var f: @Sendable (Double) -> Double
        }
        let carCols = CAR_COLUMNS.map { CarCol(name: $0.0, i: firstCol($0.1), f: $0.2) }.filter { $0.i >= 0 }
        let iThrottle = firstCol(THROTTLE_COLUMNS)
        let iBrake = firstCol(BRAKE_COLUMNS)
        let tyreCols = TYRE_COLUMNS.map { (name: $0.0, i: col($0.1)) }.filter { $0.i >= 0 }

        // Data rows → GPS points (+ car channels on the same clock). VBO
        // coordinates are minutes → /60 to degrees. The time column is a
        // time-of-day; make t relative to the first sample (handling a midnight
        // wrap).
        var points: [Geo.Point] = []
        var car: [[ChannelPoint]] = Array(repeating: [], count: carCols.count)
        var throttle: [ChannelPoint] = []
        var brake: [ChannelPoint] = []
        var tyres: [[ChannelPoint]] = Array(repeating: [], count: tyreCols.count)
        var heights: [Double] = []
        var t0: Double?
        for row in sections["data"] ?? [] {
            let f = splitWhitespace(row)
            if f.count < colNames.count { continue }
            let lat = jsNumber(f[iLat])
            let lon = jsNumber(f[iLon])
            guard let tod = timeOfDayS(f[iTime]), lat.isFinite, lon.isFinite else { continue }
            if lat == 0 && lon == 0 { continue } // no GPS fix
            if t0 == nil { t0 = tod }
            var t = tod - t0!
            if t < 0 { t += 86400 }
            points.append(
                Geo.Point(t: t, lat: lat / 60, lon: -lon / 60, v: iVel >= 0 ? jsNumber(f[iVel]) * velToMs : nil)
            )

            func num(_ i: Int) -> Double? {
                let v = jsNumber(f[i])
                return v.isFinite ? v : nil
            }
            for (k, c) in carCols.enumerated() {
                if let v = num(c.i) { car[k].append(ChannelPoint(t: t, v: c.f(v))) }
            }
            if iThrottle >= 0, let v = num(iThrottle) {
                throttle.append(ChannelPoint(t: t, v: v))
            }
            if iBrake >= 0, let v = num(iBrake) {
                brake.append(ChannelPoint(t: t, v: max(0, v)))
            }
            for (k, c) in tyreCols.enumerated() {
                if let v = num(c.i), v > 0, v < MAX_TYRE_BAR {
                    tyres[k].append(ChannelPoint(t: t, v: v * 100))
                }
            }
            if iHeight >= 0, let v = num(iHeight) { heights.append(v) }
        }
        if points.count < 10 {
            throw TelemetryParseError(message: "VBO file contains no usable GPS data")
        }

        if time == nil, let t0 {
            let h = Int((t0 / 3600).rounded(.down))
            let mi = Int((t0.truncatingRemainder(dividingBy: 3600) / 60).rounded(.down))
            let se = Int(t0.truncatingRemainder(dividingBy: 60).rounded(.down))
            time = [h, mi, se].map { $0 < 10 ? "0\($0)" : String($0) }.joined(separator: ":")
        }

        var carChannels = ParsedTelemetry.CarChannels()
        for (k, c) in carCols.enumerated() where car[k].count >= 10 && varies(car[k]) {
            carChannels[c.name] = car[k]
        }
        if throttle.count >= 10 && varies(throttle) {
            let peak = throttle.map(\.v).max()!
            let scale: Double = peak <= 1.0001 ? 100 : 1
            carChannels.throttle = throttle.map {
                ChannelPoint(t: $0.t, v: min(100, max(0, $0.v * scale)))
            }
        }
        if brake.count >= 10 && varies(brake) {
            let peak = brake.map(\.v).max()!
            carChannels.brake = brake.map { ChannelPoint(t: $0.t, v: ($0.v / peak) * 100) }
        }
        var lapScalarChannels: [String: [ChannelPoint]] = [:]
        for (k, c) in tyreCols.enumerated() where tyres[k].count >= 10 {
            lapScalarChannels[c.name] = tyres[k]
        }
        let sessionMeta = heights.count > 10
            ? ParsedTelemetry.SessionMeta(elevationM: heights.max()! - heights.min()!)
            : nil

        // [laptiming]: "Start <lon1> <lat1> <lon2> <lat2>" (minutes, two
        // endpoints of the start/finish line) per Racelogic, though some
        // exporters write latitude first. Both readings are tried and the one
        // lying on the driven trace is kept. If present, laps come for free.
        var laps: [ParsedLap] = []
        var lapTracePts: [TracePoint]?
        let startLine = (sections["laptiming"] ?? []).first(where: startsWithStartWord)
        if let startLine {
            let n = splitWhitespace(startLine).dropFirst().prefix(4).map(jsNumber)
            if n.count == 4 && n.allSatisfy(\.isFinite) {
                let originPoint = points[0]
                let origin = Geo.Origin(lat: originPoint.lat, lon: originPoint.lon)
                let trace = Geo.projectTrace(points, origin: origin)
                func endpoints(_ lonFirst: Bool) -> [Geo.Projected] {
                    Geo.projectTrace(
                        lonFirst
                            ? [
                                Geo.Point(t: 0, lat: n[1] / 60, lon: -n[0] / 60),
                                Geo.Point(t: 0, lat: n[3] / 60, lon: -n[2] / 60),
                            ]
                            : [
                                Geo.Point(t: 0, lat: n[0] / 60, lon: -n[1] / 60),
                                Geo.Point(t: 0, lat: n[2] / 60, lon: -n[3] / 60),
                            ],
                        origin: origin
                    )
                }
                func nearest(_ ends: [Geo.Projected]) -> Double {
                    let mx = (ends[0].x + ends[1].x) / 2
                    let my = (ends[0].y + ends[1].y) / 2
                    var best = Double.infinity
                    for p in trace {
                        let ex = p.x - mx
                        let ey = p.y - my
                        best = min(best, ex * ex + ey * ey)
                    }
                    return best
                }
                let lonFirst = endpoints(true)
                let latFirst = endpoints(false)
                let ends = nearest(lonFirst) <= nearest(latFirst) ? lonFirst : latFirst
                let gate = widenGate(
                    Geo.gateFromSegment((ends[0].x, ends[0].y), (ends[1].x, ends[1].y)), trace
                )
                laps = Geo.lapsFromCrossings(edgeCrossings(trace, gate)).map(ParsedLap.init)
                if let first = laps.first {
                    let best = laps.dropFirst().reduce(first) { $1.timeMs < $0.timeMs ? $1 : $0 }
                    lapTracePts = Geo.lapTrace(trace, from: best.startT!, to: best.endT!)
                }
            }
        }

        return ParsedTelemetry(
            kind: .vbo,
            date: date,
            time: time,
            durationS: points[points.count - 1].t,
            laps: laps,
            gps: points,
            // A [laptiming] line that yields no laps (wrong circuit, odd layout)
            // falls back to manual line picking.
            needsLine: laps.isEmpty,
            bestLapTrace: lapTracePts,
            carChannels: carChannels,
            lapScalarChannels: lapScalarChannels,
            sessionMeta: sessionMeta
        )
    }

    // MARK: - JS string semantics

    /// `text.split(/\r?\n/)`. Swift treats "\r\n" as one `Character`, so the split
    /// runs over unicode scalars.
    static func splitLines(_ text: String) -> [String] {
        var out: [String] = []
        var line = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar == "\n" {
                if line.last == "\r" { line.removeLast() }
                out.append(String(line))
                line = String.UnicodeScalarView()
            } else {
                line.append(scalar)
            }
        }
        out.append(String(line))
        return out
    }

    /// `s.split(/\s+/)` on an already-trimmed string.
    static func splitWhitespace(_ s: String) -> [Substring] {
        s.split(whereSeparator: { $0.isWhitespace })
    }

    /// `/^velocity\b/i`
    private static func startsWithVelocityWord(_ line: String) -> Bool {
        startsWithWord(line, "velocity", boundary: true)
    }

    /// `/^start\s/i`
    private static func startsWithStartWord(_ line: String) -> Bool {
        let lower = line.lowercased()
        guard lower.hasPrefix("start") else { return false }
        let rest = lower.dropFirst(5)
        return rest.first?.isWhitespace == true
    }

    private static func startsWithWord(_ line: String, _ word: String, boundary: Bool) -> Bool {
        let lower = line.lowercased()
        guard lower.hasPrefix(word) else { return false }
        guard let next = lower.dropFirst(word.count).unicodeScalars.first else { return true }
        let isWord = (next >= "a" && next <= "z") || (next >= "0" && next <= "9") || next == "_"
        return !isWord
    }

    /// JavaScript's `Number(string)` for one whitespace-free field: a decimal
    /// literal with optional sign and exponent (".5", "5.", "+003.5", "-0"),
    /// `Infinity`, or an unsigned 0x/0o/0b integer; anything else is NaN.
    /// `Double(_:)` alone is looser — it takes "nan", "inf" and hex floats.
    static func jsNumber(_ s: Substring) -> Double {
        if s.isEmpty { return 0 }
        let bytes = Array(s.utf8)
        var i = 0
        var sign = 1.0
        if bytes[0] == UInt8(ascii: "+") || bytes[0] == UInt8(ascii: "-") {
            if bytes[0] == UInt8(ascii: "-") { sign = -1 }
            i = 1
        }
        let body = s.dropFirst(i)
        if body == "Infinity" { return sign * .infinity }
        if i == 0, bytes.count > 2, bytes[0] == UInt8(ascii: "0") {
            let radix: Int? = switch bytes[1] {
            case UInt8(ascii: "x"), UInt8(ascii: "X"): 16
            case UInt8(ascii: "o"), UInt8(ascii: "O"): 8
            case UInt8(ascii: "b"), UInt8(ascii: "B"): 2
            default: nil
            }
            if let radix {
                var v = 0.0
                for c in s.dropFirst(2) {
                    guard let d = c.hexDigitValue, d < radix else { return .nan }
                    v = v * Double(radix) + Double(d)
                }
                return v
            }
        }
        // StrUnsignedDecimalLiteral: digits [. digits?] | . digits, then [eE][+-]digits.
        var j = i
        var mantissaDigits = 0
        while j < bytes.count, isAsciiDigit(bytes[j]) { j += 1; mantissaDigits += 1 }
        if j < bytes.count, bytes[j] == UInt8(ascii: ".") {
            j += 1
            while j < bytes.count, isAsciiDigit(bytes[j]) { j += 1; mantissaDigits += 1 }
        }
        if mantissaDigits == 0 { return .nan }
        if j < bytes.count, bytes[j] == UInt8(ascii: "e") || bytes[j] == UInt8(ascii: "E") {
            j += 1
            if j < bytes.count, bytes[j] == UInt8(ascii: "+") || bytes[j] == UInt8(ascii: "-") { j += 1 }
            var expDigits = 0
            while j < bytes.count, isAsciiDigit(bytes[j]) { j += 1; expDigits += 1 }
            if expDigits == 0 { return .nan }
        }
        if j != bytes.count { return .nan }
        // `Double("5.")` and `Double(".5")` both parse; the grammar above already
        // matched, so what's left is correct rounding, which both languages do.
        return Double(String(s)) ?? .nan
    }

    /// The capture groups of the first match, `nil` for a group that didn't take
    /// part — `RegExp.prototype.exec` with an unanchored pattern.
    private static func firstMatch(
        _ pattern: String, in text: String, caseInsensitive: Bool = false
    ) -> [String?]? {
        guard let re = try? NSRegularExpression(
            pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : []
        ) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        return (0..<m.numberOfRanges).map { k in
            let r = m.range(at: k)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
    }
}
