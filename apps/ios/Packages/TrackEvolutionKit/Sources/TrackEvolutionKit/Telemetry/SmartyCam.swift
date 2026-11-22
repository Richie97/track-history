import Foundation

/// AiM SmartyCam telemetry parser (NS-55, `docs/specs/native/NS-55-smartycam-import.md`).
///
/// A port of `public/js/import/smartycam.js`, function for function and name for
/// name, with its test cases (`test/unit/smartycam.test.js` → `SmartyCamTests`)
/// and a cross-language fixture (`contracts/logic/smartycam-parsers.json`)
/// pinning it to the JS output.
///
/// A SmartyCam .MOV is QuickTime with three tracks: the picture (avc1), the
/// sound (`sowt` PCM) and a third, handler `free`, that is *declared* as PCM
/// audio and is really the telemetry: one chunk every five video frames (6 Hz),
/// of which only the first `RECORD_BYTES` are a little-endian record — the rest
/// is noise. The layout is reverse-engineered from one camera (SmartyCam GP HD,
/// firmware 01.03.30, slave to an AiM logger); the offsets are in `readRecord`.
///
/// Three traps, each inherited from the JS:
///
/// - **Video time is not real time.** The camera drops frames (about 3 s at the
///   start of every file, and up to 3 % after), so a 128 s lap can be 125 s of
///   video. `t` here is *video* seconds — frame / fps — on purpose: every lap's
///   `startT` / `endT` then cuts the clip where the lap is in the file. Lap
///   *times* are the logger's own (offset 40), never `endT − startT`.
/// - **The lap counter trails the crossing by one record** (`LAP_LATENCY_RECORDS`).
/// - **The trailing XML's nlap / best are the logger's totals for the day**, not
///   this file's. Only the date and the time are read from it, and never the
///   driver's name, the vehicle or a serial number.
///
/// Like the other video parsers, only the index and the records are read
/// through the byte source; the video itself is never read or uploaded.
public enum SmartyCam {
    public static let RECORD_BYTES = 124
    /// The camera's "no reading" in any car field.
    public static let NO_VALUE = -12290
    public static let LAP_LATENCY_RECORDS = 1
    public static let LAP_CLOCK_TOLERANCE_MS = 1500

    static let MIN_CHANNEL_SAMPLES = 10
    /// Records fetched between cancellation checks (`READ_BATCH` in the JS, where
    /// it is how many range reads run at once).
    static let READ_BATCH = 64
    static let META_TAIL_BYTES = 4096

    // WGS-84.
    static let WGS84_A = 6378137.0
    static let WGS84_E2 = 6.69437999014e-3
    /// Fixed, so every port lands on the same digits.
    static let GEODETIC_ITERATIONS = 5

    public struct Geodetic: Hashable, Sendable {
        public var lat: Double
        public var lon: Double
    }

    /// ECEF metres → latitude / longitude in degrees.
    public static func ecefToGeodetic(_ xM: Double, _ yM: Double, _ zM: Double) -> Geodetic {
        let lon = atan2(yM, xM)
        let p = hypot(xM, yM)
        var lat = atan2(zM, p * (1 - WGS84_E2))
        for _ in 0..<GEODETIC_ITERATIONS {
            let s = sin(lat)
            let n = WGS84_A / (1 - WGS84_E2 * s * s).squareRoot()
            lat = atan2(zM + WGS84_E2 * n * s, p)
        }
        return Geodetic(lat: (lat * 180) / .pi, lon: (lon * 180) / .pi)
    }

    /// An ECEF position, metres.
    public struct ECEF: Hashable, Sendable {
        public var x: Double
        public var y: Double
        public var z: Double

        public init(x: Double, y: Double, z: Double) {
            self.x = x
            self.y = y
            self.z = z
        }
    }

    /// One telemetry record. `t` (video seconds) is not in the record itself: the
    /// file parser sets it from `frame` and the picture's frame rate.
    public struct Record: Hashable, Sendable {
        public var frame: Int
        public var tsMs: Int
        public var lapCount: Int?
        public var lapMs: Int?
        public var ecef: ECEF?
        public var speedMs: Double?
        public var rpm: Int?
        public var throttle: Int?
        public var gear: Int?
        public var t: Double

        public init(
            frame: Int = 0, tsMs: Int = 0, lapCount: Int? = nil, lapMs: Int? = nil,
            ecef: ECEF? = nil, speedMs: Double? = nil, rpm: Int? = nil, throttle: Int? = nil,
            gear: Int? = nil, t: Double = 0
        ) {
            self.frame = frame
            self.tsMs = tsMs
            self.lapCount = lapCount
            self.lapMs = lapMs
            self.ecef = ecef
            self.speedMs = speedMs
            self.rpm = rpm
            self.throttle = throttle
            self.gear = gear
            self.t = t
        }
    }

    private static func car(_ v: Int) -> Int? { v == NO_VALUE ? nil : v }

    /// `Math.hypot` of three.
    private static func hypot3(_ x: Double, _ y: Double, _ z: Double) -> Double {
        (x * x + y * y + z * z).squareRoot()
    }

    /// One record at `offset` of a view. Car fields and the lap fields are nil
    /// when the camera wrote `NO_VALUE`; `ecef` (metres) and `speedMs` are nil
    /// when the fix isn't one — all zero, a -1, or nowhere near the Earth's
    /// surface.
    ///
    ///     0 u32  video frame index (0, 5, 10, …)
    ///     8 i32  logger clock, ms
    ///    32 i32  completed-lap counter        40 i32  time of the lap just completed, ms
    ///    60/64/68 i32  ECEF position, cm      76/80/84 i32  ECEF velocity, cm/s
    ///   104 i32  rpm    108 i32  throttle %   120 i32  gear
    ///
    /// Not read: the ×1e7 latitude / longitude at 16 / 24 (2 Hz, and up to 45 m
    /// behind the ECEF fix), the float at 112 (its meaning changes with the
    /// camera's configuration) and four slow channels nobody has identified.
    public static func readRecord(_ dv: ByteView, _ offset: Int = 0) -> Record {
        // Little-endian, unlike everything else in the container.
        func u32(_ o: Int) -> UInt32 {
            var out: UInt32 = 0
            for i in (0..<4).reversed() { out = (out << 8) | UInt32(dv.getUint8(offset + o + i)) }
            return out
        }
        func i32(_ o: Int) -> Int { Int(Int32(bitPattern: u32(o))) }
        let x = i32(60)
        let y = i32(64)
        let z = i32(68)
        let r = hypot3(Double(x), Double(y), Double(z)) / 100
        let fix = x != -1 && y != -1 && z != -1 && r > 6.3e6 && r < 6.4e6
        let lapCount = car(i32(32))
        let lapMs = car(i32(40))
        return Record(
            frame: Int(u32(0)),
            tsMs: i32(8),
            lapCount: lapCount.flatMap { $0 >= 0 ? $0 : nil },
            lapMs: lapMs.flatMap { $0 > 0 ? $0 : nil },
            ecef: fix ? ECEF(x: Double(x) / 100, y: Double(y) / 100, z: Double(z) / 100) : nil,
            speedMs: fix ? hypot3(Double(i32(76)), Double(i32(80)), Double(i32(84))) / 100 : nil,
            rpm: car(i32(104)),
            throttle: car(i32(108)),
            gear: car(i32(120))
        )
    }

    /// The laps a file holds, from records that carry `t` (video seconds).
    ///
    /// The counter steps to `c` one record after the car crossed the line, with
    /// the time of lap `c` beside it. A lap needs both its crossings in the file,
    /// so it is two *consecutive* steps: the first step seen closes a lap that
    /// began before the video did (the out-lap, timed from when the logger
    /// started) and only opens the next. A counter that jumps, goes backwards or
    /// goes missing opens nothing. A lap whose logger-clock length disagrees with
    /// its reported time is a glitch, not a lap.
    public static func lapsFromCounter(_ records: [Record]) -> [ParsedLap] {
        var laps: [ParsedLap] = []
        // The crossing that began the lap in progress.
        var open: (count: Int, t: Double, tsMs: Int)?
        var prev: Int?
        for i in 0..<records.count {
            let r = records[i]
            guard let lapCount = r.lapCount else {
                open = nil
                prev = nil
                continue
            }
            if let prev, lapCount != prev {
                if lapCount == prev + 1 {
                    let at = records[max(0, i - LAP_LATENCY_RECORDS)]
                    if let open, open.count == prev, let lapMs = r.lapMs,
                       abs(at.tsMs - open.tsMs - lapMs) <= LAP_CLOCK_TOLERANCE_MS,
                       at.t > open.t {
                        laps.append(
                            ParsedLap(
                                lapNumber: laps.count + 1, timeMs: lapMs, estimated: false,
                                startT: open.t, endT: at.t))
                    }
                    open = (lapCount, at.t, at.tsMs)
                } else {
                    open = nil
                }
            }
            prev = lapCount
        }
        return laps
    }

    /// `plausibleChannels`' answer: whether each car field is kept.
    public struct Plausible: Hashable, Sendable {
        public var rpm: Bool
        public var throttle: Bool
        public var gear: Bool

        public init(rpm: Bool, throttle: Bool, gear: Bool) {
            self.rpm = rpm
            self.throttle = throttle
            self.gear = gear
        }
    }

    /// Whether each car field looks like what it is taken to be, over the whole
    /// file. Their meaning is confirmed on one camera configuration only, so a
    /// field that fails is left out — the import never fails on it.
    public static func plausibleChannels(_ records: [Record]) -> Plausible {
        func enough(_ v: [Int]) -> Bool { v.count >= MIN_CHANNEL_SAMPLES }
        let rpm = records.compactMap(\.rpm)
        let throttle = records.compactMap(\.throttle)
        let gear = records.compactMap(\.gear)
        // Only asked of a list `enough` has passed, so never of an empty one.
        func hi(_ v: [Int]) -> Int { v.max() ?? Int.min }
        func lo(_ v: [Int]) -> Int { v.min() ?? Int.max }
        return Plausible(
            rpm: enough(rpm) && lo(rpm) >= 0 && hi(rpm) >= 1000 && hi(rpm) <= 20000,
            throttle: enough(throttle) && lo(throttle) >= 0 && hi(throttle) <= 100
                && hi(throttle) - lo(throttle) >= 30,
            gear: enough(gear) && lo(gear) >= 0 && hi(gear) <= 8
        )
    }

    /// `{ date: "yyyy-mm-dd", time: "hh:mm:ss" }`, each nil when absent.
    public struct Stamp: Hashable, Sendable {
        public var date: String?
        public var time: String?

        public init(date: String? = nil, time: String? = nil) {
            self.date = date
            self.time = time
        }
    }

    /// The trailing `<aim_meta_data>` block → its date and time. Nothing else in
    /// it is read.
    public static func parseAimMeta(_ text: String?) -> Stamp {
        let chars = Array(text ?? "")
        // `<p n="NAME">([^<]*)</p>`, the first place it matches.
        func field(_ n: String) -> [Character]? {
            let open = Array("<p n=\"\(n)\">")
            let close = Array("</p>")
            var i = 0
            while i + open.count <= chars.count {
                if Array(chars[i..<i + open.count]) == open {
                    var j = i + open.count
                    while j < chars.count, chars[j] != "<" { j += 1 }
                    if j + close.count <= chars.count, Array(chars[j..<j + close.count]) == close {
                        return Array(chars[i + open.count..<j])
                    }
                }
                i += 1
            }
            return nil
        }
        func digits(_ c: [Character], _ range: Range<Int>) -> String? {
            c[range].allSatisfy(\.isASCIIDigit) ? String(c[range]) : nil
        }
        var out = Stamp()
        // `^(\d{2})\/(\d{2})\/(\d{4})$`
        if let d = field("date"), d.count == 10, d[2] == "/", d[5] == "/",
           let dd = digits(d, 0..<2), let mm = digits(d, 3..<5), let yyyy = digits(d, 6..<10) {
            out.date = "\(yyyy)-\(mm)-\(dd)"
        }
        // `^(\d{2}):(\d{2})[.:](\d{2})$`
        if let h = field("hour"), h.count == 8, h[2] == ":", h[5] == "." || h[5] == ":",
           let hh = digits(h, 0..<2), let mi = digits(h, 3..<5), let ss = digits(h, 6..<8) {
            out.time = "\(hh):\(mi):\(ss)"
        }
        return out
    }

    /// A trak's handler subtype, sample-entry type and tables.
    struct TrackInfo {
        var handler: String
        var entry: String?
        var timescale: Int
        var duration: Double
        var stbl: MP4.Box
    }

    static func trackInfo(_ moov: ByteView, _ trak: MP4.Box) -> TrackInfo? {
        guard let mdia = MP4.child(moov, trak, "mdia"),
              let hdlr = MP4.child(moov, mdia, "hdlr"),
              let mdhd = MP4.child(moov, mdia, "mdhd"),
              let minf = MP4.child(moov, mdia, "minf"),
              let stbl = MP4.child(moov, minf, "stbl")
        else { return nil }
        let stsd = MP4.child(moov, stbl, "stsd")
        let v1 = moov.getUint8(mdhd.body) == 1
        return TrackInfo(
            handler: MP4.fourcc(moov, hdlr.body + 8),
            entry: stsd.flatMap { $0.size >= 24 ? MP4.fourcc(moov, $0.body + 12) : nil },
            timescale: moov.getUint32(mdhd.body + (v1 ? 20 : 12)),
            duration: v1 ? Double(moov.getBigUint64(mdhd.body + 24)) : Double(moov.getUint32(mdhd.body + 16)),
            stbl: stbl
        )
    }

    /// Where each chunk of a track starts and how many bytes it holds, for a
    /// track of fixed-size samples (which is what a track declared as PCM is).
    static func chunkTable(_ moov: ByteView, _ stbl: MP4.Box) -> [(offset: Int, bytes: Int)] {
        guard let stco = MP4.child(moov, stbl, "stco") ?? MP4.child(moov, stbl, "co64"),
              let stsc = MP4.child(moov, stbl, "stsc"),
              let stsz = MP4.child(moov, stbl, "stsz")
        else { return [] }
        let sampleBytes = moov.getUint32(stsz.body + 4)
        if sampleBytes == 0 { return [] }
        let is64 = stco.type == "co64"
        let nChunks = moov.getUint32(stco.body + 4)
        let nRuns = moov.getUint32(stsc.body + 4)
        var out: [(offset: Int, bytes: Int)] = []
        for e in 0..<nRuns {
            let first = moov.getUint32(stsc.body + 8 + e * 12)
            let perChunk = moov.getUint32(stsc.body + 12 + e * 12)
            let next = e + 1 < nRuns ? moov.getUint32(stsc.body + 8 + (e + 1) * 12) : nChunks + 1
            var c = first
            while c < next && c <= nChunks {
                let offset = is64
                    ? Int(bitPattern: UInt(moov.getBigUint64(stco.body + 8 + (c - 1) * 8)))
                    : moov.getUint32(stco.body + 8 + (c - 1) * 4)
                out.append((offset, perChunk * sampleBytes))
                c += 1
            }
        }
        return out
    }

    /// Seconds since 1904 (QuickTime's epoch) → date and time in UTC.
    static func mvhdStamp(_ moov: ByteView, _ moovBox: MP4.Box) -> Stamp {
        guard let mvhd = MP4.child(moov, moovBox, "mvhd") else { return Stamp() }
        let v1 = moov.getUint8(mvhd.body) == 1
        let raw: UInt64 = v1 ? moov.getBigUint64(mvhd.body + 4) : UInt64(moov.getUint32(mvhd.body + 4))
        // Past year 9999 `toISOString` no longer has a four-digit year; no file is.
        guard raw > 2_082_844_800, raw < 2_082_844_800 + 253_402_300_800 else { return Stamp() }
        let s = Int(raw) - 2_082_844_800
        let days = s / 86400
        let secs = s % 86400
        // Civil date from days since 1970-01-01 (proleptic Gregorian).
        let z = days + 719_468
        let era = z / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
        func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
        let year = String(repeating: "0", count: max(0, 4 - String(y).count)) + String(y)
        return Stamp(
            date: "\(year)-\(two(m))-\(two(d))",
            time: "\(two(secs / 3600)):\(two(secs % 3600 / 60)):\(two(secs % 60))"
        )
    }

    public static func parseSmartyCamFile(_ source: some TelemetryByteSource) throws -> ParsedTelemetry {
        let moovRead = try MP4.readMoov(source)
        let moov = moovRead.view
        let moovBox = MP4.Box(type: "moov", start: 0, body: 8, size: moov.byteLength)
        let tracks = MP4.boxes(moov, moovBox.body, moovBox.start + moovBox.size)
            .filter { $0.type == "trak" }
            .compactMap { trackInfo(moov, $0) }

        // The telemetry: handler `free`, declared as `sowt`, in chunks long enough
        // to hold a record. The chunk length is the file's own — never a constant.
        let data = tracks.first { $0.handler == "free" && $0.entry == "sowt" }
        let chunks = data.map { chunkTable(moov, $0.stbl).filter { $0.bytes >= RECORD_BYTES } } ?? []
        if chunks.isEmpty {
            throw TelemetryParseError(message: "No SmartyCam telemetry track in this video", isNoTrack: true)
        }

        // The picture's frame rate turns a record's frame index into video seconds.
        let video = tracks.first { $0.handler == "vide" }
        let stts = video.flatMap { MP4.child(moov, $0.stbl, "stts") }
        let frameDelta = stts.map { moov.getUint32($0.body + 4) != 0 ? moov.getUint32($0.body + 12) : 0 } ?? 0
        guard let video, video.timescale != 0, frameDelta != 0 else {
            throw TelemetryParseError(message: "SmartyCam video track is missing its timing")
        }
        let fps = Double(video.timescale) / Double(frameDelta)
        let durationS = video.duration / Double(video.timescale)

        var records: [Record] = []
        records.reserveCapacity(chunks.count)
        var lastFrame = -1
        for (i, c) in chunks.enumerated() {
            // A user who picked the wrong 4 GB clip must be able to back out.
            if i % READ_BATCH == 0 { try Task.checkCancellation() }
            let dv = try bufAt(source, c.offset, RECORD_BYTES)
            if dv.byteLength < RECORD_BYTES { continue }
            var r = readRecord(dv)
            if r.frame <= lastFrame { continue }  // a record out of order is not a record
            lastFrame = r.frame
            r.t = Double(r.frame) / fps
            records.append(r)
        }

        var gps: [Geo.Point] = []
        for r in records {
            guard let ecef = r.ecef else { continue }
            let g = ecefToGeodetic(ecef.x, ecef.y, ecef.z)
            gps.append(Geo.Point(t: r.t, lat: g.lat, lon: g.lon, v: r.speedMs))
        }
        if gps.count < 10 { throw TelemetryParseError(message: "No GPS data in this SmartyCam video") }

        let laps = lapsFromCounter(records)

        let ok = plausibleChannels(records)
        func series(_ k: KeyPath<Record, Int?>) -> [ChannelPoint] {
            records.compactMap { r in r[keyPath: k].map { ChannelPoint(t: r.t, v: Double($0)) } }
        }
        var carChannels = ParsedTelemetry.CarChannels()
        if ok.rpm { carChannels.rpm = series(\.rpm) }
        if ok.throttle { carChannels.throttle = series(\.throttle) }
        if ok.gear { carChannels.gear = series(\.gear) }

        let topKph = gps.reduce(0.0) { max($0, ($1.v ?? 0) * 3.6) }
        let metrics = ParsedTelemetry.Metrics(
            topSpeedKph: topKph >= 30 && topKph < 500 ? topKph : nil,
            maxRpm: carChannels.rpm.map { $0.reduce(0.0) { max($0, $1.v) } }
        )

        let tail = try bufAt(source, max(0, source.size - META_TAIL_BYTES), META_TAIL_BYTES)
        let meta = parseAimMeta(tail.latin1(0, tail.byteLength))
        let stamp = meta.date != nil ? meta : mvhdStamp(moov, moovBox)

        var bestLapTrace: [TracePoint]?
        var traceGeo: TraceGeo?
        if let best = laps.min(by: { $0.timeMs < $1.timeMs }),
           let startT = best.startT, let endT = best.endT {
            bestLapTrace = Geo.lapTrace(Geo.projectTrace(gps), from: startT, to: endT)
            traceGeo = bestLapTrace != nil ? Geo.traceOrigin(gps) : nil
        }

        return ParsedTelemetry(
            kind: .smartycam,
            date: stamp.date,
            time: stamp.time,
            durationS: durationS,
            laps: laps,
            gps: gps,
            needsLine: false,
            bestLapTrace: bestLapTrace,
            traceGeo: traceGeo,
            metrics: metrics,
            carChannels: carChannels
        )
    }
}
