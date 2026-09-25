import Foundation

/// Porsche Track Precision's CSV export — a line-for-line port of
/// `public/js/import/csv.js`, under the same names, pinned to
/// `contracts/logic/csv-parsers.json` by `TrackPrecisionCsvContractTests`.
///
/// The same car, the same channels and the same app as its `.vbo` export
/// (`VBO`), in a plainer layout: one header row of camelCase names, then one
/// comma-separated row per ~10 Hz sample. Newer app versions put a space after
/// every comma; empty fields are columns the car didn't report.
///
/// Three things differ from the `.vbo` and each is load-bearing:
///   - Coordinates are decimal degrees, east-positive, so nothing is negated.
///   - The clock is `timestamp`, epoch milliseconds.
///   - There is no start/finish line — but there is Track Precision's own lap
///     timer, `laptime`, the milliseconds since the car last crossed its line.
///     The crossing is therefore `timestamp - laptime` on the first sample of
///     each lap, which is exact to the app's own timing (`lapsFromLaptime`) and
///     needs no line at all. A file whose timer never completes a lap falls back
///     to the line picker, like a `.vbo` without `[laptiming]`.
///
/// Units change with the app's firmware and the file never says which: speed is
/// km/h in the 2024 exports and m/s later (`speedToMs` decides against the GPS
/// trace), and the accelerations are m/s² then G (`VBO.accelToG`, whose _PTPA
/// columns changed the same way).
public enum TrackPrecisionCsv {
    // MARK: - Column tables

    /// Car channels, by lowercased header → `CHANNEL_NAMES` name, converted as
    /// `VBO.CAR_COLUMNS` are. `yawVelocity` is mapped for parity with the `.vbo`'s
    /// `yaw` column; every sample so far writes it as 0, which
    /// `VBO.finishCarChannels`' `varies` drops.
    static let CAR_COLUMNS: [(String, String, @Sendable (Double) -> Double)] = [
        ("rpm", "enginespeed", { $0 }),
        // Stored as a magnitude, like PDR.
        ("latG", "lateralacceleration", { abs($0) }),
        ("longG", "longitudinalacceleration", { $0 }),
        ("steering", "steeringwheelangle", { $0 }),
        ("gear", "currentgear", { $0 >= 1 && $0 <= 8 ? JSMath.round($0, 1) : 0 }),
        ("yaw", "yawvelocity", { $0 }),
    ]
    static let THROTTLE_COLUMN = "pedalforce" // 0-1
    static let BRAKE_COLUMN = "brakingpressure" // bar

    /// Tyre pressures, bar → kPa. 3276.8 (0x7FFF / 10) is "no reading", as in the
    /// `.vbo`.
    static let TYRE_COLUMNS: [(String, String)] = [
        ("tyreKpaLF", "tirepressurefl"),
        ("tyreKpaRF", "tirepressurefr"),
        ("tyreKpaLR", "tirepressurerl"),
        ("tyreKpaRR", "tirepressurerr"),
    ]
    static let MAX_TYRE_BAR: Double = 10

    // MARK: - Speed unit

    /// Speed-column units, as the column's value for 1 m/s.
    public static let SPEED_UNITS: [(String, Double)] = [
        ("m/s", 1),
        ("km/h", 3.6),
        ("mph", 2.2369362920544),
    ]

    static let MIN_STEP_M: Double = 0.5

    /// The `speed` column's factor to m/s, decided by comparing it with the GPS
    /// trace: Σ speed·dt over Σ distance driven is the column's value for 1 m/s,
    /// and the nearest unit (in ratio, not difference) wins. Only steps where the
    /// car moved at least `MIN_STEP_M` count, so a parked stretch of GPS jitter
    /// can't pull the ratio. Km/h when there's nothing to go on — the older
    /// exports' unit.
    public static func speedToMs(_ trace: [Geo.Projected], _ speeds: [Double?]) -> Double {
        var driven = 0.0
        var integrated = 0.0
        if trace.count > 1 {
            for i in 1..<trace.count {
                let d = hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y)
                let dt = trace[i].t - trace[i - 1].t
                guard d >= MIN_STEP_M, dt > 0, let v = speeds[i] else { continue }
                driven += d
                integrated += v * dt
            }
        }
        guard driven > 0, integrated > 0 else { return 1 / 3.6 }
        let ratio = integrated / driven
        var best = SPEED_UNITS[1]
        for u in SPEED_UNITS where abs(log(ratio / u.1)) < abs(log(ratio / best.1)) {
            best = u
        }
        return 1 / best.1
    }

    // MARK: - Laps

    /// One sample of the lap timer: the timer, its lap distance (m) and speed
    /// (m/s), each nil where the field was empty.
    public struct TimerRow: Hashable, Sendable {
        public var t: Double
        public var lapMs: Double?
        public var lapM: Double?
        public var v: Double?

        public init(t: Double, lapMs: Double?, lapM: Double?, v: Double?) {
            self.t = t
            self.lapMs = lapMs
            self.lapM = lapM
            self.v = v
        }
    }

    public static let LAPTIME_TOL_S: Double = 1
    public static let EDGE_M: Double = 30
    public static let EDGE_PACE: Double = 0.5

    /// Laps from Track Precision's lap timer. `rows` are in time order.
    ///
    /// A lap starts wherever the counter goes backwards or sits at 0 — some
    /// firmware writes a single 0 row at the line, some goes straight to a small
    /// value — and its crossing is placed at `t - lapMs` on the first sample
    /// after, which is finer than the 10 Hz rows. A lap between two crossings is
    /// kept only when the counter ran the whole way: its last value before the
    /// second crossing must be within `LAPTIME_TOL_S` of the lap's length. That
    /// is what drops the stretch before the first crossing, a pit stop (the
    /// counter sits at 0 for minutes) and a recording stopped mid-lap. The
    /// timer's laps are exact to the app, so `estimated` is false.
    ///
    /// Track Precision also stops recording *at* the line, so the last lap's
    /// counter runs to within metres of a full lap and never resets. When the
    /// final sample's lap distance is within `EDGE_M` of the timed laps' length
    /// (their median, each carried from its last sample to its crossing) —
    /// either side, since a lap's length varies by a few metres with the line
    /// taken and the last sample may already be past it without the reset
    /// having been written — the difference is covered at the final sample's
    /// speed, the same allowance `VBO` makes for its edge crossings, and that
    /// one lap is marked estimated. Only at pace, though: the car must still be
    /// doing at least `EDGE_PACE` of the timed laps' average speed. A session
    /// usually ends with the cool-down lap rolling down the pit lane, which runs
    /// alongside the line — its lap distance reaches a full lap at 30 km/h
    /// without the car ever crossing the line, and the app rightly never counted
    /// it.
    public static func lapsFromLaptime(
        _ rows: [TimerRow], minLapS: Double = 30, maxLapS: Double = 3600
    ) -> [ParsedLap] {
        var crossings: [(t: Double, counted: Double?)] = []
        var lapM: [Double] = [] // each timed run's length in metres, carried on to its crossing
        var prev: Double?
        var pending = true
        var runMax: Double?
        var last: TimerRow? // the last sample with the timer running
        for row in rows {
            guard let lapMs = row.lapMs else { continue }
            let t = row.t
            if lapMs <= 0 {
                if let prev, prev > 0 { runMax = prev }
                pending = true
                prev = 0
                continue
            }
            if let p = prev, lapMs < p {
                runMax = p
                pending = true
            }
            if pending {
                let ct = t - lapMs / 1000
                if runMax != nil, let l = last, let m = l.lapM, let v = l.v {
                    lapM.append(m + v * (ct - l.t))
                }
                crossings.append((ct, runMax))
                pending = false
                runMax = nil
            }
            prev = lapMs
            last = row
        }
        var laps: [ParsedLap] = []
        func keep(_ startT: Double, _ endT: Double, _ estimated: Bool) {
            let s = endT - startT
            if s < minLapS || s > maxLapS { return }
            laps.append(
                ParsedLap(timeMs: Int((s * 1000).rounded()), estimated: estimated, startT: startT, endT: endT)
            )
        }
        if crossings.count > 1 {
            for i in 1..<crossings.count {
                let s = crossings[i].t - crossings[i - 1].t
                guard let counted = crossings[i].counted, abs(s - counted / 1000) <= LAPTIME_TOL_S else {
                    continue
                }
                keep(crossings[i - 1].t, crossings[i].t, false)
            }
        }
        func median(_ xs: [Double]) -> Double { xs.sorted()[xs.count / 2] }
        if let l = last, !pending, !laps.isEmpty, !lapM.isEmpty, let m = l.lapM, let v = l.v, v > 0 {
            let lapLenM = median(lapM)
            let paceMs = lapLenM / (median(laps.map { Double($0.timeMs) }) / 1000)
            let short = lapLenM - m
            if abs(short) <= EDGE_M && v >= EDGE_PACE * paceMs {
                keep(crossings[crossings.count - 1].t, l.t + short / v, true)
            }
        }
        return laps
    }

    // MARK: - Parse

    /// "recording-2026-06-06-09-53-45.csv" → "09:53:45", the recording's local
    /// start. The timestamp column is UTC and the file carries no zone, so the
    /// name is the only source of a wall-clock time.
    static func timeFromName(_ name: String?) -> String? {
        let text = name ?? ""
        guard let re = try? NSRegularExpression(
            pattern: #"[0-9]{4}-[0-9]{2}-[0-9]{2}[-_ T]([0-9]{2})[-:]([0-9]{2})[-:]([0-9]{2})"#
        ),
            let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        else { return nil }
        let g = (1...3).map { String(text[Range(m.range(at: $0), in: text)!]) }
        return "\(g[0]):\(g[1]):\(g[2])"
    }

    private static func pad2(_ n: Int) -> String { n < 10 ? "0\(n)" : String(n) }

    private static func trim(_ s: Substring) -> Substring {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return Substring(t)
    }

    public static func parseTrackPrecisionCsv(_ text: String, fileName: String? = nil) throws -> ParsedTelemetry {
        let lines = VBO.splitLines(text).filter { !trim(Substring($0)).isEmpty }
        guard let headerLine = lines.first else {
            throw TelemetryParseError(message: "Not a Porsche Track Precision CSV (empty file)")
        }
        let names = headerLine.split(separator: ",", omittingEmptySubsequences: false)
            .map { trim($0).lowercased() }
        func col(_ name: String) -> Int { names.firstIndex(of: name) ?? -1 }
        let iTs = col("timestamp")
        let iLat = col("latitude")
        let iLon = col("longitude")
        if iTs < 0 || iLat < 0 || iLon < 0 {
            throw TelemetryParseError(
                message: "Not a Porsche Track Precision CSV (no timestamp/latitude/longitude columns)"
            )
        }
        let iSpeed = col("speed")
        let iLap = col("laptime")
        let iLapM = col("lapdistance")
        struct CarCol {
            var name: String
            var i: Int
            var f: @Sendable (Double) -> Double
        }
        let carCols = CAR_COLUMNS.map { CarCol(name: $0.0, i: col($0.1), f: $0.2) }.filter { $0.i >= 0 }
        let iThrottle = col(THROTTLE_COLUMN)
        let iBrake = col(BRAKE_COLUMN)
        let tyreCols = TYRE_COLUMNS.map { (name: $0.0, i: col($0.1)) }.filter { $0.i >= 0 }

        // First pass: the rows as numbers. The speed column's unit is only known
        // once the whole GPS trace is in (speedToMs), and the car-silence check
        // needs speed in m/s, so the channels are collected in a second pass.
        struct Row {
            var t: Double
            var lat: Double
            var lon: Double
            var f: [Substring]

            func num(_ i: Int) -> Double? {
                guard i >= 0, i < f.count else { return nil }
                let s = TrackPrecisionCsv.trim(f[i])
                if s.isEmpty { return nil }
                let v = VBO.jsNumber(s)
                return v.isFinite ? v : nil
            }
        }
        var rows: [Row] = []
        var ts0: Double?
        for r in 1..<max(1, lines.count) {
            let f = lines[r].split(separator: ",", omittingEmptySubsequences: false)
            let probe = Row(t: 0, lat: 0, lon: 0, f: f)
            guard let ts = probe.num(iTs), let lat = probe.num(iLat), let lon = probe.num(iLon) else { continue }
            if lat == 0 && lon == 0 { continue } // no GPS fix
            if ts0 == nil { ts0 = ts }
            let t = (ts - ts0!) / 1000
            if let lastRow = rows.last, t <= lastRow.t { continue } // duplicate or out-of-order row
            rows.append(Row(t: t, lat: lat, lon: lon, f: f))
        }
        if rows.count < 10 {
            throw TelemetryParseError(message: "Track Precision CSV contains no usable GPS data")
        }

        let bare = rows.map { Geo.Point(t: $0.t, lat: $0.lat, lon: $0.lon) }
        let trace = Geo.projectTrace(bare, origin: Geo.Origin(lat: bare[0].lat, lon: bare[0].lon))
        let k: Double? = iSpeed >= 0 ? speedToMs(trace, rows.map { $0.num(iSpeed) }) : nil

        var points: [Geo.Point] = []
        points.reserveCapacity(rows.count)
        var lapRows: [TimerRow] = []
        var car: [[ChannelPoint]] = Array(repeating: [], count: carCols.count)
        var throttle: [ChannelPoint] = []
        var brake: [ChannelPoint] = []
        var tyres: [[ChannelPoint]] = Array(repeating: [], count: tyreCols.count)
        let iRpm = carCols.first { $0.name == "rpm" }?.i ?? -1
        for row in rows {
            let t = row.t
            let v: Double? = k.flatMap { k in row.num(iSpeed).map { $0 * k } }
            points.append(Geo.Point(t: t, lat: row.lat, lon: row.lon, v: v))
            lapRows.append(TimerRow(t: t, lapMs: row.num(iLap), lapM: row.num(iLapM), v: v))
            if iRpm >= 0 && VBO.carSilent(row.num(iRpm), v) { continue }
            for (j, c) in carCols.enumerated() {
                if let x = row.num(c.i) { car[j].append(ChannelPoint(t: t, v: c.f(x))) }
            }
            if let th = row.num(iThrottle) { throttle.append(ChannelPoint(t: t, v: th)) }
            if let br = row.num(iBrake) { brake.append(ChannelPoint(t: t, v: max(0, br))) }
            for (j, c) in tyreCols.enumerated() {
                if let x = row.num(c.i), x > 0, x < MAX_TYRE_BAR {
                    tyres[j].append(ChannelPoint(t: t, v: x * 100))
                }
            }
        }

        let finished = VBO.finishCarChannels(
            car: carCols.enumerated().map { (name: $0.element.name, pts: car[$0.offset]) },
            throttle: throttle,
            brake: brake,
            tyres: tyreCols.enumerated().map { (name: $0.element.name, pts: tyres[$0.offset]) },
            heights: []
        )

        let laps = iLap >= 0 ? lapsFromLaptime(lapRows) : []
        var bestLapTrace: [TracePoint]?
        if let first = laps.first {
            let best = laps.dropFirst().reduce(first) { $1.timeMs < $0.timeMs ? $1 : $0 }
            bestLapTrace = Geo.lapTrace(Geo.projectTrace(points), from: best.startT!, to: best.endT!)
        }

        // The name's date and time are the recording's own, in local time; the
        // UTC timestamp is the fallback, which can land on the neighbouring day.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let d0 = utc.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: Date(timeIntervalSince1970: ts0!.rounded(.down) / 1000)
        )
        let date = VBO.dateFromName(fileName) ?? "\(d0.year!)-\(pad2(d0.month!))-\(pad2(d0.day!))"
        let time = timeFromName(fileName) ?? "\(pad2(d0.hour!)):\(pad2(d0.minute!)):\(pad2(d0.second!))"

        return ParsedTelemetry(
            kind: .trackPrecision,
            date: date,
            time: time,
            durationS: points[points.count - 1].t,
            laps: laps,
            gps: points,
            needsLine: laps.isEmpty,
            bestLapTrace: bestLapTrace,
            carChannels: finished.carChannels,
            lapScalarChannels: finished.lapScalarChannels,
            sessionMeta: finished.sessionMeta
        )
    }
}
